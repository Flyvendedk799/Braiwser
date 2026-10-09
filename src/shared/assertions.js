'use strict';
// ONE assertion specification, shared by every engine that evaluates a recorded
// journey assertion:
//   - the Playwright exporter (src/main/services/export/playwright.js) compiles
//     it to @playwright/test code;
//   - the live replay (src/webview/replay.js) and the agent drivers
//     (browser/drivers/*) evaluate it against the DOM / page facts;
//   - test/shared/assertions.table.js is the conformance table every
//     engine must satisfy (CE-07, CE-06).
//
// Pure data + pure functions. No DOM, no Node-only APIs, so the module can be
// bundled into the guest preload as well as required from main.
//
// ---------------------------------------------------------------------------
// Semantics (the contract)
//
//   Matching   A selector matches only the page's own content; the inspector's
//              own UI ([data-caos], #__caos_root) is never counted or matched.
//   exists     passes when the selector has >= 1 match (NOT exactly one).
//   visible    passes when the FIRST match is visible: it has a non-empty box and
//              neither display:none nor visibility:hidden. opacity:0 is still
//              "visible" (this is Playwright's definition, so both engines agree).
//   text       compares the FIRST match's text. Text is innerText (textContent
//              as fallback) with every run of whitespace collapsed to one space
//              and trimmed; the expected string is normalised the same way.
//                contains  case-INSENSITIVE substring (default op)
//                equals    case-sensitive, whole-string, after normalisation
//                matches   JS RegExp (no flags) tested against the normalised
//                          text; an invalid pattern FAILS, it never passes
//   count      number of matches vs a finite non-negative integer.
//                equals    exactly N (default op)
//                contains  at least N
//   url        compares the page's full URL string.
//                contains  case-insensitive substring (default op)
//                equals    exact, case-sensitive
//                matches   JS RegExp (no flags)
//   anything else (unknown kind/op, missing selector/expected where required)
//              FAILS CLOSED: status 'failed' with a reason - never a pass.
//   Engine/transport problems (page gone, timeout) are 'unknown', decided by the
//   caller; evaluate() itself only returns 'passed' | 'failed'.
//
// Controls / actions recorded on steps (so exporters need not guess):
//   step.type    navigate | click | input | key | scroll | assert
//   step.control for type=input: text | select | multiselect | checkbox | radio | secret
//                (legacy steps without it are inferred by controlOfStep()).
//     text         fill(value)
//     select       selectOption(value)            (single <select>)
//     multiselect  selectOption([values])         (<select multiple>)
//     checkbox     setChecked(boolean)
//     radio        setChecked(true) / check()
//     secret       value is NEVER stored; replays use a runtime placeholder
// ---------------------------------------------------------------------------

const KINDS = Object.freeze(['exists', 'visible', 'text', 'count', 'url']);

// op allowed per kind. `null` => the kind takes no op.
const OPS = Object.freeze({
  exists: null,
  visible: null,
  text: Object.freeze(['contains', 'equals', 'matches']),
  count: Object.freeze(['equals', 'contains']),
  url: Object.freeze(['contains', 'equals', 'matches']),
});

const DEFAULT_OP = Object.freeze({ text: 'contains', count: 'equals', url: 'contains' });
const NEEDS_SELECTOR = Object.freeze({ exists: true, visible: true, text: true, count: true, url: false });
const NEEDS_EXPECTED = Object.freeze({ exists: false, visible: false, text: true, count: true, url: true });

const STEP_TYPES = Object.freeze(['navigate', 'click', 'input', 'key', 'scroll', 'assert']);
const CONTROLS = Object.freeze(['text', 'select', 'multiselect', 'checkbox', 'radio', 'secret']);

const MAX_SELECTOR = 2000;
const MAX_EXPECTED = 4000;
const MAX_COUNT = 1e9;

// Whitespace runs -> single space, trimmed. Applied to BOTH sides of a text compare.
function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isKind(kind) { return typeof kind === 'string' && KINDS.includes(kind); }

function fail(error) { return { ok: false, error }; }

