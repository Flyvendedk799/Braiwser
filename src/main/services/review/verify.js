// Persist local before/after verify runs on a session (RF-04).
// Screenshots are optional data URLs and are dropped if they would bloat the store.
//
// A Verify run must never turn "we could not check" into "everything is fixed".
// An audit that timed out, errored, was skipped or returned nothing has NO total;
// numeric deltas exist only when BOTH audits completed and are comparable
// (review/verdict.js `auditDelta`). A journey's outcome comes from
// review/verdict.js `runVerdict` when step-level facts are supplied, otherwise
// from an explicit counts-only summary that is conservative about completeness.
//
// ---------------------------------------------------------------------------------
// INPUT  saveRun(repos, sessionId, payload) / buildRun(payload, { sessionId })
//   payload = {
//     notes:   { open, total },
//     context?: { comparisonKey? },                       // optional caller context
//     before:  { audit, journey, screenshot },
//     after:   { audit, journey, screenshot },
//   }
//   audit   = null                                        -> status 'missing'
//           | { status?: 'completed'|'error'|'timedOut'|'skipped'|'cancelled',
//               total, counts, error?, reason?, url?, comparisonKey? }
//             (no status: `error` => 'error' (or 'timedOut' if it says so);
//              finite integer `total` => 'completed'; anything else => 'missing')
//   journey = null                                        -> journey not part of this run
//           | { id, name, at,
//               planned?, executed?, passed, failed, skipped?, cancelled?, timedOut?,
//               total?,                                   // legacy: number of results
//               terminal?: 'completed'|'failed'|'cancelled'|'timedOut'|'unknown',
//               cancelled?: true|number, steps?: [...] }  // see journeyVerdict below
//             With `plannedStepIds` + `steps:[{stepId,status,effect,evidenceIds}]` the
//             result is exactly runVerdict(); with counts only, `planned` should be
//             supplied - without it a clean all-pass can only be reported 'unknown'.
//
// OUTPUT  run (schema v2) = {
//   v: 2, at, notesOpen, notesTotal,
//   status: 'verified'|'failed'|'inconclusive',           // headline; ONLY 'verified' may be shown as green
//   reason: string,                                       // why, when not verified ('' when verified)
//   audit: {
//     before: AuditSummary, after: AuditSummary,
//     deltaAvailable: boolean,
//     delta: number|null,                                 // after.total - before.total; null unless deltaAvailable
//     reason: string|null,                                // e.g. 'after:timedOut', 'baseline:missing_report',
//   },                                                    //      'incomparable_context', 'legacy'
//   journey: JourneySummary|null,                         // the AFTER journey outcome
//   before: { audit: AuditSummary, journey: JourneySummary|null, screenshot },
//   after:  { audit: AuditSummary, journey: JourneySummary|null, screenshot },
//   delta:  { audit: number|null, deltaAvailable, reason, journeyFailed: number|null, notesOpen },  // legacy mirror
// }
// AuditSummary   = { status: 'completed'|'error'|'timedOut'|'skipped'|'cancelled'|'missing',
//                    total: integer|null,                 // null unless status==='completed'
//                    counts: {}, error: string, reason: string }
// JourneySummary = { id, name, at, source: 'verdict'|'counts'|'legacy',
//                    status: 'passed'|'failed'|'cancelled'|'timedOut'|'skipped'|'unknown',
//                    planned, executed, passed, failed, skipped, cancelled, timedOut, pending, unknown,
//                    total /* = planned, legacy mirror */ }
//
// LEGACY runs (no `v`) are read through normalizeStoredRun(): same shape, with
// audit.deltaAvailable=false, audit.delta=null, audit.reason='legacy', status
// 'inconclusive'. A legacy "delta" is never trusted - it may be a fake improvement.
// ---------------------------------------------------------------------------------

const { auditDelta, runVerdict } = require('./verdict');

const MAX_RUNS = 5;
const MAX_SHOT = 350000;
const RUN_VERSION = 2;

