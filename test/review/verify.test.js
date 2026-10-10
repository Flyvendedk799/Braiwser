'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../src/main/services/review/verify');

const ok = (total, extra = {}) => ({ total, counts: { critical: total }, ...extra });
const completeJourney = (over = {}) => ({ id: 'r1', name: 'J', at: 't', planned: 3, passed: 3, failed: 0, total: 3, ...over });

function run(before, after, extra = {}) {
  return V.buildRun({ notes: { open: 2, total: 5 }, before, after, ...extra }, { sessionId: 's1' });
}

test('RF-04: baseline 12 + after timeout is NOT a -12 improvement', () => {
  const r = run({ audit: ok(12) }, { audit: { error: 'The page did not answer the audit in time.', total: 0, counts: {} } });
  assert.equal(r.audit.deltaAvailable, false);
  assert.equal(r.audit.delta, null);
  assert.equal(r.audit.after.status, 'timedOut');
  assert.equal(r.audit.after.total, null);
  assert.match(r.audit.after.error, /did not answer/);
  assert.equal(r.audit.reason, 'after:timedOut');
  assert.equal(r.delta.audit, null);
  assert.equal(r.status, 'inconclusive');
});

test('RF-04: null report (audit already running) is missing, never a clean zero', () => {
  const r = run({ audit: ok(12) }, { audit: null });
  assert.equal(r.audit.after.status, 'missing');
  assert.equal(r.audit.after.total, null);
  assert.equal(r.audit.deltaAvailable, false);
  assert.equal(r.status, 'inconclusive');
});

test('RF-04: missing baseline is unavailable too', () => {
  const r = run({ audit: null }, { audit: ok(0) });
  assert.equal(r.audit.reason, 'baseline:missing');
  assert.equal(r.audit.delta, null);
});

test('RF-04: explicit skipped / cancelled / error statuses are preserved with reasons', () => {
  const skipped = run({ audit: ok(3) }, { audit: { status: 'skipped', reason: 'already_running' } });
  assert.equal(skipped.audit.after.status, 'skipped');
  assert.equal(skipped.audit.after.reason, 'already_running');
  assert.equal(skipped.audit.reason, 'after:skipped');
  const cancelled = run({ audit: ok(3) }, { audit: { status: 'cancelled' } });
  assert.equal(cancelled.audit.reason, 'after:cancelled');
  const errored = run({ audit: ok(3) }, { audit: { error: 'boom', total: 0 } });
  assert.equal(errored.audit.after.status, 'error');
  assert.equal(errored.audit.after.error, 'boom');
});

test('RF-04: a "completed" report with a bogus total or an error is not completed', () => {
  assert.equal(V.auditSummary({ status: 'completed', total: -1 }).status, 'missing');
  assert.equal(V.auditSummary({ status: 'completed', total: 1.5 }).status, 'missing');
  assert.equal(V.auditSummary({ status: 'completed', total: 0, error: 'x' }).status, 'error');
  assert.equal(V.auditSummary({ total: '5' }).status, 'missing');
  assert.equal(V.auditSummary({ total: NaN }).status, 'missing');
});

test('RF-04: both audits completed -> numeric delta, improvement is real', () => {
  const r = run({ audit: ok(12) }, { audit: ok(2) });
  assert.equal(r.audit.deltaAvailable, true);
  assert.equal(r.audit.delta, -10);
  assert.equal(r.audit.reason, null);
  assert.equal(r.delta.audit, -10);
  assert.equal(r.status, 'verified');
  assert.equal(r.audit.before.total, 12);
});

test('RF-04: a genuine zero is distinguishable from a failed audit', () => {
  const r = run({ audit: ok(4) }, { audit: ok(0) });
  assert.equal(r.audit.after.status, 'completed');
  assert.equal(r.audit.after.total, 0);
  assert.equal(r.audit.delta, -4);
});

test('RF-04: more findings after is a failure, not an improvement', () => {
  const r = run({ audit: ok(1) }, { audit: ok(5) });
  assert.equal(r.audit.delta, 4);
  assert.equal(r.status, 'failed');
});

test('RF-04: audits of different pages are incomparable', () => {
  const r = run({ audit: ok(1, { url: 'https://a.test/x#1' }) }, { audit: ok(0, { url: 'https://a.test/y' }) });
  assert.equal(r.audit.deltaAvailable, false);
  assert.equal(r.audit.reason, 'incomparable_context');
  const same = run({ audit: ok(1, { url: 'https://a.test/x#1' }) }, { audit: ok(0, { url: 'https://a.test/x#2' }) });
  assert.equal(same.audit.deltaAvailable, true);
});

test('journey: complete all-pass with known plan is passed', () => {
  const r = run({ audit: ok(2) }, { audit: ok(1), journey: completeJourney() });
  assert.equal(r.journey.status, 'passed');
  assert.deepEqual([r.journey.planned, r.journey.executed, r.journey.passed, r.journey.pending], [3, 3, 3, 0]);
  assert.equal(r.status, 'verified');
});

test('journey: cancelled partial replay (2 of 5 ran, all passed) is not a pass', () => {
  const r = run({ audit: ok(2) }, { audit: ok(1), journey: completeJourney({ planned: 5, passed: 2, total: 2, cancelled: true }) });
  assert.equal(r.journey.status, 'cancelled');
  assert.equal(r.journey.pending, 3);
  assert.equal(r.status, 'inconclusive');
});

test('journey: legacy counts without a planned total cannot prove a pass', () => {
  const r = run({ audit: ok(2) }, { audit: ok(1), journey: { passed: 3, failed: 0, total: 3 } });
  assert.equal(r.journey.status, 'unknown');
  assert.equal(r.status, 'inconclusive');
});

