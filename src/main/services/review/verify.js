// Persist local before/after verify runs on a session.
// Screenshots are optional data URLs and are dropped if they would bloat the store.

const MAX_RUNS = 5;
const MAX_SHOT = 350000;

function auditSummary(report) {
  if (!report || typeof report !== 'object') return { total: 0, counts: {}, error: '' };
  return {
    total: Number(report.total) || 0,
    counts: report.counts && typeof report.counts === 'object' ? report.counts : {},
    error: report.error ? String(report.error).slice(0, 200) : '',
  };
}

function journeySummary(lastRun, recording) {
  if (!lastRun && !recording) return null;
  const run = lastRun || (recording && recording.lastRun) || null;
  return {
    id: recording && recording.id || null,
    name: recording && recording.name || '',
    passed: run ? Number(run.passed) || 0 : null,
    failed: run ? Number(run.failed) || 0 : null,
    total: run ? Number(run.total) || 0 : null,
    at: run && run.at || null,
  };
}

function clipShot(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return '';
  if (dataUrl.length > MAX_SHOT) return '';
  return dataUrl;
}

function buildRun(payload) {
  const beforeAudit = auditSummary(payload && payload.before && payload.before.audit);
  const afterAudit = auditSummary(payload && payload.after && payload.after.audit);
  const beforeJourney = (payload && payload.before && payload.before.journey) || null;
  const afterJourney = (payload && payload.after && payload.after.journey) || null;
  const notes = payload && payload.notes || {};
  return {
    at: new Date().toISOString(),
    notesOpen: Number(notes.open) || 0,
    notesTotal: Number(notes.total) || 0,
    before: {
      audit: beforeAudit,
      journey: beforeJourney,
      screenshot: clipShot(payload && payload.before && payload.before.screenshot),
    },
    after: {
      audit: afterAudit,
      journey: afterJourney,
      screenshot: clipShot(payload && payload.after && payload.after.screenshot),
    },
    delta: {
      audit: afterAudit.total - beforeAudit.total,
      journeyFailed: afterJourney && afterJourney.failed != null ? afterJourney.failed : null,
      notesOpen: Number(notes.open) || 0,
    },
  };
}

function saveRun(repos, sessionId, payload) {
  const session = repos.sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };
  const run = buildRun(payload);
  const prev = Array.isArray(session.verifyRuns) ? session.verifyRuns : [];
  const verifyRuns = prev.concat(run).slice(-MAX_RUNS);
  const updated = repos.sessions.update(sessionId, { verifyRuns, lastVerifyAt: run.at });
  return { ok: true, run, session: updated };
}

function listRuns(repos, sessionId) {
  const session = repos.sessions.get(sessionId);
  if (!session) return [];
  return Array.isArray(session.verifyRuns) ? session.verifyRuns : [];
}

module.exports = { saveRun, listRuns, buildRun, auditSummary, journeySummary };
