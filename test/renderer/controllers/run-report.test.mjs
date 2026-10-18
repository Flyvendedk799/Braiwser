import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runVerdict, buildReplayReport, describeReplay, auditOutcome, auditComparable, auditToVerifyPayload, journeyToVerifyPayload } from '../../../src/renderer/controllers/run-report.js';

const require = createRequire(import.meta.url);
const cjs = require('../../../src/main/services/review/verdict.js');

const ok = (stepId, extra) => ({ stepId, status: 'passed', effect: 'confirmed', evidenceIds: ['e-' + stepId], ...extra });
const FIXTURES = {
  'all passed with assertion': { plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [ok('a'), { stepId: 'b', status: 'passed', effect: 'notDispatched', evidenceIds: ['x'] }], terminal: 'completed', evidenceComplete: true },
  'all passed but no assertion plan': { plannedStepIds: ['a'], assertionStepIds: [], results: [ok('a')], terminal: 'completed', evidenceComplete: true },
  'passed without evidence is unknown': { plannedStepIds: ['a'], assertionStepIds: ['a'], results: [{ stepId: 'a', status: 'passed', effect: 'confirmed', evidenceIds: [] }], terminal: 'completed', evidenceComplete: true },
  'dispatched-only is unproven': { plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [{ stepId: 'a', status: 'passed', effect: 'dispatched', evidenceIds: ['e'] }, { stepId: 'b', status: 'passed', effect: 'notDispatched', evidenceIds: ['x'] }], terminal: 'completed', evidenceComplete: true },
  'one failed': { plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [ok('a'), { stepId: 'b', status: 'failed', effect: 'unknown', evidenceIds: [] }], terminal: 'completed', evidenceComplete: true },
  'timed out step': { plannedStepIds: ['a'], assertionStepIds: [], results: [{ stepId: 'a', status: 'timedOut', effect: 'unknown', evidenceIds: [] }], terminal: 'completed' },
  'cancelled step': { plannedStepIds: ['a'], assertionStepIds: [], results: [{ stepId: 'a', status: 'cancelled', effect: 'unknown', evidenceIds: [] }], terminal: 'completed' },
  'terminal cancelled wins': { plannedStepIds: ['a', 'b'], assertionStepIds: [], results: [ok('a')], terminal: 'cancelled' },
  'terminal timedOut wins': { plannedStepIds: ['a'], assertionStepIds: [], results: [], terminal: 'timedOut' },
  'pending steps are not a pass': { plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [ok('a')], terminal: 'completed', evidenceComplete: true },
  'all skipped': { plannedStepIds: ['a', 'b'], assertionStepIds: [], results: [{ stepId: 'a', status: 'skipped', effect: 'notDispatched', evidenceIds: [] }, { stepId: 'b', status: 'skipped', effect: 'notDispatched', evidenceIds: [] }], terminal: 'completed' },
  'empty plan': { plannedStepIds: [], assertionStepIds: [], results: [], terminal: 'completed', evidenceComplete: true },
  'uncertain effect': { plannedStepIds: ['a'], assertionStepIds: [], results: [{ stepId: 'a', status: 'failed', effect: 'unknown', evidenceIds: [] }], terminal: 'failed' },
  'terminal unknown': { plannedStepIds: ['a'], assertionStepIds: ['a'], results: [], terminal: 'unknown' },
};
const INVALID = {
  'duplicate planned ids': { plannedStepIds: ['a', 'a'], assertionStepIds: [], results: [], terminal: 'completed' },
  'assertion not planned': { plannedStepIds: ['a'], assertionStepIds: ['z'], results: [], terminal: 'completed' },
  'bad terminal': { plannedStepIds: ['a'], assertionStepIds: [], results: [], terminal: 'weird' },
  'unknown step id': { plannedStepIds: ['a'], assertionStepIds: [], results: [ok('zzz')], terminal: 'completed' },
  'duplicate result': { plannedStepIds: ['a'], assertionStepIds: [], results: [ok('a'), ok('a')], terminal: 'completed' },
  'bad status': { plannedStepIds: ['a'], assertionStepIds: [], results: [{ stepId: 'a', status: 'meh', effect: 'confirmed', evidenceIds: [] }], terminal: 'completed' },
  'not arrays': { plannedStepIds: 'a', assertionStepIds: [], results: [], terminal: 'completed' },
};

test('parity: renderer runVerdict port == CJS verdict.js on the shared fixture table', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    assert.deepEqual({ ...runVerdict(input) }, { ...cjs.runVerdict(input) }, name);
  }
});

test('parity: invalid runs throw the same TypeError code', () => {
  for (const [name, input] of Object.entries(INVALID)) {
    let a, b;
    try { runVerdict(input); } catch (e) { a = e; }
    try { cjs.runVerdict(input); } catch (e) { b = e; }
    assert.ok(a instanceof TypeError && b instanceof TypeError, name);
    assert.equal(a.message, b.message, name);
  }
});

const steps = [
  { type: 'navigate', url: 'http://x/', ts: 1 },
  { type: 'click', selector: '#a', ts: 2 },
  { type: 'assert', kind: 'exists', selector: '#b', ts: 3 },
];
const row = (i, type, status, extra) => ({ i, type, selector: '', status, error: '', ...extra });

