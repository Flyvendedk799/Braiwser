// Braiwser — replay.js
// Re-executes recorded steps against the live page. 'navigate' steps are owned
// by the host (it changes the webview src), so they are a no-op here.

'use strict';

const anchor = require('./anchor');

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Replay is meant to look like the journey being taken again, and a person
// does not teleport down a page. Scrolls are animated at a human speed —
// distance-based, eased, and capped so a long page does not crawl.
const SCROLL_MIN_MS = 180;
const SCROLL_MAX_MS = 1100;
const SCROLL_PX_PER_MS = 2.4;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function scrollDuration(dx, dy) {
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return 0;
  return Math.max(SCROLL_MIN_MS, Math.min(SCROLL_MAX_MS, distance / SCROLL_PX_PER_MS));
}

function smoothScrollTo(x, y) {
  return new Promise((resolve) => {
    const startX = window.scrollX || window.pageXOffset || 0;
    const startY = window.scrollY || window.pageYOffset || 0;
    const dx = x - startX;
    const dy = y - startY;
    const ms = scrollDuration(dx, dy);
    if (!ms) {
      resolve();
      return;
    }
    const t0 = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const e = easeInOutCubic(p);
      window.scrollTo(Math.round(startX + dx * e), Math.round(startY + dy * e));
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Bring an element into view the way a reader would: only if it is off screen,
// and by gliding there rather than jumping.
function scrollIntoView(el) {
  try {
    const r = el.getBoundingClientRect();
    const margin = 80;
    const onScreen = r.top >= margin && r.bottom <= window.innerHeight - margin;
    if (onScreen) return Promise.resolve();
    const targetY = (window.scrollY || 0) + r.top - Math.round((window.innerHeight - r.height) / 2);
    return smoothScrollTo(window.scrollX || 0, Math.max(0, targetY));
  } catch (_e) {
    try {
      el.scrollIntoView();
    } catch (_e2) {
      /* ignore */
    }
    return Promise.resolve();
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

// Braiwser injects its own UI (data-caos). Assertions must never count or
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
      await smoothScrollTo(step.x || 0, step.y || 0);
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
    await scrollIntoView(el);
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
