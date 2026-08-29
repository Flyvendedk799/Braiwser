// Braiwser — inspector preload, injected into every page in the <webview>.
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
const elementExport = require('./element-export');
const recorder = require('./recorder');
const replay = require('./replay');
const audit = require('./audit');

(function () {
  'use strict';

  let mode = 'off'; // 'off' | 'inspect' | 'draw' | 'edit' | 'assert' | 'arrange'
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
  let dropZoneEl = null; // outline of the container a drag would land in
  let panelHover = false; // the highlight box is being driven from a side panel
  let composeBubble = null; // the "+" bubble an Inspect click drops on an element
  let composeTarget = null; // …and the element it belongs to

  // ---- edit-mode state ---------------------------------------------------------
  let editSel = null; // the element being styled / typed into
  let editBox = null; // its outline
  let editingText = null; // { el, before } while contenteditable is on
  let styleSession = null; // { el, annId, restore, props } — one note per element
  let redoStack = []; // undone edits, waiting to be re-applied
  let insertLineEl = null; // the "it lands here" bar at the placeholder's edge
  let savedUserSelect = null; // page's own user-select, restored when tools go off
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

  // Trying to change something IS the request to edit it: a double-click in
  // Inspect hands the element to Edit mode with the caret already in its text.
  function onDoubleClick(e) {
    if (mode !== 'inspect' && mode !== 'edit') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnUI(el)) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'inspect') {
      closePopup();
      setMode('edit');
      ipcRenderer.sendToHost('caos:mode-changed', { mode: 'edit' });
    }
    editSelect(el);
    startTextEdit(el, { x: e.clientX, y: e.clientY });
  }

  // ---- inspect mode ---------------------------------------------------------
  function onMove(e) {
    clearPanelHover(); // the pointer is back on the page — drop the panel's outline
    if (mode !== 'inspect' && mode !== 'assert' && mode !== 'arrange' && mode !== 'edit') return;
    if (mode === 'arrange' && arrangeDrag) return; // no hover flicker mid-drag
    if (editingText) return; // typing — do not paint over the text you are editing
    let el = document.elementFromPoint(e.clientX, e.clientY);
    if (mode === 'arrange' && arrangeSel && (el === arrangeSel || arrangeSel.contains(el))) {
      // the selection box already outlines it — skip the hover overlay
      highlight.style.display = tooltip.style.display = 'none';
      return;
    }
    if (!el || isOwnUI(el)) {
      highlight.style.display = tooltip.style.display = 'none';
      hovered = null;
      return;
    }
    // In arrange mode, preview what a press would actually grab — not the
    // inner text node the cursor happens to be over.
    if (mode === 'arrange') el = grabTarget(el);
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
    if (mode !== 'inspect' && mode !== 'assert' && mode !== 'arrange' && mode !== 'edit') return;
    // A click with no point on the page — a keyboard-activated button, or one
    // fired from script — must not pick whatever happens to sit at (0, 0).
    if (!e.detail && !e.clientX && !e.clientY) return;
    if (isOwnUI(e.target)) return; // our own chrome handles its own clicks
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOwnUI(el)) return; // let popup / arrange-bar interactions through
    e.preventDefault();
    e.stopPropagation();
    if (!el) return;
    if (mode === 'arrange') {
      // Normally the pointerdown handler has already selected this (and swallowed
      // the click); this is the fallback for anything that reaches us as a click.
      arrangeSelect(grabTarget(el));
      return;
    }
    if (mode === 'edit') {
      // A second click on the selected text starts typing in it.
      if (el === editSel && isTextEditable(el)) startTextEdit(el, { x: e.clientX, y: e.clientY });
      else editSelect(el);
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
    // Inspect mode: update the panels for this element and drop a comment
    // bubble on its corner. The editor opens when you click the bubble — being
    // thrown a text box every time you point at something is exhausting.
    pickLayout(el);
    showComposeBubble(el);
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
      ...namingHints(el),
    };
  }

  // Everything the panels need to call an element what a person would call it.
  function namingHints(el) {
    const out = { heading: '', label: '', text: '', hidden: false, childCount: 0 };
    try {
      out.label = (el.getAttribute('aria-label') || '').trim().slice(0, 60);
      const hd = el.querySelector('h1,h2,h3,h4,h5,h6');
      if (hd) out.heading = (hd.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      out.text = Array.prototype.filter
        .call(el.childNodes, (n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);
      const cs = getComputedStyle(el);
      out.hidden = cs.display === 'none' || cs.visibility === 'hidden' || el.style.display === 'none';
      out.childCount = elChildren(el).length;
    } catch (_e) {
      /* ignore */
    }
    return out;
  }

  // Deep enough to always reach the top of the document: the Sections panel
  // matches its selection against this chain, and a chain that stops 12 levels
  // down never overlaps the tree on a deeply nested page.
  function ancestorChain(el) {
    const chain = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
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
        ...namingHints(k),
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
        ...namingHints(parent),
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
      pushStyle(el); // the Style panel follows every pick, not just Edit-mode ones
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
      'background:rgba(61,220,151,.07);pointer-events:auto;cursor:grab;z-index:2147483644;touch-action:none;';

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
      'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'align-items:center;gap:6px;background:#11131a;border:1px solid #2a2e3a;border-radius:10px;padding:7px 10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.45);color:#9aa2b1;font:12px sans-serif;pointer-events:none;flex-wrap:wrap;max-width:92vw;';

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
        'color:#cdd6f4;font:600 11px sans-serif;white-space:nowrap;pointer-events:auto;';
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

    mkBtn('parent', '⤴', 'Select the parent container', () => selectParent());
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
    hint.textContent = 'drag anything to move it · click again to go deeper · ⤴ = parent · Alt-drag = free · Esc = cancel';
    hint.style.cssText = 'color:#6b7280;font:11px sans-serif;';
    bar.appendChild(hint);

    box.addEventListener('pointerdown', (e) => startMove(e, true));
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

  // What a press on this element should actually grab: the nearest ancestor
  // that has siblings to reorder among. Pressing the lone <span> inside a card
  // means "move the card" far more often than it means "move the span" — and a
  // lone child has nowhere to go anyway. Click again to step back down.
  function grabTarget(el) {
    let n = el;
    let best = el;
    for (let i = 0; i < 8; i++) {
      const p = n.parentElement;
      if (!p || isOwnUI(n) || n === document.body || n === document.documentElement) break;
      best = n;
      if (elChildren(p).length >= 2) return n;
      n = p;
    }
    return best;
  }

  function selectParent() {
    const p = arrangeSel && arrangeSel.parentElement;
    if (p && !isOwnUI(p) && p !== document.body && p !== document.documentElement) arrangeSelect(p);
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
    cancelDrag(); // a drag in flight owns window listeners and a ghost
    arrangeSel = null;
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
    const ann = {
      id: annId,
      kind: 'edit',
      action: entry.action || 'change',
      note: entry.note,
      target: anchor.describe(el),
      edit: { type: entry.type, css: entry.css || '', details: entry.details || {} },
    };
    // The change is already applied, so "where the element is right now" IS the
    // redo — one generic snapshot covers moves, styles, text and hiding alike.
    const stackEntry = { type: entry.type, annId, undo: entry.undo, redo: entry.redo || restorePoint(el), ann, el };
    editStack.push(stackEntry);
    redoStack = []; // a fresh edit forks the history
    send(ann);
    updateArrangeBar();
    syncArrange();
    pushTree();
    pushStacks();
    return stackEntry;
  }

  // Everything an element needs to be put back exactly as it is at this moment:
  // where it sits, what inline style it carries, and (for a text leaf) its copy.
  function restorePoint(el) {
    const parent = el.parentElement;
    const next = el.nextElementSibling;
    const style = el.getAttribute('style');
    const text = el.children.length === 0 ? el.textContent : null;
    return () => {
      try {
        if (parent && document.documentElement.contains(parent) && (el.parentElement !== parent || el.nextElementSibling !== next)) {
          parent.insertBefore(el, next && next.parentElement === parent ? next : null);
        }
        if (style == null) el.removeAttribute('style');
        else el.setAttribute('style', style);
        if (text != null && el.children.length === 0 && el.textContent !== text) el.textContent = text;
      } catch (_e) {
        /* the element may be gone */
      }
    };
  }

  function pushStacks() {
    ipcRenderer.sendToHost('caos:edit-stacks', { undo: editStack.length, redo: redoStack.length });
  }

  function undoLastEdit() {
    const entry = editStack.pop();
    if (!entry) return;
    if (styleSession && styleSession.annId === entry.annId) endStyleSession();
    try {
      entry.undo();
    } catch (_e) {
      /* element may be gone — nothing to revert */
    }
    redoStack.push(entry);
    ipcRenderer.sendToHost('caos:edit-undo', { id: entry.annId });
    afterHistoryChange();
  }

  function redoLastEdit() {
    const entry = redoStack.pop();
    if (!entry) return;
    try {
      entry.redo();
    } catch (_e) {
      /* element may be gone */
    }
    editStack.push(entry);
    send(entry.ann); // same id: the note comes back exactly as it was
    afterHistoryChange();
  }

  function afterHistoryChange() {
    updateArrangeBar();
    syncArrange();
    syncEditBox();
    pushTree();
    pushStacks();
    if (editSel) pushStyle(editSel);
  }

  // Undo one specific edit (not just the newest) and retract its note.
  function retractEdit(entry) {
    const i = editStack.indexOf(entry);
    if (i < 0) return false;
    editStack.splice(i, 1);
    pushStacks();
    try {
      entry.undo();
    } catch (_e) {
      /* element may be gone */
    }
    ipcRenderer.sendToHost('caos:edit-undo', { id: entry.annId });
    updateArrangeBar();
    syncArrange();
    pushTree();
    return true;
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
  // A reorder drag is WYSIWYG: a scaled ghost of the element rides the cursor,
  // the element itself stays in the flow — dimmed — and hops to the live
  // insertion point as the pointer passes it, and the container it would land
  // in is outlined. Dragging clear of the current parent drops it INTO another
  // container. Escape (or a cancelled pointer) puts everything back.
  const GHOST_MAX_NODES = 200; // deep style-copy budget; bigger subtrees get a flat ghost
  const GHOST_MAX_W = 360;
  const GHOST_MAX_H = 260;
  const EDGE_SCROLL = 64; // px from a viewport edge where auto-scroll starts
  const EDGE_SPEED = 26; // px per frame at the very edge
  const REORDER_STEP = 4; // px of pointer/scroll travel before re-testing the slot
  const REPARENT_MARGIN = 24; // px the pointer must clear the parent by to leave it

  // Tags that are never a sensible drop container.
  const NOT_A_CONTAINER =
    /^(input|textarea|select|option|optgroup|img|picture|svg|canvas|video|audio|iframe|embed|object|br|hr|script|style|link|meta|title)$/;

  // Arrange mode's primary gesture: press ANY element and drag. No pre-select
  // step, and no chance for the press to start a text selection instead.
  function onArrangePointerDown(e) {
    if (mode !== 'arrange' || arrangeDrag) return;
    if (e.button != null && e.button !== 0) return;
    const raw = document.elementFromPoint(e.clientX, e.clientY);
    // Own UI presses belong to the thing pressed — the selection box starts its
    // own drag (and drills down on a click), the bar's buttons want their click.
    if (!raw || isOwnUI(raw)) return;
    const el = grabTarget(raw);
    if (!el || el === document.body || el === document.documentElement) return;
    if (el !== arrangeSel) arrangeSelect(el);
    if (arrangeSel === el) startMove(e, false);
  }

  function startMove(e, fromBox) {
    if (!arrangeSel || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = arrangeSel;
    const parent = el.parentElement;
    const cs = getComputedStyle(el);
    const free = e.altKey || cs.position === 'absolute' || cs.position === 'fixed' || !parent || isOwnUI(parent);
    const surface = arrangeUI.box;
    const r = el.getBoundingClientRect();
    clearTextSelection(); // any leftover blue highlight would smear under the drag
    const d = {
      kind: free ? 'free' : 'reorder',
      fromBox: !!fromBox,
      el,
      parent,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      // Keep the grabbed point under the cursor, ghost scaling included.
      grabDX: e.clientX - r.left,
      grabDY: e.clientY - r.top,
      moved: false,
      startIndex: parent ? indexIn(parent, el) : -1,
      // The selector as the SOURCE still spells it: after the move a structural
      // path would describe the new position, not the code the agent must edit.
      selBefore: anchor.cssPath(el),
      restoreStyle: styleSnapshot(el),
      baseTransform: el.style.transform || '',
      startOpacity: el.style.opacity || '',
      surface,
      ghost: null,
      raf: 0,
      frame: 0,
      lastApply: null,
    };
    // Grabbing feedback for the whole gesture — the captured pointer keeps the
    // surface's cursor, so set it there as well as on the page.
    surface.style.cursor = 'grabbing';
    document.documentElement.style.cursor = 'grabbing';
    arrangeDrag = d;
    // Listen on window (pointer capture is only belt-and-braces): the selection
    // box lags behind the cursor while the element reflows, so element-scoped
    // listeners would drop moves the moment the pointer escapes it.
    const onMoveEv = (ev) => dragMove(ev);
    const onUpEv = (ev) => {
      if (ev.type === 'pointercancel') cancelDrag();
      else dragEnd(ev);
    };
    d.cleanup = () => {
      window.removeEventListener('pointermove', onMoveEv, true);
      window.removeEventListener('pointerup', onUpEv, true);
      window.removeEventListener('pointercancel', onUpEv, true);
    };
    window.addEventListener('pointermove', onMoveEv, true);
    window.addEventListener('pointerup', onUpEv, true);
    window.addEventListener('pointercancel', onUpEv, true);
  }

  function dragMove(e) {
    const d = arrangeDrag;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.moved) {
      if (Math.abs(d.x - d.startX) < DRAG_CLICK_MAX && Math.abs(d.y - d.startY) < DRAG_CLICK_MAX) return;
      d.moved = true;
      d.el.style.opacity = '0.4';
      if (d.kind === 'reorder') {
        d.ghost = makeGhost(d.el);
        startEdgeScroll(d);
      }
    }
    // The ghost is a single transform write, so it tracks the pointer with no
    // throttling. Everything that reads layout (and may reflow the page) is
    // coalesced to one frame — a pointermove stream can outrun the renderer.
    moveGhost(d);
    queueDragFrame(d);
  }

  function queueDragFrame(d) {
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (arrangeDrag === d) applyDrag(d);
    });
  }

  // One frame of the drag: ghost to the cursor, element to its live slot.
  function applyDrag(d) {
    if (d.kind === 'free') {
      d.dx = d.x - d.startX;
      d.dy = d.y - d.startY;
      d.el.style.transform = (d.baseTransform ? d.baseTransform + ' ' : '') + 'translate(' + d.dx + 'px,' + d.dy + 'px)';
      syncArrange();
      return;
    }
    moveGhost(d);
    // Only re-test the slot once the pointer (or the page) has actually moved a
    // little — stops a pixel of jitter from ping-ponging the node.
    const last = d.lastApply;
    const travel = last
      ? Math.abs(d.x - last.x) + Math.abs(d.y - last.y) + Math.abs(window.scrollX - last.sx) + Math.abs(window.scrollY - last.sy)
      : Infinity;
    if (travel >= REORDER_STEP) {
      d.lastApply = { x: d.x, y: d.y, sx: window.scrollX, sy: window.scrollY };
      const drop = dropSlot(d);
      if (drop) {
        showDropZone(drop.parent);
        const sameParent = drop.parent === d.el.parentElement;
        if (!sameParent || (drop.ref !== d.el && drop.ref !== d.el.nextElementSibling)) {
          try {
            drop.parent.insertBefore(d.el, drop.ref === d.el ? d.el.nextElementSibling : drop.ref);
          } catch (_e) {
            /* ignore — e.g. a ref that just left the DOM */
          }
        }
        showInsertLine(d.el, drop.horiz);
      }
    }
    syncArrange();
  }

  function dragEnd(e) {
    const d = arrangeDrag;
    arrangeDrag = null;
    if (!d) return;
    if (d.moved && e) {
      // The pointer may have travelled past the last frame we rendered.
      d.x = e.clientX;
      d.y = e.clientY;
      d.lastApply = null;
      applyDrag(d);
    }
    endDrag(d, e);
    if (!d.moved) {
      // A press on the page already selected what it grabbed; only a click on
      // the selection ITSELF means "go deeper" — and then by exactly one level,
      // so repeated clicks walk down the tree predictably.
      if (!d.fromBox) {
        syncArrange();
        return;
      }
      arrangeUI.box.style.display = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      arrangeUI.box.style.display = 'block';
      if (!under || isOwnUI(under)) {
        syncArrange();
        return;
      }
      let next = under;
      if (arrangeSel && arrangeSel !== under && arrangeSel.contains(under)) {
        while (next.parentElement && next.parentElement !== arrangeSel) next = next.parentElement;
      }
      arrangeSelect(next);
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
        note: 'Reposition `' + d.selBefore + '` by ' + dx + 'px horizontally, ' + dy + 'px vertically (freehand drag).',
        css,
        details: { dx, dy },
        undo: d.restoreStyle,
      });
      return;
    }
    commitReorder(d);
  }

  // Turn a finished reorder drag into an edit annotation — either a reorder
  // among siblings or a move into a different container.
  function commitReorder(d) {
    const el = d.el;
    const origParent = d.parent;
    const parentNow = el.parentElement;
    const startIndex = d.startIndex;
    const endIndex = parentNow ? indexIn(parentNow, el) : -1;
    const reparented = !!parentNow && parentNow !== origParent;
    if (!parentNow || startIndex < 0 || endIndex < 0 || (!reparented && endIndex === startIndex)) {
      syncArrange(); // dropped back where it started — nothing to record
      return;
    }
    const toSel = anchor.cssPath(parentNow);
    const n = elChildren(parentNow).length;
    const undo = () => {
      const kids = elChildren(origParent, el);
      origParent.insertBefore(el, kids[startIndex] || null);
    };
    if (reparented) {
      const fromSel = anchor.cssPath(origParent);
      commitEdit(el, {
        type: 'reparent',
        note:
          'Move `' + d.selBefore + '` out of `' + fromSel + '` and into `' + toSel + '` at position ' +
          (endIndex + 1) + ' of ' + n + '.',
        details: { fromParentSelector: fromSel, parentSelector: toSel, fromIndex: startIndex, toIndex: endIndex },
        undo,
      });
    } else {
      commitEdit(el, {
        type: 'reorder',
        note:
          'Move `' + d.selBefore + '` from position ' + (startIndex + 1) + ' to position ' + (endIndex + 1) +
          ' (of ' + n + ') inside `' + toSel + '`.',
        details: { parentSelector: toSel, fromIndex: startIndex, toIndex: endIndex },
        undo,
      });
    }
    pickLayout(el); // the hierarchy panel is showing the old order otherwise
  }

  // Escape / a stolen pointer: put the page back exactly as it was.
  function cancelDrag() {
    const d = arrangeDrag;
    if (!d) return;
    arrangeDrag = null;
    endDrag(d, null);
    try {
      if (d.moved && d.kind === 'reorder' && d.parent && d.startIndex >= 0) {
        const kids = elChildren(d.parent, d.el);
        d.parent.insertBefore(d.el, kids[d.startIndex] || null);
      }
      d.restoreStyle();
    } catch (_e) {
      /* element may be gone */
    }
    syncArrange();
  }

  // Tear down everything a live drag put on screen.
  function endDrag(d, e) {
    if (d.cleanup) d.cleanup();
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.frame) cancelAnimationFrame(d.frame);
    d.raf = d.frame = 0;
    d.surface.style.cursor = 'grab';
    document.documentElement.style.cursor = '';
    if (d.ghost) {
      try { d.ghost.node.remove(); } catch (_e) { /* ignore */ }
      d.ghost = null;
    }
    hideDropZone();
    d.el.style.opacity = d.startOpacity;
  }

  // ---- drag visuals -----------------------------------------------------------
  function copyComputedStyle(src, dst) {
    const cs = getComputedStyle(src);
    let css = '';
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      css += p + ':' + cs.getPropertyValue(p) + ';';
    }
    dst.style.cssText = css;
  }

  // A floating copy of the element that rides the cursor. Computed styles are
  // baked in because the clone lives outside its stylesheet context (child,
  // descendant and :nth-child rules stop matching once it leaves its parent),
  // and ids are stripped so the live page keeps unique ones while it exists.
  function makeGhost(el) {
    const r = el.getBoundingClientRect();
    let node;
    try {
      node = el.cloneNode(true);
      const src = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
      const dst = [node].concat(Array.prototype.slice.call(node.querySelectorAll('*')));
      const deep = src.length <= GHOST_MAX_NODES && src.length === dst.length;
      for (let i = 0; i < (deep ? src.length : 1); i++) copyComputedStyle(src[i], dst[i]);
      dst.forEach((n) => {
        try {
          n.removeAttribute('id');
          n.removeAttribute('name');
        } catch (_e) {
          /* ignore */
        }
      });
    } catch (_e) {
      node = document.createElement('div');
      node.textContent = arrangeLabel(el);
      node.style.cssText = 'background:#11131a;color:#cdd6f4;font:600 12px sans-serif;padding:6px 10px;border-radius:6px;';
    }
    const scale = Math.max(
      0.25,
      Math.min(1, GHOST_MAX_W / Math.max(1, r.width), GHOST_MAX_H / Math.max(1, r.height))
    );
    node.setAttribute('data-caos', '');
    node.setAttribute('data-caos-arrange', 'ghost');
    const set = (k, v) => node.style.setProperty(k, v, 'important');
    // An inline element ignores width/height — give the ghost a box.
    const disp = getComputedStyle(el).display;
    if (disp === 'inline' || disp === 'contents') set('display', 'inline-block');
    set('position', 'fixed');
    set('left', '0');
    set('top', '0');
    set('right', 'auto');
    set('bottom', 'auto');
    set('float', 'none');
    set('margin', '0');
    set('width', Math.max(1, r.width) + 'px');
    set('height', Math.max(1, r.height) + 'px');
    set('max-width', 'none');
    set('max-height', 'none');
    set('box-sizing', 'border-box');
    set('pointer-events', 'none');
    set('opacity', '.85');
    set('z-index', '2147483643');
    set('transform-origin', 'top left');
    set('transition', 'none');
    set('animation', 'none');
    set('box-shadow', '0 12px 34px rgba(0,0,0,.45)');
    set('outline', '2px solid ' + ARRANGE_COLOR);
    document.documentElement.appendChild(node);
    return { node, scale };
  }

  function moveGhost(d) {
    if (!d.ghost) return;
    const s = d.ghost.scale;
    const x = Math.round(d.x - d.grabDX * s);
    const y = Math.round(d.y - d.grabDY * s);
    d.ghost.node.style.setProperty(
      'transform',
      'translate3d(' + x + 'px,' + y + 'px,0) scale(' + s + ')',
      'important'
    );
  }

  function ensureDropZone() {
    if (dropZoneEl && root && root.contains(dropZoneEl)) return dropZoneEl;
    dropZoneEl = document.createElement('div');
    dropZoneEl.setAttribute('data-caos', '');
    dropZoneEl.setAttribute('data-caos-arrange', 'dropzone');
    dropZoneEl.style.cssText =
      'position:fixed;display:none;pointer-events:none;border:2px solid rgba(61,220,151,.5);border-radius:4px;' +
      'background:rgba(61,220,151,.05);z-index:2147483642;';
    root.appendChild(dropZoneEl);
    return dropZoneEl;
  }

  function showDropZone(parent) {
    if (!parent || !parent.getBoundingClientRect) return;
    const z = ensureDropZone();
    const r = parent.getBoundingClientRect();
    z.style.display = 'block';
    z.style.left = r.left + 'px';
    z.style.top = r.top + 'px';
    z.style.width = Math.max(0, r.width) + 'px';
    z.style.height = Math.max(0, r.height) + 'px';
  }

  function hideDropZone() {
    if (dropZoneEl) dropZoneEl.style.display = 'none';
    if (insertLineEl) insertLineEl.style.display = 'none';
  }

  // A solid bar on the leading edge of the placeholder: the one cue that reads
  // as "it lands HERE" at a glance, whichever way the container flows.
  function ensureInsertLine() {
    if (insertLineEl && root && root.contains(insertLineEl)) return insertLineEl;
    insertLineEl = document.createElement('div');
    insertLineEl.setAttribute('data-caos', '');
    insertLineEl.setAttribute('data-caos-arrange', 'insert-line');
    insertLineEl.style.cssText =
      'position:fixed;display:none;pointer-events:none;border-radius:3px;background:' + ARRANGE_COLOR + ';' +
      'box-shadow:0 0 10px rgba(61,220,151,.8);z-index:2147483644;';
    root.appendChild(insertLineEl);
    return insertLineEl;
  }

  function showInsertLine(el, horiz) {
    const r = el.getBoundingClientRect();
    const L = ensureInsertLine();
    L.style.display = 'block';
    L.style.left = (horiz ? r.left - 5 : r.left) + 'px';
    L.style.top = (horiz ? r.top : r.top - 5) + 'px';
    L.style.width = (horiz ? 4 : Math.max(4, r.width)) + 'px';
    L.style.height = (horiz ? Math.max(4, r.height) : 4) + 'px';
  }

  // ---- where the drag would land -----------------------------------------------
  // The container to drop into, plus the child to insert before. Staying inside
  // the current parent is the common case; clearing its bounds by a margin is
  // what asks for a different container.
  function dropSlot(d) {
    let parent = d.el.parentElement || d.parent;
    if (!parent || isOwnUI(parent)) return null;
    const pr = parent.getBoundingClientRect();
    const out =
      d.x < pr.left - REPARENT_MARGIN ||
      d.x > pr.right + REPARENT_MARGIN ||
      d.y < pr.top - REPARENT_MARGIN ||
      d.y > pr.bottom + REPARENT_MARGIN;
    if (out) {
      const alt = containerUnder(d.el, d.x, d.y);
      if (alt) parent = alt;
    }
    const slot = insertionRef(parent, d.el, d.x, d.y);
    return { parent, ref: slot.ref, horiz: slot.horiz };
  }

  // The deepest element under the pointer that can actually hold children.
  function containerUnder(dragged, x, y) {
    let stack;
    try {
      stack = document.elementsFromPoint(x, y) || [];
    } catch (_e) {
      return null;
    }
    for (const n of stack) {
      if (!n || n.nodeType !== 1) continue;
      if (isOwnUI(n) || n === document.documentElement) continue;
      if (n === dragged || dragged.contains(n)) continue;
      if (NOT_A_CONTAINER.test(n.nodeName.toLowerCase())) continue;
      if (!elChildren(n, dragged).length) continue;
      return n;
    }
    return null;
  }

  // Where would the dragged element land if dropped at (x, y)?
  // Returns { ref, horiz }: the child to insert BEFORE (null = append at the
  // end) and whether that slot's container flows across or down.
  // The flow direction is read off the CHILDREN's geometry, never the
  // container's `display`: a row of inline-blocks in plain block flow is still
  // a row, and a wrapped flex line or a grid needs a per-item answer anyway.
  function insertionRef(parent, el, x, y) {
    const kids = elChildren(parent, el);
    if (!kids.length) return { ref: null, horiz: false };
    const rects = kids.map((k) => k.getBoundingClientRect());
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < kids.length; i++) {
      const dist = rectDistance(rects[i], x, y);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    const r = rects[best];
    const horiz = sharesRow(r, rects[best - 1]) || sharesRow(r, rects[best + 1]);
    const after = horiz ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    return { ref: after ? kids[best].nextElementSibling : kids[best], horiz };
  }

  // Squared distance from a point to a rect — 0 when the point is inside it.
  function rectDistance(r, x, y) {
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    return dx * dx + dy * dy;
  }

  // Do two boxes sit side by side on the same line?
  function sharesRow(a, b) {
    if (!a || !b) return false;
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return overlap > Math.min(a.height, b.height) * 0.5;
  }

  // ---- edge auto-scroll ---------------------------------------------------------
  // Without this you could only ever reorder within one screenful.
  function startEdgeScroll(d) {
    const tick = () => {
      if (arrangeDrag !== d) return;
      d.raf = requestAnimationFrame(tick);
      const vx = edgeVelocity(d.x, window.innerWidth);
      const vy = edgeVelocity(d.y, window.innerHeight);
      if (!vx && !vy) return;
      const sx = window.scrollX;
      const sy = window.scrollY;
      window.scrollBy(vx, vy);
      if (window.scrollX !== sx || window.scrollY !== sy) applyDrag(d);
    };
    d.raf = requestAnimationFrame(tick);
  }

  function edgeVelocity(pos, size) {
    if (pos < EDGE_SCROLL) return -Math.round(EDGE_SPEED * (1 - Math.max(0, pos) / EDGE_SCROLL));
    if (pos > size - EDGE_SCROLL) return Math.round(EDGE_SPEED * (1 - Math.max(0, size - pos) / EDGE_SCROLL));
    return 0;
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

  function smartLayout(kindWanted, containerEl) {
    const container = containerEl || smartTarget();
    if (!container || isOwnUI(container)) return;
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
    if (mode === 'arrange') arrangeSelect(container);
    else pickLayout(container); // keep the panel's view of this container fresh
  }

  // Bring a layer to the front / send it to the back of its siblings. z-index
  // only bites on a positioned element, so a static one gets position:relative
  // — and the note says so, because that is a real change to the source.
  function setZOrder(el, dir) {
    const parent = el.parentElement;
    if (!parent || isOwnUI(el)) return;
    let max = 0;
    let min = 0;
    for (const k of elChildren(parent, el)) {
      const z = parseInt(getComputedStyle(k).zIndex, 10);
      if (isFinite(z)) {
        max = Math.max(max, z);
        min = Math.min(min, z);
      }
    }
    const restore = styleSnapshot(el);
    const cs = getComputedStyle(el);
    const needsPos = cs.position === 'static';
    const z = dir === 'front' ? max + 1 : min - 1;
    if (needsPos) el.style.position = 'relative';
    el.style.zIndex = String(z);
    const css = (needsPos ? 'position: relative; ' : '') + 'z-index: ' + z + ';';
    commitEdit(el, {
      type: 'zorder',
      note:
        (dir === 'front' ? 'Bring ' : 'Send ') + '`' + anchor.cssPath(el) + '` ' +
        (dir === 'front' ? 'to the front' : 'to the back') + ' of its siblings. Apply: ' + css,
      css,
      details: { zIndex: z, direction: dir },
      undo: restore,
    });
    pickLayout(el);
  }

  // ---- note popup -----------------------------------------------------------
  function openElementNote(el, opts) {
    const meta = anchor.describe(el);
    const r = el.getBoundingClientRect();
    showPopup(
      { kind: 'element', target: meta, anchor: r, existing: (opts && opts.existing) || 0 },
      (note, action) => {
        send({ id: uid(), kind: 'element', action, note, target: meta });
        clearComposeBubble(); // the saved note's own bubble takes over
      }
    );
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
  // The tag you picked last is almost always the tag you want next — triaging a
  // page means five "fix" notes in a row, not one of each.
  let lastAction = 'comment';
  const MOD_KEY = navigator.platform.toLowerCase().indexOf('mac') !== -1 ? '⌘' : 'Ctrl';

  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

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
      'padding:14px;box-shadow:0 16px 50px rgba(0,0,0,.55);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#e6e9f0;' +
      // Tool modes lock text selection page-wide; our own note editor is the
      // one place that still needs it.
      'user-select:text;';

    const isEl = ctxObj.kind === 'element';
    const head = isEl
      ? '&lt;' + escHtml(ctxObj.target.tag) + '&gt;' + (ctxObj.target.id ? ' #' + escHtml(ctxObj.target.id) : '')
      : 'Drawn region';
    // The text inside says which button/heading this is far better than the tag.
    const snippet = isEl && ctxObj.target.text ? escHtml(String(ctxObj.target.text).slice(0, 46)) : '';
    const already = ctxObj.existing
      ? '<span style="margin-left:auto;flex:0 0 auto;font:600 11px sans-serif;color:#7f8694">' +
        ctxObj.existing +
        (ctxObj.existing === 1 ? ' note here' : ' notes here') +
        '</span>'
      : '';
    popup.innerHTML =
      '<div style="display:flex;align-items:baseline;gap:7px;margin-bottom:9px;min-width:0">' +
      '<span style="font:600 12px ui-monospace,monospace;color:#9aa2b1;flex:0 0 auto">' + head + '</span>' +
      (snippet
        ? '<span style="font:12px sans-serif;color:#5f6673;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">“' + snippet + '”</span>'
        : '') +
      already +
      '</div>' +
      '<div data-chips style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>' +
      '<textarea placeholder="Describe the change… e.g. \'remove this banner\'" style="width:100%;box-sizing:border-box;min-height:74px;resize:vertical;background:#0c0e14;border:1px solid #2a2e3a;border-radius:8px;color:#e6e9f0;padding:9px;font:13px/1.45 sans-serif;outline:none"></textarea>' +
      '<div data-hint style="margin-top:8px;font:11px sans-serif;color:#5f6673">' + MOD_KEY + '↵ to save · Esc to cancel</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">' +
      '<button data-cancel style="cursor:pointer;border:0;border-radius:8px;padding:7px 13px;background:#22262f;color:#cdd6f4;font:600 12px sans-serif">Cancel</button>' +
      '<button data-save style="cursor:pointer;border:0;border-radius:8px;padding:7px 13px;background:#5b8cff;color:#fff;font:600 12px sans-serif">Save note</button>' +
      '</div>';

    let action = ACTIONS.some((a) => a.id === lastAction) ? lastAction : 'comment';
    const chips = popup.querySelector('[data-chips]');
    const chipStyle = (b, a, on) => {
      if (on) b.setAttribute('data-on', '1');
      else b.removeAttribute('data-on');
      b.style.cssText =
        'cursor:pointer;border:1px solid ' + a.color + (on ? 'cc' : '44') + ';border-radius:999px;' +
        'padding:4px 10px;background:' + (on ? a.color + '2e' : 'transparent') + ';color:' + a.color + ';' +
        'font:' + (on ? '700' : '600') + ' 11px sans-serif;box-shadow:' + (on ? '0 0 0 1px ' + a.color + '33' : 'none');
    };
    ACTIONS.forEach((a) => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.title = a.label + ' note';
      chipStyle(b, a, a.id === action);
      b.addEventListener('click', () => {
        action = a.id;
        lastAction = a.id;
        ACTIONS.forEach((other, i) => chipStyle(chips.children[i], other, other.id === action));
      });
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
    });
    const hint = popup.querySelector('[data-hint]');
    popup.querySelector('[data-save]').addEventListener('click', () => {
      const note = ta.value.trim();
      if (!note) {
        // Say what is missing instead of just turning the box red.
        ta.focus();
        ta.style.borderColor = '#ff6b6b';
        hint.textContent = 'Describe the change first — a tag on its own is not a request.';
        hint.style.color = '#ff8f8f';
        return;
      }
      onSave(note, action);
      closePopup();
    });
    ta.addEventListener('input', () => {
      if (ta.style.borderColor === 'rgb(255, 107, 107)' && ta.value.trim()) {
        ta.style.borderColor = '#2a2e3a';
        hint.textContent = MOD_KEY + '↵ to save · Esc to cancel';
        hint.style.color = '#5f6673';
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) popup.querySelector('[data-save]').click();
      if (e.key === 'Escape') {
        closePopup();
        if (onCancel) onCancel();
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

  // ---- comment bubbles --------------------------------------------------------
  // One bubble per annotated element, parked on its top-right corner: it carries
  // the number of notes on that element and stays put whether or not the element
  // is selected. Clicking a bubble opens the note editor for that element.
  //
  // Clicking an element in Inspect does NOT throw the editor at you — it drops a
  // fresh bubble on the corner, and you open it when you are ready to write.
  const BUBBLE_TAIL = 'border-radius:11px 11px 11px 2px;';

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

  // A bubble is a marker, not a control, once you are rearranging: one parked
  // over an element used to swallow the press that was aimed at the element,
  // which reads as "the drag just doesn't work here".
  function syncPinInteractivity() {
    const clickable = mode !== 'arrange';
    for (const p of pins) {
      try {
        p.badge.style.pointerEvents = clickable ? 'auto' : 'none';
      } catch (_e) {
        /* ignore */
      }
    }
    if (composeBubble) composeBubble.style.pointerEvents = clickable ? 'auto' : 'none';
  }

  function makeBubble(text, color, title) {
    const b = document.createElement('div');
    b.setAttribute('data-caos', '');
    b.setAttribute('data-caos-bubble', '');
    b.textContent = text;
    if (title) b.title = title;
    b.style.cssText =
      'position:fixed;min-width:22px;height:22px;padding:0 6px;' +
      BUBBLE_TAIL +
      'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
      'font:700 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff;background:' +
      color +
      ';border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);cursor:pointer;pointer-events:auto;' +
      'z-index:2147483641;transform:translate(-40%,-55%);transition:transform .1s ease-out;';
    b.addEventListener('mouseenter', () => {
      b.style.transform = 'translate(-40%,-55%) scale(1.12)';
    });
    b.addEventListener('mouseleave', () => {
      b.style.transform = 'translate(-40%,-55%)';
    });
    return b;
  }

  // Group the session's notes by the thing they are attached to, so an element
  // with four notes wears one bubble that says 4 — not four overlapping pins.
  function groupAnnotations(annotations) {
    const groups = [];
    const byKey = new Map();
    for (const ann of annotations) {
      const target = ann && ann.target;
      let el = null;
      if (target && !isRegionTarget(target)) el = anchor.resolve(target);
      const key = el || 'region:' + JSON.stringify((target && target.box) || {});
      let g = byKey.get(key);
      if (!g) {
        g = { el, target, anns: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      g.anns.push(ann);
    }
    return groups;
  }

  function restoreAnnotations(annotations) {
    ensureUI();
    clearPins();
    if (!Array.isArray(annotations)) return;
    for (const g of groupAnnotations(annotations)) {
      try {
        const first = g.anns[0];
        const color = ACTION_COLOR[first && first.action] || '#9aa2b1';
        const title = g.anns
          .map((a) => (a.action ? a.action + ': ' : '') + (a.note || ''))
          .join('\n');
        const badge = makeBubble(String(g.anns.length), color, title);
        badge.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isRegionTarget(g.target)) {
            anchor.highlight(null, { duration: 1200, color, box: viewportBox(g.target) });
            return;
          }
          const live = g.el && document.documentElement.contains(g.el) ? g.el : anchor.resolve(g.target);
          if (!live) return;
          anchor.highlight(live, { duration: 700, color });
          openElementNote(live, { existing: g.anns.length });
        });
        pinLayer.appendChild(badge);
        pins.push({ el: g.el, target: g.target, badge, action: first && first.action, count: g.anns.length });
      } catch (_e) {
        /* skip a bad annotation */
      }
    }
    // A fresh bubble is only needed while the element has nothing on it yet.
    if (composeTarget && pins.some((p) => p.el === composeTarget)) clearComposeBubble();
    syncPinInteractivity();
    syncPins();
  }

  // ---- the bubble you get from an Inspect click ---------------------------------
  function clearComposeBubble() {
    if (composeBubble) {
      try {
        composeBubble.remove();
      } catch (_e) {
        /* ignore */
      }
    }
    composeBubble = null;
    composeTarget = null;
  }

  function showComposeBubble(el) {
    if (!el || isOwnUI(el)) return;
    // Already wearing a bubble? Draw attention to it instead of stacking another.
    const existing = pins.find((p) => p.el === el);
    if (existing) {
      clearComposeBubble();
      pulse(existing.badge);
      return;
    }
    if (composeTarget === el) {
      pulse(composeBubble);
      return;
    }
    clearComposeBubble();
    composeTarget = el;
    composeBubble = makeBubble('+', '#5b8cff', 'Write a note about this element');
    composeBubble.setAttribute('data-caos-bubble', 'new');
    composeBubble.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openElementNote(el);
    });
    pinLayer.appendChild(composeBubble);
    syncPinInteractivity();
    syncPins();
    pulse(composeBubble);
  }

  function pulse(node) {
    if (!node) return;
    node.style.transform = 'translate(-40%,-55%) scale(1.35)';
    setTimeout(() => {
      try {
        node.style.transform = 'translate(-40%,-55%)';
      } catch (_e) {
        /* ignore */
      }
    }, 190);
  }

  // A drawn region carries nothing but a box — no selector, no tag (see
  // openRegionNote). It must never be re-resolved to an element: the mark is
  // the target, and elementFromPoint would shrink it to whatever child node
  // happens to sit under its centre.
  function isRegionTarget(t) {
    return !!(t && t.box && !t.selector && !t.tag);
  }

  // Convert a stored box to current viewport coords. Region boxes are PAGE
  // coords (strokes are captured as clientX + scrollX), so they have to be
  // un-scrolled; an element's box is viewport coords at capture time and is
  // only ever a best-effort fallback for when the element can't be re-resolved.
  function viewportBox(target) {
    const b = (target && target.box) || { x: 0, y: 0, w: 0, h: 0 };
    if (!isRegionTarget(target)) return { x: b.x, y: b.y, w: b.w, h: b.h };
    return { x: b.x - window.scrollX, y: b.y - window.scrollY, w: b.w, h: b.h };
  }

  // Bring an off-screen region into view before flashing it. Instant, not
  // smooth: the flash is position:fixed, so it would be left behind mid-scroll.
  function scrollRegionIntoView(target) {
    const b = viewportBox(target);
    const offY = b.y + b.h <= 0 || b.y >= window.innerHeight;
    const offX = b.x + b.w <= 0 || b.x >= window.innerWidth;
    if (!offY && !offX) return;
    const y = offY ? Math.max(0, b.y + window.scrollY - Math.round(window.innerHeight / 3)) : window.scrollY;
    const x = offX ? Math.max(0, b.x + window.scrollX - Math.round(window.innerWidth / 3)) : window.scrollX;
    try { window.scrollTo(x, y); } catch (_e) { /* ignore */ }
  }

  // Top-right corner, slightly outside the box — the spot every commenting tool
  // uses, and the one least likely to cover the thing you are talking about.
  function cornerOf(r) {
    return { x: r.right - 2, y: r.top + 2, visible: r.bottom > 0 && r.top < window.innerHeight };
  }

  function pinPosition(pin) {
    if (isRegionTarget(pin.target)) {
      const b = viewportBox(pin.target);
      return cornerOf({ right: b.x + b.w, top: b.y, bottom: b.y + b.h });
    }
    let el = pin.el;
    if (!el || !document.documentElement.contains(el)) {
      el = pin.target ? anchor.resolve(pin.target) : null;
      pin.el = el;
    }
    if (el) return cornerOf(el.getBoundingClientRect());
    if (pin.target && pin.target.box) {
      const b = pin.target.box;
      return cornerOf({ right: b.x + b.w, top: b.y, bottom: b.y + b.h });
    }
    return null;
  }

  function syncPins() {
    pinSyncQueued = false;
    if (composeBubble) {
      if (composeTarget && document.documentElement.contains(composeTarget)) {
        const pos = cornerOf(composeTarget.getBoundingClientRect());
        composeBubble.style.display = pos.visible ? 'flex' : 'none';
        composeBubble.style.left = pos.x + 'px';
        composeBubble.style.top = pos.y + 'px';
      } else {
        clearComposeBubble();
      }
    }
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
    syncEditBox(); // …and the edit selection
  }

  function queuePinSync() {
    if (pinSyncQueued) return;
    pinSyncQueued = true;
    requestAnimationFrame(syncPins);
  }

  // ---- DOM tree serializer --------------------------------------------------
  const TREE_MAX_DEPTH = 12; // deep enough to reach what people actually click
  const TREE_MAX_NODES = 2500; // …without shipping a 40k-node page over IPC

  function serializeTree(rootEl, maxDepth) {
    let budget = TREE_MAX_NODES;
    function walk(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      const tag = el.nodeName ? el.nodeName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return null;
      if (isOwnUI(el)) return null;
      const node = {
        tag,
        id: el.id || null,
        classes: Array.prototype.slice.call(el.classList || []),
        selector: anchor.cssPath(el),
        // heading / label / text / hidden / childCount — everything the panels
        // need to call this row "Hero" instead of "div.x7".
        ...namingHints(el),
        children: [],
      };
      if (depth < maxDepth && budget > 0) {
        for (let i = 0; i < el.children.length; i++) {
          if (budget <= 0) {
            node.truncated = true;
            break;
          }
          budget--;
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

  // ---- edit mode --------------------------------------------------------------
  // The visual editor: click any element to select it, type straight into its
  // text, and drive type / colour / spacing / size from the Style panel. Every
  // change is an inline style (or a text change) on the live page AND an edit
  // note carrying the exact CSS, so it exports to an agent like everything else.
  const EDIT_COLOR = '#c792ea';
  const INLINE_TAGS = /^(a|b|i|em|strong|span|small|u|s|code|mark|sup|sub|br|abbr|time|label)$/;
  const NOT_TEXT = /^(input|textarea|select|option|img|picture|svg|canvas|video|audio|iframe|embed|object|br|hr|table|thead|tbody|tr|ul|ol)$/;

  function ensureEditUI() {
    if (editBox && root && root.contains(editBox)) return editBox;
    editBox = document.createElement('div');
    editBox.setAttribute('data-caos', '');
    editBox.setAttribute('data-caos-edit', 'box');
    editBox.style.cssText =
      'position:fixed;display:none;pointer-events:none;border:2px solid ' + EDIT_COLOR + ';border-radius:3px;' +
      'box-shadow:0 0 0 1px rgba(199,146,234,.25);z-index:2147483644;';
    root.appendChild(editBox);
    return editBox;
  }

  function syncEditBox() {
    if (!editSel || mode !== 'edit') {
      if (editBox) editBox.style.display = 'none';
      return;
    }
    if (!document.documentElement.contains(editSel)) {
      editSel = null;
      if (editBox) editBox.style.display = 'none';
      return;
    }
    const b = ensureEditUI();
    const r = editSel.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left - 1 + 'px';
    b.style.top = r.top - 1 + 'px';
    b.style.width = Math.max(0, r.width) + 'px';
    b.style.height = Math.max(0, r.height) + 'px';
  }

  // Text you can actually type into: it owns its words, and no block-level
  // child would be destroyed by editing them.
  function isTextEditable(el) {
    if (!el || el.nodeType !== 1 || isOwnUI(el)) return false;
    const tag = el.nodeName.toLowerCase();
    if (NOT_TEXT.test(tag)) return false;
    if (!(el.textContent || '').trim()) return false;
    return Array.prototype.every.call(el.children, (c) => INLINE_TAGS.test(c.nodeName.toLowerCase()));
  }

  function editSelect(el, opts) {
    if (!el || el.nodeType !== 1 || isOwnUI(el)) return;
    if (el === document.documentElement) return;
    if (editSel !== el) endStyleSession(); // one note per element you work on
    finishTextEdit();
    editSel = el;
    syncEditBox();
    pushStyle(el);
    if (opts && opts.text) startTextEdit(el);
  }

  function editDeselect() {
    finishTextEdit();
    endStyleSession();
    editSel = null;
    if (editBox) editBox.style.display = 'none';
  }

  // ---- typing straight into the page -------------------------------------------
  function startTextEdit(el, point) {
    if (!isTextEditable(el)) return false;
    finishTextEdit();
    editingText = { el, before: el.textContent };
    try {
      el.setAttribute('contenteditable', 'plaintext-only');
      el.style.setProperty('outline', '2px solid ' + EDIT_COLOR);
      el.style.setProperty('outline-offset', '1px');
      el.style.setProperty('user-select', 'text'); // the page-wide lock stops here
      el.focus();
      // Put the caret where the pointer was, not at the start of the line.
      if (point && document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(point.x, point.y);
        if (range) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch (_e) {
      /* ignore */
    }
    el.addEventListener('blur', finishTextEdit);
    el.addEventListener('keydown', onTextKey, true);
    ipcRenderer.sendToHost('caos:text-editing', { editing: true, selector: anchor.cssPath(el) });
    return true;
  }

  function onTextKey(e) {
    if (!editingText) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      const { el, before } = editingText;
      editingText = null;
      cleanupTextEdit(el);
      el.textContent = before;
      pushStyle(el);
      return;
    }
    // Single-line-ish elements finish on Enter; a paragraph keeps its newlines.
    const multiline = /^(p|div|section|article|li|blockquote|pre|td)$/.test(editingText.el.nodeName.toLowerCase());
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      finishTextEdit();
    }
  }

  function cleanupTextEdit(el) {
    try {
      el.removeAttribute('contenteditable');
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('user-select');
      if (!el.getAttribute('style')) el.removeAttribute('style');
      el.removeEventListener('blur', finishTextEdit);
      el.removeEventListener('keydown', onTextKey, true);
    } catch (_e) {
      /* ignore */
    }
    ipcRenderer.sendToHost('caos:text-editing', { editing: false });
  }

  function finishTextEdit() {
    const t = editingText;
    if (!t) return;
    editingText = null;
    const el = t.el;
    const after = el.textContent;
    cleanupTextEdit(el);
    if (after === t.before) return;
    const before = t.before;
    commitEdit(el, {
      type: 'text',
      action: 'change',
      note:
        'Change the copy of `' + anchor.cssPath(el) + '` from “' + trim60(before) + '” to “' + trim60(after) + '”.',
      details: { before: before, after: after },
      undo: () => {
        el.textContent = before;
      },
    });
    pushStyle(el);
  }

  function trim60(v) {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  // ---- style edits ---------------------------------------------------------------
  // One note per element per visit: changing five properties on a heading is one
  // request ("restyle the heading"), not five.
  function startStyleSession(el) {
    styleSession = { el, annId: null, restore: styleSnapshot(el), props: {} };
  }

  function endStyleSession() {
    styleSession = null;
  }

  function applyStyle(el, props, commit) {
    if (!el || isOwnUI(el)) return;
    if (!styleSession || styleSession.el !== el) {
      finishTextEdit();
      startStyleSession(el);
    }
    for (const prop in props) {
      const value = props[prop];
      if (value == null || value === '') {
        el.style.removeProperty(prop);
        delete styleSession.props[prop];
      } else {
        el.style.setProperty(prop, value);
        styleSession.props[prop] = value;
      }
    }
    if (commit) commitStyleSession();
    syncEditBox();
    syncArrange();
    pushStyle(el);
  }

  function commitStyleSession() {
    const s = styleSession;
    if (!s || !Object.keys(s.props).length) return;
    const css = Object.keys(s.props)
      .map((k) => k + ': ' + s.props[k] + ';')
      .join(' ');
    const note = 'Restyle `' + anchor.cssPath(s.el) + '` — apply: ' + css;
    const details = { props: JSON.parse(JSON.stringify(s.props)) };
    if (!s.annId) {
      const entry = commitEdit(s.el, {
        type: 'style',
        note,
        css,
        details,
        undo: s.restore,
      });
      s.annId = entry && entry.annId;
      return;
    }
    // Same element, same visit — grow the note instead of filing another one.
    const entry = editStack.filter((x) => x.annId === s.annId)[0];
    if (entry) {
      entry.ann.note = note;
      entry.ann.edit = { type: 'style', css, details };
      entry.redo = restorePoint(s.el);
    }
    ipcRenderer.sendToHost('caos:annotation-update', {
      id: s.annId,
      patch: { note, edit: { type: 'style', css, details } },
    });
  }

  // What the Style panel renders: what the element is now, plus the handful of
  // font stacks the page itself uses.
  function pushStyle(el) {
    try {
      if (!el || !document.documentElement.contains(el)) {
        ipcRenderer.sendToHost('caos:style-picked', null);
        return;
      }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const inline = {};
      for (let i = 0; i < el.style.length; i++) inline[el.style[i]] = el.style.getPropertyValue(el.style[i]);
      ipcRenderer.sendToHost('caos:style-picked', {
        selector: anchor.cssPath(el),
        brief: nodeBrief(el),
        editableText: isTextEditable(el),
        text: isTextEditable(el) ? el.textContent : '',
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        inline,
        pageFonts: pageFonts(),
        pageColors: pageColors(),
        computed: {
          'font-family': cs.fontFamily,
          'font-size': cs.fontSize,
          'font-weight': cs.fontWeight,
          'font-style': cs.fontStyle,
          'line-height': cs.lineHeight,
          'letter-spacing': cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing,
          'text-align': cs.textAlign,
          'text-transform': cs.textTransform,
          'text-decoration-line': cs.textDecorationLine,
          color: cs.color,
          'background-color': cs.backgroundColor,
          opacity: cs.opacity,
          'border-radius': cs.borderTopLeftRadius,
          'border-width': cs.borderTopWidth,
          'border-color': cs.borderTopColor,
          'border-style': cs.borderTopStyle,
          'padding-top': cs.paddingTop,
          'padding-right': cs.paddingRight,
          'padding-bottom': cs.paddingBottom,
          'padding-left': cs.paddingLeft,
          'margin-top': cs.marginTop,
          'margin-right': cs.marginRight,
          'margin-bottom': cs.marginBottom,
          'margin-left': cs.marginLeft,
          width: cs.width,
          height: cs.height,
          display: cs.display,
        },
      });
    } catch (_e) {
      /* ignore */
    }
  }

  let _colorsCache = null;
  function pageColors() {
    if (_colorsCache) return _colorsCache;
    const counts = {};
    try {
      const all = document.querySelectorAll('body *');
      const step = Math.max(1, Math.floor(all.length / 400));
      for (let i = 0; i < all.length; i += step) {
        const el = all[i];
        if (isOwnUI(el)) continue;
        const cs = getComputedStyle(el);
        for (const v of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
          const h = rgbToHex(v);
          if (h) counts[h] = (counts[h] || 0) + 1;
        }
      }
    } catch (_e) {
      /* ignore */
    }
    _colorsCache = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, 10);
    return _colorsCache;
  }

  function rgbToHex(v) {
    const m = /rgba?\(([^)]+)\)/i.exec(String(v || ''));
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length < 3 || p.some(isNaN)) return null;
    if (p.length > 3 && p[3] < 0.1) return null; // effectively transparent
    return (
      '#' +
      p
        .slice(0, 3)
        .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
        .join('')
    );
  }

  let _fontsCache = null;
  function pageFonts() {
    if (_fontsCache) return _fontsCache;
    const seen = [];
    try {
      const all = document.querySelectorAll('body *');
      const step = Math.max(1, Math.floor(all.length / 300));
      for (let i = 0; i < all.length; i += step) {
        const el = all[i];
        if (isOwnUI(el)) continue;
        const f = getComputedStyle(el).fontFamily;
        if (f && seen.indexOf(f) === -1) seen.push(f);
        if (seen.length >= 8) break;
      }
    } catch (_e) {
      /* ignore */
    }
    _fontsCache = seen;
    return seen;
  }

  // ---- mode plumbing --------------------------------------------------------
  function setMode(next) {
    ensureUI();
    if (next === mode) return; // re-entering a mode must not drop the selection
    if (mode === 'edit' && next !== 'edit') editDeselect();
    mode = next;
    closePopup();
    highlight.style.display = tooltip.style.display = 'none';
    const drawOn = next === 'draw';
    canvas.style.display = drawOn ? 'block' : 'none';
    canvas.style.pointerEvents = drawOn ? 'auto' : 'none';
    drawBar.style.display = drawOn ? 'block' : 'none';
    const arrangeOn = next === 'arrange';
    syncPinInteractivity();
    if (arrangeOn) {
      ensureArrangeUI();
      arrangeUI.barEl.style.display = 'flex';
      updateArrangeBar();
    } else {
      arrangeDeselect();
      if (arrangeUI) arrangeUI.barEl.style.display = 'none';
    }
    if (next !== 'inspect') clearComposeBubble();
    const editOn = next === 'edit';
    if (!editOn) {
      editDeselect();
    } else {
      ensureEditUI();
      syncEditBox();
    }
    if (document.body) document.body.style.cursor = arrangeOn ? 'grab' : next === 'inspect' || next === 'assert' ? 'crosshair' : editOn ? 'default' : '';
    // Every tool mode is a pointer tool: a press is a pick or a grab, never the
    // start of a text selection. Leaving the page selectable made drags smear a
    // blue highlight across everything they crossed.
    const toolOn = next !== 'off';
    if (toolOn && savedUserSelect == null) savedUserSelect = document.documentElement.style.userSelect || '';
    document.documentElement.style.userSelect = toolOn ? 'none' : savedUserSelect || '';
    if (!toolOn) savedUserSelect = null;
    if (toolOn) clearTextSelection();
  }

  // A panel hover owns the highlight box until the pointer comes back to the
  // page (or the panel says so), since nothing else would take it down.
  function clearPanelHover() {
    if (!panelHover) return;
    panelHover = false;
    if (highlight) highlight.style.display = 'none';
    if (tooltip) tooltip.style.display = 'none';
  }

  function clearTextSelection() {
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    } catch (_e) {
      /* ignore */
    }
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
    document.addEventListener('dblclick', onDoubleClick, true);
    document.addEventListener('pointerdown', onArrangePointerDown, true);
    // Belt and braces on top of the user-select lock: pages that force
    // user-select:text on their own content would still start a selection
    // under a drag. Our own note editor is the one place selection is allowed.
    document.addEventListener(
      'selectstart',
      (e) => {
        if (mode === 'off') return;
        const t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
        // …except the text you are actually typing into.
        if (editingText && editingText.el && (t === editingText.el || editingText.el.contains(t))) return;
        if (!isOwnUI(t)) e.preventDefault();
      },
      true
    );
    // Images and links start a NATIVE html5 drag on mousedown, which eats the
    // pointer stream our own drag runs on. Not while a tool mode is on.
    document.addEventListener('dragstart', (e) => { if (mode !== 'off') e.preventDefault(); }, true);
    // Draw-mode dragging is handled by canvas/window listeners bound in
    // ensureUI() — the canvas only accepts pointer events while draw mode is
    // on, so it never needs to compete with these document-level pick handlers.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          // A live rearrange drag is the first thing Escape gets to abort —
          // otherwise leaving arrange mode would strand a half-finished,
          // unrecorded DOM move on the page.
          if (arrangeDrag) {
            e.stopPropagation();
            e.preventDefault();
            cancelDrag();
            return;
          }
          // Then an open note popup (its cancel path may
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

  ipcRenderer.on('caos:hover-target', (_e, payload) => {
    try {
      ensureUI();
      const el = payload && payload.selector && document.querySelector(payload.selector);
      if (!el || isOwnUI(el)) return;
      const r = el.getBoundingClientRect();
      panelHover = true;
      highlight.style.display = 'block';
      highlight.style.left = r.left + 'px';
      highlight.style.top = r.top + 'px';
      highlight.style.width = r.width + 'px';
      highlight.style.height = r.height + 'px';
      tooltip.style.display = 'block';
      tooltip.textContent = label(el);
      tooltip.style.left = Math.max(4, r.left) + 'px';
      tooltip.style.top = (r.top > 28 ? r.top - 26 : r.bottom + 6) + 'px';
    } catch (_err) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:hover-clear', () => clearPanelHover());

  // Re-layout a container straight from the Layers panel — same smart layout the
  // arrange bar applies, same edit note.
  ipcRenderer.on('caos:smart-layout', (_e, payload) => {
    try {
      const el = payload && payload.selector && document.querySelector(payload.selector);
      if (el && payload.kind) smartLayout(payload.kind, el);
    } catch (_err) {
      /* ignore */
    }
  });

  // Stacking order for overlapping layers.
  ipcRenderer.on('caos:set-z-order', (_e, payload) => {
    try {
      const el = payload && payload.selector && document.querySelector(payload.selector);
      if (el && payload.dir) setZOrder(el, payload.dir);
    } catch (_err) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:highlight-target', (_e, target) => {
    let ok = false;
    try {
      if (isRegionTarget(target)) {
        // Flash the marked area itself. (This only ever looked right while draw
        // mode was on, because its canvas swallowed the elementFromPoint hit.)
        scrollRegionIntoView(target);
        anchor.highlight(null, { duration: 1400, box: viewportBox(target) });
        ipcRenderer.sendToHost('caos:highlight-ack', { ok: true });
        return;
      }
      const el = anchor.resolve(target);
      if (el) {
        // Same courtesy the region path gets: a flash you cannot see is not a
        // located element. Instant, since the flash is position:fixed.
        try {
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= window.innerHeight) {
            window.scrollTo(window.scrollX, Math.max(0, r.top + window.scrollY - Math.round(window.innerHeight / 3)));
          }
        } catch (_e2) {
          /* ignore */
        }
        anchor.highlight(el, { duration: 1400 });
        ok = true;
      }
      else if (target && target.box) { anchor.highlight(null, { duration: 1400, box: viewportBox(target) }); ok = true; }
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
      if (el) {
        clearPanelHover();
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= window.innerHeight) {
          window.scrollTo(window.scrollX, Math.max(0, r.top + window.scrollY - Math.round(window.innerHeight / 3)));
        }
        pickLayout(el);
      }
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
      const selBefore = anchor.cssPath(node);
      parent.insertBefore(node, ref);
      commitEdit(node, {
        type: 'reorder',
        note:
          'Move `' + selBefore + '` from position ' + (from + 1) + ' to position ' + (to + 1) +
          ' (of ' + kids.length + ') inside `' + (p.parentSelector || anchor.cssPath(parent)) + '`.',
        details: { parentSelector: p.parentSelector || anchor.cssPath(parent), fromIndex: from, toIndex: to },
        undo: () => {
          const k2 = elChildren(parent, node);
          parent.insertBefore(node, k2[from] || null);
        },
      });
      pushTree();
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

  // A Sections drag that crossed into another container.
  ipcRenderer.on('caos:move-into', (_e, payload) => {
    try {
      const p = payload || {};
      const el = p.selector && document.querySelector(p.selector);
      const parent = p.parentSelector && document.querySelector(p.parentSelector);
      if (!el || !parent || isOwnUI(el) || isOwnUI(parent) || el === parent || el.contains(parent)) return;
      const origParent = el.parentElement;
      if (!origParent) return;
      const startIndex = indexIn(origParent, el);
      const selBefore = anchor.cssPath(el);
      const fromSel = anchor.cssPath(origParent);
      const kids = elChildren(parent, el);
      parent.insertBefore(el, kids[p.index] || null);
      const endIndex = indexIn(parent, el);
      if (parent === origParent) {
        if (endIndex === startIndex) return;
        commitEdit(el, {
          type: 'reorder',
          note:
            'Move `' + selBefore + '` from position ' + (startIndex + 1) + ' to position ' + (endIndex + 1) +
            ' inside `' + fromSel + '`.',
          details: { parentSelector: fromSel, fromIndex: startIndex, toIndex: endIndex },
          undo: () => {
            const k2 = elChildren(origParent, el);
            origParent.insertBefore(el, k2[startIndex] || null);
          },
        });
      } else {
        const toSel = anchor.cssPath(parent);
        commitEdit(el, {
          type: 'reparent',
          note:
            'Move `' + selBefore + '` out of `' + fromSel + '` and into `' + toSel + '` at position ' +
            (endIndex + 1) + ' of ' + elChildren(parent).length + '.',
          details: { fromParentSelector: fromSel, parentSelector: toSel, fromIndex: startIndex, toIndex: endIndex },
          undo: () => {
            const k2 = elChildren(origParent, el);
            origParent.insertBefore(el, k2[startIndex] || null);
          },
        });
      }
      pickLayout(el);
    } catch (_err) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:undo-edit', () => undoLastEdit());
  ipcRenderer.on('caos:redo-edit', () => redoLastEdit());
  ipcRenderer.on('caos:request-stacks', () => pushStacks());

  ipcRenderer.on('caos:edit-select', (_e, payload) => {
    try {
      const el = payload && payload.selector && document.querySelector(payload.selector);
      if (el) editSelect(el, { text: !!(payload && payload.text) });
    } catch (_err) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:edit-select-parent', () => {
    try {
      const p = editSel && editSel.parentElement;
      if (p && !isOwnUI(p) && p !== document.documentElement) editSelect(p);
    } catch (_err) {
      /* ignore */
    }
  });

  // Lift the selected element off the page: markup, the CSS that applies to it,
  // and the assets it needs. The host turns that into a file or a zip.
  ipcRenderer.on('caos:collect-element', (_e, payload) => {
    let bundle = null;
    try {
      const p = payload || {};
      const el = p.selector ? document.querySelector(p.selector) : editSel || lastPickedEl;
      if (el && !isOwnUI(el)) bundle = elementExport.collect(el, { selector: p.selector || anchor.cssPath(el) });
    } catch (err) {
      bundle = null;
    }
    ipcRenderer.sendToHost('caos:element-collected', bundle);
  });

  ipcRenderer.on('caos:request-style', (_e, payload) => {
    try {
      const el = payload && payload.selector ? document.querySelector(payload.selector) : editSel;
      pushStyle(el);
    } catch (_err) {
      /* ignore */
    }
  });

  // The Style panel drives this: props applied live, committed on change-end.
  ipcRenderer.on('caos:apply-style', (_e, payload) => {
    try {
      const p = payload || {};
      const el = p.selector ? document.querySelector(p.selector) : editSel;
      if (el) applyStyle(el, p.props || {}, !!p.commit);
    } catch (_err) {
      /* ignore */
    }
  });

  // "Reset element": undo everything this visit did to it, note included.
  ipcRenderer.on('caos:reset-element', (_e, payload) => {
    try {
      const el = payload && payload.selector ? document.querySelector(payload.selector) : editSel;
      if (!el || !styleSession || styleSession.el !== el) return;
      const entry = styleSession.annId ? editStack.filter((x) => x.annId === styleSession.annId)[0] : null;
      if (entry) retractEdit(entry); // its undo IS the session's restore point
      else styleSession.restore();
      endStyleSession();
      syncEditBox();
      pushStyle(el);
    } catch (_err) {
      /* ignore */
    }
  });

  ipcRenderer.on('caos:set-text', (_e, payload) => {
    try {
      const p = payload || {};
      const el = p.selector ? document.querySelector(p.selector) : editSel;
      if (!el || typeof p.text !== 'string' || !isTextEditable(el)) return;
      const before = el.textContent;
      if (before === p.text) return;
      el.textContent = p.text;
      commitEdit(el, {
        type: 'text',
        action: 'change',
        note: 'Change the copy of `' + anchor.cssPath(el) + '` from “' + trim60(before) + '” to “' + trim60(p.text) + '”.',
        details: { before, after: p.text },
        undo: () => {
          el.textContent = before;
        },
      });
      pushStyle(el);
    } catch (_err) {
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

  // Run the offline accessibility / quality audit over the live page and hand
  // the findings back to the shell. Anchoring uses the same describe() the
  // inspector uses, so a finding can be located or promoted to a note.
  ipcRenderer.on('caos:run-audit', () => {
    let report;
    try {
      report = audit.runAudit({ describe: anchor.describe });
    } catch (err) {
      report = { error: String((err && err.message) || err), findings: [], counts: {}, total: 0 };
    }
    ipcRenderer.sendToHost('caos:audit-result', report);
  });

  ipcRenderer.on('caos:request-dom-tree', () => pushTree());

  // The Sections panel mirrors the live DOM, so anything that restructures the
  // page has to re-publish it or the panel goes stale.
  function pushTree() {
    try {
      ipcRenderer.sendToHost('caos:dom-tree', serializeTree(document.body, TREE_MAX_DEPTH));
    } catch (_e) {
      /* ignore */
    }
  }

  // Hide / show an element from the Sections list. Hiding records a removal
  // note exactly like the arrange bar's Hide; showing retracts that note again
  // rather than piling a second edit on top of the first.
  ipcRenderer.on('caos:toggle-hidden', (_e, payload) => {
    try {
      const sel = payload && payload.selector;
      const el = sel && document.querySelector(sel);
      if (!el || isOwnUI(el)) return;
      if (el.style.display === 'none') {
        const entry = editStack.slice().reverse().find((x) => x.type === 'hide' && x.el === el);
        if (entry) retractEdit(entry);
        else {
          // Hidden by the page itself (or by an edit we no longer hold) —
          // showing it is its own change to record.
          const restore = styleSnapshot(el);
          el.style.removeProperty('display');
          commitEdit(el, {
            type: 'show',
            action: 'change',
            note: 'Show `' + anchor.cssPath(el) + '` again (it was hidden on the page).',
            css: 'display: revert;',
            undo: restore,
          });
        }
      } else {
        const restore = styleSnapshot(el);
        el.style.display = 'none';
        commitEdit(el, {
          type: 'hide',
          action: 'remove',
          note: 'Remove `' + anchor.cssPath(el) + '` from the page (hidden in preview with display:none).',
          css: 'display: none;',
          undo: restore,
        });
      }
      pushTree();
    } catch (_err) {
      /* ignore */
    }
  });

  // Resolve each annotation to a live PAGE-coordinate box for full-page
  // screenshot compositing. Elements are resolved fresh; region boxes are
  // already stored in page coordinates.
  ipcRenderer.on('caos:request-page-boxes', (_e, annotations) => {
    const boxes = (annotations || []).map((a) => {
      try {
        const target = a && a.target;
        if (isRegionTarget(target) || (a && a.kind === 'region' && target && target.box)) return target.box;
        const el = target ? anchor.resolve(target) : null;
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