const AUDIT_STATUSES = new Set(['completed', 'error', 'timedOut', 'skipped', 'cancelled', 'missing']);
const JOURNEY_STATUSES = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;
const asCount = (x) => (isCount(x) ? x : Number.isFinite(Number(x)) && Number(x) >= 0 && x !== null && x !== '' && typeof x !== 'boolean' ? Math.floor(Number(x)) : 0);
const LINE_BREAKS = new RegExp('[\r\n' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
const clip = (v, n) => String(v == null ? '' : v).replace(LINE_BREAKS, ' ').slice(0, n);

// ---- audit -----------------------------------------------------------------------
function auditSummary(report) {
  if (!isObj(report)) {
    return { status: 'missing', total: null, counts: {}, error: '', reason: 'no_report' };
  }
  const counts = isObj(report.counts) ? report.counts : {};
  const error = report.error ? clip(report.error, 200) : '';
  const reason = report.reason ? clip(report.reason, 120) : '';
  let status = typeof report.status === 'string' && AUDIT_STATUSES.has(report.status) ? report.status : null;
  if (!status) {
    if (error) status = /did not answer|timed? ?out|timeout/i.test(error) ? 'timedOut' : 'error';
    else if (isCount(report.total)) status = 'completed';
    else status = 'missing';
  }
  if (status === 'completed' && (!isCount(report.total) || error)) {
    // "completed" with a bogus total, or carrying an error, is not a completed audit.
    status = error ? 'error' : 'missing';
  }
  return {
    status,
    total: status === 'completed' ? report.total : null,
    counts: status === 'completed' ? counts : {},
    error,
    reason: reason || (status === 'completed' ? '' : status === 'missing' ? 'no_report' : status),
  };
}

// Compare two audit summaries. `ctx` carries the comparison identity for auditDelta.
function computeAuditDelta(before, after, ctx = {}, rawBefore = null, rawAfter = null) {
  if (before.status !== 'completed') return { deltaAvailable: false, delta: null, reason: `baseline:${before.status}` };
  if (after.status !== 'completed') return { deltaAvailable: false, delta: null, reason: `after:${after.status}` };
  const base = ctx.comparisonKey || (ctx.sessionId ? `session:${ctx.sessionId}` : 'local');
  // A different page/viewport between the two audits is not a before/after of the same thing.
  const keyOf = (raw) => {
    const k = isObj(raw) && typeof raw.comparisonKey === 'string' && raw.comparisonKey ? raw.comparisonKey : base;
    const url = isObj(raw) && typeof raw.url === 'string' ? raw.url.split('#')[0] : '';
    return `${k}|${url}`;
  };
  // Local in-app runs have no separate evidence store or app-revision tracking: the
  // stored report IS the evidence, and baseline/candidate revisions are the roles.
  const r = auditDelta({
    baseline: { status: 'passed', total: before.total, comparisonKey: keyOf(rawBefore), evidenceIds: ['local:baseline'], appRevision: 'baseline' },
    candidate: { status: 'passed', total: after.total, comparisonKey: keyOf(rawAfter), evidenceIds: ['local:candidate'], appRevision: 'candidate' },
    expectedBaselineRevision: 'baseline',
    expectedCandidateRevision: 'candidate',
  });
  return { deltaAvailable: r.available, delta: r.available ? r.delta : null, reason: r.reason };
}

// ---- journey ---------------------------------------------------------------------
function emptyJourney(meta, source, status) {
  return {
    id: meta.id, name: meta.name, at: meta.at, source, status,
    planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, timedOut: 0, pending: 0, unknown: 0, total: 0,
  };
}

function journeyFromVerdict(meta, input) {
  let verdict;
  try {
    verdict = runVerdict({
      plannedStepIds: input.plannedStepIds,
      assertionStepIds: Array.isArray(input.assertionStepIds) ? input.assertionStepIds : [],
      results: Array.isArray(input.steps) ? input.steps : [],
      terminal: input.terminal || 'unknown',
      evidenceComplete: input.evidenceComplete === true,
    });
  } catch (_e) {
    const j = emptyJourney(meta, 'verdict', 'unknown');
    return j; // malformed step facts never read as a pass
  }
  const j = emptyJourney(meta, 'verdict', JOURNEY_STATUSES.has(verdict.status) ? verdict.status : 'unknown');
  for (const k of ['planned', 'executed', 'passed', 'failed', 'skipped', 'cancelled', 'timedOut', 'pending', 'unknown']) j[k] = verdict[k];
  j.total = verdict.planned;
  return j;
}

function journeyFromCounts(meta, input) {
  const passed = asCount(input.passed);
  const failed = asCount(input.failed);
  const skipped = asCount(input.skipped);
  const timedOut = asCount(input.timedOut);
  const cancelled = typeof input.cancelled === 'number' ? asCount(input.cancelled) : 0;
  const abortedRun = input.cancelled === true || input.terminal === 'cancelled';
  const plannedKnown = input.planned != null && isCount(Number(input.planned));
  const accounted = passed + failed + skipped + timedOut + cancelled;
  const planned = plannedKnown ? asCount(input.planned) : Math.max(asCount(input.total), accounted);
  const executed = input.executed != null ? asCount(input.executed) : passed + failed + timedOut + cancelled;
  const pending = Math.max(0, planned - accounted);

  let status = 'unknown';
  if (failed > 0) status = 'failed';
  else if (timedOut > 0 || input.terminal === 'timedOut') status = 'timedOut';
  else if (cancelled > 0 || abortedRun) status = 'cancelled';
  else if (planned > 0 && skipped === planned) status = 'skipped';
  else if (plannedKnown && planned > 0 && passed === planned && pending === 0
      && input.terminal !== 'unknown' && input.terminal !== 'failed') status = 'passed';
  // else: nothing planned, steps unaccounted for, or completeness cannot be proven => 'unknown'

  return {
    id: meta.id, name: meta.name, at: meta.at, source: 'counts', status,
    planned, executed, passed, failed, skipped, cancelled, timedOut, pending,
    unknown: status === 'unknown' ? pending : 0,
    total: planned,
  };
}

// Normalise whatever the renderer sent into a JourneySummary (or null).
function journeySummary(input, recording) {
  if (!isObj(input) && !isObj(recording)) return null;
  const run = isObj(input) ? input : (recording && isObj(recording.lastRun) ? recording.lastRun : null);
  if (!run) return null;
  const meta = {
    id: (isObj(input) && input.id) || (recording && recording.id) || null,
    name: clip((isObj(input) && input.name) || (recording && recording.name) || '', 200),
    at: run.at || null,
  };
  if (Array.isArray(run.plannedStepIds) && Array.isArray(run.steps)) return journeyFromVerdict(meta, run);
  return journeyFromCounts(meta, run);
}

// ---- run -------------------------------------------------------------------------
function clipShot(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return '';
  if (dataUrl.length > MAX_SHOT) return '';
  return dataUrl;
}

function headline(audit, journey) {
  if (journey && journey.status === 'failed') return { status: 'failed', reason: `${journey.failed} journey step(s) failed` };
  if (audit.deltaAvailable && audit.delta > 0) return { status: 'failed', reason: `${audit.delta} more audit finding(s) than before` };
  if (!audit.deltaAvailable) return { status: 'inconclusive', reason: `audit comparison unavailable (${audit.reason || 'unknown'})` };
  if (journey && journey.status !== 'passed') return { status: 'inconclusive', reason: `journey ${journey.status}` };
  return { status: 'verified', reason: '' };
}

function buildRun(payload, opts = {}) {
  const p = isObj(payload) ? payload : {};
  const before = isObj(p.before) ? p.before : {};
  const after = isObj(p.after) ? p.after : {};
  const notes = isObj(p.notes) ? p.notes : {};
  const ctx = {
    sessionId: opts.sessionId || '',
    comparisonKey: isObj(p.context) && typeof p.context.comparisonKey === 'string' ? p.context.comparisonKey : '',
  };

  const beforeAudit = auditSummary(before.audit);
  const afterAudit = auditSummary(after.audit);
  const d = computeAuditDelta(beforeAudit, afterAudit, ctx, before.audit, after.audit);
  const beforeJourney = journeySummary(before.journey);
  const afterJourney = journeySummary(after.journey);
  const audit = { before: beforeAudit, after: afterAudit, deltaAvailable: d.deltaAvailable, delta: d.delta, reason: d.reason };
  const head = headline(audit, afterJourney);

  return {
    v: RUN_VERSION,
    at: new Date().toISOString(),
    notesOpen: asCount(notes.open),
    notesTotal: asCount(notes.total),
    status: head.status,
    reason: head.reason,
    audit,
    journey: afterJourney,
    before: { audit: beforeAudit, journey: beforeJourney, screenshot: clipShot(before.screenshot) },
    after: { audit: afterAudit, journey: afterJourney, screenshot: clipShot(after.screenshot) },
    delta: {
      audit: d.delta,
      deltaAvailable: d.deltaAvailable,
      reason: d.reason,
      journeyFailed: afterJourney ? afterJourney.failed : null,
      notesOpen: asCount(notes.open),
    },
  };
}

// Read a stored run of any vintage. v2 runs are returned as-is; legacy runs are lifted
// into the v2 shape with the audit delta explicitly UNAVAILABLE (reason 'legacy').
function normalizeStoredRun(run) {
  if (!isObj(run)) return null;
  if (run.v === RUN_VERSION && isObj(run.audit)) return run;
  const lift = (side) => {
    const s = isObj(side) ? side : {};
    const a = isObj(s.audit) ? s.audit : null;
    // Legacy summaries were `{ total, counts, error }` with total 0 on failure: a
    // legacy total is only trusted when it carries no error.
    const summary = a
      ? (a.error ? auditSummary({ error: a.error }) : auditSummary({ total: a.total, counts: a.counts }))
      : auditSummary(null);
    const j = isObj(s.journey) ? journeyLegacy(s.journey) : null;
    return { audit: summary, journey: j, screenshot: typeof s.screenshot === 'string' ? s.screenshot : '' };
  };
  const b = lift(run.before);
  const a = lift(run.after);
  const audit = { before: b.audit, after: a.audit, deltaAvailable: false, delta: null, reason: 'legacy' };
  return {
    v: RUN_VERSION,
    legacy: true,
    at: run.at || null,
    notesOpen: asCount(run.notesOpen),
    notesTotal: asCount(run.notesTotal),
    status: 'inconclusive',
    reason: 'recorded before verify tracked audit failures (legacy run)',
    audit,
    journey: a.journey,
    before: b,
    after: a,
    delta: { audit: null, deltaAvailable: false, reason: 'legacy', journeyFailed: a.journey ? a.journey.failed : null, notesOpen: asCount(run.notesOpen) },
  };
}

function journeyLegacy(j) {
  const passed = asCount(j.passed);
  const failed = asCount(j.failed);
  const total = asCount(j.total);
  return {
    id: j.id || null, name: clip(j.name || '', 200), at: j.at || null, source: 'legacy',
    // A legacy count cannot prove all intended steps ran, so only failure is certain.
    status: failed > 0 ? 'failed' : 'unknown',
    planned: total, executed: passed + failed, passed, failed, skipped: 0, cancelled: 0, timedOut: 0,
    pending: Math.max(0, total - passed - failed), unknown: failed > 0 ? 0 : total - passed - failed > 0 ? total - passed - failed : 0, total,
  };
}

function saveRun(repos, sessionId, payload) {
  const session = repos.sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };
  const run = buildRun(payload, { sessionId });
  const prev = Array.isArray(session.verifyRuns) ? session.verifyRuns : [];
  const verifyRuns = prev.map(normalizeStoredRun).filter(Boolean).concat(run).slice(-MAX_RUNS);
  const updated = repos.sessions.update(sessionId, { verifyRuns, lastVerifyAt: run.at });
  return { ok: true, run, session: updated };
}

function listRuns(repos, sessionId) {
  const session = repos.sessions.get(sessionId);
  if (!session) return [];
  return (Array.isArray(session.verifyRuns) ? session.verifyRuns : []).map(normalizeStoredRun).filter(Boolean);
}

module.exports = { saveRun, listRuns, buildRun, auditSummary, journeySummary, normalizeStoredRun, computeAuditDelta, RUN_VERSION };
