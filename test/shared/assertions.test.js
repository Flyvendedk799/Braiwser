'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const A = require('../../src/shared/assertions');
const { cases, controlCases } = require('./assertions.table');

test('table case names are unique', () => {
  const names = cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

for (const c of cases) {
  test(`evaluate(facts): ${c.name}`, () => {
    const r = A.evaluate(c.assertion, c.facts);
    assert.equal(r.ok, c.ok, JSON.stringify(r));
    assert.equal(r.status, c.ok ? 'passed' : 'failed');
    if (!c.ok) assert.ok(r.error, 'failures carry a reason');
  });
}

// The `facts` in the table must be what a DOM engine would actually observe for
// `html`, otherwise the table would be conformance to itself only.
function factsFromDom(dom, assertion) {
  const { document } = dom.window;
  const own = (el) => !(el.closest && el.closest('[data-caos], #__caos_root'));
  const sel = assertion.selector;
  let list = [];
  try { list = sel ? Array.from(document.querySelectorAll(sel)).filter(own) : []; } catch (_e) { list = []; }
  const first = list[0];
  return {
    matchCount: list.length,
    firstText: first ? first.innerText || first.textContent : null,
    firstVisible: first ? true : null,
    url: dom.window.location.href,
  };
}

for (const c of cases.filter((x) => x.domSafe)) {
  test(`evaluate(jsdom): ${c.name}`, () => {
    const dom = new JSDOM(`<!doctype html><body>${c.html || ''}</body>`, { url: c.url });
    const facts = factsFromDom(dom, c.assertion);
    // jsdom has no innerText; textContent is the same for these fixtures once normalised.
    const r = A.evaluate(c.assertion, facts);
    assert.equal(r.ok, c.ok, JSON.stringify({ r, facts }));
  });
}

test('normalizeAssertion rejects hostile or malformed input without throwing', () => {
  for (const bad of [null, undefined, 5, 'x', [], { kind: {} }, { kind: 'text', selector: 's', op: 'x', expected: 'a' },
    { kind: 'count', selector: 's', expected: 1.5 }, { kind: 'count', selector: 's', expected: -1 },
    { kind: 'count', selector: 's', expected: Infinity }, { kind: 'url', op: 'matches', expected: '[' },
    { kind: 'text', selector: 's', expected: { toString() { return 'x'; } } }]) {
    assert.equal(A.normalizeAssertion(bad).ok, false, JSON.stringify(bad));
  }
  const ok = A.normalizeAssertion({ kind: 'count', selector: 'li', expected: '3' });
  assert.deepEqual(ok.assertion, { kind: 'count', op: 'equals', selector: 'li', expected: 3 });
});

for (const c of controlCases) {
  test(`controlOfStep: ${c.name}`, () => {
    assert.equal(A.controlOfStep(c.step), c.control);
  });
}
