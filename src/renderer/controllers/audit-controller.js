// Audit run lifecycle bound to an operation context (RF-04 / RF-06).
//
//  - one audit at a time; a second request is reported as `skipped`, never as a
//    clean report;
//  - the reply is accepted only from the tab/webview that started the run, only
//    while the run is pending, and only if the page is still the same document;
//    a reply after timeout/abandon is dropped;
//  - every result carries the identity of the page it audited
//    ({ tabId, docGen, url, title, viewport, runId, at }) so a later "Add as
//    note" or "Locate" is bound to that page, not to whatever is current.
import { auditOutcome } from './run-report.js';
import { DEFAULT_TIMERS } from './timers.js';

export const AUDIT_TIMEOUT_MS = 15000;

export function createAuditRunner({ send, staleReason, getViewport, timeoutMs = AUDIT_TIMEOUT_MS, timers = DEFAULT_TIMERS, now = () => new Date().toISOString() }) {
  let pending = null; // { ctx, resolve, timer }

  function settle(result) {
    const p = pending;
    if (!p) return;
    pending = null;
    timers.clearTimeout(p.timer);
    p.resolve(result);
  }

  const identity = (ctx, extra) => ({
    runId: ctx.runId, tabId: ctx.tabId, docGen: ctx.docGen, url: ctx.url, title: ctx.title,
    viewport: getViewport ? getViewport(ctx) : null, at: now(), ...extra,
  });

  // Start an audit on ctx's tab. Resolves with { outcome, report, source }.
  function run(ctx) {
    if (pending) {
      return Promise.resolve({ outcome: auditOutcome(null, { skipped: true, reason: 'An audit is already running' }), report: null, source: identity(ctx) });
    }
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => {
        const report = { error: 'The page did not answer the audit in time. Reload it and try again.', findings: [], counts: {}, total: 0 };
        settle({ outcome: auditOutcome(report, { timedOut: true }), report, source: identity(ctx), timedOut: true });
      }, timeoutMs);
      pending = { ctx, resolve, timer };
      try { send(ctx); } catch (e) {
        settle({ outcome: auditOutcome(null, { reason: 'Could not reach the page: ' + ((e && e.message) || e) }), report: null, source: identity(ctx) });
      }
    });
  }

  // A `caos:audit-result` arrived from tab `tabId`. Returns true if consumed.
  function deliver(tabId, payload) {
    const p = pending;
    if (!p || p.ctx.tabId !== tabId) return false;
    if (payload && payload.runId !== undefined && payload.runId !== p.ctx.runId) return false;
    const stale = staleReason ? staleReason(p.ctx) : null;
    if (stale) {
      settle({ outcome: auditOutcome(null, { cancelled: true, reason: 'Audit result discarded: ' + stale }), report: null, source: identity(p.ctx), stale });
      return true;
    }
    const report = payload || { error: 'The page returned no audit result', findings: [], counts: {}, total: 0 };
    settle({ outcome: auditOutcome(report), report, source: identity(p.ctx) });
    return true;
  }

  // The tab closed / navigated away: settle the waiter instead of letting it hang.
  function abandon(tabId, reason = 'Audit abandoned') {
    const p = pending;
    if (!p || (tabId && p.ctx.tabId !== tabId)) return false;
    settle({ outcome: auditOutcome(null, { cancelled: true, reason }), report: null, source: identity(p.ctx), stale: reason });
    return true;
  }

  return { run, deliver, abandon, active: () => (pending ? pending.ctx : null) };
}

// Is a stored audit still describing the page the tab shows? Hash-only changes
// do not count as a different page.
export function sameAuditedPage(source, current) {
  if (!source || !current) return false;
  const strip = (u) => String(u || '').split('#')[0];
  return source.tabId === current.tabId && strip(source.url) === strip(current.url);
}
