// Braiwser — replay.js
// Re-executes recorded steps against the live page. 'navigate' steps are owned
// by the host (it changes the webview src), so they are a no-op here.
//
// Replay is paced to look human: a visible cursor moves to the target, clicks
// flash, short text is typed, and the host adds inter-step delays from the
// timestamps captured at record time.
//
// ---------------------------------------------------------------------------
// Replay fails closed (CE-06). A step is only reported as done when the page
// was in a state where a user could really have done it, and the result says
// how much was actually verified. executeStep() resolves to:
//
//   {
//     ok:      boolean                // false only for status 'failed'
//     status:  'passed' | 'dispatched' | 'failed' | 'skipped'
//     effect:  'confirmed'    // the replay verified the intended state (value
//                             //   applied, option selected, submit event fired,
//                             //   scroll reached, assertion evaluated)
//              | 'observed'   // events were dispatched and the page visibly
//                             //   reacted (DOM mutation / URL change), intent unproven
//              | 'dispatchOnly' // events dispatched, nothing observable happened:
//                             //   NOT a proven outcome — a journey must follow it
//                             //   with an assertion (postcondition)
//              | 'none'       // nothing was dispatched
//     reason:  string                 // machine code when failed/not confirmed, e.g.
//                                     //   target-not-found | ambiguous-target |
//                                     //   target-unconfirmed | disabled | not-visible |
//                                     //   covered | inert | pointer-events-none |
//                                     //   read-only | option-not-found | value-not-applied |
//                                     //   secret-binding-missing | form-invalid |
//                                     //   unsupported-assertion | unsupported-step ...
//     error:   string                 // human text (empty when ok)
//     actual?: any                    // assertions / observed value (never a secret)
//     targetConfidence?: 'exact'|'suggested'
//     suggestion?: { selector, via }  // present when a fallback match was refused
//     coveredBy?: string              // selector of the covering element
//     needsPostcondition?: true       // set with effect 'dispatchOnly'
//   }
//
// Options (host -> guest via 'caos:replay-step' opts):
//   fast               snappy replay, no cursor travel / typing animation
//   actionTimeoutMs    bounded wait for the target to become actionable
//                      (default 1500, 800 when fast)
//   allowSuggested     act on a fallback (text/coordinate) match. Default false:
//                      only an exact, unique selector hit is acted on.
//   secrets            runtime secret bindings for steps with `secret:true`:
//                      either { [step.secretRef || step.selector]: string } or
//                      (step) => string. A recorded secret never carries a value;
//                      with no binding the step FAILS (secret-binding-missing).
// ---------------------------------------------------------------------------

'use strict';

const anchor = require('./anchor');
const cursor = require('./cursor');
// The shared assertion spec. If it cannot be loaded (a guest bundle built
// without src/shared), assertions FAIL rather than pass unevaluated.
let assertions = null;
try {
  assertions = require('../shared/assertions');
} catch (_e) {
  assertions = null;
}

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

// `behavior:'instant'` so a page's CSS scroll-behavior:smooth cannot turn each
// animation frame into its own competing smooth scroll.
function scrollToNow(x, y) {
  try {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  } catch (_e) {
    window.scrollTo(x, y);
  }
}