test('RF-03: a full clean run is passed; total is the planned count', () => {
  const r = buildReplayReport({ steps, terminal: 'completed', results: [row(0, 'navigate', 'passed'), row(1, 'click', 'passed', { effect: 'confirmed' }), row(2, 'assert:exists', 'passed')] });
  assert.equal(r.status, 'passed');
  assert.equal(r.total, 3);
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 0);
  assert.equal(describeReplay(r).tone, 'success');
});

test('RF-03: cancelled after the first step is NOT passed and keeps the planned total', () => {
  const r = buildReplayReport({ steps, terminal: 'cancelled', results: [row(0, 'navigate', 'passed')] });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.total, 3);
  assert.equal(r.executed, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[2].status, 'skipped');
  assert.match(describeReplay(r).text, /cancelled/);
  assert.notEqual(describeReplay(r).tone, 'success');
});

test('RF-03: failed / timed out navigation never yields a green verdict', () => {
  const failed = buildReplayReport({ steps, terminal: 'completed', results: [row(0, 'navigate', 'failed', { error: 'ERR_NAME_NOT_RESOLVED' })] });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failed, 1);
  const timed = buildReplayReport({ steps, terminal: 'completed', results: [row(0, 'navigate', 'timedOut')] });
  assert.equal(timed.status, 'timedOut');
  assert.equal(timed.failed, 1);
  assert.equal(describeReplay(timed).tone, 'error');
});

test('RF-03: no steps completed -> skipped/cancelled, never passed', () => {
  assert.equal(buildReplayReport({ steps, terminal: 'completed', results: [] }).status, 'skipped');
  assert.equal(buildReplayReport({ steps, terminal: 'cancelled', results: [] }).status, 'cancelled');
  const allSkipped = buildReplayReport({ steps, terminal: 'completed', results: steps.map((s, i) => row(i, s.type, 'skipped')) });
  assert.equal(allSkipped.status, 'skipped');
});

test('dispatch-only click is unproven unless a LATER assertion passed', () => {
  const dispatchOnly = row(1, 'click', 'passed', { effect: 'dispatchOnly' });
  const without = buildReplayReport({ steps: steps.slice(0, 2), terminal: 'completed', results: [row(0, 'navigate', 'passed'), dispatchOnly] });
  assert.equal(without.status, 'unknown');
  assert.equal(without.unknown, 1);
  assert.equal(without.steps[1].unproven, true);
  assert.match(describeReplay(without).text, /no confirmed effect/);
  const withPost = buildReplayReport({ steps, terminal: 'completed', results: [row(0, 'navigate', 'passed'), dispatchOnly, row(2, 'assert:exists', 'passed')] });
  assert.equal(withPost.status, 'passed');
  const failedPost = buildReplayReport({ steps, terminal: 'completed', results: [row(0, 'navigate', 'passed'), dispatchOnly, row(2, 'assert:exists', 'failed')] });
  assert.equal(failedPost.status, 'failed');
});

test('RF-04: audit failure / timeout / skip / abandon are never a zero total', () => {
  const failed = auditOutcome({ error: 'boom', total: 0, findings: [] });
  const timed = auditOutcome({ error: 'slow', total: 0 }, { timedOut: true });
  const skipped = auditOutcome(null, { skipped: true });
  const gone = auditOutcome(null, { cancelled: true });
  const none = auditOutcome(null);
  for (const o of [failed, timed, skipped, gone, none]) {
    assert.equal(o.ok, false);
    assert.equal(o.total, null);
  }
  assert.deepEqual([failed.status, timed.status, skipped.status, gone.status, none.status], ['failed', 'timedOut', 'skipped', 'cancelled', 'unknown']);
  const good = auditOutcome({ total: 12, counts: { critical: 1 } });
  const clean = auditOutcome({ total: 0, counts: {} });
  assert.equal(good.status, 'findings');
  assert.equal(clean.status, 'passed');
  assert.ok(auditComparable(good, clean));
  for (const bad of [failed, timed, skipped, gone, none]) assert.ok(!auditComparable(good, bad));
});

test('RF-04: verify payload keeps failures explicit (null total, status, error)', () => {
  const p = auditToVerifyPayload(auditOutcome({ error: 'Audit timed out', total: 0 }, { timedOut: true }), { url: 'u' });
  assert.equal(p.status, 'timedOut');
  assert.equal(p.total, null);
  assert.match(p.error, /timed out/);
  assert.equal(p.url, 'u');
  assert.equal(auditToVerifyPayload(auditOutcome({ total: 3, counts: { minor: 3 } })).status, 'completed');
  assert.equal(auditToVerifyPayload(null), null);
});

test('journey payload carries planned count + terminal', () => {
  const r = buildReplayReport({ steps, terminal: 'cancelled', results: [row(0, 'navigate', 'passed')] });
  const j = journeyToVerifyPayload({ id: 'r1', name: 'J' }, r);
  assert.equal(j.planned, 3);
  assert.equal(j.terminal, 'cancelled');
  assert.equal(j.passed, 1);
  assert.equal(j.skipped, 2);
  assert.equal(journeyToVerifyPayload({}, null), null);
});
