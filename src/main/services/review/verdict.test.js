'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runVerdict, auditDelta } = require('./verdict.js');
const step = (stepId, status = 'passed', effect = 'confirmed') => ({ stepId, status, effect, evidenceIds: ['ev1'] });
const report = (total, extra = {}) => ({ status: 'passed', total, comparisonKey: 'fixture/route/viewport/rules-v1',
  appRevision: 'base', evidenceIds: ['ev1'], ...extra });
const pair = (extra = {}) => ({ baseline: report(12), candidate: report(0, { appRevision: 'fixed' }),
  expectedBaselineRevision: 'base', expectedCandidateRevision: 'fixed', ...extra });

test('only the complete proven plan passes', () => {
  const r = runVerdict({ plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [step('a'), step('b')], terminal: 'completed', evidenceComplete: true });
  assert.equal(r.status, 'passed'); assert.equal(r.planned, 2); assert.equal(r.passed, 2);
});
test('cancellation never shrinks planned count to completed count', () => {
  const r = runVerdict({ plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [step('a')], terminal: 'cancelled' });
  assert.equal(r.status, 'cancelled'); assert.equal(r.planned, 2); assert.equal(r.pending, 1);
});
test('partial, empty and unsupported plans cannot become a pass', () => {
  assert.equal(runVerdict({ plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], results: [step('a')], terminal: 'completed', evidenceComplete: true }).status, 'unknown');
  assert.equal(runVerdict({ plannedStepIds: [], assertionStepIds: [], results: [], terminal: 'completed', evidenceComplete: true }).status, 'unknown');
  assert.equal(runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'], results: [step('a', 'unknown')], terminal: 'completed', evidenceComplete: true }).status, 'unknown');
});
test('dispatch alone and missing evidence cannot prove success', () => {
  for (const r of [step('a', 'passed', 'dispatched'), step('a', 'passed', 'unknown'), { ...step('a'), evidenceIds: [] }]) {
    assert.equal(runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'], results: [r], terminal: 'completed', evidenceComplete: true }).status, 'unknown');
  }
});
test('timeout preserves uncertainty rather than retry permission', () => {
  const r = runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'], results: [step('a', 'timedOut', 'unknown')], terminal: 'timedOut' });
  assert.equal(r.status, 'timedOut'); assert.equal(r.uncertainEffect, true);
});
test('foreign and duplicate step results are rejected', () => {
  assert.throws(() => runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'], results: [step('b')], terminal: 'completed', evidenceComplete: true }), /INVALID_STEP_RESULT/);
  assert.throws(() => runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'], results: [step('a'), step('a')], terminal: 'completed', evidenceComplete: true }), /INVALID_STEP_RESULT/);
});
test('valid zero-findings report gives an honest before/after delta across expected revisions', () => {
  assert.deepEqual(auditDelta(pair()), { available: true, delta: -12, reason: null });
});
test('error, missing, legacy, skipped and invalid reports never become zero improvement', () => {
  for (const candidate of [null, {}, { total: 0 }, report(0, { error: 'timeout' }), report(0, { status: 'skipped' }), report(-1)]) {
    const r = auditDelta(pair({ candidate })); assert.equal(r.available, false); assert.equal(r.delta, null);
  }
});
test('context mismatch and an unexpected deployed revision suppress comparison', () => {
  assert.equal(auditDelta(pair({ candidate: report(0, { appRevision: 'fixed', comparisonKey: 'other' }) })).reason, 'incomparable_context');
  assert.equal(auditDelta(pair({ candidate: report(0, { appRevision: 'wrong-deployment' }) })).reason, 'unexpected_application_revision');
});


test('missing assertion plan or uncommitted manifest cannot pass', () => {
  for (const extra of [{ assertionStepIds: [] }, { evidenceComplete: false }]) {
    assert.equal(runVerdict({ plannedStepIds: ['a'], assertionStepIds: ['a'],
      results: [step('a')], terminal: 'completed', evidenceComplete: true, ...extra }).status, 'unknown');
  }
});
test('read-only assertion can pass but an undispatched action cannot', () => {
  const good = runVerdict({ plannedStepIds: ['a', 'b'], assertionStepIds: ['b'],
    results: [step('a'), step('b', 'passed', 'notDispatched')], terminal: 'completed', evidenceComplete: true });
  assert.equal(good.status, 'passed'); assert.equal(good.requiredAssertions, 1); assert.equal(good.passedAssertions, 1);
  const bad = runVerdict({ plannedStepIds: ['a', 'b'], assertionStepIds: ['b'],
    results: [step('a', 'passed', 'notDispatched'), step('b')], terminal: 'completed', evidenceComplete: true });
  assert.equal(bad.status, 'unknown'); assert.equal(bad.unknown, 1); assert.equal(bad.passed, 1);
});
