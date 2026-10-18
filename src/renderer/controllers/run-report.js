// Run/verify outcome model for the renderer. Pure ESM (no DOM) so it is unit
// testable and so a green result can only come from facts, never from the
// absence of failures.
//
// runVerdict() is a renderer-local PORT of src/main/services/review/verdict.js
// (the renderer cannot require() CommonJS). test/renderer/run-report.parity.test.mjs
// asserts the two stay in lock-step on a shared fixture table.

export const STEP_STATES = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);
export const EFFECT_STATES = new Set(['notDispatched', 'dispatched', 'confirmed', 'unknown']);
export const TERMINALS = new Set(['completed', 'failed', 'cancelled', 'timedOut', 'unknown']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// `requireAssertions` is a renderer-only extension (default true == CJS
// behaviour, the one the parity test pins). A recorded UI journey with no
// assertion step has nothing to "prove"; the replay adapter passes false so such
// a journey can still be `passed` when every step ran and was acknowledged.
export function runVerdict({ plannedStepIds, assertionStepIds, results, terminal, evidenceComplete = false }, { requireAssertions = true } = {}) {
  if (!Array.isArray(plannedStepIds) || !Array.isArray(assertionStepIds)
      || !Array.isArray(results) || !TERMINALS.has(terminal)
      || typeof evidenceComplete !== 'boolean'
      || plannedStepIds.some((x) => typeof x !== 'string' || !x)
      || assertionStepIds.some((x) => typeof x !== 'string' || !x)
      || new Set(plannedStepIds).size !== plannedStepIds.length
      || new Set(assertionStepIds).size !== assertionStepIds.length) {
    throw new TypeError('INVALID_RUN');
  }
  const planned = new Set(plannedStepIds), assertions = new Set(assertionStepIds), seen = new Set();
  if ([...assertions].some((id) => !planned.has(id))) throw new TypeError('INVALID_ASSERTION_PLAN');
  const counts = Object.fromEntries([...STEP_STATES].map((k) => [k, 0]));
  let passedAssertions = 0;
  for (const r of results) {
    if (!object(r) || !planned.has(r.stepId) || seen.has(r.stepId)
        || !STEP_STATES.has(r.status) || !EFFECT_STATES.has(r.effect)
        || !Array.isArray(r.evidenceIds) || r.evidenceIds.some((x) => typeof x !== 'string' || !x)) {
      throw new TypeError('INVALID_STEP_RESULT');
    }
    seen.add(r.stepId);
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
  else if (planned.size > 0 && (!requireAssertions || assertions.size > 0) && evidenceComplete
      && counts.passed === planned.size && passedAssertions === assertions.size) status = 'passed';
  else if (planned.size > 0 && counts.skipped === planned.size) status = 'skipped';
  return Object.freeze({ status, planned: planned.size,
    executed: results.length - counts.skipped,
    passed: counts.passed, failed: counts.failed, skipped: counts.skipped,
    cancelled: counts.cancelled, timedOut: counts.timedOut,
    pending: planned.size - results.length, unknown: counts.unknown,
    requiredAssertions: assertions.size, passedAssertions, evidenceComplete,
    uncertainEffect: results.some((r) => r.effect === 'unknown') });
}

// ------------------------------------------------------------ replay report
const stepId = (i) => 's' + i;

// Map one UI replay step outcome onto the verdict's step result.
//   outcome: { status:'passed'|'failed'|'timedOut'|'cancelled'|'skipped', kind }
function toVerdictResult(i, step, r, postcondition) {
  const isAssert = step && step.type === 'assert';
  if (r.status === 'passed') {
    // A guest step that only DISPATCHED events (effect 'dispatchOnly', needs a
    // postcondition) proved nothing: it stays unproven (verdict 'unknown') unless
    // a later assertion step passed.
    if (!isAssert && r.effect === 'dispatchOnly' && postcondition === undefined) {
      return { stepId: stepId(i), status: 'passed', effect: 'dispatched', evidenceIds: ['ack:' + i] };
    }
    const ev = postcondition !== undefined && !isAssert && r.effect === 'dispatchOnly' ? 'post:' + postcondition : (isAssert ? 'assert:' : 'ack:') + i;
    // An acknowledged action is 'confirmed'; a read-only assertion needs no effect.
    return { stepId: stepId(i), status: 'passed', effect: isAssert ? 'notDispatched' : 'confirmed', evidenceIds: [ev] };
  }
  const effect = r.status === 'skipped' ? 'notDispatched' : r.dispatched === false ? 'notDispatched' : 'unknown';
  return { stepId: stepId(i), status: r.status, effect, evidenceIds: [] };
}

// Build the persisted/rendered replay report.
//   steps:   the planned recording steps
//   results: executed entries in order: { i, type, selector, status, error, actual, dispatched? }
//   terminal: 'completed' | 'cancelled' | 'failed' | 'timedOut' | 'unknown'
// Steps without an executed entry are reported as `skipped` (or `cancelled`
// for the one that was in flight when the run was cancelled), never dropped.
export function buildReplayReport({ steps, results, terminal, at, extra = {} }) {
  const planned = Array.isArray(steps) ? steps : [];
  const byIndex = new Map();
  for (const r of results) byIndex.set(r.i, r);
  const full = planned.map((step, i) => {
    const r = byIndex.get(i);
    if (r) return r;
    return { i, type: stepLabel(step), selector: stepTarget(step), status: 'skipped', error: terminal === 'cancelled' ? 'Not run — replay cancelled' : 'Not run — replay stopped earlier', actual: undefined, dispatched: false };
  });
  const assertionStepIds = planned.map((s, i) => (s && s.type === 'assert' ? stepId(i) : null)).filter(Boolean);
  // A dispatch-only step is vouched for by the first LATER assertion that passed.
  const postFor = (i) => {
    for (let j = i + 1; j < full.length; j++) {
      if (planned[j] && planned[j].type === 'assert' && full[j].status === 'passed') return j;
    }
    return undefined;
  };
  const verdictResults = full.map((r, i) => toVerdictResult(i, planned[i], r, r.effect === 'dispatchOnly' ? postFor(i) : undefined));
  const evidenceComplete = full.every((r) => r.status === 'passed');
  const verdict = runVerdict({
    plannedStepIds: planned.map((_, i) => stepId(i)),
    assertionStepIds,
    results: verdictResults,
    terminal: TERMINALS.has(terminal) ? terminal : 'unknown',
    evidenceComplete,
  }, { requireAssertions: false });
  const outSteps = full.map((r) => ({
    i: r.i,
    type: r.type,
    selector: r.selector,
    ok: r.status === 'passed',
    status: r.status,
    error: r.error || '',
    actual: r.actual,
    ...(r.effect ? { effect: r.effect } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(verdictResults[r.i] && r.status === 'passed' && verdictResults[r.i].effect === 'dispatched' ? { unproven: true } : {}),
  }));
  return {
    at: at || new Date().toISOString(),
    status: verdict.status,
    terminal,
    total: planned.length, // PLANNED steps, not "steps that happened to run"
    executed: verdict.executed,
    passed: verdict.passed,
    failed: verdict.failed + verdict.timedOut,
    skipped: verdict.skipped,
    cancelled: verdict.cancelled,
    timedOut: verdict.timedOut,
    unknown: verdict.unknown,
    steps: outSteps,
    ...extra,
  };
}

export function stepLabel(step) {
  if (!step) return 'step';
  return step.type === 'assert' ? `assert:${step.kind}` : step.type;
}
export function stepTarget(step) {
  if (!step) return '';
  return step.selector || step.url || step.expected || '';
}

// Human summary of a report for toasts / panels. Never says "passed" for
// anything but status === 'passed'.
export function describeReplay(report) {
  if (!report) return { tone: 'warn', text: 'Replay did not run' };
  const n = report.total;
  switch (report.status) {
    case 'passed': return { tone: 'success', text: `Replay passed — ${report.passed}/${n} steps` };
    case 'cancelled': return { tone: 'warn', text: `Replay cancelled — ${report.executed} of ${n} steps ran` };
    case 'timedOut': return { tone: 'error', text: `Replay timed out — ${report.timedOut} step(s) did not respond` };
    case 'failed': return { tone: 'error', text: `Replay: ${report.failed} step(s) failed` };
    case 'skipped': return { tone: 'warn', text: 'Replay skipped — no steps ran' };
    default:
      if (report.unknown) return { tone: 'warn', text: `Replay finished but ${report.unknown} step(s) had no confirmed effect — add an assertion after them` };
      return { tone: 'warn', text: `Replay result unknown — ${report.passed}/${n} steps confirmed` };
  }
}

// ------------------------------------------------------------ audit outcome
// Audit outcome the verify flow can trust. `status`:
//   'passed'    completed with 0 findings
//   'findings'  completed with N > 0 findings
//   'failed'    the guest reported an error
//   'timedOut'  the page never answered
//   'skipped'   not run (another audit running, no page)
//   'cancelled' abandoned (tab closed / page navigated / session changed)
//   'unknown'   anything else
export function auditOutcome(report, { skipped = false, timedOut = false, cancelled = false, reason = '' } = {}) {
  const none = (status, error) => ({ status, total: null, counts: {}, error, ok: false });
  if (cancelled) return none('cancelled', reason || 'Audit was abandoned');
  if (skipped) return none('skipped', reason || 'Audit did not run');
  if (timedOut) return none('timedOut', (report && report.error) || reason || 'Audit timed out');
  if (!report) return none('unknown', reason || 'No audit result');
  if (report.error) return none('failed', String(report.error));
  const total = Number.isSafeInteger(report.total) && report.total >= 0 ? report.total : null;
  if (total === null) return none('unknown', 'Audit returned no total');
  return { status: total === 0 ? 'passed' : 'findings', total, counts: report.counts || {}, error: '', ok: true };
}

// Can two audit outcomes be compared as "improved / regressed"?
export function auditComparable(before, after) {
  return !!(before && after && before.ok && after.ok && Number.isFinite(before.total) && Number.isFinite(after.total));
}

const VERIFY_AUDIT_STATUS = {
  passed: 'completed', findings: 'completed', failed: 'error', timedOut: 'timedOut',
  skipped: 'skipped', cancelled: 'cancelled', unknown: 'missing',
};

// Wire shape handed to the verify IPC for one audit side (see the header of
// src/main/services/review/verify.js). Failures keep their status + error and
// carry `total: null`, so nothing downstream can subtract them.
export function auditToVerifyPayload(outcome, base = {}) {
  if (!outcome) return null; // -> 'missing' in the main process
  return {
    status: VERIFY_AUDIT_STATUS[outcome.status] || 'missing',
    total: outcome.ok ? outcome.total : null,
    counts: outcome.ok ? outcome.counts : {},
    error: outcome.ok ? '' : String(outcome.error || '').slice(0, 200),
    ...base,
  };
}

// Journey side of the verify payload from a replay report (or a stored lastRun).
// Counts + terminal only; the main process never trusts a bare pass count.
export function journeyToVerifyPayload(rec, report) {
  if (!report) return null;
  const planned = Number.isFinite(report.total) ? report.total : undefined;
  return {
    id: (rec && rec.id) || null,
    name: (rec && rec.name) || '',
    at: report.at || null,
    planned,
    total: planned,
    executed: report.executed,
    passed: report.passed || 0,
    failed: report.failed || 0,
    skipped: report.skipped || 0,
    cancelled: report.cancelled || 0,
    timedOut: report.timedOut || 0,
    terminal: report.terminal || (report.status === 'cancelled' ? 'cancelled' : undefined),
  };
}
