// A modal dialog with its OWN focus trap and Escape handling, for the agent
// surfaces (approval, add-finding, connection enable). It exists because the
// shared modal() in dom.js listens for Escape/Tab on `document` and every open
// modal reacts — so a second modal opened over Settings would close both (RF-09/10).
//
// Here a module-level stack decides who is "active". Only the top dialog handles
// keys; its listener runs in the capture phase and stops propagation, so a parent
// modal's bubble-phase document listener never sees the Escape or Tab.
import { h, icon } from './dom.js';

const stack = [];
let seq = 0;

export function activeDialogCount() { return stack.length; }

// Close every open agent dialog (used when the feature is torn down).
export function closeAllAgentDialogs() {
  for (const entry of stack.slice().reverse()) if (entry.api) entry.api.close('teardown');
}

export function openTrappedDialog({
  title, body, actions = [], width = 520, role = 'dialog', testid = '', describedBy = '',
  dismissible = true, onClose, initialFocus,
} = {}) {
  const id = ++seq;
  const titleId = `agent-dlg-title-${id}`;
  const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;
  const entry = { id, closed: false };

  const footer = h('div', { class: 'modal-footer agent-dlg-footer' });
  const buttons = {};
  for (const a of actions) {
    const btn = h('button', {
      class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}`,
      type: 'button',
      text: a.label,
      disabled: !!a.disabled,
      dataset: a.id ? { action: a.id } : null,
      'data-testid': a.testid || (a.id ? `agent-dialog-${a.id}` : null),
      on: {
        click: async () => {
          if (btn.disabled || entry.closed) return;
          let keep = false;
          if (a.onClick) keep = await a.onClick(api);
          if (keep !== true) api.close(a.id || 'action');
        },
      },
    });
    if (a.id) buttons[a.id] = btn;
    footer.appendChild(btn);
  }

  const closeBtn = h('button', {
    class: 'icon-btn modal-x', type: 'button', title: 'Close', 'aria-label': 'Close',
    html: icon('close', 16), on: { click: () => api.close('x') },
  });
  const card = h('div', {
    class: 'modal-card agent-dlg',
    role,
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': describedBy || null,
    'data-testid': testid || null,
    style: { width: width + 'px' },
  }, [
    h('div', { class: 'modal-head' }, [h('div', { class: 'modal-title', id: titleId, text: title || '' }), dismissible ? closeBtn : null]),
    h('div', { class: 'modal-body' }, [body]),
    actions.length ? footer : null,
  ]);
  const backdrop = h('div', { class: 'modal-backdrop agent-dlg-backdrop show' }, [card]);

  const focusables = () => Array.from(card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
  // Top = last in OUR stack AND last .modal-backdrop in the document, so a
  // shared modal() opened over this dialog is respected as the active one.
  const isTop = () => {
    if (stack[stack.length - 1] !== entry) return false;
    const all = document.querySelectorAll('.modal-backdrop');
    return all.length === 0 || all[all.length - 1] === backdrop;
  };

  function onKey(e) {
    if (!isTop()) return;
    if (e.key === 'Escape') {
      // This dialog, and only this one, handles the key.
      e.preventDefault();
      e.stopPropagation();
      if (dismissible) api.close('escape');
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      e.stopPropagation();
      if (!f.length) { e.preventDefault(); card.focus && card.focus(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  }
  function onFocusIn(e) {
    if (!isTop() || card.contains(e.target)) return;
    const f = focusables();
    if (f[0]) f[0].focus();
  }

  const api = {
    card, backdrop, buttons,
    get closed() { return entry.closed; },
    close(reason = 'close') {
      if (entry.closed) return;
      entry.closed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      backdrop.remove();
      // Make the dialogs underneath interactive again (only the ones we covered).
      for (const el of covered) { if (el.isConnected) el.removeAttribute('inert'); }
      try { if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus(); } catch (_e) { /* ignore */ }
      if (onClose) onClose(reason);
    },
    focusFirst() {
      const target = (typeof initialFocus === 'function' ? initialFocus(card) : null) || focusables()[0];
      if (target) target.focus();
    },
  };

  card.setAttribute('tabindex', '-1');
  entry.api = api;
  // Dialogs underneath become inert: not focusable, hidden from assistive tech.
  const covered = Array.from(document.querySelectorAll('.modal-backdrop')).filter((el) => !el.hasAttribute('inert'));
  covered.forEach((el) => el.setAttribute('inert', ''));
  stack.push(entry);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.body.appendChild(backdrop);
  api.focusFirst();
  return api;
}
