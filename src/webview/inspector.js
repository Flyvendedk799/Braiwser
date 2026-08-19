// Chrome AI OS — inspector preload, injected into every page in the <webview>.
// Runs in the guest page's isolated world and is the ENTRY for all in-page
// engines. It wires together:
//   • anchor.js   — element identity / re-resolution / highlight
//   • recorder.js — capture real user actions as steps
//   • replay.js   — re-execute steps against the live page
// and owns the overlay UI: element picking, freehand region drawing, the note
// popup with action tags, restored annotation pins, and the DOM-tree serializer.
// The shell keeps the canonical annotation list and does all export.

const { ipcRenderer } = require('electron');
const anchor = require('./anchor');
const recorder = require('./recorder');
const replay = require('./replay');

(function () {
  'use strict';

  let mode = 'off'; // 'off' | 'inspect' | 'draw' | 'assert' | 'arrange'
  let hovered = null; // element under cursor (inspect mode)
  let root, highlight, tooltip, canvas, ctx, popup, drawBar, pinLayer;
  let drawing = false;
  let strokes = []; // page-coordinate strokes for the current region
  let curStroke = null;
  let pins = []; // [{ el, target, badge, action }] restored annotation pins
  let pinSyncQueued = false;
  let lastPickedEl = null; // live ref to the last layout-hierarchy selection, for reorder refocus

  // ---- rearrange-mode state ---------------------------------------------------
  let arrangeSel = null; // the selected live element
  let arrangeUI = null; // { box, barEl, label, undoBtn, handles: {...} }
  let arrangeDrag = null; // active drag descriptor (move or resize)
  const editStack = []; // applied edits: { type, annId, undo }

  const ACTIONS = [
    { id: 'remove', label: 'Remove', color: '#ff6b6b' },
    { id: 'change', label: 'Change', color: '#ffb454' },
    { id: 'fix', label: 'Fix', color: '#5b8cff' },
    { id: 'add', label: 'Add', color: '#3ddc97' },
    { id: 'question', label: 'Question', color: '#c792ea' },
    { id: 'comment', label: 'Comment', color: '#9aa2b1' },
  ];
  const ACTION_COLOR = ACTIONS.reduce((m, a) => ((m[a.id] = a.color), m), {});

  const uid = () =>
    'a' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  function label(el) {
    let s = el.nodeName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.classList && el.classList.length) {
      s += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    }
    const r = el.getBoundingClientRect();
    return s + '  ·  ' + Math.round(r.width) + '×' + Math.round(r.height);
  }

  function isOwnUI(el) {
    try {
      return !!(el && el.closest && el.closest('[data-caos], #__caos_root'));
    } catch (_e) {
      return false;
    }
  }

  // ---- overlay UI -----------------------------------------------------------
  function ensureUI() {
    if (root && document.documentElement.contains(root)) return;

    root = document.createElement('div');
    root.id = '__caos_root';
    root.setAttribute('data-caos', '');
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';

    highlight = document.createElement('div');
    highlight.setAttribute('data-caos', '');
    highlight.style.cssText =
      'position:fixed;border:2px solid #5b8cff;background:rgba(91,140,255,.16);' +
      'border-radius:3px;display:none;pointer-events:none;transition:all .04s ease-out;';

    tooltip = document.createElement('div');
    tooltip.setAttribute('data-caos', '');
    tooltip.style.cssText =
      'position:fixed;background:#11131a;color:#cdd6f4;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'padding:5px 9px;border-radius:6px;border:1px solid #2a2e3a;display:none;pointer-events:none;' +
      'max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 24px rgba(0,0,0,.4);';

    pinLayer = document.createElement('div');
    pinLayer.setAttribute('data-caos', '');
    pinLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;';

    root.appendChild(highlight);
    root.appendChild(tooltip);
    root.appendChild(pinLayer);
    document.documentElement.appendChild(root);

    // The draw-mode surface. It only receives pointer events while draw mode
    // is on (setMode toggles pointer-events), so its own handlers never fight
    // with page content or other own-UI chrome — no target-filtering needed,
    // unlike the document-level pick handlers. Pointer Events (not mouse
    // events) so pen/touch drags work too, and setPointerCapture guarantees
    // the move/up events keep arriving even when the pointer leaves the
    // webview mid-drag — with window mouse listeners, releasing the button
    // outside the page left `drawing` stuck on and the stroke glued to the
    // cursor. touch-action:none stops touch drags from scrolling instead.
    canvas = document.createElement('canvas');
    canvas.setAttribute('data-caos', '');
    canvas.style.cssText = 'position:fixed;inset:0;display:none;z-index:2147483645;cursor:crosshair;touch-action:none;';
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', onCanvasDown);
    canvas.addEventListener('pointermove', onCanvasMove);
    canvas.addEventListener('pointerup', onCanvasUp);
    canvas.addEventListener('pointercancel', onCanvasCancel);

    drawBar = document.createElement('div');
    drawBar.setAttribute('data-caos', '');
    drawBar.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'background:#11131a;border:1px solid #2a2e3a;border-radius:10px;padding:8px 14px;box-shadow:0 8px 30px rgba(0,0,0,.45);' +
      'color:#9aa2b1;font:12px sans-serif;pointer-events:none;';
    drawBar.textContent = DRAW_HINT;
    document.documentElement.appendChild(drawBar);

    sizeCanvas();
  }

  function sizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (mode !== 'draw' || !strokes.length) return; // nothing to paint
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ff5d8f';
    for (const stroke of strokes) {
      ctx.beginPath();
      stroke.forEach((p, i) => {
        const x = p.x - window.scrollX;
        const y = p.y - window.scrollY;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  }

  // ---- inspect mode ---------------------------------------------------------
  function onMove(e) {
    if (mode !== 'inspect' && mode !== 'assert' && mode !== 'arrange') return;
    if (mode === 'arrange' && arrangeDrag) return; // no hover flicker mid-drag
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (mode === 'arrange' && el === arrangeSel) {
      // the selection box already outlines it — skip the hover overlay
      highlight.style.display = tooltip.style.display = 'none';
      return;
    }
    if (!el || isOwnUI(el)) {
      highlight.style.display = tooltip.style.display = 'none';
      hovered = null;
      return;
    }
    hovered = el;
    const r = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = r.left + 'px';
    highlight.style.top = r.top + 'px';
    highlight.style.width = r.width + 'px';
    highlight.style.height = r.height + 'px';
    tooltip.style.display = 'block';
    tooltip.textContent = label(el);
    const ty = r.top > 28 ? r.top - 26 : r.bottom + 6;
    tooltip.style.left = Math.max(4, r.left) + 'px';
    tooltip.style.top = ty + 'px';
  }

  function onClick(e) {
    if (mode !== 'inspect' && mode !== 'assert' && mode !== 'arrange') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOwnUI(el)) return; // let popup / arrange-bar interactions through
    e.preventDefault();
    e.stopPropagation();
    if (!el) return;
    if (mode === 'arrange') {
      arrangeSelect(el);
      return;
    }
    if (mode === 'assert') {
      // Point at an element; the host opens the assertion editor pre-filled.
      try {
        anchor.highlight(el, { duration: 700, color: '#c792ea' });
        ipcRenderer.sendToHost('caos:assert-pick', anchor.describe(el));
      } catch (_e) {
        /* ignore */
      }
      return;
    }
    // Inspect mode does both: update the Inspector tab's layout/hierarchy
    // view for this element, and open the note popup to capture a comment.
    pickLayout(el);
    openElementNote(el);
  }

  // ---- draw mode ------------------------------------------------------------
  // Handlers are bound directly on the canvas (see ensureUI), so no mode or
  // own-UI check is strictly needed here — but the mode check guards against
  // a stray event during a mode switch mid-drag.
  const DRAW_MIN = 6; // px — below this in EVERY direction, treat as an accidental click
  const DRAW_THIN = 14; // px — pad a thinner-than-this region box out to a usable size
  const DRAW_HINT = 'Drag on the page to circle something — release to add a note';
  let drawHintTimer = null;

  function flashDrawHint(msg) {
    if (!drawBar) return;
    drawBar.textContent = msg;
    drawBar.style.color = '#ffb454';
    clearTimeout(drawHintTimer);
    drawHintTimer = setTimeout(() => {
      drawBar.textContent = DRAW_HINT;
      drawBar.style.color = '#9aa2b1';
    }, 1600);
  }

  function onCanvasDown(e) {
    if (mode !== 'draw' || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    drawing = true;
    curStroke = [{ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }];
    strokes = [curStroke]; // one region per draw — a fresh drag replaces any prior stroke
    redraw();
  }
  function onCanvasMove(e) {
    if (!drawing) return;
    curStroke.push({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
    redraw();
  }
  function onCanvasUp(e) {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    const box = strokesBox();
    // A mark only needs to be long in ONE direction — an underline or a strike
    // across a row is a perfectly good region. Only a near-zero blob (a click
    // with hand jitter) is discarded.
    if (box && Math.max(box.w, box.h) >= DRAW_MIN) {
      openRegionNote(); // drag was a real mark — go straight to the note
    } else {
      strokes = []; // accidental click — leave no mark behind
      redraw();
      flashDrawHint('Keep dragging a little further to mark an area');
    }
  }
  function onCanvasCancel() {
    // Pointer was taken away mid-drag (e.g. touch gesture stolen) — discard.
    if (!drawing) return;
    drawing = false;
    strokes = [];
    redraw();
  }

  function strokesBox() {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of strokes)
      for (const p of s) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    if (!isFinite(minX)) return null;
    return {
      x: Math.round(minX),
      y: Math.round(minY),
      w: Math.round(maxX - minX),
      h: Math.round(maxY - minY),
    };
  }

  // ---- layout hierarchy (Layers mode) ----------------------------------------
  // Describes a clicked element's spot in the layout: its ancestor breadcrumb,
  // its parent container's layout kind (row/column/grid/stacked block flow),
  // and the parent's children ("layers") with box/position/z-index — enough
  // for the host panel to render the hierarchy and let the user reorder it.
  function nodeBrief(el) {
    return {
      selector: anchor.cssPath(el),
      tag: el.nodeName.toLowerCase(),
      id: el.id || null,
      classes: Array.prototype.slice.call(el.classList || []),
    };
  }

  function ancestorChain(el) {
    const chain = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      if (!isOwnUI(node)) chain.unshift(nodeBrief(node));
      if (node === document.body) break;
      node = node.parentElement;
      depth++;
    }
    return chain;
  }

  function rectsOverlap(a, b) {
    const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const inter = ix * iy;
    if (inter <= 0) return false;
    const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;
    return inter / minArea > 0.3;
  }

  function containerKind(cs) {
    const display = cs.display || '';
    if (display.indexOf('grid') !== -1) {
      const cols = (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length;
      const rows = (cs.gridTemplateRows || '').split(' ').filter(Boolean).length;
      return { kind: 'grid', detail: cols && rows ? cols + '×' + rows : 'grid' };
    }
    if (display.indexOf('flex') !== -1) {
      const dir = cs.flexDirection || 'row';
      const wrap = cs.flexWrap && cs.flexWrap !== 'nowrap';
      return { kind: dir.indexOf('column') === 0 ? 'column' : 'row', detail: dir + (wrap ? ' · wrap' : '') };
    }
    return { kind: 'block', detail: 'block flow' };
  }

  function layerList(parent, targetEl) {
    const kids = Array.prototype.filter.call(parent.children, (c) => c.nodeType === 1 && !isOwnUI(c));
    const boxes = kids.map((k) => k.getBoundingClientRect());
    return kids.map((k, i) => {
      const r = boxes[i];
      const kcs = getComputedStyle(k);
      const overlapping = boxes.some((r2, j) => j !== i && rectsOverlap(r, r2));
      return {
        selector: anchor.cssPath(k),
        tag: k.nodeName.toLowerCase(),
        id: k.id || null,
        classes: Array.prototype.slice.call(k.classList || []),
        index: i,
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        position: kcs.position,
        zIndex: kcs.zIndex,
        overlapping,
        isTarget: k === targetEl,
      };
    });
  }

  function describeLayout(el) {
    if (!el || el.nodeType !== 1 || isOwnUI(el)) return null;
    const parent = el.parentElement;
    let container = null;
    let siblings = [];
    if (parent && parent.nodeType === 1 && !isOwnUI(parent)) {
      const pcs = getComputedStyle(parent);
      const k = containerKind(pcs);
      siblings = layerList(parent, el);
      container = {
        selector: anchor.cssPath(parent),
        tag: parent.nodeName.toLowerCase(),
        id: parent.id || null,
        classes: Array.prototype.slice.call(parent.classList || []),
        kind: k.kind,
        detail: k.detail,
        childCount: siblings.length,
      };
    }
    return {
      selector: anchor.cssPath(el),
      target: nodeBrief(el),
      breadcrumb: ancestorChain(el),
      container,
      siblings,
    };
  }

  function pickLayout(el) {
    try {
      lastPickedEl = el;
      anchor.highlight(el, { duration: 700, color: '#3ddc97' });
      const info = describeLayout(el);
      if (info) ipcRenderer.sendToHost('caos:layout-picked', info);
    } catch (_e) {
      /* ignore */
    }
  }

  // ---- rearrange mode ---------------------------------------------------------
  // Select any element, then: drag to reorder it among its siblings (the DOM
  // actually moves, live), Alt-drag (or drag a positioned element) to nudge it
  // freehand, pull the handles to resize, hide it, or apply a smart re-layout
  // to its container (row / column / grid / tidy). Every committed change is
  // applied to the live page AND captured as a kind:'edit' annotation carrying
  // the exact CSS / reorder details, so it exports straight to a coding agent.
  // Undo/Reset revert the page and retract the captured note.

  const ARRANGE_COLOR = '#3ddc97';
  const DRAG_CLICK_MAX = 4; // px — under this, a drag on the selection is a click-through

  function elChildren(parent, excludeEl) {
    return Array.prototype.filter.call(
      parent.children,
      (c) => c.nodeType === 1 && !isOwnUI(c) && c !== excludeEl
    );
  }
  function indexIn(parent, el) {
    return elChildren(parent).indexOf(el);
  }

  function ensureArrangeUI() {
    if (arrangeUI && root.contains(arrangeUI.box)) return arrangeUI;

    const box = document.createElement('div');
    box.setAttribute('data-caos', '');
    box.setAttribute('data-caos-arrange', 'box');
    box.style.cssText =
      'position:fixed;display:none;border:2px dashed ' + ARRANGE_COLOR + ';border-radius:3px;' +
      'background:rgba(61,220,151,.07);pointer-events:auto;cursor:move;z-index:2147483644;touch-action:none;';

    const mkHandle = (kind, cursor) => {
      const hd = document.createElement('div');
      hd.setAttribute('data-caos', '');
      hd.setAttribute('data-caos-arrange', 'handle-' + kind);
      hd.style.cssText =
        'position:fixed;display:none;width:11px;height:11px;border-radius:3px;background:' + ARRANGE_COLOR + ';' +
        'border:2px solid #0e0f13;box-shadow:0 1px 4px rgba(0,0,0,.5);pointer-events:auto;z-index:2147483645;cursor:' +
        cursor + ';touch-action:none;';
      hd.addEventListener('pointerdown', (e) => startResize(e, kind, hd));
      root.appendChild(hd);
      return hd;
    };

    const bar = document.createElement('div');
    bar.setAttribute('data-caos', '');
    bar.setAttribute('data-caos-arrange', 'bar');
    bar.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'align-items:center;gap:6px;background:#11131a;border:1px solid #2a2e3a;border-radius:10px;padding:7px 10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.45);color:#9aa2b1;font:12px sans-serif;pointer-events:auto;flex-wrap:wrap;max-width:92vw;';

    const label = document.createElement('span');
    label.style.cssText =
      'font:600 11px ui-monospace,monospace;color:#3ddc97;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    bar.appendChild(label);

    const mkBtn = (slug, text, title, onClick) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      b.setAttribute('data-caos-arrange', 'btn-' + slug);
      b.style.cssText =
        'cursor:pointer;border:1px solid #2a2e3a;border-radius:7px;padding:4px 9px;background:#171a22;' +
        'color:#cdd6f4;font:600 11px sans-serif;white-space:nowrap;';
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      bar.appendChild(b);
      return b;
    };
    const mkSep = () => {
      const s = document.createElement('span');
      s.style.cssText = 'width:1px;height:16px;background:#2a2e3a;';
      bar.appendChild(s);
    };

    mkBtn('up', '↑', 'Move earlier among its siblings', () => nudgeOrder(-1));
    mkBtn('down', '↓', 'Move later among its siblings', () => nudgeOrder(1));
    mkSep();
    mkBtn('row', 'Row', 'Smart re-layout the container as a flex row', () => smartLayout('row'));
    mkBtn('column', 'Column', 'Smart re-layout the container as a flex column', () => smartLayout('column'));
    mkBtn('grid', 'Grid', 'Smart re-layout the container as a responsive grid', () => smartLayout('grid'));
    mkBtn('tidy', 'Tidy', 'Normalize the container: consistent gaps and alignment', () => smartLayout('tidy'));
    mkSep();
    mkBtn('hide', 'Hide', 'Hide this element (records a removal edit)', () => hideSelected());
    mkSep();
    const undoBtn = mkBtn('undo', 'Undo', 'Undo the last layout edit (also retracts its note)', () => undoLastEdit());
    mkBtn('reset', 'Reset', 'Undo ALL layout edits made in this session', () => resetEdits());

    const hint = document.createElement('span');
    hint.textContent = 'drag = reorder · Alt-drag = free move · handles = resize · Esc = done';
    hint.style.cssText = 'color:#6b7280;font:11px sans-serif;';
    bar.appendChild(hint);

    box.addEventListener('pointerdown', startMove);
    root.appendChild(box);
    root.appendChild(bar);

    arrangeUI = {
      box,
      barEl: bar,
      label,
      undoBtn,
      handles: {
        e: mkHandle('e', 'ew-resize'),
        s: mkHandle('s', 'ns-resize'),
        se: mkHandle('se', 'nwse-resize'),
      },
    };
    updateArrangeBar();
    return arrangeUI;
  }

  function updateArrangeBar() {
    if (!arrangeUI) return;
    arrangeUI.undoBtn.textContent = editStack.length ? 'Undo (' + editStack.length + ')' : 'Undo';
    arrangeUI.undoBtn.disabled = !editStack.length;
    arrangeUI.undoBtn.style.opacity = editStack.length ? '1' : '.45';
  }

  function arrangeLabel(el) {
    let s = el.nodeName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + el.classList[0];
    return s;
  }

  function arrangeSelect(el) {
    if (!el || el.nodeType !== 1 || isOwnUI(el)) return;
    if (el === document.body || el === document.documentElement) {
      arrangeDeselect();
      return;
    }
    arrangeSel = el;
    ensureArrangeUI();
    arrangeUI.label.textContent = arrangeLabel(el);
    arrangeUI.label.title = anchor.cssPath(el);
    syncArrange();
    pickLayout(el); // keep the Inspector panel's hierarchy view in step
  }

  function arrangeDeselect() {
    arrangeSel = null;
    arrangeDrag = null;
    if (!arrangeUI) return;
    arrangeUI.box.style.display = 'none';
    for (const k in arrangeUI.handles) arrangeUI.handles[k].style.display = 'none';
    arrangeUI.label.textContent = '';
  }

  // Position the selection box + handles over the live element.
  function syncArrange() {
    if (!arrangeSel || !arrangeUI || mode !== 'arrange') return;
    if (!document.documentElement.contains(arrangeSel)) {
      arrangeDeselect();
      return;
    }
    const r = arrangeSel.getBoundingClientRect();
    const b = arrangeUI.box;
    b.style.display = 'block';
    b.style.left = r.left - 2 + 'px';
    b.style.top = r.top - 2 + 'px';
    b.style.width = Math.max(0, r.width) + 'px';
    b.style.height = Math.max(0, r.height) + 'px';
    const hs = arrangeUI.handles;
    const place = (hd, x, y) => {
      hd.style.display = 'block';
      hd.style.left = x - 5 + 'px';
      hd.style.top = y - 5 + 'px';
    };
    place(hs.e, r.right, r.top + r.height / 2);
    place(hs.s, r.left + r.width / 2, r.bottom);
    place(hs.se, r.right, r.bottom);
  }

  // ---- committing edits -------------------------------------------------------
  // Applies are done by the caller; this records the undo, sends the edit
  // annotation to the host, and refreshes the overlay.
  function commitEdit(el, entry) {
    const annId = uid();
    editStack.push({ type: entry.type, annId, undo: entry.undo });
    send({
      id: annId,
      kind: 'edit',
      action: entry.action || 'change',
      note: entry.note,
      target: anchor.describe(el),
      edit: { type: entry.type, css: entry.css || '', details: entry.details || {} },
    });
    updateArrangeBar();
    syncArrange();
  }

  function undoLastEdit() {
    const entry = editStack.pop();
    if (!entry) return;
    try {
      entry.undo();
    } catch (_e) {
      /* element may be gone — nothing to revert */
    }
    ipcRenderer.sendToHost('caos:edit-undo', { id: entry.annId });
    updateArrangeBar();
    syncArrange();
  }

  function resetEdits() {
    while (editStack.length) undoLastEdit();
  }

  // Snapshot an element's inline style so undo can restore it exactly.
  function styleSnapshot(el) {
    const before = el.getAttribute('style');
    return () => {
      if (before == null) el.removeAttribute('style');
      else el.setAttribute('style', before);
    };
  }

  function px(n) {
    return Math.round(n) + 'px';
  }

  // ---- move / reorder drag ------------------------------------------------------
  function startMove(e) {
    if (!arrangeSel || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = arrangeSel;
    const parent = el.parentElement;
    const cs = getComputedStyle(el);
    const free = e.altKey || cs.position === 'absolute' || cs.position === 'fixed' || !parent || isOwnUI(parent);
    const surface = arrangeUI.box;
    try { surface.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    arrangeDrag = {
      kind: free ? 'free' : 'reorder',
      el,
      parent,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      startIndex: parent ? indexIn(parent, el) : -1,
      restoreStyle: styleSnapshot(el),
      baseTransform: el.style.transform || '',
      surface,
    };
    // Listen on window (capture is only belt-and-braces): the selection box
    // lags behind the cursor while the element reflows, so element-scoped
    // listeners would drop moves the moment the pointer escapes it.
    const onMoveEv = (ev) => dragMove(ev);
    const onUpEv = (ev) => {
      window.removeEventListener('pointermove', onMoveEv, true);
      window.removeEventListener('pointerup', onUpEv, true);
      window.removeEventListener('pointercancel', onUpEv, true);
      dragEnd(ev);
    };
    window.addEventListener('pointermove', onMoveEv, true);
    window.addEventListener('pointerup', onUpEv, true);
    window.addEventListener('pointercancel', onUpEv, true);
  }

  function dragMove(e) {
    const d = arrangeDrag;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < DRAG_CLICK_MAX && Math.abs(dy) < DRAG_CLICK_MAX) return;
    d.moved = true;
    d.el.style.opacity = '0.65';
    if (d.kind === 'free') {
      d.dx = dx;
      d.dy = dy;
      d.el.style.transform = (d.baseTransform ? d.baseTransform + ' ' : '') + 'translate(' + dx + 'px,' + dy + 'px)';
    } else {
      // Live reorder: actually move the node when the pointer crosses a
      // sibling midpoint — the page shows the real result the whole time.
      const ref = insertionRef(d.parent, d.el, e.clientX, e.clientY);
      if (ref !== d.el && ref !== d.el.nextElementSibling) {
        try {
          d.parent.insertBefore(d.el, ref);
        } catch (_e) {
          /* ignore */
        }
      }
    }
    syncArrange();
  }

  function dragEnd(e) {
    const d = arrangeDrag;
    arrangeDrag = null;
    if (!d) return;
    try { d.surface.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    d.el.style.opacity = '';
    if (!d.moved) {
      // Effectively a click on the selection — drill through to whatever is
      // under the pointer (lets you select a child inside the selected box).
      arrangeUI.box.style.display = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      arrangeUI.box.style.display = 'block';
      if (under && !isOwnUI(under)) arrangeSelect(under);
      else syncArrange();
      return;
    }
    if (d.kind === 'free') {
      const dx = Math.round(d.dx || 0);
      const dy = Math.round(d.dy || 0);
      if (!dx && !dy) {
        d.restoreStyle();
        syncArrange();
        return;
      }
      const css = 'transform: ' + d.el.style.transform + ';';
      commitEdit(d.el, {
        type: 'move',
        note: 'Reposition `' + anchor.cssPath(d.el) + '` by ' + dx + 'px horizontally, ' + dy + 'px vertically (freehand drag).',
        css,
        details: { dx, dy },
        undo: d.restoreStyle,
      });
    } else {
      const endIndex = indexIn(d.parent, d.el);
      if (endIndex === d.startIndex || d.startIndex < 0 || endIndex < 0) {
        syncArrange();
        return;
      }
      const parentSel = anchor.cssPath(d.parent);
      const n = elChildren(d.parent).length;
      const el = d.el;
      const parent = d.parent;
      const startIndex = d.startIndex;
      commitEdit(el, {
        type: 'reorder',
        note:
          'Move `' + anchor.cssPath(el) + '` from position ' + (d.startIndex + 1) + ' to position ' + (endIndex + 1) +
          ' (of ' + n + ') inside `' + parentSel + '`.',
        details: { parentSelector: parentSel, fromIndex: d.startIndex, toIndex: endIndex },
        undo: () => {
          const kids = elChildren(parent, el);
          parent.insertBefore(el, kids[startIndex] || null);
        },
      });
    }
  }

  // Where would the dragged element land if dropped at (x, y)?
  // Returns the child to insert BEFORE (null = append at the end).
  function insertionRef(parent, el, x, y) {
    const kids = elChildren(parent, el);
    if (!kids.length) return null;
    const kind = containerKind(getComputedStyle(parent)).kind;
    if (kind === 'grid') {
      let best = null;
      let bestD = Infinity;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (dd < bestD) {
          bestD = dd;
          best = { k, r, cx, cy };
        }
      }
      if (!best) return null;
      const after = y > best.cy + best.r.height / 2 || (Math.abs(y - best.cy) <= best.r.height / 2 && x > best.cx);
      return after ? best.k.nextElementSibling : best.k;
    }
    const horiz = kind === 'row';
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      const c = horiz ? r.left + r.width / 2 : r.top + r.height / 2;
      if ((horiz ? x : y) < c) return k;
    }
    return null;
  }

  // Keyboard-precise reorder from the action bar (↑ / ↓).
  function nudgeOrder(delta) {
    const el = arrangeSel;
    if (!el || !el.parentElement) return;
    const parent = el.parentElement;
    const from = indexIn(parent, el);
    const to = from + delta;
    const kids = elChildren(parent);
    if (from < 0 || to < 0 || to >= kids.length) return;
    const ref = kids[delta > 0 ? to + 1 : to] || null;
    parent.insertBefore(el, ref === el ? el.nextElementSibling : ref);
    const parentSel = anchor.cssPath(parent);
    commitEdit(el, {
      type: 'reorder',
      note:
        'Move `' + anchor.cssPath(el) + '` from position ' + (from + 1) + ' to position ' + (to + 1) +
        ' (of ' + kids.length + ') inside `' + parentSel + '`.',
      details: { parentSelector: parentSel, fromIndex: from, toIndex: to },
      undo: () => {
        const k2 = elChildren(parent, el);
        parent.insertBefore(el, k2[from] || null);
      },
    });
  }

  // ---- resize drag --------------------------------------------------------------
  function startResize(e, kind, handleEl) {
    if (!arrangeSel || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = arrangeSel;
    const r = el.getBoundingClientRect();
    try { handleEl.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    const restoreStyle = styleSnapshot(el);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMoveEv = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      moved = true;
      if (kind === 'e' || kind === 'se') el.style.width = px(Math.max(8, r.width + dx));
      if (kind === 's' || kind === 'se') el.style.height = px(Math.max(8, r.height + dy));
      if (kind === 'se' || kind === 'e' || kind === 's') el.style.boxSizing = 'border-box';
      syncArrange();
    };
    const onUpEv = (ev) => {
      window.removeEventListener('pointermove', onMoveEv, true);
      window.removeEventListener('pointerup', onUpEv, true);
      window.removeEventListener('pointercancel', onUpEv, true);
      try { handleEl.releasePointerCapture(ev.pointerId); } catch (_e) { /* ignore */ }
      if (!moved) return;
      const r2 = el.getBoundingClientRect();
      const parts = [];
      if (kind === 'e' || kind === 'se') parts.push('width: ' + px(r2.width) + ';');
      if (kind === 's' || kind === 'se') parts.push('height: ' + px(r2.height) + ';');
      commitEdit(el, {
        type: 'resize',
        note:
          'Resize `' + anchor.cssPath(el) + '` to ' + Math.round(r2.width) + '×' + Math.round(r2.height) +
          'px (was ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px).',
        css: parts.join(' '),
        details: {
          before: { w: Math.round(r.width), h: Math.round(r.height) },
          after: { w: Math.round(r2.width), h: Math.round(r2.height) },
        },
        undo: restoreStyle,
      });
    };
    // Window-scoped for the same reason as startMove: the handle chases the
    // corner it resizes, so the pointer routinely outruns it mid-drag.
    window.addEventListener('pointermove', onMoveEv, true);
    window.addEventListener('pointerup', onUpEv, true);
    window.addEventListener('pointercancel', onUpEv, true);
  }

  // ---- hide + smart re-layout -----------------------------------------------------
  function hideSelected() {
    const el = arrangeSel;
    if (!el) return;
    const restore = styleSnapshot(el);
    el.style.display = 'none';
    commitEdit(el, {
      type: 'hide',
      action: 'remove',
      note: 'Remove `' + anchor.cssPath(el) + '` from the page (hidden in preview with display:none).',
      css: 'display: none;',
      undo: restore,
    });
    arrangeDeselect();
  }

  // The container a smart layout applies to: the selection itself when it has
  // 2+ real children, otherwise its parent.
  function smartTarget() {
    const el = arrangeSel;
    if (!el) return null;
    if (elChildren(el).length >= 2) return el;
    const p = el.parentElement;
    if (p && p.nodeType === 1 && !isOwnUI(p) && p !== document.documentElement) return p;
    return null;
  }

  // Median gap between consecutive children along the container's main axis —
  // used so re-layouts keep the page's existing rhythm instead of forcing one.
  function medianGap(kids, horiz) {
    const gaps = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const g = horiz ? b.left - a.right : b.top - a.bottom;
      if (isFinite(g) && g >= 0 && g < 400) gaps.push(g);
    }
    if (!gaps.length) return 12;
    gaps.sort((x, y) => x - y);
    return Math.max(4, Math.round(gaps[Math.floor(gaps.length / 2)]));
  }

  function smartLayout(kindWanted) {
    const container = smartTarget();
    if (!container) return;
    const kids = elChildren(container);
    if (kids.length < 2 && kindWanted !== 'tidy') return;
    const cs = getComputedStyle(container);
    const currentKind = containerKind(cs).kind;
    const horiz = kindWanted === 'row' || (kindWanted === 'tidy' && currentKind === 'row');
    const gap = medianGap(kids, currentKind === 'row');
    const restore = styleSnapshot(container);

    const decl = {};
    if (kindWanted === 'row') {
      decl.display = 'flex';
      decl['flex-direction'] = 'row';
      decl['flex-wrap'] = 'wrap';
      decl['align-items'] = 'center';
      decl.gap = gap + 'px';
    } else if (kindWanted === 'column') {
      decl.display = 'flex';
      decl['flex-direction'] = 'column';
      decl['align-items'] = 'stretch';
      decl.gap = gap + 'px';
    } else if (kindWanted === 'grid') {
      let minW = Infinity;
      for (const k of kids) minW = Math.min(minW, k.getBoundingClientRect().width);
      if (!isFinite(minW) || minW < 80) minW = 160;
      decl.display = 'grid';
      decl['grid-template-columns'] = 'repeat(auto-fit, minmax(' + Math.round(Math.min(minW, 420)) + 'px, 1fr))';
      decl.gap = gap + 'px';
    } else {
      // tidy — keep the axis it already flows in, normalize gap + alignment
      decl.display = 'flex';
      decl['flex-direction'] = horiz ? 'row' : 'column';
      decl['align-items'] = horiz ? 'center' : 'stretch';
      decl.gap = gap + 'px';
      if (horiz) decl['flex-wrap'] = 'wrap';
    }
    let css = '';
    for (const k in decl) {
      container.style.setProperty(k, decl[k]);
      css += k + ': ' + decl[k] + '; ';
    }
    css = css.trim();
    const names = { row: 'a horizontal flex row', column: 'a vertical flex column', grid: 'a responsive grid', tidy: 'a tidied ' + (horiz ? 'row' : 'column') + ' with consistent spacing' };
    commitEdit(container, {
      type: 'layout',
      note: 'Re-layout `' + anchor.cssPath(container) + '` (' + kids.length + ' children) as ' + names[kindWanted] + '. Apply: ' + css,
      css,
      details: { layout: kindWanted, gap },
      undo: restore,
    });
    arrangeSelect(container);
  }

  // ---- note popup -----------------------------------------------------------
  function openElementNote(el) {
    const meta = anchor.describe(el);
    const r = el.getBoundingClientRect();
    showPopup({ kind: 'element', target: meta, anchor: r }, (note, action) => {
      send({ id: uid(), kind: 'element', action, note, target: meta });
    });
  }

  function openRegionNote() {
    const box = strokesBox();
    if (!box) return;
    // Pad a razor-thin mark (an underline / a vertical tick) out to a usable
    // region so the stored box actually covers what the user pointed at.
    if (box.h < DRAW_THIN) {
      const pad = Math.ceil((DRAW_THIN - box.h) / 2);
      box.y -= pad;
      box.h += pad * 2;
    }
    if (box.w < DRAW_THIN) {
      const pad = Math.ceil((DRAW_THIN - box.w) / 2);
      box.x -= pad;
      box.w += pad * 2;
    }
    const anchorRect = {
      left: box.x - window.scrollX,
      top: box.y - window.scrollY,
      bottom: box.y - window.scrollY + box.h,
      right: box.x - window.scrollX + box.w,
    };
    const clearStroke = () => {
      strokes = [];
      redraw();
    };
    showPopup(
      { kind: 'region', target: { box }, anchor: anchorRect },
      (note, action) => {
        send({ id: uid(), kind: 'region', action, note, target: { box } });
        clearStroke();
        // Flash the captured region so it's obvious the note registered.
        anchor.highlight(null, { duration: 900, color: ACTION_COLOR[action] || '#ff5d8f', box: anchorRect2Box(anchorRect) });
      },
      clearStroke // cancelling a region note just discards the mark — stay in draw mode to try again
    );
  }

  function anchorRect2Box(r) {
    return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
  }

  let popupCancel = null; // cancel path of the OPEN popup, for the global Escape

  function showPopup(ctxObj, onSave, onCancel) {
    closePopup();
    popupCancel = () => {
      closePopup();
      if (onCancel) onCancel();
    };
    popup = document.createElement('div');
    popup.setAttribute('data-caos', '');
    popup.style.cssText =
      'position:fixed;z-index:2147483647;width:320px;background:#11131a;border:1px solid #2a2e3a;border-radius:12px;' +
      'padding:14px;box-shadow:0 16px 50px rgba(0,0,0,.55);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#e6e9f0;';

    const head =
      ctxObj.kind === 'element'
        ? '&lt;' +
          ctxObj.target.tag +
          '&gt;' +
          (ctxObj.target.id ? ' #' + ctxObj.target.id : '')
        : 'Drawn region';
    popup.innerHTML =
      '<div style="font:12px ui-monospace,monospace;color:#7f8694;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
      head +
      '</div>' +
      '<div data-chips style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>' +
      '<textarea placeholder="Describe the change… e.g. \'remove this banner\'" style="width:100%;box-sizing:border-box;min-height:70px;resize:vertical;background:#0c0e14;border:1px solid #2a2e3a;border-radius:8px;color:#e6e9f0;padding:9px;font:13px/1.45 sans-serif;outline:none"></textarea>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">' +
      '<button data-cancel style="cursor:pointer;border:0;border-radius:8px;padding:7px 13px;background:#22262f;color:#cdd6f4;font:600 12px sans-serif">Cancel</button>' +
      '<button data-save style="cursor:pointer;border:0;border-radius:8px;padding:7px 13px;background:#5b8cff;color:#fff;font:600 12px sans-serif">Save note</button>' +
      '</div>';

    let action = 'comment';
    const chips = popup.querySelector('[data-chips]');
    ACTIONS.forEach((a) => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.style.cssText =
        'cursor:pointer;border:1px solid ' +
        a.color +
        '44;border-radius:999px;padding:4px 10px;background:transparent;color:' +
        a.color +
        ';font:600 11px sans-serif';
      b.addEventListener('click', () => {
        action = a.id;
        chips.querySelectorAll('button').forEach((x) => (x.style.background = 'transparent'));
        b.style.background = a.color + '22';
      });
      if (a.id === 'comment') b.style.background = a.color + '22';
      chips.appendChild(b);
    });

    document.documentElement.appendChild(popup);
    // position near anchor, clamped to viewport
    const a = ctxObj.anchor;
    const pw = 320,
      ph = popup.offsetHeight || 220;
    const left = Math.min(window.innerWidth - pw - 10, Math.max(10, a.left || 20));
    let top = (a.bottom || 20) + 8;
    if (top + ph > window.innerHeight - 10) top = Math.max(10, (a.top || 20) - ph - 8);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';

    const ta = popup.querySelector('textarea');
    ta.focus();
    popup.querySelector('[data-cancel]').addEventListener('click', () => {
      closePopup();
      if (onCancel) onCancel();
      else ipcRenderer.sendToHost('caos:escape');
    });
    popup.querySelector('[data-save]').addEventListener('click', () => {
      const note = ta.value.trim();
      if (!note) {
        ta.focus();
        ta.style.borderColor = '#ff6b6b';
        return;
      }
      onSave(note, action);
      closePopup();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) popup.querySelector('[data-save]').click();
      if (e.key === 'Escape') {
        closePopup();
        if (onCancel) onCancel();
        else ipcRenderer.sendToHost('caos:escape');
      }
    });
  }

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
    popupCancel = null;
  }

  // ---- restored annotation pins ---------------------------------------------
  function clearPins() {
    for (const p of pins) {
      try {
        p.badge.remove();
      } catch (_e) {
        /* ignore */
      }
    }
    pins = [];
  }

  function restoreAnnotations(annotations) {
    ensureUI();
    clearPins();
    if (!Array.isArray(annotations)) return;
    annotations.forEach((ann, i) => {
      try {
        const target = ann && ann.target;
        const color = ACTION_COLOR[ann && ann.action] || '#9aa2b1';
        let el = null;
        if (target) el = anchor.resolve(target);
        const badge = document.createElement('div');
        badge.setAttribute('data-caos', '');
        badge.textContent = String(ann && ann.pinNum != null ? ann.pinNum : i + 1);
        badge.title = (ann && ann.action ? ann.action + ': ' : '') + (ann && ann.note ? ann.note : '');
        badge.style.cssText =
          'position:fixed;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
          'font:700 12px sans-serif;color:#fff;background:' +
          color +
          ';border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);cursor:pointer;pointer-events:auto;' +
          'z-index:2147483641;transform:translate(-50%,-50%);';
        badge.addEventListener('click', () => {
          const live = el || (target ? anchor.resolve(target) : null);
          if (live) anchor.highlight(live, { duration: 1200, color });
          else if (target && target.box) anchor.highlight(null, { duration: 1200, color, box: viewportBox(target.box) });
        });
        pinLayer.appendChild(badge);
        pins.push({ el, target, badge, action: ann && ann.action });
      } catch (_e) {
        /* skip bad annotation */
      }
    });
    syncPins();
  }

  // convert a stored (viewport-at-capture) box to current viewport coords.
  // Stored boxes from describe() are viewport coords at capture time; pins are
  // re-anchored to the live element when possible, otherwise we just place at
  // the stored coordinates as a best effort.
  function viewportBox(box) {
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  }

  function pinPosition(pin) {
    let el = pin.el;
    if (!el || !document.documentElement.contains(el)) {
      el = pin.target ? anchor.resolve(pin.target) : null;
      pin.el = el;
    }
    if (el) {
      const r = el.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + 4, visible: r.bottom > 0 && r.top < window.innerHeight };
    }
    if (pin.target && pin.target.box) {
      const b = pin.target.box;
      return { x: b.x + 4, y: b.y + 4, visible: true };
    }
    return null;
  }

  function syncPins() {
    pinSyncQueued = false;
    for (const pin of pins) {
      const pos = pinPosition(pin);
      if (!pos) {
        pin.badge.style.display = 'none';
        continue;
      }
      pin.badge.style.display = pos.visible ? 'flex' : 'none';
      pin.badge.style.left = pos.x + 'px';
      pin.badge.style.top = pos.y + 'px';
    }
    redraw(); // batch the draw-mode stroke repaint into the same rAF frame
    syncArrange(); // keep the rearrange selection glued to its element too
  }

  function queuePinSync() {
    if (pinSyncQueued) return;
    pinSyncQueued = true;
    requestAnimationFrame(syncPins);
  }

  // ---- DOM tree serializer --------------------------------------------------
  function serializeTree(rootEl, maxDepth) {
    function walk(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      const tag = el.nodeName ? el.nodeName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return null;
      if (isOwnUI(el)) return null;
      let text = '';
      try {
        // only own direct text, kept short
        text = Array.prototype.filter
          .call(el.childNodes, (n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(' ')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 60);
      } catch (_e) {
        text = '';
      }
      const node = {
        tag,
        id: el.id || null,
        classes: Array.prototype.slice.call(el.classList || []),
        text,
        selector: anchor.cssPath(el),
        children: [],
      };
      if (depth < maxDepth) {
        for (let i = 0; i < el.children.length; i++) {
          const child = walk(el.children[i], depth + 1);
          if (child) node.children.push(child);
        }
      }
      return node;
    }
    try {
      return walk(rootEl, 0);
    } catch (_e) {
      return null;
    }
  }

  // ---- mode plumbing --------------------------------------------------------
  function setMode(next) {
    ensureUI();
    mode = next;
    closePopup();
    highlight.style.display = tooltip.style.display = 'none';
    const drawOn = next === 'draw';
    canvas.style.display = drawOn ? 'block' : 'none';
    canvas.style.pointerEvents = drawOn ? 'auto' : 'none';
    drawBar.style.display = drawOn ? 'block' : 'none';
    const arrangeOn = next === 'arrange';
    if (arrangeOn) {
      ensureArrangeUI();
      arrangeUI.barEl.style.display = 'flex';
      updateArrangeBar();
    } else {
      arrangeDeselect();
      if (arrangeUI) arrangeUI.barEl.style.display = 'none';
    }
    if (document.body) document.body.style.cursor = next === 'inspect' || next === 'assert' || arrangeOn ? 'crosshair' : '';
  }

  function send(annotation) {
    annotation.url = location.href;
    annotation.title = document.title || location.href;
    annotation.ts = new Date().toISOString();
    ipcRenderer.sendToHost('caos:annotation', annotation);
  }

  // ---- boot -----------------------------------------------------------------
  function boot() {
    ensureUI();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    // Draw-mode dragging is handled by canvas/window listeners bound in
    // ensureUI() — the canvas only accepts pointer events while draw mode is
    // on, so it never needs to compete with these document-level pick handlers.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          // First Escape only cancels an open note popup (its cancel path may
          // keep the current mode alive, e.g. draw mode after a region note).
          // Only with no popup open does Escape exit the mode host-side.
          if (popupCancel) {
            e.stopPropagation();
            popupCancel();
          } else {
            ipcRenderer.sendToHost('caos:escape');
          }
        }
      },
      true
    );
    window.addEventListener('resize', () => {
      sizeCanvas();
      queuePinSync();
    });
    window.addEventListener(
      'scroll',
      () => {
        queuePinSync(); // rAF-batched; syncPins() repaints strokes too
      },
      true
    );
    ipcRenderer.sendToHost('caos:ready', { url: location.href, title: document.title });
  }

  // ---- host message wiring --------------------------------------------------
  ipcRenderer.on('caos:set-mode', (_e, m) => setMode(m));

  ipcRenderer.on('caos:restore-annotations', (_e, annotations) => {
    restoreAnnotations(annotations);
  });

  ipcRenderer.on('caos:clear-overlays', () => {
    clearPins();
    if (highlight) highlight.style.display = 'none';
    if (tooltip) tooltip.style.display = 'none';
    // Remove transient flash overlays from anchor.highlight (direct children of
    // <html> tagged data-caos), without touching our structural UI.
    try {
      Array.prototype.slice.call(document.documentElement.children).forEach((n) => {
        if (
          n !== root &&
          n !== canvas &&
          n !== drawBar &&
          n !== popup &&
          n.hasAttribute &&
          n.hasAttribute('data-caos')
        ) {
          n.remove();
        }
      });
    } catch (_e) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:highlight-target', (_e, target) => {
    let ok = false;
    try {
      const el = anchor.resolve(target);
      if (el) { anchor.highlight(el, { duration: 1400 }); ok = true; }
      else if (target && target.box) { anchor.highlight(null, { duration: 1400, box: target.box }); ok = true; }
    } catch (_err) {
      /* ignore */
    }
    ipcRenderer.sendToHost('caos:highlight-ack', { ok });
  });

  // Re-target the Layers panel to a specific node — used for breadcrumb clicks
  // and drilling into a sibling row, independent of whether Layers mode is on.
  ipcRenderer.on('caos:request-layout', (_e, target) => {
    try {
      let el = target && target.selector ? document.querySelector(target.selector) : null;
      if (!el && target) el = anchor.resolve(target);
      if (el) pickLayout(el);
    } catch (_e) {
      /* ignore */
    }
  });

  // Move a container's child from one index to another (DOM order — this is
  // what actually drives row/column and default paint order for that parent).
  ipcRenderer.on('caos:reorder-sibling', (_e, payload) => {
    try {
      const p = payload || {};
      const parent = p.parentSelector && document.querySelector(p.parentSelector);
      if (!parent) return;
      const kids = Array.prototype.filter.call(parent.children, (c) => c.nodeType === 1 && !isOwnUI(c));
      const from = p.fromIndex,
        to = p.toIndex;
      if (from == null || to == null || from < 0 || from >= kids.length || to < 0 || to >= kids.length || from === to) return;
      const node = kids[from];
      const ref = kids[to > from ? to + 1 : to] || null;
      parent.insertBefore(node, ref);
      // Refocus on whatever was selected before the move (usually — but not
      // always — the moved node itself) using the LIVE reference, not a
      // re-derived selector: reordering can shift nth-of-type-based selectors
      // for every reshuffled sibling, not just the one that moved.
      const targetEl = lastPickedEl && document.documentElement.contains(lastPickedEl) ? lastPickedEl : node;
      pickLayout(targetEl);
    } catch (_e) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:start-recording', () => {
    recorder.start((step) => ipcRenderer.sendToHost('caos:rec-step', step));
  });

  ipcRenderer.on('caos:stop-recording', () => {
    recorder.stop();
  });

  ipcRenderer.on('caos:replay-step', async (_e, payload) => {
    const p = payload || {};
    let r;
    try {
      r = await replay.executeStep(p.step);
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    ipcRenderer.sendToHost('caos:replay-ack', { index: p.index, ok: !!r.ok, error: r.error, actual: r.actual });
  });

  ipcRenderer.on('caos:request-dom-tree', () => {
    const tree = serializeTree(document.body, 6);
    ipcRenderer.sendToHost('caos:dom-tree', tree);
  });

  // Resolve each annotation to a live PAGE-coordinate box for full-page
  // screenshot compositing. Elements are resolved fresh; region boxes are
  // already stored in page coordinates.
  ipcRenderer.on('caos:request-page-boxes', (_e, annotations) => {
    const boxes = (annotations || []).map((a) => {
      try {
        const el = a && a.target ? anchor.resolve(a.target) : null;
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
        }
        if (a && a.target && a.target.box) return a.target.box;
      } catch (_err) {
        /* ignore */
      }
      return null;
    });
    ipcRenderer.sendToHost('caos:page-boxes', boxes);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
