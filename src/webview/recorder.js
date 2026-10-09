// Braiwser — recorder.js
// Captures real user interactions on the page as a step list and streams them
// out via the onStep callback. Capture-phase, never preventDefault — the page
// must behave totally normally while recording.
//
// Consecutive text inputs on the same field are coalesced into one step so
// replay does not flicker through every keystroke. A synthetic cursor follows
// the pointer so the filmed guest page (which has no OS cursor) still shows it.
//
// ---------------------------------------------------------------------------
// Secrets (CE-01). A field is classified from its ATTRIBUTES (secret-field.js)
// and from the already-built step's hints (shared/redact.js) BEFORE its value is
// read. A secret field's `.value` is never read, never stored and never emitted:
//
//   { type:'input', control:'secret', secret:true, placeholder:'{{secret}}',
//     selector, tag, text, ... }          // NO `value` key at all
//
// Replay supplies the real credential at run time (see replay.js `secrets`).
// The coalescing/replace path produces the same value-free shape; for a secret
// field it emits nothing after the first step, since there is nothing to update.
//
// Re-arm protocol (RF-02). Every new document gets a fresh preload and
// therefore a fresh, INACTIVE recorder with a new `documentId`. The host must
// re-arm on each owned document's dom-ready. Messages (guest <-> host), wired by
// attachIpc(ipcRenderer) below:
//
//   host -> guest  'caos:start-recording'  { recordingId, ownerTabId }   (payload optional;
//                                            idempotent for the same recordingId — a
//                                            re-send never duplicates listeners or resets
//                                            coalescing / sequence state)
//   host -> guest  'caos:stop-recording'   (no payload) - stops, removes every listener
//   host -> guest  'caos:recording-status' (no payload) - query
//   guest -> host  'caos:recording-status' { active, documentId, generation, recordingId,
//                                            ownerTabId, seq, url, reason }
//        sent: once per new document when the preload attaches (reason:'document-ready',
//        active:false), and in reply to start / stop / query (reason:'start'|'stop'|'query').
//   guest -> host  'caos:rec-step'         step (unchanged channel) plus these stamped
//                                            fields: documentId, recordingId, ownerTabId,
//                                            generation (increments on each real start in
//                                            this document), seq (per generation, from 1).
// ---------------------------------------------------------------------------

'use strict';

const anchor = require('./anchor');
const cursor = require('./cursor');
const { isSecretField } = require('./secret-field');

let redact = null;
try {
  redact = require('../shared/redact');
} catch (_e) {
  redact = null; // field-level classification still applies
}
const SECRET_PLACEHOLDER = (redact && redact.SECRET_PLACEHOLDER) || '{{secret}}';

// One id per document load: a fresh preload (new document) gets a fresh id.
const documentId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let active = false;
let cb = null;
let recordingId = null;
let ownerTabId = null;
let generation = 0;
let seq = 0;
let lastScroll = 0;
let scrollSettle = null; // trailing emit, so the resting position is recorded
let lastInput = null; // { selector, step } — coalesced text entry
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

function stamp(step) {
  step.ts = now();
  step.documentId = documentId;
  step.generation = generation;
  step.seq = ++seq;
  if (recordingId != null) step.recordingId = recordingId;
  if (ownerTabId != null) step.ownerTabId = ownerTabId;
  return step;
}

function emit(step) {
  if (!active || typeof cb !== 'function') return;
  try {
    cb(stamp(step));
  } catch (_e) {
    /* swallow — recording must never break the page */
  }
}

function flushInput() {
  lastInput = null;
}