function smoothScrollTo(x, y) {
  return new Promise((resolve) => {
    const startX = window.scrollX || window.pageXOffset || 0;
    const startY = window.scrollY || window.pageYOffset || 0;
    const dx = x - startX;
    const dy = y - startY;
    const ms = scrollDuration(dx, dy);
    if (!ms) {
      scrollToNow(x, y);
      resolve();
      return;
    }
    const t0 = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const e = easeInOutCubic(p);
      scrollToNow(Math.round(startX + dx * e), Math.round(startY + dy * e));
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

function firePointer(el, type, point) {
  if (typeof PointerEvent !== 'function') return;
  try {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
  } catch (_e) {
    /* ignore */
  }
}

// ---- result helpers ---------------------------------------------------------
function failed(reason, error, extra) {
  return { ok: false, status: 'failed', effect: 'none', reason, error: error || reason, ...(extra || {}) };
}

function done(effect, extra) {
  const dispatchOnly = effect === 'dispatchOnly';
  return {
    ok: true,
    status: dispatchOnly ? 'dispatched' : 'passed',
    effect,
    reason: '',
    error: '',
    ...(dispatchOnly ? { needsPostcondition: true } : {}),
    ...(extra || {}),
  };
}

// ---- assertions (shared spec: src/shared/assertions.js) ------------------------
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

function rawText(el) {
  return el.innerText || el.textContent || '';
}

// Spec "visible": a non-empty box that is neither display:none nor
// visibility:hidden. opacity:0 is still visible (Playwright's definition).
function isVisible(el) {
  if (!el) return false;
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch (_e) {
    return false;
  }
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Evaluate an assertion against the live DOM using the shared spec. Anything the
// spec does not define FAILS (unsupported kind/op, missing selector/expected,
// invalid regex) — an assertion can never pass by being unrecognised.
function evaluateAssert(step) {
  try {
    if (!assertions) return failed('assertions-unavailable', 'the shared assertion spec is not available in this guest');
    const normalized = assertions.normalizeAssertion(step);
    if (!normalized.ok) {
      return failed('unsupported-assertion', normalized.error, { actual: '' });
    }
    const a = normalized.assertion;
    const facts = { url: location.href };
    if (a.selector) {
      const matches = queryAll(a.selector);
      facts.matchCount = matches.length;
      facts.firstText = matches.length ? rawText(matches[0]) : null;
      facts.firstVisible = matches.length ? isVisible(matches[0]) : null;
    } else {
      facts.matchCount = 0;
    }
    const r = assertions.evaluate(step, facts);
    if (!r.ok) {
      return failed(/not found|no element/i.test(r.error) ? 'assertion-target-missing' : 'assertion-failed', r.error, { actual: r.actual });
    }
    return done('confirmed', { actual: r.actual });
  } catch (e) {
    return failed('assertion-error', String((e && e.message) || e), { actual: '' });
  }
}

// ---- actionability ---------------------------------------------------------------
function describeEl(el) {
  try {
    return anchor.cssPath(el) || el.nodeName.toLowerCase();
  } catch (_e) {
    return '';
  }
}

function disabledProblem(el) {
  try {
    if (el.matches && el.matches(':disabled')) return 'disabled';
    if (el.closest && el.closest('[aria-disabled="true"]')) return 'disabled';
    if (el.closest && el.closest('[inert]')) return 'inert';
  } catch (_e) {
    /* ignore */
  }
  return null;
}

function visibilityProblem(el) {
  if (!el.isConnected) return 'detached';
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch (_e) {
    return 'not-visible';
  }
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'not-visible';
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return 'not-visible';
  return null;
}

// Hit test at the click point: the topmost page element must be the target or
// one of its descendants (or a label that forwards to it). Our own overlays are
// ignored. Returns null (ok) | { reason, coveredBy } | 'unverifiable' sentinel.
function hitProblem(el, point) {
  let stack;
  if (typeof document.elementsFromPoint === 'function') {
    stack = document.elementsFromPoint(point.x, point.y);
  } else if (typeof document.elementFromPoint === 'function') {
    const one = document.elementFromPoint(point.x, point.y);
    stack = one ? [one] : [];
  } else {
    return 'unverifiable';
  }
  stack = (stack || []).filter(notOwnUI);
  if (!stack.length) return { reason: 'not-visible', coveredBy: '' };
  const top = stack[0];
  if (top === el || el.contains(top)) return null;
  try {
    const label = top.closest && top.closest('label');
    if (label && el.labels && Array.prototype.indexOf.call(el.labels, label) !== -1) return null;
  } catch (_e) {
    /* ignore */
  }
  let pe = '';
  try {
    pe = getComputedStyle(el).pointerEvents;
  } catch (_e) {
    /* ignore */
  }
  if (pe === 'none') return { reason: 'pointer-events-none', coveredBy: describeEl(top) };
  return { reason: 'covered', coveredBy: describeEl(top) };
}

// One synchronous look at whether `kind` ('click'|'input'|'key') is possible now.
function actionability(el, kind, point) {
  const vis = visibilityProblem(el);
  if (vis) return { reason: vis };
  const dis = disabledProblem(el);
  if (dis) return { reason: dis };
  if (kind === 'input') {
    const tag = el.nodeName.toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && (el.readOnly || el.hasAttribute('readonly'))) {
      return { reason: 'read-only' };
    }
  }
  if (kind === 'click' && point) {
    const hit = hitProblem(el, point);
    if (hit && hit !== 'unverifiable') return hit;
  }
  return null;
}

const PROBLEM_TEXT = {
  disabled: 'target is disabled',
  inert: 'target is inert',
  'not-visible': 'target is not visible',
  detached: 'target left the page',
  'read-only': 'target is read-only',
  covered: 'another element covers the target',
  'pointer-events-none': 'target ignores pointer events',
};

// Bounded readiness wait: re-check until the target is actionable or the budget
// runs out, then report the last reason.
async function waitActionable(el, kind, getPoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = actionability(el, kind, kind === 'click' ? getPoint() : null);
    if (!last) return null;
    if (Date.now() >= deadline) return last;
    await wait(50);
  }
}

// Watch for visible reaction (DOM change / URL change) while dispatching.
function watchReaction() {
  let changed = false;
  const startUrl = location.href;
  let mo = null;
  try {
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver((list) => {
        // Our own overlays (highlight, cursor) are not the page reacting.
        for (const m of list) {
          const t = m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
          if (t && !notOwnUI(t)) continue;
          if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && !notOwnUI(n))) continue;
          changed = true;
        }
      });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  } catch (_e) {
    mo = null;
  }
  return {
    async settle(ms) {
      if (ms > 0) await wait(ms);
      if (mo) {
        if (mo.takeRecords) {
          // flush anything the observer has not delivered yet
          const rest = mo.takeRecords();
          if (rest && rest.length) changed = true;
        }
        mo.disconnect();
      }
      return changed || location.href !== startUrl;
    },
  };
}

