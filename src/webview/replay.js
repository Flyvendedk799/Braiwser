// Braiwser — replay.js
// Re-executes recorded steps against the live page. 'navigate' steps are owned
// by the host (it changes the webview src), so they are a no-op here.
//
// Replay is paced to look human: a visible cursor moves to the target, clicks
// flash, short text is typed, and the host adds inter-step delays from the
// timestamps captured at record time.

'use strict';

const anchor = require('./anchor');
const cursor = require('./cursor');

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

function pointFor(el, step) {
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const px = step && step.position && Number.isFinite(step.position.x) ? step.position.x : cx;
  const py = step && step.position && Number.isFinite(step.position.y) ? step.position.y : cy;
  // If the recorded point drifted off the element (layout shift), fall back to center.
  const onEl = px >= r.left - 4 && px <= r.right + 4 && py >= r.top - 4 && py <= r.bottom + 4;
  return onEl ? { x: Math.round(px), y: Math.round(py) } : { x: cx, y: cy };
}

function fireMouse(el, type, point) {
  try {
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
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

async function typeValue(el, value, { fast } = {}) {
  const text = value == null ? '' : String(value);
  // Keep e2e / snappy replays instant; film / normal replays type short strings.
  if (fast || text.length === 0 || text.length > 48 || el.secret) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < text.length; i++) {
    el.value = text.slice(0, i + 1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(28 + Math.floor(Math.random() * 36));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function executeStep(step, opts = {}) {
  if (!step || !step.type) return { ok: false, error: 'no step' };
  const fast = !!opts.fast;

  // Navigation is handled by the host (changes webview location).
  if (step.type === 'navigate') return { ok: true };

  if (step.type === 'assert') return evaluateAssert(step);

  if (step.type === 'scroll') {
    try {
      cursor.show();
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
    await wait(fast ? 20 : 120);
    const point = pointFor(el, step);
    if (!fast) {
      cursor.show();
      await cursor.moveTo(point.x, point.y);
      await wait(140);
    } else {
      cursor.setPosition(point.x, point.y, { instant: true });
      cursor.show();
    }
    anchor.highlight(el, { duration: fast ? 200 : 700, color: '#3ddc97' });

    if (step.type === 'click') {
      if (!fast) await cursor.clickFlash(point.x, point.y);
      fireMouse(el, 'mousedown', point);
      fireMouse(el, 'mouseup', point);
      if (typeof el.click === 'function') {
        el.click();
      } else {
        fireMouse(el, 'click', point);
      }
      if (!fast) await wait(220);
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
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        await typeValue(el, step.secret ? '' : step.value, { fast });
      }
      if (!fast) await wait(180);
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
      if (!fast) await wait(160);
      return { ok: true };
    }

    return { ok: false, error: 'unknown step type: ' + step.type };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { executeStep, cursor };
