'use strict';
// A review note as a checkable contract (src/shared/note-checks.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('../../src/shared/note-checks');
const A = require('../../src/shared/assertions');
const verify = require('../../src/main/services/review/verify');

const styleNote = (extra = {}) => ({ id: 'a1', kind: 'edit', action: 'change', status: 'open',
  target: { selector: '#cta', tag: 'button', text: 'Buy', locator: { by: 'role', role: 'button', name: 'Buy' } },
  edit: { type: 'style', css: 'color: red; padding: 8px 16px !important;', details: { props: { color: 'red', padding: '8px 16px !important' }, original: {} } }, ...extra });

test('a style note becomes one check per declaration, without !important', () => {
  const d = nc.deriveChecks(styleNote());
  assert.equal(d.unverifiable, null);
  assert.deepEqual(d.checks, [{ kind: 'style', expected: 'color: red' }, { kind: 'style', expected: 'padding: 8px 16px' }]);
});

test('declarations that could fetch or are not plain are skipped with a reason, never checked loosely', () => {
  const d = nc.deriveChecks(styleNote({ edit: { type: 'style', css: '', details: { props: { 'background-image': 'url(https://x.test/a.png)', color: 'blue' } } } }));
  assert.deepEqual(d.checks, [{ kind: 'style', expected: 'color: blue' }]);
  assert.equal(d.skipped.length, 1);
  assert.equal(d.skipped[0].what, 'background-image');
  const none = nc.deriveChecks(styleNote({ edit: { type: 'style', css: '', details: { props: { background: 'url(x)' } } } }));
  assert.ok(none.unverifiable);
});

test('copy, hide and remove notes each have their own check; css-only edits are parsed from the css text', () => {
  assert.deepEqual(nc.deriveChecks({ kind: 'edit', edit: { type: 'text', details: { before: 'Buy', after: '  Buy   now ' } } }).checks, [{ kind: 'text', expected: 'Buy now' }]);
  assert.deepEqual(nc.deriveChecks({ kind: 'edit', action: 'remove', edit: { type: 'hide', css: 'display: none;' } }).checks, [{ kind: 'style', expected: 'display: none' }]);
  assert.deepEqual(nc.deriveChecks({ kind: 'element', action: 'remove', note: 'drop this banner' }).checks, [{ kind: 'absent' }]);
  assert.deepEqual(nc.deriveChecks({ kind: 'edit', edit: { type: 'resize', css: 'width: 320px; height: 48px;' } }).checks.map((c) => c.expected), ['width: 320px', 'height: 48px']);
});

test('a written note and a structural edit are unverifiable, with the reason', () => {
  assert.match(nc.deriveChecks({ kind: 'element', action: 'fix', note: 'this feels cramped' }).unverifiable, /person/);
  assert.match(nc.deriveChecks({ kind: 'edit', edit: { type: 'reorder', details: { parentSelector: 'ul', fromIndex: 0, toIndex: 2 } } }).unverifiable, /journey assertion/);
  assert.match(nc.deriveChecks({ kind: 'region', action: 'remove' }).unverifiable, /person/);
});

test('plan assertions are valid in the closed assertion language and need a semantic target', () => {
  const p = nc.planAssertions(styleNote());
  assert.equal(p.ok, true);
  for (const a of p.assertions) {
    assert.equal(A.normalizeAssertion({ ...a, selector: 'x' }).ok, true);
    assert.deepEqual(a.target, { by: 'role', role: 'button', name: 'Buy' });
  }
  const noTarget = nc.planAssertions(styleNote({ target: { selector: 'div > span:nth-of-type(2)' } }));
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.code, 'NOTE_NO_SEMANTIC_TARGET');
  assert.equal(nc.planAssertions({ kind: 'element', note: 'hmm' }).code, 'NOTE_UNVERIFIABLE');
  assert.deepEqual(nc.planAssertions({ kind: 'element', action: 'remove', target: { locator: { by: 'testId', value: 'banner' } } }).assertions,
    [{ kind: 'count', op: 'equals', expected: '0', target: { by: 'testId', value: 'banner' } }]);
});

test('a copy edit on an element named by its text is addressed by the new copy', () => {
  const p = nc.planAssertions({ kind: 'edit', target: { locator: { by: 'role', role: 'button', name: 'Buy' } }, edit: { type: 'text', details: { before: 'Buy', after: 'Buy now' } } });
  assert.deepEqual(p.assertions, [{ kind: 'text', op: 'equals', expected: 'Buy now', target: { by: 'role', role: 'button', name: 'Buy now' } }]);
  const byId = nc.planAssertions({ kind: 'edit', target: { locator: { by: 'testId', value: 'cta' } }, edit: { type: 'text', details: { before: 'Buy', after: 'Buy now' } } });
  assert.deepEqual(byId.target, { by: 'testId', value: 'cta' });
});