test('journey: failed, timed out, skipped, zero-planned', () => {
  assert.equal(V.journeySummary(completeJourney({ passed: 2, failed: 1 })).status, 'failed');
  assert.equal(V.journeySummary(completeJourney({ passed: 2, timedOut: 1 })).status, 'timedOut');
  assert.equal(V.journeySummary(completeJourney({ passed: 0, skipped: 3 })).status, 'skipped');
  assert.equal(V.journeySummary({ planned: 0, passed: 0, failed: 0, total: 0 }).status, 'unknown');
  assert.equal(V.journeySummary(completeJourney({ passed: 2 })).pending, 1, 'unaccounted step is pending');
  assert.equal(V.journeySummary(completeJourney({ passed: 2 })).status, 'unknown');
});

test('journey: failed journey marks the run failed even when the audit improved', () => {
  const r = run({ audit: ok(2) }, { audit: ok(0), journey: completeJourney({ passed: 2, failed: 1 }) });
  assert.equal(r.status, 'failed');
  assert.equal(r.delta.journeyFailed, 1);
});

test('journey: step-level facts go through runVerdict', () => {
  const j = {
    plannedStepIds: ['a', 'b'], assertionStepIds: ['b'], terminal: 'completed', evidenceComplete: true,
    steps: [
      { stepId: 'a', status: 'passed', effect: 'confirmed', evidenceIds: ['e1'] },
      { stepId: 'b', status: 'passed', effect: 'notDispatched', evidenceIds: ['e2'] },
    ],
  };
  const pass = V.journeySummary(j);
  assert.equal(pass.source, 'verdict');
  assert.equal(pass.status, 'passed');
  const noEvidence = V.journeySummary({ ...j, steps: [{ stepId: 'a', status: 'passed', effect: 'dispatched', evidenceIds: ['e1'] }, j.steps[1]] });
  assert.equal(noEvidence.status, 'unknown');
  assert.equal(noEvidence.unknown, 1);
  const malformed = V.journeySummary({ ...j, steps: [{ stepId: 'zzz', status: 'passed' }] });
  assert.equal(malformed.status, 'unknown');
  assert.equal(V.journeySummary({ ...j, terminal: 'cancelled' }).status, 'cancelled');
});

test('legacy stored runs lift to v2 with deltaAvailable:false reason legacy', () => {
  const legacy = {
    at: '2026-01-01T00:00:00Z', notesOpen: 1, notesTotal: 2,
    before: { audit: { total: 12, counts: { critical: 3 }, error: '' }, journey: { id: 'r', name: 'J', passed: 3, failed: 0, total: 3 }, screenshot: '' },
    after: { audit: { total: 0, counts: {}, error: 'Audit timed out' }, journey: null, screenshot: '' },
    delta: { audit: -12, journeyFailed: null, notesOpen: 1 },
  };
  const n = V.normalizeStoredRun(legacy);
  assert.equal(n.legacy, true);
  assert.equal(n.audit.deltaAvailable, false);
  assert.equal(n.audit.reason, 'legacy');
  assert.equal(n.audit.delta, null);
  assert.equal(n.delta.audit, null, 'the stored -12 is never replayed');
  assert.equal(n.audit.after.status, 'timedOut');
  assert.equal(n.audit.after.total, null);
  assert.equal(n.audit.before.total, 12);
  assert.equal(n.status, 'inconclusive');
  assert.equal(V.normalizeStoredRun(null), null);
  assert.equal(V.normalizeStoredRun(n), n, 'idempotent');
});

function fakeRepos(initial) {
  const sessions = new Map([['s1', { id: 's1', ...initial }]]);
  return {
    sessions: {
      get: (id) => sessions.get(id) || null,
      update: (id, patch) => { const s = { ...sessions.get(id), ...patch }; sessions.set(id, s); return s; },
    },
  };
}

test('saveRun persists v2 and upgrades previous legacy runs; listRuns reads legacy safely', () => {
  const legacy = { at: 'x', before: { audit: { total: 5, counts: {} } }, after: { audit: { total: 0, error: 'e' } }, delta: { audit: -5 } };
  const repos = fakeRepos({ verifyRuns: [legacy] });
  assert.equal(V.listRuns(repos, 's1')[0].audit.reason, 'legacy');
  const saved = V.saveRun(repos, 's1', { notes: { open: 1, total: 1 }, before: { audit: ok(3) }, after: { audit: ok(1) } });
  assert.equal(saved.ok, true);
  const stored = repos.sessions.get('s1').verifyRuns;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].v, 2);
  assert.equal(stored[0].audit.deltaAvailable, false);
  assert.equal(stored[1].audit.delta, -2);
  assert.equal(V.saveRun(repos, 'nope', {}).ok, false);
});

test('saveRun keeps at most 5 runs and drops oversized screenshots', () => {
  const repos = fakeRepos({});
  for (let i = 0; i < 7; i++) V.saveRun(repos, 's1', { before: { audit: ok(1) }, after: { audit: ok(1), screenshot: 'x'.repeat(400000) } });
  const runs = V.listRuns(repos, 's1');
  assert.equal(runs.length, 5);
  assert.equal(runs[4].after.screenshot, '');
});

test('buildRun tolerates garbage payloads', () => {
  for (const p of [undefined, null, 5, 'x', [], { before: 5, after: [], notes: 'n' }]) {
    const r = V.buildRun(p, {});
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.audit.deltaAvailable, false);
  }
});
