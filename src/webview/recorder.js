// Chrome AI OS — recorder.js
// Captures real user interactions on the page as a step list and streams them
// out via the onStep callback. Capture-phase, never preventDefault — the page
// must behave totally normally while recording.

'use strict';

const anchor = require('./anchor');

let active = false;
let cb = null;
let lastScroll = 0;
let scrollSettle = null; // trailing emit, so the resting position is recorded
const listeners = []; // { target, type, fn, opts }

function isOwnUI(el) {
  try {
    return !!(el && el.closest && el.closest('[data-caos], #__caos_root'));
  } catch (_e) {
    return false;
  }
}

function now() {
  return new Date().toISOString();
}

function emit(step) {
  if (!active || typeof cb !== 'function') return;
  try {
    step.ts = now();
    cb(step);
  } catch (_e) {
    /* swallow — recording must never break the page */
  }
}

// What the step touched, in words — the written exports read "Click “Log in”
// (button#login-btn)" instead of a bare selector.
function describeTarget(el) {
  const out = { tag: '', text: '' };
  try {
    out.tag = el.nodeName ? el.nodeName.toLowerCase() : '';
    const raw =
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'))) ||
      el.innerText ||
      el.textContent ||
      '';
    out.text = String(raw).trim().replace(/\s+/g, ' ').slice(0, 60);
  } catch (_e) {
    /* ignore */
  }
  return out;
}

function add(target, type, fn) {
  const opts = true; // capture phase
  target.addEventListener(type, fn, opts);
  listeners.push({ target, type, fn, opts });
}

function onClick(e) {
  if (isOwnUI(e.target)) return;
  emit({
    type: 'click',
    selector: anchor.cssPath(e.target),
    position: { x: e.clientX, y: e.clientY },
    ...describeTarget(e.target),
  });
}

function onInputEvt(e) {
  const t = e.target;
  if (isOwnUI(t)) return;
  if (!t || !t.tagName) return;
  const tag = t.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
  let value;
  try {
    if (tag === 'input' && (t.type === 'checkbox' || t.type === 'radio')) {
      value = t.checked;
    } else {
      value = t.value;
    }
  } catch (_e) {
    value = undefined;
  }
  emit({
    type: 'input',
    selector: anchor.cssPath(t),
    value,
    // A password's characters have no place in a debugging artefact.
    secret: tag === 'input' && t.type === 'password',
    ...describeTarget(t),
  });
}

function onKeyDown(e) {
  if (isOwnUI(e.target)) return;
  if (e.key !== 'Enter') return;
  emit({
    type: 'key',
    selector: anchor.cssPath(e.target),
    key: 'Enter',
    ...describeTarget(e.target),
  });
}

function emitScroll() {
  emit({
    type: 'scroll',
    x: window.scrollX || window.pageXOffset || 0,
    y: window.scrollY || window.pageYOffset || 0,
  });
}

function onScroll() {
  // Waypoints while it moves, plus one when it stops — without the trailing
  // emit the position you actually came to rest at was never recorded.
  clearTimeout(scrollSettle);
  scrollSettle = setTimeout(emitScroll, 180);
  const t = Date.now();
  if (t - lastScroll < 200) return;
  lastScroll = t;
  emitScroll();
}

function start(onStep) {
  if (active) stop();
  cb = onStep;
  active = true;
  lastScroll = 0;
  add(document, 'click', onClick);
  add(document, 'input', onInputEvt);
  add(document, 'change', onInputEvt);
  add(document, 'keydown', onKeyDown);
  add(window, 'scroll', onScroll);
}

function stop() {
  clearTimeout(scrollSettle);
  active = false;
  cb = null;
  while (listeners.length) {
    const l = listeners.pop();
    try {
      l.target.removeEventListener(l.type, l.fn, l.opts);
    } catch (_e) {
      /* ignore */
    }
  }
}

module.exports = { start, stop };
