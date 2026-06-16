// Chrome AI OS — replay.js
// Re-executes recorded steps against the live page. 'navigate' steps are owned
// by the host (it changes the webview src), so they are a no-op here.

'use strict';

const anchor = require('./anchor');

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function scrollIntoView(el) {
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (_e) {
    try {
      el.scrollIntoView();
    } catch (_e2) {
      /* ignore */
    }
  }
}

function fireMouse(el, type) {
  try {
    const r = el.getBoundingClientRect();
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
    });
    el.dispatchEvent(evt);
  } catch (_e) {
    /* ignore */
  }
}

function textOf(el) {
  return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
  return el.offsetParent !== null || cs.position === 'fixed';
}

function compareStr(op, actual, expected) {
  const a = String(actual == null ? '' : actual);
  const e = String(expected == null ? '' : expected);
  if (op === 'equals') return a === e;
  if (op === 'matches') { try { return new RegExp(e).test(a); } catch (_e) { return false; } }
  return a.toLowerCase().includes(e.toLowerCase()); // 'contains' (default)
}

// Chrome AI OS injects its own UI (data-caos). Assertions must never count or
// match those elements — only the page's real content.
function notOwnUI(el) {
  try {
    return !(el.closest && el.closest('[data-caos], #__caos_root'));
  } catch (_e) {
    return true;
  }
}
function queryAll(sel) {
  if (!sel) return [];
  return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(notOwnUI);
}

// Evaluate an assertion against the live DOM. 'url' is handled by the host.
function evaluateAssert(step) {
  const kind = step.kind || 'exists';
  try {
    if (kind === 'count') {
      const n = queryAll(step.selector).length;
      const expected = Number(step.expected);
      const op = step.op || 'equals';
      const ok = op === 'contains' ? n >= expected : n === expected;
      return { ok, actual: n, error: ok ? '' : `count ${n} ${op === 'contains' ? '≥' : '='} ${expected} failed` };
    }
    const el = queryAll(step.selector)[0] || null;
    if (kind === 'exists') {
      return { ok: !!el, actual: el ? 'present' : 'absent', error: el ? '' : 'not found: ' + step.selector };
    }
    if (kind === 'visible') {
      const ok = isVisible(el);
      return { ok, actual: ok ? 'visible' : el ? 'hidden' : 'absent', error: ok ? '' : 'not visible: ' + step.selector };
    }
    if (kind === 'text') {
      if (!el) return { ok: false, actual: '(no element)', error: 'not found: ' + step.selector };
      const t = textOf(el);
      const ok = compareStr(step.op || 'contains', t, step.expected);
      return { ok, actual: t.slice(0, 80), error: ok ? '' : `text "${t.slice(0, 40)}" ${step.op || 'contains'} "${step.expected}" failed` };
    }
    return { ok: true, actual: '', error: '' }; // url / unknown → host-evaluated or no-op
  } catch (e) {
    return { ok: false, actual: '', error: String((e && e.message) || e) };
  }
}

async function executeStep(step) {
  if (!step || !step.type) return { ok: false, error: 'no step' };

  // Navigation is handled by the host (changes webview location).
  if (step.type === 'navigate') return { ok: true };

  if (step.type === 'assert') return evaluateAssert(step);

  if (step.type === 'scroll') {
    try {
      window.scrollTo(step.x || 0, step.y || 0);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const el = anchor.resolve(step.selector ? { selector: step.selector } : null);
  if (!el) {
    return { ok: false, error: 'could not resolve target: ' + (step.selector || '(none)') };
  }

  try {
    scrollIntoView(el);
    await wait(60);
    anchor.highlight(el, { duration: 700, color: '#3ddc97' });

    if (step.type === 'click') {
      fireMouse(el, 'mousedown');
      fireMouse(el, 'mouseup');
      if (typeof el.click === 'function') {
        el.click();
      } else {
        fireMouse(el, 'click');
      }
      return { ok: true };
    }

    if (step.type === 'input') {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      try {
        el.focus();
      } catch (_e) {
        /* ignore */
      }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = !!step.value;
      } else {
        el.value = step.value == null ? '' : step.value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    if (step.type === 'key') {
      const key = step.key || 'Enter';
      try {
        el.focus();
      } catch (_e) {
        /* ignore */
      }
      const base = { bubbles: true, cancelable: true, key, code: key };
      el.dispatchEvent(new KeyboardEvent('keydown', base));
      el.dispatchEvent(new KeyboardEvent('keyup', base));
      return { ok: true };
    }

    return { ok: false, error: 'unknown step type: ' + step.type };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { executeStep };
