// Agent <-> human control transfer for a BrowserSession.
//
//   agent -> handoff-pending -> human -> agent        (+ `quarantined` stop state)
//
// "Take over" revokes agent dispatch on EVERY page of the session (SessionLease)
// before the human is granted control, drains lanes, invalidates all refs and
// outstanding approvals, and bumps the fencing epoch. "Resume" is a trusted-UI
// action only: it bumps document epochs again and requires a fresh observation.
// Page content ("click here to resume") has no path into either operation.
'use strict';
const C = require('../../../shared/browser-contracts');
const { redactText } = require('../../../shared/browser-redact');

function createHandoff({ policy, emit, clock = { now: () => Date.now() }, drainTimeoutMs = 5000 }) {
  const badge = (session, owner) => {
    for (const p of session.pages.values()) {
      try { p.driverPage.setOwnerBadge?.(owner); } catch { /* cosmetic */ }
    }
  };

  async function handoff(session, { pageId, runId = null, reason }, principal) {
    session.page(pageId); // existence check
    const method = session.capabilities && session.capabilities.humanHandoff;
    // Only 'native' and 'remote-view' are honoured. A relaunch needs an explicit,
    // disclosed checkpoint transition that this broker does not perform.
    if (method !== 'native' && method !== 'remote-view') {
      throw C.brokerError('UNSUPPORTED', `human handoff is not available for this session (${method || 'unknown'})`, { detail: 'HANDOFF_UNSUPPORTED' });
    }
    let result;
    try {
      // The human is the authority to reconcile uncertainty; an agent is not.
      result = await session.lease.takeOver({ acknowledgeUncertain: principal.kind === 'ui', drainTimeoutMs });
    } catch (e) {
      if (e.code === 'RECONCILE_BEFORE_HANDOFF') throw C.brokerError('DENIED', 'a possibly dispatched action must be reconciled by the trusted UI before takeover', { dispatched: true, effectUnknown: true, detail: e.code });
      if (e.code === 'DRAIN_TIMEOUT') throw C.brokerError('UNAVAILABLE', 'the page is busy and cannot be drained; close the session', { dispatched: true, effectUnknown: true, detail: e.code });
      if (e.code === 'NOT_HANDOFF_READY') throw C.brokerError('DENIED', 'session is not agent-controlled', { detail: e.code });
      throw e;
    }
    session.invalidateAll();
    policy.revokeApprovals({ sessionId: session.sessionId });
    badge(session, 'human');
    const entry = { at: clock.now(), principalId: principal.id, runId, reason: redactText(String(reason || ''), 200), fence: result.fence };
    session.handoffLog.push(entry);
    emit('owner-changed', { sessionId: session.sessionId, owner: 'human', fence: result.fence, runId, reason: entry.reason, uncertain: result.uncertain });
    return { owner: 'human', documentEpoch: session.page(pageId).documentEpoch, method };
  }

  function resume(session, { pageId }, principal) {
    if (principal.kind !== 'ui') throw C.brokerError('DENIED', 'only the trusted UI can resume agent control', { detail: 'RESUME_ACTOR' });
    session.page(pageId);
    let result;
    try { result = session.lease.resume(); } catch (e) {
      if (e.code === 'NOT_HUMAN_OWNED') throw C.brokerError('DENIED', 'session is not human-controlled', { detail: e.code });
      throw e;
    }
    session.invalidateAll(); // refs from before the human touched the page are dead
    policy.revokeApprovals({ sessionId: session.sessionId });
    badge(session, 'agent');
    emit('owner-changed', { sessionId: session.sessionId, owner: 'agent', fence: result.fence, requireFreshObservation: true });
    return { owner: 'agent', documentEpoch: session.page(pageId).documentEpoch, requireFreshObservation: true };
  }

  return { handoff, resume };
}

module.exports = { createHandoff };