// What the step touched, in words — the written exports read "Click “Log in”
// (button#login-btn)" instead of a bare selector. Form controls are described
// from their attributes/labels only: a textarea's text content IS its default
// value, and a secret control's content must never leak into a description.
function describeTarget(el) {
  const out = { tag: '', text: '' };
  try {
    out.tag = el.nodeName ? el.nodeName.toLowerCase() : '';
    const isField = out.tag === 'input' || out.tag === 'textarea' || out.tag === 'select';
    let raw =
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'))) ||
      '';
    if (!raw) {
      if (isField) {
        const lbl = el.labels && el.labels[0];
        raw = (lbl && lbl.textContent) || '';
      } else {
        raw = el.innerText || el.textContent || '';
      }
    }
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
  flushInput();
  emit({
    type: 'click',
    selector: anchor.cssPath(e.target),
    position: { x: e.clientX, y: e.clientY },
    ...describeTarget(e.target),
  });
}

function controlOf(t, tag) {
  if (tag === 'select') return t.multiple ? 'multiselect' : 'select';
  if (tag === 'input' && t.type === 'checkbox') return 'checkbox';
  if (tag === 'input' && t.type === 'radio') return 'radio';
  return 'text';
}

function onInputEvt(e) {
  const t = e.target;
  if (isOwnUI(t)) return;
  if (!t || !t.tagName) return;
  const tag = t.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;

  const control = controlOf(t, tag);
  const selector = anchor.cssPath(t);
  const step = {
    type: 'input',
    selector,
    control,
    ...describeTarget(t),
  };

  // Classify BEFORE touching `.value`: attributes first, then whatever the
  // shared redactor can tell from the step's own hints. Booleans/fixed choices
  // cannot carry a typed credential, so only free-text-ish controls are screened
  // by hint.
  let secret = isSecretField(t);
  if (!secret && redact && (control === 'text' || control === 'select' || control === 'multiselect')) {
    try {
      secret = redact.isSecretStep(step);
    } catch (_e) {
      secret = true; // cannot tell -> do not read the value
    }
  }

  // Checkbox / radio / select: each change is a distinct action.
  const coalesce = control === 'text';

  if (secret) {
    step.control = 'secret';
    step.secret = true;
    step.placeholder = SECRET_PLACEHOLDER;
    // Nothing about a secret changes between keystrokes: one value-free step per
    // field visit is the whole record, so the replace path stays silent.
    if (coalesce && lastInput && lastInput.selector === selector) return;
    lastInput = { selector, step };
    emit(step);
    return;
  }

  step.secret = false;
  try {
    if (control === 'checkbox' || control === 'radio') {
      step.value = !!t.checked;
    } else if (control === 'multiselect') {
      step.value = Array.prototype.filter.call(t.options || [], (o) => o.selected).map((o) => o.value);
    } else {
      step.value = t.value;
    }
  } catch (_e) {
    step.value = undefined;
  }

  if (coalesce && lastInput && lastInput.selector === selector && typeof cb === 'function' && active) {
    // Update the in-flight step the host already has: emit a replace marker.
    stamp(step);
    step.replaceLast = true;
    lastInput.step = step;
    try { cb(step); } catch (_e) { /* ignore */ }
    return;
  }

  lastInput = coalesce ? { selector, step } : null;
  emit(step);
}

function onKeyDown(e) {
  if (isOwnUI(e.target)) return;
  if (e.key !== 'Enter') return;
  flushInput();
  emit({
    type: 'key',
    selector: anchor.cssPath(e.target),
    key: 'Enter',
    ...describeTarget(e.target),
  });
}

function emitScroll() {
  flushInput();
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
  scrollSettle = setTimeout(() => {
    scrollSettle = null;
    emitScroll();
  }, 180);
  const t = Date.now();
  if (t - lastScroll < 200) return;
  lastScroll = t;
  emitScroll();
}

// A navigation can unload the page before the 180 ms settle timer fires; flush
// the resting position now so the last scroll of a document is not lost.
function onPageHide() {
  if (scrollSettle != null) {
    clearTimeout(scrollSettle);
    scrollSettle = null;
    emitScroll();
  }
}

function status(reason) {
  let url = '';
  try {
    url = location.href;
  } catch (_e) {
    /* ignore */
  }
  return { active, documentId, generation, recordingId, ownerTabId, seq, url, reason: reason || 'query' };
}

function detach() {
  clearTimeout(scrollSettle);
  scrollSettle = null;
  while (listeners.length) {
    const l = listeners.pop();
    try {
      l.target.removeEventListener(l.type, l.fn, l.opts);
    } catch (_e) {
      /* ignore */
    }
  }
}

// start(onStep[, { recordingId, ownerTabId }])
// Idempotent for an already-active recording with the same recordingId: the
// callback is refreshed, listeners and coalescing state are left alone.
function start(onStep, ctx) {
  const next = ctx && ctx.recordingId != null ? String(ctx.recordingId) : null;
  if (active && next !== null && next === recordingId) {
    cb = onStep;
    if (ctx && ctx.ownerTabId != null) ownerTabId = ctx.ownerTabId;
    return status('start');
  }
  if (active) stop();
  cb = onStep;
  active = true;
  recordingId = next;
  ownerTabId = ctx && ctx.ownerTabId != null ? ctx.ownerTabId : null;
  generation += 1;
  seq = 0;
  lastScroll = 0;
  lastInput = null;
  cursor.followPointer(true);
  add(document, 'click', onClick);
  add(document, 'input', onInputEvt);
  add(document, 'change', onInputEvt);
  add(document, 'keydown', onKeyDown);
  add(window, 'scroll', onScroll);
  add(window, 'pagehide', onPageHide);
  return status('start');
}

function stop() {
  const wasActive = active;
  detach();
  flushInput();
  active = false;
  cb = null;
  recordingId = null;
  ownerTabId = null;
  if (wasActive) cursor.followPointer(false);
  return status('stop');
}

// Wire the host protocol onto an ipcRenderer (preload side). Safe to call once
// per document; handlers are thin wrappers over start/stop/status.
function attachIpc(ipcRenderer) {
  const send = (reason) => {
    try {
      ipcRenderer.sendToHost('caos:recording-status', status(reason));
    } catch (_e) {
      /* host gone */
    }
  };
  ipcRenderer.on('caos:start-recording', (_e, payload) => {
    start((step) => ipcRenderer.sendToHost('caos:rec-step', step), payload || undefined);
    send('start');
  });
  ipcRenderer.on('caos:stop-recording', () => {
    stop();
    send('stop');
  });
  ipcRenderer.on('caos:recording-status', () => send('query'));
  // A fresh document announces itself (inactive) so the host can re-arm.
  send('document-ready');
}

module.exports = { start, stop, status, attachIpc, documentId };
