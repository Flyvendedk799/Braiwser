'use strict';
// Proposed pure module for the shared run/Verify contract. It does not run a
// browser, authenticate evidence, or authorize actions. Broker/adapter/schema
// boundaries must first validate ownership and produce these immutable facts.
const STEP_STATES = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);
const EFFECT_STATES = new Set(['notDispatched', 'dispatched', 'confirmed', 'unknown']);
const TERMINALS = new Set(['completed', 'failed', 'cancelled', 'timedOut', 'unknown']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = x => Number.isSafeInteger(x) && x >= 0;

function runVerdict({ plannedStepIds, assertionStepIds, results, terminal, evidenceComplete = false }) {
  if (!Array.isArray(plannedStepIds) || !Array.isArray(assertionStepIds)
      || !Array.isArray(results) || !TERMINALS.has(terminal)
      || typeof evidenceComplete !== 'boolean'
      || plannedStepIds.some(x => typeof x !== 'string' || !x)
      || assertionStepIds.some(x => typeof x !== 'string' || !x)
      || new Set(plannedStepIds).size !== plannedStepIds.length
      || new Set(assertionStepIds).size !== assertionStepIds.length) {
    throw new TypeError('INVALID_RUN');
  }
  const planned = new Set(plannedStepIds), assertions = new Set(assertionStepIds), seen = new Set();
  if ([...assertions].some(id => !planned.has(id))) throw new TypeError('INVALID_ASSERTION_PLAN');
  const counts = Object.fromEntries([...STEP_STATES].map(k => [k, 0]));
  let passedAssertions = 0;
  for (const r of results) {
    if (!object(r) || !planned.has(r.stepId) || seen.has(r.stepId)
        || !STEP_STATES.has(r.status) || !EFFECT_STATES.has(r.effect)
        || !Array.isArray(r.evidenceIds) || r.evidenceIds.some(x => typeof x !== 'string' || !x)) {
      throw new TypeError('INVALID_STEP_RESULT');
    }
    seen.add(r.stepId);
    // Assertions may be read-only; successful actions must have confirmed
    // effects. Evidence IDs refer to broker-validated assertion/receipt records.
    const proven = r.status === 'passed' && r.evidenceIds.length > 0
      && (r.effect === 'confirmed' || (assertions.has(r.stepId) && r.effect === 'notDispatched'));
    counts[r.status === 'passed' && !proven ? 'unknown' : r.status]++;
    if (proven && assertions.has(r.stepId)) passedAssertions++;
  }
  let status = 'unknown';
  if (terminal !== 'completed') status = terminal;
  else if (counts.failed) status = 'failed';
  else if (counts.timedOut) status = 'timedOut';
  else if (counts.cancelled) status = 'cancelled';
  else if (planned.size > 0 && assertions.size > 0 && evidenceComplete
      && counts.passed === planned.size && passedAssertions === assertions.size) status = 'passed';
  else if (planned.size > 0 && counts.skipped === planned.size) status = 'skipped';
  return Object.freeze({ status, planned: planned.size,
    // Executed means a step was entered, not that its external effect succeeded.
    executed: results.length - counts.skipped,
    passed: counts.passed, failed: counts.failed, skipped: counts.skipped,
    cancelled: counts.cancelled, timedOut: counts.timedOut,
    pending: planned.size - results.length, unknown: counts.unknown,
    requiredAssertions: assertions.size, passedAssertions, evidenceComplete,
    uncertainEffect: results.some(r => r.effect === 'unknown') });
}

// The caller supplies a comparison key generated from target route, fixture,
// viewport, locale, auth profile and audit/rule schema. It is not raw page input.
// App revisions are intentionally DIFFERENT for a before/after fix; the exact
// expected revision pair is checked independently and retained in the report.
function auditDelta({ baseline, candidate, expectedBaselineRevision, expectedCandidateRevision }) {
  const reason = report => {
    if (!object(report)) return 'missing_report';
    if (report.status !== 'passed') return 'check_not_passed';
    if (report.error) return 'check_error';
    if (!count(report.total)) return 'invalid_total';
    if (typeof report.comparisonKey !== 'string' || !report.comparisonKey) return 'missing_context';
    if (!Array.isArray(report.evidenceIds) || report.evidenceIds.length === 0
        || report.evidenceIds.some(x => typeof x !== 'string' || !x)) return 'missing_evidence';
    return null;
  };
  const baselineReason = reason(baseline), candidateReason = reason(candidate);
  if (baselineReason || candidateReason) return { available: false, delta: null,
    reason: baselineReason ? `baseline:${baselineReason}` : `candidate:${candidateReason}` };
  if (baseline.comparisonKey !== candidate.comparisonKey) return { available: false, delta: null,
    reason: 'incomparable_context' };
  if (typeof expectedBaselineRevision !== 'string' || !expectedBaselineRevision
      || typeof expectedCandidateRevision !== 'string' || !expectedCandidateRevision
      || baseline.appRevision !== expectedBaselineRevision
      || candidate.appRevision !== expectedCandidateRevision) {
    return { available: false, delta: null, reason: 'unexpected_application_revision' };
  }
  return { available: true, delta: candidate.total - baseline.total, reason: null };
}

module.exports = { runVerdict, auditDelta };
