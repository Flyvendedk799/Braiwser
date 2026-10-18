// Verify panel: explicit outcome states with text + icon, planned vs ran counts,
// audit errors visible with retry, and NO improvement number or green claim for
// anything that was not a comparable, completed pair of audits (RF-04 UI side).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click } from './dom-env.mjs';

const { document } = setupDom();
const { createVerifyPanel, normalizeRun } = await load('components/verify-panel.js');

const audit = (status, total, extra = {}) => ({ status, total: status === 'completed' ? total : null, counts: {}, error: '', reason: status === 'completed' ? '' : status, ...extra });
const journey = (over = {}) => ({
  id: 'r1', name: 'Checkout', at: null, source: 'verdict', status: 'passed',
  planned: 4, executed: 4, passed: 4, failed: 0, skipped: 0, cancelled: 0, timedOut: 0, pending: 0, unknown: 0, total: 4, ...over,
});
const runOf = (over = {}) => {
  const a = { before: audit('completed', 12), after: audit('completed', 3), deltaAvailable: true, delta: -9, reason: null, ...(over.audit || {}) };
  const j = over.journey === undefined ? journey() : over.journey;
  return {
    v: 2, at: '2026-01-01T00:00:00.000Z', notesOpen: 1, notesTotal: 3, status: 'verified', reason: '',
    audit: a, journey: j,
    before: { audit: a.before, journey: null, screenshot: '' }, after: { audit: a.after, journey: j, screenshot: '' },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['audit', 'journey'].includes(k))),
  };
};

function mount(actions = {}) {
  const panel = createVerifyPanel({ run: () => {}, ...actions });
  document.body.appendChild(panel.root);
  panel.setPageReady(true);
  return panel;
}
const text = (panel) => panel.root.textContent.replace(/\s+/g, ' ');
const pillOf = (panel, label) => Array.from(panel.root.querySelectorAll('.verify-pill')).find((p) => p.querySelector('.vp-label').textContent === label);

test('a comparable completed pair shows the change, and only then', () => {
  const p = mount();
  p.setRun(runOf());
  const change = pillOf(p, 'Audit change');
  assert.equal(change.querySelector('.vp-value').textContent, '-9');
  assert.ok(change.classList.contains('tone-good'));
  assert.match(text(p), /Verified/);
  assert.ok(p.root.querySelector('.verify-headline').classList.contains('tone-good'));
});

test('regression (RF-04): baseline 12, after audit timed out => no -12, no green, error + retry shown', () => {
  let retried = 0;
  const p = mount({ retryAudit: () => retried++ });
  p.setRun(runOf({
    status: 'inconclusive', reason: 'audit comparison unavailable (after:timedOut)',
    audit: { after: audit('timedOut', null, { error: 'Audit timed out' }), deltaAvailable: false, delta: null, reason: 'after:timedOut' },
    journey: null,
  }));
  const t = text(p);
  assert.doesNotMatch(t, /-12|−12/);
  assert.equal(pillOf(p, 'Audit change').querySelector('.vp-value').textContent, '—');
  assert.ok(!pillOf(p, 'Audit change').classList.contains('tone-good'));
  assert.ok(!pillOf(p, 'Audit after').classList.contains('tone-good'));
  assert.equal(pillOf(p, 'Audit after').querySelector('.vp-value').textContent, '—', 'no 0 findings claimed');
  assert.match(t, /Timed out/);
  assert.match(t, /Audit timed out/, 'the error text is rendered');
  assert.match(t, /Inconclusive/);
  assert.equal(p.root.querySelector('.verify-headline').classList.contains('tone-good'), false);
  assert.equal(p.root.querySelectorAll('.tone-good').length, 0, 'nothing on the page is green');
  const retry = p.root.querySelector('.verify-retry');
  assert.ok(retry && !retry.disabled);
  click(retry);
  assert.equal(retried, 1);
});

test('retry falls back to the full verify when no retryAudit action exists', () => {
  let ran = 0;
  const p = mount({ run: () => ran++ });
  p.setRun(runOf({ audit: { after: audit('error', null, { error: 'boom' }), deltaAvailable: false, delta: null, reason: 'after:error' } }));
  click(p.root.querySelector('.verify-retry'));
  assert.equal(ran, 1);
});

test('every audit failure state renders text + icon, never a number', () => {
  const labels = { error: 'Error', timedOut: 'Timed out', skipped: 'Skipped', cancelled: 'Cancelled', missing: 'No result' };
  for (const [status, label] of Object.entries(labels)) {
    const p = mount();
    p.setRun(runOf({ audit: { after: audit(status, null), deltaAvailable: false, delta: null, reason: 'after:' + status } }));
    const chip = pillOf(p, 'Audit after').querySelector('.verify-state');
    assert.equal(chip.querySelector('.vs-label').textContent, label, status);
    assert.ok(chip.querySelector('svg'), status + ' has an icon');
    assert.equal(pillOf(p, 'Audit after').querySelector('.vp-value').textContent, '—');
    assert.match(pillOf(p, 'Audit change').textContent, /after audit/i);
  }
});

