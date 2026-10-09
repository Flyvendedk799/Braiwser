'use strict';
// compare-fix 1.0.0 — rerun the SAME frozen assertions against a baseline and a
// candidate deployment and report what changed. Two ORCHESTRATED runs (one per
// side) whose plans are identical except for the origin they navigate to. This
// module never edits an assertion, accepts a new baseline or marks a finding
// fixed to make a changed implementation pass:
//   * the frozen-assertion digest of both sides must equal the digest computed
//     at planning time, otherwise the comparison is unavailable;
//   * comparability (route/fixture/viewport/locale/profile) is decided by the
//     caller-supplied environmentKey folded into the comparison key;
//   * the exact expected baseline/candidate application revisions are checked by
//     review/verdict.js auditDelta, which also refuses failed/missing/errored
//     checks (a failed audit is never "zero findings");
//   * "fixed" requires the baseline to have actually reproduced the defect.
const { z } = require('zod');
const wf = require('../workflow-core');
const { auditDelta } = require('../../review/verdict');
const { id, RegistryError } = require('./_shared');

const manifest = Object.freeze({
  id: 'compare-fix',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Compare a fix against its baseline',
  description: 'Run one journey\'s frozen assertions on a baseline and a candidate origin and report fixed / regressed / not reproduced, or why the comparison is unavailable.',
  executor: 'orchestrator',
  requires: ['navigate', 'interact', 'assert'],
  maxDurationMs: 300000,
});

const origin = z.string().max(300).refine((v) => {
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v; }
  catch (_e) { return false; }
}, 'Expected a bare http(s) origin');
const revision = z.string().min(1).max(120);

const inputSchema = z.strictObject({
  recordingId: id,
  baselineOrigin: origin,
  candidateOrigin: origin,
  expectedBaselineRevision: revision,
  expectedCandidateRevision: revision,
  // Names everything that must be equal for the two sides to be comparable
  // (fixture/data set, locale, auth profile, rule version). Supplied by the human.
  environmentKey: z.string().min(1).max(200),
}).superRefine((v, ctx) => {
  if (v.expectedBaselineRevision === v.expectedCandidateRevision) {
    ctx.addIssue({ code: 'custom', path: ['expectedCandidateRevision'],
      message: 'Baseline and candidate must be different application revisions' });
  }
});

function rebase(url, base) {
  const u = new URL(url);
  return new URL(u.pathname + u.search + u.hash, base).toString();
}

// Digest of the assertions + actions with every origin erased. Equal for both
// sides by construction; recomputed from each side's plan at compare time.
function frozenDigest(plan) {
  const p = wf.validateWorkflow(plan);
  return wf.digestOf({
    inputKeys: p.inputKeys,
    steps: p.steps.map((s) => (s.type === 'navigate'
      ? { ...s, url: (() => { const u = new URL(s.url); return u.pathname + u.search + u.hash; })() } : s)),
  });
}

function compile(inputs, ctx = {}) {
  const parsed = inputSchema.parse(inputs);
  if (typeof ctx.loadRecording !== 'function') {
    throw new RegistryError('UNAVAILABLE', 'No recording loader is configured for compare-fix.');
  }
  const recording = ctx.loadRecording(parsed.recordingId);
  if (recording && typeof recording.then === 'function') throw new RegistryError('UNAVAILABLE', 'The recording loader must be synchronous.');
  if (!recording) throw new RegistryError('RECORDING_NOT_FOUND', 'The recording does not exist or is not visible to this principal.');
  const migrated = wf.recordingToWorkflow(recording, { skillId: manifest.id, version: manifest.version,
    maxDurationMs: Math.min(ctx.maxDurationMs || 120000, manifest.maxDurationMs) });
  if (!migrated.ok) {
    throw new RegistryError('RECORDING_NOT_MIGRATABLE',
      'The recording contains steps the closed workflow language refuses.', { refused: migrated.refused.slice(0, 50) });
  }
  const side = (base) => wf.validateWorkflow({
    ...migrated.plan,
    steps: migrated.plan.steps.map((s) => (s.type === 'navigate' ? { ...s, url: rebase(s.url, base) } : s)),
  });
  const baselinePlan = side(parsed.baselineOrigin);
  const candidatePlan = side(parsed.candidateOrigin);
  const frozen = frozenDigest(baselinePlan);
  if (frozen !== frozenDigest(candidatePlan)) {
    throw new RegistryError('INTERNAL', 'Baseline and candidate plans diverged beyond their origin.');
  }
  return {
    baselinePlan, candidatePlan, frozenDigest: frozen,
    baselinePlanDigest: wf.digestOf(baselinePlan), candidatePlanDigest: wf.digestOf(candidatePlan),
    runInputs: migrated.suggestedInputs, dropped: migrated.dropped, warnings: migrated.warnings,
  };
}