test('grading: all passed is fixed; a real failure is not-fixed; a missing element is unknown, never fixed', () => {
  assert.equal(nc.gradeNote([{ status: 'passed' }, { status: 'passed' }]), 'fixed');
  assert.equal(nc.gradeNote([{ status: 'passed' }, { status: 'failed' }]), 'not-fixed');
  assert.equal(nc.gradeNote([{ status: 'failed', missing: true }]), 'unknown');
  assert.equal(nc.gradeNote([{ status: 'passed' }, { status: 'unknown' }]), 'unknown');
  assert.equal(nc.gradeNote([]), 'unknown');
  assert.equal(nc.verdictFor({ status: 'resolved' }, 'not-fixed'), 'regressed');
  assert.equal(nc.verdictFor({ status: 'open' }, 'not-fixed'), 'not-fixed');
  assert.equal(nc.verdictFor({ status: 'resolved' }, 'unknown'), 'unknown');
  assert.equal(nc.verdictFor({}, null), 'unverifiable');
});

test('the style assertion: grammar, evaluation and fail-closed behaviour', () => {
  assert.deepEqual(A.parseStyleDeclaration('color:  red '), { property: 'color', value: 'red' });
  assert.deepEqual(A.parseStyleDeclaration('--brand-gap: 4px'), { property: '--brand-gap', value: '4px' });
  for (const bad of ['color', 'color: red; top: 0', 'background: url(x)', 'color: red !important', 'COLOR: red', 'x: }', 'width: expression(1)', 'a: ' + 'x'.repeat(201)]) {
    assert.equal(A.parseStyleDeclaration(bad), null, bad);
  }
  const step = { kind: 'style', selector: '#a', expected: 'color: red' };
  assert.equal(A.evaluate(step, { matchCount: 1, style: { supported: true, actual: 'rgb(255, 0, 0)', expected: 'rgb(255, 0, 0)' } }).status, 'passed');
  assert.equal(A.evaluate(step, { matchCount: 1, style: { supported: true, actual: 'rgb(0, 0, 0)', expected: 'rgb(255, 0, 0)' } }).status, 'failed');
  assert.equal(A.evaluate(step, { matchCount: 1, style: { supported: false, actual: 'rgb(0, 0, 0)', expected: null } }).status, 'failed');
  assert.equal(A.evaluate(step, { matchCount: 1 }).status, 'failed', 'an engine with no style facts never passes');
  assert.equal(A.evaluate(step, { matchCount: 0, style: { supported: true, actual: 'a', expected: 'a' } }).status, 'failed');
  assert.equal(A.normalizeAssertion({ kind: 'style', selector: '#a', expected: 'color: red', op: 'contains' }).ok, false);
});

test('a verify run reports per-note verdicts and fails when an exact change is not on the page', () => {
  const audit = { status: 'completed', total: 2, counts: {} };
  const base = { notes: { open: 1, total: 2 }, before: { audit }, after: { audit } };
  const items = [
    { id: 'a1', verdict: 'fixed', checks: [{ kind: 'style', expected: 'color: red', actual: 'color: rgb(255, 0, 0)', status: 'passed' }] },
    { id: 'a2', verdict: 'unverifiable', reason: 'a written note', checks: [] },
  ];
  const ok = verify.buildRun({ ...base, after: { audit, noteChecks: { status: 'completed', url: 'https://x.test/', items } } }, { sessionId: 's' });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.noteChecks.fixed, 1);
  assert.equal(ok.noteChecks.unverifiable, 1);

  const bad = verify.buildRun({ ...base, after: { audit, noteChecks: { status: 'completed', items: [{ id: 'a1', verdict: 'not-fixed', checks: [] }] } } }, { sessionId: 's' });
  assert.equal(bad.status, 'failed');
  assert.match(bad.reason, /not fixed/);
  const reg = verify.buildRun({ ...base, after: { audit, noteChecks: { status: 'completed', items: [{ id: 'a1', verdict: 'regressed', checks: [] }] } } }, { sessionId: 's' });
  assert.match(reg.reason, /no longer hold/);

  // A grading that did not complete contributes nothing: no counts, no failure, no green from it.
  const timedOut = verify.buildRun({ ...base, after: { audit, noteChecks: { status: 'timedOut', items: [{ id: 'a1', verdict: 'fixed', checks: [] }] } } }, { sessionId: 's' });
  assert.equal(timedOut.noteChecks.total, 0);
  assert.equal(timedOut.noteChecks.status, 'timedOut');
  const bogus = verify.buildRun({ ...base, after: { audit, noteChecks: { status: 'completed', items: [{ id: 'a1', verdict: 'totally-fine', checks: [] }] } } }, { sessionId: 's' });
  assert.equal(bogus.noteChecks.total, 0);
  const none = verify.buildRun(base, { sessionId: 's' });
  assert.equal(none.noteChecks.status, 'missing');
});