// Validate + canonicalise an assertion step. Returns
//   { ok:true, assertion:{ kind, op, selector, expected } }   or   { ok:false, error }
// `expected` is a string for text/url, a finite integer for count, undefined otherwise.
// Never throws, never mutates the input.
function normalizeAssertion(step) {
  if (!step || typeof step !== 'object') return fail('assertion is not an object');
  const kind = step.kind == null || step.kind === '' ? 'exists' : step.kind;
  if (!isKind(kind)) return fail('unsupported assertion kind');

  let op;
  if (OPS[kind] === null) {
    op = undefined;
  } else {
    op = step.op == null || step.op === '' ? DEFAULT_OP[kind] : step.op;
    if (typeof op !== 'string' || !OPS[kind].includes(op)) return fail(`unsupported operation for ${kind} assertion`);
  }

  let selector;
  if (NEEDS_SELECTOR[kind]) {
    if (typeof step.selector !== 'string' || !step.selector.trim()) return fail(`${kind} assertion has no selector`);
    if (step.selector.length > MAX_SELECTOR) return fail('assertion selector is too long');
    selector = step.selector;
  }

  let expected;
  if (NEEDS_EXPECTED[kind]) {
    if (kind === 'count') {
      const raw = step.expected;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) return fail('count assertion needs a non-negative integer');
      expected = n;
    } else {
      if (step.expected == null) return fail(`${kind} assertion has no expected value`);
      if (typeof step.expected === 'object') return fail(`${kind} assertion expected value must be text`);
      expected = String(step.expected);
      if (expected.length > MAX_EXPECTED) return fail('assertion expected value is too long');
      if (op === 'matches') {
        try { new RegExp(expected); } catch (_e) { return fail('assertion pattern is not a valid regular expression'); }
      }
    }
  }
  return { ok: true, assertion: { kind, op, selector, expected } };
}

function compareText(op, actual, expected, { normalize = true } = {}) {
  const a = normalize ? normalizeText(actual) : String(actual == null ? '' : actual);
  const e = normalize ? normalizeText(expected) : String(expected == null ? '' : expected);
  if (op === 'equals') return a === e;
  if (op === 'matches') {
    try { return new RegExp(String(expected == null ? '' : expected)).test(a); } catch (_e) { return false; }
  }
  if (op === 'contains') return a.toLowerCase().includes(e.toLowerCase());
  return false; // unknown op fails closed
}

// facts: what an engine observed. All fields optional; missing => not observed.
//   matchCount   number of own-UI-excluded matches of the selector
//   firstText    raw text (innerText/textContent) of the first match, or null if none
//   firstVisible boolean visibility of the first match, or null if none
//   url          the page URL
// Returns { ok, status:'passed'|'failed', actual, error }.
function evaluate(step, facts = {}) {
  const n = normalizeAssertion(step);
  if (!n.ok) return { ok: false, status: 'failed', actual: '', error: n.error };
  const { kind, op, selector, expected } = n.assertion;
  const matchCount = Number.isInteger(facts.matchCount) ? facts.matchCount : 0;
  const done = (ok, actual, error) => ({ ok, status: ok ? 'passed' : 'failed', actual, error: ok ? '' : error });

  switch (kind) {
    case 'exists':
      return done(matchCount >= 1, matchCount >= 1 ? 'present' : 'absent', `not found: ${selector}`);
    case 'visible': {
      if (matchCount < 1) return done(false, 'absent', `not found: ${selector}`);
      const vis = facts.firstVisible === true;
      return done(vis, vis ? 'visible' : 'hidden', `not visible: ${selector}`);
    }
    case 'count': {
      const ok = op === 'contains' ? matchCount >= expected : matchCount === expected;
      return done(ok, matchCount, `count ${matchCount} ${op === 'contains' ? '>=' : '='} ${expected} failed`);
    }
    case 'text': {
      if (matchCount < 1 || facts.firstText == null) return done(false, '(no element)', `not found: ${selector}`);
      const text = normalizeText(facts.firstText);
      const ok = compareText(op, text, expected);
      return done(ok, text.slice(0, 80), `text "${text.slice(0, 40)}" ${op} "${expected.slice(0, 80)}" failed`);
    }
    case 'url': {
      const url = String(facts.url == null ? '' : facts.url);
      const ok = compareText(op, url, expected, { normalize: false });
      return done(ok, url.slice(0, 200), `url "${url.slice(0, 80)}" ${op} "${expected.slice(0, 80)}" failed`);
    }
    default:
      return done(false, '', 'unsupported assertion kind');
  }
}

// Which control a recorded input step drives. Explicit `control` wins; legacy steps
// (no `control`) are inferred from the tag recorded by describeTarget and the
// value's type, never from the selector string.
function controlOfStep(step) {
  if (!step || typeof step !== 'object') return 'text';
  if (typeof step.control === 'string' && CONTROLS.includes(step.control)) return step.control;
  if (step.secret === true) return 'secret';
  if (typeof step.value === 'boolean') return 'checkbox';
  if (Array.isArray(step.value)) return 'multiselect';
  if (String(step.tag || '').toLowerCase() === 'select') return 'select';
  return 'text';
}

module.exports = {
  KINDS, OPS, DEFAULT_OP, STEP_TYPES, CONTROLS,
  normalizeText, normalizeAssertion, compareText, evaluate, controlOfStep, isKind,
};