// ---- value application -------------------------------------------------------------
// Frameworks (React & co.) track the value setter on the prototype; assigning
// through the instance hides the change from them.
function setNativeValue(el, value) {
  let proto = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  el.value = value;
}

function fireInput(el, data) {
  let evt;
  try {
    evt = new InputEvent('input', { bubbles: true, data: data == null ? null : data, inputType: 'insertText' });
  } catch (_e) {
    evt = new Event('input', { bubbles: true });
  }
  el.dispatchEvent(evt);
}

async function typeValue(el, value, { fast, instant } = {}) {
  const text = value == null ? '' : String(value);
  // Keep e2e / snappy replays instant; film / normal replays type short strings.
  if (fast || instant || text.length === 0 || text.length > 48) {
    setNativeValue(el, text);
    fireInput(el, text);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  setNativeValue(el, '');
  fireInput(el, null);
  for (let i = 0; i < text.length; i++) {
    setNativeValue(el, text.slice(0, i + 1));
    fireInput(el, text[i]);
    await wait(28 + Math.floor(Math.random() * 36));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Runtime secret binding for a `secret:true` step. Never read from the step.
function secretFor(step, opts) {
  const s = opts && opts.secrets;
  if (!s) return undefined;
  try {
    const v = typeof s === 'function' ? s(step) : Object.prototype.hasOwnProperty.call(s, step.secretRef || step.selector) ? s[step.secretRef || step.selector] : undefined;
    return typeof v === 'string' ? v : undefined;
  } catch (_e) {
    return undefined;
  }
}

async function applyInput(el, step, opts, fast) {
  const tag = el.nodeName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    return failed('unsupported-control', `cannot enter a value into <${tag}>`);
  }
  try {
    el.focus();
  } catch (_e) {
    /* ignore */
  }

  // ---- select / multiselect
  if (tag === 'select') {
    const wanted = (Array.isArray(step.value) ? step.value : [step.value]).map((v) => String(v == null ? '' : v));
    const options = Array.prototype.slice.call(el.options || []);
    const missing = wanted.filter((w) => !options.some((o) => o.value === w));
    if (missing.length) return failed('option-not-found', `option not found: ${missing[0].slice(0, 40)}`);
    const chosen = new Set();
    wanted.forEach((w) => {
      const o = options.find((x) => x.value === w && !x.disabled);
      if (o) chosen.add(o);
    });
    if (!chosen.size) return failed('option-not-found', 'option is disabled');
    options.forEach((o) => { o.selected = chosen.has(o); });
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const got = options.filter((o) => o.selected).map((o) => o.value).sort();
    const exp = wanted.slice().sort();
    const same = el.multiple ? got.length === exp.length && got.every((v, i) => v === exp[i]) : got[0] === wanted[0];
    if (!same) return failed('value-not-applied', 'the selection did not stick');
    return done('confirmed');
  }

  // ---- checkbox / radio: toggle through a real click so the page's own
  //      handlers and default actions run.
  if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = !!step.value;
    if (el.type === 'radio' && !want && el.checked) {
      return failed('value-not-applied', 'a radio button cannot be unchecked directly');
    }
    if (el.checked !== want) {
      const react = watchReaction();
      el.click();
      await react.settle(0);
    }
    if (el.checked !== want) return failed('value-not-applied', `control is ${el.checked ? 'checked' : 'unchecked'}, expected ${want ? 'checked' : 'unchecked'}`);
    return done('confirmed');
  }

  // ---- text-like
  let text;
  if (step.secret) {
    text = secretFor(step, opts);
    if (text === undefined) {
      return failed('secret-binding-missing', 'this step types a secret; supply a runtime binding to replay it');
    }
  } else {
    text = step.value == null ? '' : String(step.value);
  }
  await typeValue(el, text, { fast, instant: !!step.secret });
  await wait(0); // let a controlled component re-render and (maybe) revert
  if (el.value !== text) {
    return failed('value-not-applied', step.secret ? 'the page did not keep the supplied secret' : `field holds "${String(el.value).slice(0, 40)}", expected "${text.slice(0, 40)}"`);
  }
  return done('confirmed');
}

// ---- Enter / key -----------------------------------------------------------------
const TEXTISH = /^(text|search|url|tel|email|password|number|date|datetime-local|month|week|time)$/i;

function defaultSubmitButton(form) {
  const candidates = Array.prototype.slice.call(form.elements || []).filter((c) => {
    const t = c.nodeName.toLowerCase();
    return (t === 'button' && (!c.type || c.type === 'submit')) || (t === 'input' && (c.type === 'submit' || c.type === 'image'));
  });
  return candidates[0] || null;
}

function implicitSubmit(el) {
  const form = el.form;
  if (!form) return { reason: 'no-form' };
  const button = defaultSubmitButton(form);
  let submitted = false;
  const onSubmit = () => { submitted = true; };
  document.addEventListener('submit', onSubmit, true);
  try {
    if (button) {
      if (button.disabled) return { reason: 'default-button-disabled' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit(button);
      else button.click();
    } else {
      // No submit button: implicit submission only when at most one field blocks it.
      const blockers = Array.prototype.filter.call(form.elements || [], (c) => c.nodeName.toLowerCase() === 'input' && TEXTISH.test(c.type || 'text'));
      if (blockers.length > 1) return { reason: 'implicit-submission-blocked' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else return { reason: 'unsupported' };
    }
  } finally {
    document.removeEventListener('submit', onSubmit, true);
  }
  if (submitted) return { submitted: true };
  let valid = true;
  try {
    valid = form.checkValidity();
  } catch (_e) {
    valid = true;
  }
  return valid ? { reason: 'no-submit-event' } : { reason: 'form-invalid' };
}

async function pressKey(el, step, fast) {
  const key = step.key || 'Enter';
  try {
    el.focus();
  } catch (_e) {
    /* ignore */
  }
  const base = { bubbles: true, cancelable: true, key, code: key };
  const react = watchReaction();
  const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', base));
  let outcome = null;
  let effect = 'dispatchOnly';
  let failure = null;

  if (notPrevented && key === 'Enter') {
    const tag = el.nodeName.toLowerCase();
    const type = String(el.type || '').toLowerCase();
    if (tag === 'input' && TEXTISH.test(type || 'text')) {
      // Enter in a text field is implicit form submission — a synthetic key
      // event does not do that by itself, so perform it explicitly.
      outcome = implicitSubmit(el);
      if (outcome.submitted) effect = 'confirmed';
      else if (outcome.reason === 'form-invalid') failure = failed('form-invalid', 'Enter did not submit: the form failed constraint validation');
    } else if (tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || tag === 'summary' ||
      (tag === 'input' && /^(button|submit|reset|image)$/.test(type))) {
      el.click(); // Enter activates these natively
      effect = 'observed-pending';
    }
  }
  el.dispatchEvent(new KeyboardEvent('keyup', base));
  const reacted = await react.settle(fast ? 30 : 120);
  if (failure) return failure;
  if (effect === 'observed-pending') effect = reacted ? 'observed' : 'dispatchOnly';
  else if (effect === 'dispatchOnly' && reacted) effect = 'observed';
  const extra = outcome && outcome.reason ? { detail: outcome.reason } : {};
  return done(effect, extra);
}

// ---- scroll ----------------------------------------------------------------------
async function scrollStep(step) {
  const x = Number(step.x) || 0;
  const y = Number(step.y) || 0;
  cursor.show();
  await smoothScrollTo(x, y);
  const docEl = document.documentElement;
  const maxY = docEl && docEl.scrollHeight ? Math.max(0, docEl.scrollHeight - window.innerHeight) : Infinity;
  const maxX = docEl && docEl.scrollWidth ? Math.max(0, docEl.scrollWidth - window.innerWidth) : Infinity;
  const wantX = Math.min(x, maxX);
  const wantY = Math.min(y, maxY);
  const cur = () => ({ x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 });
  const near = () => Math.abs(cur().x - wantX) <= 2 && Math.abs(cur().y - wantY) <= 2;
  const deadline = Date.now() + 400;
  while (!near() && Date.now() < deadline) await wait(30);
  if (!near()) {
    return failed('scroll-not-reached', `scroll stopped at ${Math.round(cur().x)},${Math.round(cur().y)} (wanted ${Math.round(wantX)},${Math.round(wantY)})`);
  }
  return done('confirmed');
}

// ---- executeStep -----------------------------------------------------------------
async function executeStep(step, opts = {}) {
  if (!step || !step.type) return failed('no-step', 'no step');
  const fast = !!opts.fast;

  // Navigation is handled by the host (changes webview location).
  if (step.type === 'navigate') {
    return { ok: true, status: 'skipped', effect: 'none', reason: 'host-owned', error: '' };
  }

  if (step.type === 'assert') return evaluateAssert(step);

  if (step.type === 'scroll') {
    try {
      return await scrollStep(step);
    } catch (e) {
      return failed('scroll-error', String((e && e.message) || e));
    }
  }

  if (step.type !== 'click' && step.type !== 'input' && step.type !== 'key') {
    return failed('unsupported-step', 'unknown step type: ' + step.type);
  }

  if (!step.selector) return failed('target-not-found', 'could not resolve target: (none)');
  // Exact, unique selector hits only. A text/coordinate guess is a suggestion,
  // never an unreviewed action target.
  const found = anchor.resolveDetailed({ selector: step.selector, tag: step.tag });
  let el = found.el;
  let targetConfidence = found.confidence;
  if (el && found.confidence !== 'exact' && !opts.allowSuggested) {
    return failed('target-unconfirmed', 'target only matched by a fallback guess: ' + step.selector, {
      suggestion: { selector: describeEl(el), via: found.via },
    });
  }
  if (!el) {
    if (found.ambiguous) {
      return failed('ambiguous-target', `selector matches ${found.candidates} elements: ${step.selector}`, { candidates: found.candidates });
    }
    return failed('target-not-found', 'could not resolve target: ' + step.selector);
  }

  try {
    await scrollIntoView(el);
    await wait(fast ? 20 : 120);
    let point = pointFor(el, step);
    if (!fast) {
      cursor.show();
      await cursor.moveTo(point.x, point.y);
      await wait(140);
    } else {
      cursor.setPosition(point.x, point.y, { instant: true });
      cursor.show();
    }
    anchor.highlight(el, { duration: fast ? 200 : 700, color: '#3ddc97' });

    // Fail closed unless a user could really do this right now.
    const timeoutMs = Number.isFinite(opts.actionTimeoutMs) ? opts.actionTimeoutMs : fast ? 800 : 1500;
    const problem = await waitActionable(el, step.type, () => (point = pointFor(el, step)), timeoutMs);
    if (problem) {
      return failed(problem.reason, `${PROBLEM_TEXT[problem.reason] || problem.reason}: ${step.selector}`, {
        targetConfidence,
        ...(problem.coveredBy ? { coveredBy: problem.coveredBy } : {}),
      });
    }

    if (step.type === 'click') {
      if (!fast) await cursor.clickFlash(point.x, point.y);
      const react = watchReaction();
      firePointer(el, 'pointerdown', point);
      fireMouse(el, 'mousedown', point);
      firePointer(el, 'pointerup', point);
      fireMouse(el, 'mouseup', point);
      if (typeof el.click === 'function') {
        el.click();
      } else {
        fireMouse(el, 'click', point);
      }
      const reacted = await react.settle(fast ? 30 : 220);
      return done(reacted ? 'observed' : 'dispatchOnly', { targetConfidence });
    }

    if (step.type === 'input') {
      const r = await applyInput(el, step, opts, fast);
      if (r.ok && !fast) await wait(180);
      return r.ok ? { ...r, targetConfidence } : r;
    }

    // key
    const r = await pressKey(el, step, fast);
    if (r.ok && !fast) await wait(160);
    return r.ok ? { ...r, targetConfidence } : r;
  } catch (e) {
    return failed('step-error', String((e && e.message) || e));
  }
}

module.exports = { executeStep, evaluateAssert, cursor };