const STEP = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);

function assertionIds(plan) {
  return wf.validateWorkflow(plan).steps.filter((s) => s.type === 'assert').map((s) => s.id);
}

// Turn one side's finished run into the report shape auditDelta expects, without
// trusting any field that the broker did not produce.
function toReport(side, expectedFrozen, plan, environmentKey) {
  if (!side || typeof side !== 'object' || !side.run || typeof side.run !== 'object' || !Array.isArray(side.stepResults)) {
    return { report: null, reason: 'missing_report' };
  }
  const run = side.run;
  const ids = new Set(assertionIds(plan));
  const results = new Map();
  for (const r of side.stepResults) {
    if (!r || typeof r.stepId !== 'string' || !STEP.has(r.status) || results.has(r.stepId)) {
      return { report: null, reason: 'invalid_step_results' };
    }
    results.set(r.stepId, r.status);
  }
  // The check completed only if the grader reached passed/failed with every
  // assertion decided and no uncertain effect. Anything else is "not passed".
  const decided = [...ids].every((stepId) => results.get(stepId) === 'passed' || results.get(stepId) === 'failed');
  const completed = (run.verdict === 'passed' || run.verdict === 'failed') && decided && run.uncertainEffect !== true;
  const failedAssertions = [...ids].filter((stepId) => results.get(stepId) === 'failed');
  const frozenMatches = side.frozenDigest === expectedFrozen && frozenDigest(plan) === expectedFrozen;
  if (!frozenMatches) return { report: null, reason: 'frozen_assertions_changed' };
  return {
    report: {
      status: completed ? 'passed' : (run.verdict || 'unknown'),
      total: failedAssertions.length,
      comparisonKey: wf.digestOf({ frozen: expectedFrozen, environmentKey, viewport: side.viewport || null }),
      evidenceIds: run.evidenceComplete === true && Array.isArray(side.evidenceIds) ? side.evidenceIds : [],
      appRevision: side.appRevision,
    },
    failedAssertions, results,
  };
}

// compare({ baseline, candidate }, { frozenDigest, baselinePlan, candidatePlan, skillInputs })
// skillInputs are the validated compare-fix inputs (expected revisions, environmentKey).
// side = { run: RunDTO, stepResults:[{stepId,status}], appRevision, frozenDigest, viewport?, evidenceIds[] }
function compare(sides, planning) {
  const { baselinePlan, candidatePlan, skillInputs: inputs } = planning;
  const expectedFrozen = planning.frozenDigest;
  const b = toReport(sides.baseline, expectedFrozen, baselinePlan, inputs.environmentKey);
  const c = toReport(sides.candidate, expectedFrozen, candidatePlan, inputs.environmentKey);
  const unavailable = (reason) => ({ available: false, verdict: 'unavailable', reason, delta: null, assertions: [],
    fixed: [], regressed: [], remaining: [], frozenDigest: expectedFrozen });
  if (!b.report) return unavailable(`baseline:${b.reason}`);
  if (!c.report) return unavailable(`candidate:${c.reason}`);
  const delta = auditDelta({ baseline: b.report, candidate: c.report,
    expectedBaselineRevision: inputs.expectedBaselineRevision,
    expectedCandidateRevision: inputs.expectedCandidateRevision });
  if (!delta.available) return unavailable(delta.reason);

  const rows = [...assertionIds(baselinePlan)].map((stepId) => {
    const before = b.results.get(stepId), after = c.results.get(stepId);
    let change = 'unchanged';
    if (before === 'failed' && after === 'passed') change = 'fixed';
    else if (before === 'passed' && after === 'failed') change = 'regressed';
    else if (before === 'failed' && after === 'failed') change = 'still-failing';
    else if (before === 'passed' && after === 'passed') change = 'still-passing';
    return { stepId, baseline: before, candidate: after, change };
  });
  const fixed = rows.filter((r) => r.change === 'fixed').map((r) => r.stepId);
  const regressed = rows.filter((r) => r.change === 'regressed').map((r) => r.stepId);
  const remaining = rows.filter((r) => r.change === 'still-failing').map((r) => r.stepId);
  let verdict;
  if (regressed.length) verdict = 'regressed';
  else if (b.failedAssertions.length === 0) verdict = 'not-reproduced'; // baseline never showed the defect: no fix claim
  else if (remaining.length === 0) verdict = 'fixed';
  else if (fixed.length) verdict = 'partially-fixed';
  else verdict = 'not-fixed';
  return {
    available: true, verdict, reason: null, delta: delta.delta, assertions: rows,
    fixed, regressed, remaining, frozenDigest: expectedFrozen,
    baselineRevision: sides.baseline.appRevision, candidateRevision: sides.candidate.appRevision,
  };
}

module.exports = { manifest, inputSchema, compile, compare, frozenDigest, sourceFile: __filename };
