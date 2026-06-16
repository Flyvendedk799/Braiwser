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

  let mode = 'off'; // 'off' | 'inspect' | 'draw'
  let hovered = null; // element under cursor (inspect mode)
  let root, highlight, tooltip, canvas, ctx, popup, drawBar, pinLayer;
  let drawing = false;
  let strokes = []; // page-coordinate strokes for the current region
  let curStroke = null;
  let pins = []; // [{ el, target, badge, action }] restored annotation pins
  let pinSyncQueued = false;

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

    canvas = document.createElement('canvas');
    canvas.setAttribute('data-caos', '');
    canvas.style.cssText = 'position:fixed;inset:0;display:none;z-index:2147483645;';
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');

    drawBar = document.createElement('div');
    drawBar.setAttribute('data-caos', '');
    drawBar.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:none;gap:8px;' +
      'background:#11131a;border:1px solid #2a2e3a;border-radius:10px;padding:8px 10px;box-shadow:0 8px 30px rgba(0,0,0,.45);';
    drawBar.innerHTML =
      '<span style="color:#9aa2b1;font:12px sans-serif;align-self:center;padding:0 4px">Draw to circle an area</span>' +
      '<button data-act="note" style="cursor:pointer;border:0;border-radius:7px;padding:6px 12px;background:#5b8cff;color:#fff;font:600 12px sans-serif">Add note</button>' +
      '<button data-act="clear" style="cursor:pointer;border:0;border-radius:7px;padding:6px 12px;background:#22262f;color:#cdd6f4;font:600 12px sans-serif">Clear</button>';
    document.documentElement.appendChild(drawBar);
    drawBar.querySelector('[data-act=note]').addEventListener('click', openRegionNote);
    drawBar.querySelector('[data-act=clear]').addEventListener('click', () => {
      strokes = [];
      redraw();
    });

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
    if (mode !== 'inspect' && mode !== 'assert') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
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
    if (mode !== 'inspect' && mode !== 'assert') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOwnUI(el)) return; // let popup interactions through
    e.preventDefault();
    e.stopPropagation();
    if (!el) return;
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
    openElementNote(el);
  }

  // ---- draw mode ------------------------------------------------------------
  function onDown(e) {
    if (mode !== 'draw' || isOwnUI(e.target)) return;
    drawing = true;
    curStroke = [{ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }];
    strokes.push(curStroke);
  }
  function onDraw(e) {
    if (!drawing) return;
    curStroke.push({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
    redraw();
  }
  function onUp() {
    drawing = false;
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
    const anchorRect = {
      left: box.x - window.scrollX,
      top: box.y - window.scrollY,
      bottom: box.y - window.scrollY + box.h,
      right: box.x - window.scrollX + box.w,
    };
    showPopup(
      { kind: 'region', target: { box }, anchor: anchorRect },
      (note, action) => {
        send({ id: uid(), kind: 'region', action, note, target: { box } });
        strokes = [];
        redraw();
      }
    );
  }

  function showPopup(ctxObj, onSave) {
    closePopup();
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
      ipcRenderer.sendToHost('caos:escape');
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
        ipcRenderer.sendToHost('caos:escape');
      }
    });
  }

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
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
        badge.textContent = String(i + 1);
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
    drawBar.style.display = drawOn ? 'flex' : 'none';
    if (document.body) document.body.style.cursor = next === 'inspect' || next === 'assert' ? 'crosshair' : '';
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
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onDraw, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          closePopup();
          ipcRenderer.sendToHost('caos:escape');
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
        redraw();
        queuePinSync();
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
    try {
      const el = anchor.resolve(target);
      if (el) anchor.highlight(el, { duration: 1400 });
      else if (target && target.box) anchor.highlight(null, { duration: 1400, box: target.box });
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
