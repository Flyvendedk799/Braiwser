// Tiny DOM toolkit for the renderer: element builder, query helpers, and the
// shared overlay primitives (toast + modal + confirm). Zero dependencies, pure
// browser DOM — safe under contextIsolation with no node/require.

// h(tag, props?, children?) -> HTMLElement
//   props: { class, text, html, on:{event:fn}, dataset:{}, style:{}, ...attrs }
//   children: node | string | array of (node|string|falsy)
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === 'dataset') for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = !!value;
    else if (key === 'disabled') el.disabled = !!value;
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false || c === '') continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Inline SVG icon factory — a curated set of stroke icons used in the toolbar
// and panels. Returns a string so it can drop into html: props or be parsed.
const ICONS = {
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  reload: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  inspect: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  draw: 'M12 19l7-7-4-4-7 7-1 5 5-1zM15 5l4 4',
  record: '', // filled circle, handled specially
  stop: '', // filled square
  replay: 'M5 3l14 9-14 9V3z',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  ai: 'M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  locate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3',
  check: 'M20 6L9 17l-5-5',
  chevron: 'M9 18l6-6-6-6',
  copy: 'M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  close: 'M18 6L6 18M6 6l12 12',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
  layers: 'M12 2L2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  'eye-off': 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-3.2 4M6.2 6.7A18.3 18.3 0 0 0 1 12s4 7 11 7a10.7 10.7 0 0 0 4.3-.9',
  audit: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 11.5l2 2 4-4',
  device: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10.5 18.5h3',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5.2-5.2',
  keyboard: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 3h16',
};

export function icon(name, size = 16) {
  if (name === 'record') return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`;
  if (name === 'stop') return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
  const d = ICONS[name] || '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d.split('M').filter(Boolean).map((seg) => `<path d="M${seg}"/>`).join('')}</svg>`;
}

// ---- Toast -----------------------------------------------------------------
let toastHost = null;
function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = h('div', { class: 'toast-host' });
  document.body.appendChild(toastHost);
  return toastHost;
}

export function toast(message, kind = 'info', ms = 2600) {
  const host = ensureToastHost();
  const node = h('div', { class: `toast toast-${kind}` }, [
    h('span', { class: 'toast-dot' }),
    h('span', { class: 'toast-msg', text: message }),
  ]);
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  const close = () => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 220);
  };
  const t = setTimeout(close, ms);
  node.addEventListener('click', () => {
    clearTimeout(t);
    close();
  });
  return close;
}

// ---- Modal -----------------------------------------------------------------
// modal({ title, body:Node, actions:[{label,kind,onClick}], onClose }) -> { close }
export function modal({ title, body, actions = [], onClose, width = 460 } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const prevFocus = document.activeElement; // restore on close
  const close = () => {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 200);
    if (onClose) onClose();
    document.removeEventListener('keydown', onKey);
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_e) { /* ignore */ }
  };
  const focusables = () => card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const footer = h('div', { class: 'modal-footer' });
  for (const a of actions) {
    const btn = h('button', {
      class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}`,
      text: a.label,
      on: {
        click: async () => {
          if (a.onClick) {
            const keep = await a.onClick();
            if (keep === true) return; // keep open if handler returns true
          }
          close();
        },
      },
    });
    footer.appendChild(btn);
  }

  const card = h('div', { class: 'modal-card', style: { width: width + 'px' } }, [
    h('div', { class: 'modal-head' }, [
      h('div', { class: 'modal-title', text: title || '' }),
      h('button', { class: 'icon-btn modal-x', title: 'Close', 'aria-label': 'Close', html: icon('close', 16), on: { click: close } }),
    ]),
    h('div', { class: 'modal-body' }, [body]),
    actions.length ? footer : null,
  ]);

  backdrop.appendChild(card);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    // Initial focus: a field if present, else the primary action.
    const f = card.querySelector('input, textarea, select') || card.querySelector('.modal-footer button:last-child') || card.querySelector('button');
    if (f) try { f.focus(); } catch (_e) { /* ignore */ }
  });
  return { close, card };
}

// Lightweight popover menu anchored under an element. items: [{label, onClick}].
export function menu(anchorEl, items) {
  const m = h('div', { class: 'popover-menu' });
  const close = () => {
    m.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e) => { if (!m.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  for (const it of items) {
    m.appendChild(h('button', { class: 'pm-item', text: it.label, on: { click: () => { close(); if (it.onClick) it.onClick(); } } }));
  }
  document.body.appendChild(m);
  const r = anchorEl.getBoundingClientRect();
  m.style.top = r.bottom + 4 + 'px';
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return { close };
}

// confirm({ title, message, confirmLabel, danger }) -> Promise<boolean>
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      width: 420,
      body: h('div', { class: 'confirm-msg', text: message }),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => resolve(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
    return m;
  });
}

// prompt({ title, label, value, placeholder, confirmLabel }) -> Promise<string|null>
export function promptDialog({ title = 'Name', label = '', value = '', placeholder = '', confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h('input', { class: 'input', type: 'text', value, placeholder });
    const submit = () => {
      const v = input.value.trim();
      settled = true;
      resolve(v || null);
    };
    const body = h('div', { class: 'prompt-body' }, [
      label ? h('label', { class: 'field-label', text: label }) : null,
      input,
    ]);
    const m = modal({
      title,
      width: 420,
      body,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { settled = true; resolve(null); } },
        { label: confirmLabel, kind: 'primary', onClick: submit },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { submit(); m.close(); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// Format a relative-ish timestamp for compact list display.
export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1m';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 7200) return '1h';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 172800) return 'yesterday';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
}

// Escape text for safe interpolation into html: strings.
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
