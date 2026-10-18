'use strict';
// Conformance table for the shared assertion spec (src/shared/assertions.js).
//
// Every engine that evaluates journey assertions - src/webview/replay.js (live),
// the agent drivers, and the Playwright exporter's compiled output - must agree
// with this table. Cases are plain data:
//
//   name       unique, human-readable
//   assertion  the recorded assert step ({ kind, op?, selector?, expected? })
//   html       DOM fixture (body innerHTML) for engines that run against a DOM
//   url        page URL for the fixture
//   facts      what an engine observes on that fixture:
//              { matchCount, firstText, firstVisible, url }
//              (firstText is the RAW innerText; engines must not pre-normalise)
//   ok         the REQUIRED outcome (true = passed, false = failed)
//   domSafe    false when the case depends on layout (jsdom has none), i.e. only
//              `facts` is meaningful; true when evaluating `html` in any DOM works
//
// Add cases here, not in individual engine tests, so all engines stay equal.

const URL0 = 'https://example.test/app/Dashboard?tab=Billing#top';

const cases = [
  // ---- exists: >= 1 match, never "exactly one" --------------------------------
  { name: 'exists: single match passes', assertion: { kind: 'exists', selector: '.row' },
    html: '<div class="row">a</div>', url: URL0, facts: { matchCount: 1, firstText: 'a', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'exists: multiple matches pass', assertion: { kind: 'exists', selector: '.row' },
    html: '<div class="row">a</div><div class="row">b</div>', url: URL0, facts: { matchCount: 2, firstText: 'a', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'exists: no match fails', assertion: { kind: 'exists', selector: '.row' },
    html: '<p>nothing</p>', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },
  { name: 'exists: kind defaults to exists', assertion: { selector: '.row' },
    html: '<div class="row"></div>', url: URL0, facts: { matchCount: 1, firstText: '', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'exists: inspector UI is not page content', assertion: { kind: 'exists', selector: '.pin' },
    html: '<div data-caos="1"><span class="pin">x</span></div>', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },

  // ---- visible: first match; opacity:0 still visible --------------------------
  { name: 'visible: visible first match passes', assertion: { kind: 'visible', selector: '.row' },
    html: '<div class="row">a</div>', url: URL0, facts: { matchCount: 1, firstText: 'a', firstVisible: true, url: URL0 }, ok: true, domSafe: false },
  { name: 'visible: hidden first match fails', assertion: { kind: 'visible', selector: '.row' },
    html: '<div class="row" style="display:none">a</div>', url: URL0, facts: { matchCount: 1, firstText: '', firstVisible: false, url: URL0 }, ok: false, domSafe: false },
  { name: 'visible: absent fails', assertion: { kind: 'visible', selector: '.row' },
    html: '', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },
  { name: 'visible: only the FIRST match counts', assertion: { kind: 'visible', selector: '.row' },
    html: '<div class="row" style="display:none">a</div><div class="row">b</div>', url: URL0, facts: { matchCount: 2, firstText: '', firstVisible: false, url: URL0 }, ok: false, domSafe: false },
  { name: 'visible: opacity 0 is still visible', assertion: { kind: 'visible', selector: '.row' },
    html: '<div class="row" style="opacity:0">a</div>', url: URL0, facts: { matchCount: 1, firstText: 'a', firstVisible: true, url: URL0 }, ok: true, domSafe: false },

  // ---- text: contains (case-insensitive default), equals, matches ------------
  { name: 'text: default op is contains', assertion: { kind: 'text', selector: 'h1', expected: 'welcome' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: contains is case-insensitive', assertion: { kind: 'text', op: 'contains', selector: 'h1', expected: 'WELCOME BACK' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: contains miss fails', assertion: { kind: 'text', op: 'contains', selector: 'h1', expected: 'goodbye' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: contains normalises whitespace on both sides', assertion: { kind: 'text', op: 'contains', selector: 'p', expected: 'hello   big\n world' },
    html: '<p>  Hello big\n\t world!  </p>', url: URL0, facts: { matchCount: 1, firstText: '  Hello big\n\t world!  ', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: equals is case-sensitive', assertion: { kind: 'text', op: 'equals', selector: 'h1', expected: 'welcome back' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: equals normalises whitespace', assertion: { kind: 'text', op: 'equals', selector: 'h1', expected: 'Welcome back' },
    html: '<h1>\n  Welcome\n   back </h1>', url: URL0, facts: { matchCount: 1, firstText: '\n  Welcome\n   back ', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: equals is whole-string', assertion: { kind: 'text', op: 'equals', selector: 'h1', expected: 'Welcome' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: matches uses a case-sensitive regex', assertion: { kind: 'text', op: 'matches', selector: 'h1', expected: '^Welcome\\b' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: matches is case-sensitive', assertion: { kind: 'text', op: 'matches', selector: 'h1', expected: '^welcome' },
    html: '<h1>Welcome back</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome back', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: matches tests the whitespace-normalised text', assertion: { kind: 'text', op: 'matches', selector: 'p', expected: '^a b$' },
    html: '<p>a\n   b</p>', url: URL0, facts: { matchCount: 1, firstText: 'a\n   b', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'text: invalid regex fails, never passes', assertion: { kind: 'text', op: 'matches', selector: 'h1', expected: '(' },
    html: '<h1>Welcome</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: missing element fails', assertion: { kind: 'text', op: 'contains', selector: 'h1', expected: '' },
    html: '', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: compares the FIRST match only', assertion: { kind: 'text', op: 'contains', selector: 'li', expected: 'two' },
    html: '<ul><li>one</li><li>two</li></ul>', url: URL0, facts: { matchCount: 2, firstText: 'one', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'text: missing expected fails closed', assertion: { kind: 'text', op: 'contains', selector: 'h1' },
    html: '<h1>Welcome</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome', firstVisible: true, url: URL0 }, ok: false, domSafe: true },

  // ---- count: equals (default) / contains = at least ---------------------------
  { name: 'count: default op is equals (match)', assertion: { kind: 'count', selector: 'li', expected: 3 },
    html: '<li>1</li><li>2</li><li>3</li>', url: URL0, facts: { matchCount: 3, firstText: '1', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'count: equals rejects more', assertion: { kind: 'count', op: 'equals', selector: 'li', expected: 2 },
    html: '<li>1</li><li>2</li><li>3</li>', url: URL0, facts: { matchCount: 3, firstText: '1', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'count: contains means at least', assertion: { kind: 'count', op: 'contains', selector: 'li', expected: 2 },
    html: '<li>1</li><li>2</li><li>3</li>', url: URL0, facts: { matchCount: 3, firstText: '1', firstVisible: true, url: URL0 }, ok: true, domSafe: true },
  { name: 'count: contains fewer than N fails', assertion: { kind: 'count', op: 'contains', selector: 'li', expected: 4 },
    html: '<li>1</li><li>2</li><li>3</li>', url: URL0, facts: { matchCount: 3, firstText: '1', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'count: zero matches equals 0', assertion: { kind: 'count', selector: 'li', expected: '0' },
    html: '', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: true, domSafe: true },
  { name: 'count: non-numeric expected fails closed', assertion: { kind: 'count', selector: 'li', expected: 'many' },
    html: '<li>1</li>', url: URL0, facts: { matchCount: 1, firstText: '1', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'count: NaN-like expected never coerces to 0', assertion: { kind: 'count', selector: 'li', expected: '' },
    html: '', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },

  // ---- url ----------------------------------------------------------------------
  { name: 'url: default op is contains', assertion: { kind: 'url', expected: '/app/' },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: true, domSafe: true },
  { name: 'url: contains is case-insensitive', assertion: { kind: 'url', op: 'contains', expected: 'DASHBOARD' },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: true, domSafe: true },
  { name: 'url: equals is exact and case-sensitive', assertion: { kind: 'url', op: 'equals', expected: URL0.toLowerCase() },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },
  { name: 'url: equals exact match', assertion: { kind: 'url', op: 'equals', expected: URL0 },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: true, domSafe: true },
  { name: 'url: matches regex', assertion: { kind: 'url', op: 'matches', expected: 'tab=Billing$|tab=Billing#' },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: true, domSafe: true },
  { name: 'url: matches is case-sensitive', assertion: { kind: 'url', op: 'matches', expected: 'dashboard' },
    url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },

  // ---- fail closed ------------------------------------------------------------------
  { name: 'unknown kind fails closed even when the selector is absent', assertion: { kind: 'hasRainbow', selector: '.nope' },
    html: '', url: URL0, facts: { matchCount: 0, firstText: null, firstVisible: null, url: URL0 }, ok: false, domSafe: true },
  { name: 'unknown kind fails closed even when the selector matches', assertion: { kind: 'hasRainbow', selector: '.row' },
    html: '<div class="row"></div>', url: URL0, facts: { matchCount: 1, firstText: '', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'unknown op fails closed', assertion: { kind: 'text', op: 'startsWith', selector: 'h1', expected: 'Wel' },
    html: '<h1>Welcome</h1>', url: URL0, facts: { matchCount: 1, firstText: 'Welcome', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
  { name: 'selector-less selector assertion fails closed', assertion: { kind: 'exists' },
    html: '<div></div>', url: URL0, facts: { matchCount: 1, firstText: '', firstVisible: true, url: URL0 }, ok: false, domSafe: true },
];

// Controls: how a recorded input step must be driven (CE-07). `expect` is the
// action the Playwright compiler must emit and the live replay must perform.
const controlCases = [
  { name: 'text input -> fill', step: { type: 'input', selector: '#a', value: 'hi', tag: 'input' }, control: 'text', action: 'fill' },
  { name: 'textarea -> fill', step: { type: 'input', selector: '#a', value: 'hi', tag: 'textarea' }, control: 'text', action: 'fill' },
  { name: 'select -> selectOption', step: { type: 'input', selector: '#a', value: 'b', tag: 'select' }, control: 'select', action: 'selectOption' },
  { name: 'explicit multiselect -> selectOption([..])', step: { type: 'input', selector: '#a', value: ['a', 'b'], control: 'multiselect' }, control: 'multiselect', action: 'selectOption' },
  { name: 'array value infers multiselect', step: { type: 'input', selector: '#a', value: ['a'] }, control: 'multiselect', action: 'selectOption' },
  { name: 'boolean -> setChecked', step: { type: 'input', selector: '#a', value: true, tag: 'input' }, control: 'checkbox', action: 'setChecked' },
  { name: 'explicit radio -> setChecked', step: { type: 'input', selector: '#a', value: true, control: 'radio' }, control: 'radio', action: 'setChecked' },
  { name: 'secret -> runtime placeholder fill', step: { type: 'input', selector: '#a', secret: true }, control: 'secret', action: 'fillSecret' },
  { name: 'explicit control beats inference', step: { type: 'input', selector: '#a', value: 'x', tag: 'select', control: 'text' }, control: 'text', action: 'fill' },
];

module.exports = cases;
module.exports.cases = cases;
module.exports.controlCases = controlCases;
