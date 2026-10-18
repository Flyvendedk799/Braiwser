// Verify orchestration (RF-04 / RF-05), pure over injected dependencies.
//
//  - Everything the run needs is captured ONCE at the start: the session, the tab
//    context, the note counts, the baseline audit and the selected recording.
//  - Results are saved only to the captured session; the panel is rendered only
//    if that session is still the one on screen.
//  - An audit that failed / timed out / was skipped / was abandoned stays that
//    way — it is never replaced by a clean zero report.
//  - One run at a time; busy state is always released (try/finally).
import { auditOutcome, auditToVerifyPayload, journeyToVerifyPayload } from './run-report.js';

export function createVerifyRunner(deps) {
  let running = null;

  function run() {
    if (running) return running; // single-run guard: join the one in flight
    running = (async () => {
      try { return await runOnce(deps); } finally { running = null; }
    })();
    return running;
  }
  return { run, isRunning: () => !!running };
}

async function runOnce(d) {
  const session = d.getSession();
  if (!session) { d.toast('Open or start a session first', 'warn'); return null; }
  const ctx = d.captureContext();                 // tab + doc + session identity
  const annotations = d.getAnnotations().slice();  // consistent snapshot
  const notes = { open: annotations.filter((a) => (a.status || 'open') !== 'resolved').length, total: annotations.length };
  const rec = d.getSelectedRecording();
  const baseline = d.getBaselineAudit(ctx);        // audit outcome for THIS tab/page, or null
  const beforeJourney = rec && rec.lastRun ? journeyToVerifyPayload(rec, rec.lastRun) : null;

  d.setBusy(true, ctx);
  try {
    const beforeShot = await d.captureShot(ctx);

    // After audit: a fresh run bound to ctx. Never substituted with zeros.
    let after;
    try { after = await d.runAudit(ctx); } catch (e) { after = auditOutcome(null, { reason: (e && e.message) || String(e) }); }
    if (!after) after = auditOutcome(null, { skipped: true, reason: 'Audit did not run (already running or no page)' });

    let afterJourney = beforeJourney;
    let journeyReport = null;
    if (rec) {
      try { journeyReport = await d.replay(ctx, rec); } catch (_e) { journeyReport = null; }
      afterJourney = journeyReport ? journeyToVerifyPayload(rec, journeyReport) : null;
    }
    const afterShot = await d.captureShot(ctx);

    const payload = {
      notes,
      context: { runId: ctx.runId, tabId: ctx.tabId, url: ctx.url, sessionId: session.id, recordingId: rec ? rec.id : null },
      before: { audit: baseline ? auditToVerifyPayload(baseline) : null, journey: beforeJourney, screenshot: beforeShot },
      after: { audit: auditToVerifyPayload(after, { url: d.currentUrlOf(ctx) }), journey: afterJourney, screenshot: afterShot },
    };
    let saved;
    try {
      saved = await d.save(session.id, payload); // captured session, not "whatever is current now"
    } catch (e) {
      d.toast('Could not save verify run: ' + ((e && e.message) || e), 'error');
      return null;
    }
    // Render only if the user is still looking at the session this belongs to.
    if (saved && saved.run && d.getSession() && d.getSession().id === session.id) d.showRun(saved.run);
    if (saved && saved.ok) {
      const status = saved.run && saved.run.status;
      if (status === 'verified') d.toast('Verified — saved to this session', 'success');
      else if (status === 'failed') d.toast('Verify run saved — a check failed', 'error');
      else d.toast('Verify run saved — inconclusive: ' + ((saved.run && saved.run.reason) || 'some checks did not complete'), 'warn');
    } else if (saved && saved.error) {
      d.toast('Could not save verify run: ' + saved.error, 'error');
    }
    return saved;
  } finally {
    d.setBusy(false, ctx);
  }
}