test('a missing baseline is explained, not shown as 0', () => {
  const p = mount();
  p.setRun(runOf({ audit: { before: audit('missing', null), deltaAvailable: false, delta: null, reason: 'baseline:missing' } }));
  assert.match(pillOf(p, 'Audit change').textContent, /baseline audit/i);
  assert.equal(pillOf(p, 'Audit before').querySelector('.vp-value').textContent, '—');
});

test('an incomparable context reads as unavailable with its reason', () => {
  const p = mount();
  p.setRun(runOf({ audit: { deltaAvailable: false, delta: null, reason: 'incomparable_context' } }));
  assert.match(pillOf(p, 'Audit change').textContent, /different page, viewport or rule set/);
  assert.equal(pillOf(p, 'Audit change').querySelector('.vp-value').textContent, '—');
});

test('a worsening comparable pair is red, and +N is signed', () => {
  const p = mount();
  p.setRun(runOf({ status: 'failed', reason: '2 more audit finding(s) than before', audit: { after: audit('completed', 14), delta: 2 } }));
  const change = pillOf(p, 'Audit change');
  assert.equal(change.querySelector('.vp-value').textContent, '+2');
  assert.ok(change.classList.contains('tone-bad'));
  assert.match(text(p), /Failed/);
});

test('journey states: explicit text + icon, planned vs ran counts', () => {
  const cases = [
    ['passed', 'Passed'], ['failed', 'Failed'], ['cancelled', 'Cancelled'],
    ['timedOut', 'Timed out'], ['skipped', 'Skipped'], ['unknown', 'Unknown'],
  ];
  for (const [status, label] of cases) {
    const p = mount();
    p.setRun(runOf({ journey: journey({ status, planned: 5, executed: 2, passed: 2, pending: 3 }) }));
    const chip = p.root.querySelector('.verify-journey .verify-state');
    assert.equal(chip.querySelector('.vs-label').textContent, label);
    assert.ok(chip.querySelector('svg'));
    assert.match(p.root.querySelector('.vj-counts').textContent, /2 of 5 planned steps ran/);
    assert.match(p.root.querySelector('.vj-detail').textContent, /3 not run/);
  }
});

test('a cancelled journey with unrun steps is not green even if the audit improved', () => {
  const p = mount();
  p.setRun(runOf({ status: 'inconclusive', reason: 'journey cancelled', journey: journey({ status: 'cancelled', planned: 4, executed: 1, passed: 1, cancelled: 1, pending: 2 }) }));
  assert.equal(p.root.querySelector('.verify-journey').classList.contains('tone-good'), false);
  assert.equal(p.root.querySelector('.verify-headline').classList.contains('tone-good'), false);
  assert.match(p.root.querySelector('.vj-counts').textContent, /1 of 4 planned steps ran/);
});

test('legacy runs: comparison unavailable, no delta, no green, errors surfaced', () => {
  const legacy = {
    at: '2025-01-01T00:00:00.000Z', notesOpen: 0, notesTotal: 2,
    before: { audit: { total: 12, counts: {} }, journey: null, screenshot: '' },
    after: { audit: { total: 0, counts: {}, error: 'Audit timed out' }, journey: { passed: 2, failed: 0, total: 2 }, screenshot: '' },
    delta: { audit: -12, journeyFailed: 0, notesOpen: 0 },
  };
  const p = mount();
  p.setRun(legacy);
  const t = text(p);
  assert.match(t, /legacy: comparison unavailable/);
  assert.doesNotMatch(t, /-12|−12/);
  assert.match(t, /Audit timed out/);
  assert.equal(p.root.querySelectorAll('.tone-good').length, 0);
  assert.equal(pillOf(p, 'Audit change').querySelector('.vp-value').textContent, '—');
  // legacy journey counts cannot prove completeness
  assert.equal(p.root.querySelector('.verify-journey .vs-label').textContent, 'Unknown');
  assert.match(p.root.querySelector('.vj-counts').textContent, /legacy|planned/);
});

test('normalizeRun is idempotent for v2 and lifts v1', () => {
  const v2 = runOf();
  assert.equal(normalizeRun(v2), v2);
  assert.equal(normalizeRun({ before: {}, after: {} }).legacy, true);
  assert.equal(normalizeRun(null), null);
});

test('empty state, then run button honours running / page-ready', () => {
  const p = createVerifyPanel({ run: () => {} });
  document.body.appendChild(p.root);
  assert.match(p.root.textContent, /Prove the fix/);
  const btn = p.root.querySelector('.verify-bar button');
  assert.equal(btn.disabled, true);
  p.setPageReady(true);
  assert.equal(btn.disabled, false);
  p.setRunning(true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  p.setRun(runOf({ audit: { after: audit('error', null), deltaAvailable: false, delta: null, reason: 'after:error' } }));
  assert.equal(p.root.querySelector('.verify-retry').disabled, true, 'retry also waits while running');
  p.setRunning(false);
  assert.equal(p.root.querySelector('.verify-retry').disabled, false);
});
