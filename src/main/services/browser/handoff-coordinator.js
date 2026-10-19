// Session-level handoff ledger. The per-page lease is the fencing kernel;
// this module is the durable episode: pause, handoff record, exclusive viewer
// lease, private input, and a one-use resume grant. It never auto-acquires
// human control and never puts a redemption secret in a tool result.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const C = require('../../../shared/browser-contracts');
const H = require('../../../shared/handoff-contracts');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const FRAME_STALE_MS = 2000;

function digestOf(value) {
  return C.sha256(value);
}

function createHandoffCoordinator({
  clock = { now: () => Date.now() },
  dataDir = null,
  ttlMs = DEFAULT_TTL_MS,
  getViewer = () => null,
} = {}) {
  const records = new Map();
  const keys = new Map(); // principalId:requestKey -> { digest, handoffId }
  const grants = new Map();
  const controls = new Map();
  const locks = new Map();
  const lockStore = new AsyncLocalStorage();
  const file = dataDir ? path.join(dataDir, 'browser', 'handoffs.json') : null;

  function persist() {
    if (!file) return;
    const body = {
      version: 1,
      controls: [...controls.entries()],
      records: [...records.values()].map((rec) => ({ ...publicRecord(rec), inviteHash: null,
        resumeResult: rec.resumeResult || null, writeReceipts: rec.writeReceipts || {} })),
      keys: [...keys.entries()].map(([k, v]) => ({ k, digest: v.digest, handoffId: v.handoffId })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file);
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    for (const [key, value] of parsed.controls || []) controls.set(key, value);
    for (const rec of Array.isArray(parsed.records) ? parsed.records : []) {
      if (!rec || !rec.handoffId) continue;
      // A restarted broker does not still own the live browser. The episode is closed.
      rec.state = 'closed';
      rec.blocker = 'BROKER_RESTART';
      rec.resumeEligible = false;
      rec.controlOwner = 'closed';
      rec.inviteHash = null;
      records.set(rec.handoffId, rec);
    }
    for (const row of Array.isArray(parsed.keys) ? parsed.keys : []) {
      if (row && row.k && row.handoffId) keys.set(row.k, { digest: row.digest, handoffId: row.handoffId });
    }
  }
  load();

  function withLock(sessionId, fn) {
    const held = lockStore.getStore();
    if (held && held.has(sessionId)) return Promise.resolve().then(fn);
    const prev = locks.get(sessionId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => gate, () => gate);
    locks.set(sessionId, tail);
    const next = new Set(held || []);
    next.add(sessionId);
    return prev.then(() => lockStore.run(next, fn), () => lockStore.run(next, fn)).finally(() => {
      release();
      if (locks.get(sessionId) === tail) locks.delete(sessionId);
    });
  }

  function publicRecord(rec) {
    return {
      handoffId: rec.handoffId,
      sessionId: rec.sessionId,
      pageId: rec.pageId,
      runId: rec.runId,
      reasonCode: rec.reasonCode,
      state: rec.state,
      method: rec.method,
      controlOwner: rec.controlOwner,
      controlEpoch: rec.controlEpoch,
      eventSequence: rec.eventSequence,
      expiresAt: rec.expiresAt,
      viewerUrl: rec.viewerUrl,
      nextSequence: rec.eventSequence,
      resumeEligible: rec.resumeEligible === true,
      blocker: rec.blocker || null,
      requestKey: rec.requestKey,
      principalId: rec.principalId,
      documentEpoch: rec.documentEpoch,
      events: rec.events,
      inviteHash: rec.inviteHash || null,
      privateInput: rec.privateInput === true,
      viewerInstance: rec.viewerInstance || null,
    };
  }

  function dto(rec) {
    const view = publicRecord(rec);
    delete view.inviteHash;
    delete view.principalId;
    delete view.events;
    delete view.viewerInstance;
    return view;
  }

  function pushEvent(rec, kind, summary) {
    rec.eventSequence += 1;
    rec.events.push({ sequence: rec.eventSequence, at: clock.now(), kind, summary: String(summary || '').slice(0, 300) });
    if (rec.events.length > 200) rec.events.splice(0, rec.events.length - 200);
  }

  function assertLive(rec) {
    if (!rec) throw H.v2Error('ACCESS_REVOKED', 'handoff is not available');
    if (rec.state === 'closed') throw H.v2Error(rec.blocker === 'ACCESS_EXPIRED' ? 'ACCESS_EXPIRED' : 'ACCESS_REVOKED', rec.blocker || 'handoff is closed');
    if (clock.now() > rec.expiresAt) {
      rec.state = 'closed';
      rec.blocker = 'ACCESS_EXPIRED';
      rec.resumeEligible = false;
      pushEvent(rec, 'expired', 'access expired');
      persist();
      throw H.v2Error('ACCESS_EXPIRED', 'handoff access expired; the owner can issue a new one');
    }
  }

  function sameRequest(principal, requestKey, digest) {
    if (!requestKey) return null;
    const prior = keys.get(`${principal.id}:${requestKey}`);
    if (!prior) return null;
    if (prior.digest !== digest) throw H.v2Error('IDEMPOTENCY_CONFLICT', 'this request key was already used with different content');
    return records.get(prior.handoffId) || null;
  }

  function effectiveMethod(session) {
    const reported = session.capabilities && session.capabilities.humanHandoff;
    const viewer = getViewer() || null;
    const viewerOn = !!(viewer && viewer.enabled && viewer.baseUrl);
    if (reported === 'checkpoint-relaunch') return { method: reported, viewer };
    if (viewerOn && session.mode === 'headless') {
      return { method: 'remote-view', viewer };
    }
    return { method: reported, viewer };
  }

  async function pause(session, { acknowledgeUncertain = false, drainTimeoutMs = 5000 } = {}) {
    let result;
    try {
      result = await session.lease.pause({ acknowledgeUncertain, drainTimeoutMs });
    } catch (e) {
      if (e.code === 'DRAIN_TIMEOUT') throw H.v2Error('IN_FLIGHT_UNSETTLED', 'in-flight browser work has not settled');
      if (e.code === 'RECONCILE_BEFORE_HANDOFF') throw H.v2Error('RECONCILIATION_REQUIRED', 'a possibly dispatched action must be reconciled before pause', { effectUnknown: true });
      if (e.code === 'NOT_HANDOFF_READY') throw H.v2Error('CONTROL_BUSY', 'session is not agent-controlled');
      throw e;
    }
    if (session.privateInput) session.privateInput = false;
    return result;
  }

  async function requestHandoff(session, input, principal) {
    const requestKey = input.requestKey || null;
    const digest = digestOf({
      sessionId: session.sessionId, pageId: input.pageId, runId: input.runId || null,
      reasonCode: input.reasonCode || 'needsHuman', requestKey,
    });
    const replay = sameRequest(principal, requestKey, digest);
    if (replay) return { record: dto(replay), replayed: true };
    const { method, viewer } = effectiveMethod(session);
    if (method !== 'remote-view') {
      throw H.v2Error('UNSUPPORTED_HANDOFF', `human handoff is not available (${method || 'unknown'})`);
    }
    let viewerUrl = null;
    if (method === 'remote-view') {
      const deployment = (viewer && viewer.deployment) || 'local';
      const check = H.viewerUrlAllowed(viewer.baseUrl, deployment);
      if (!check.ok) throw H.v2Error('VIEWER_UNREACHABLE', 'the viewer origin is not reachable for this deployment');
      viewerUrl = null; // filled after the id exists
    }
    const paused = await pause(session, {
      acknowledgeUncertain: principal.kind === 'ui',
      drainTimeoutMs: input.drainTimeoutMs,
    });
    if (paused.owner === 'quarantined') {
      throw H.v2Error('RECONCILIATION_REQUIRED', 'the session is quarantined until a supervisor reconciles it', { effectUnknown: true });
    }
    const handoffId = C.newId('handoff');
    const code = crypto.randomBytes(24).toString('base64url');
    const page = session.page(input.pageId);
    if (method === 'remote-view') viewerUrl = `${String(viewer.baseUrl).replace(/\/$/, '')}/handoff/${handoffId}`;
    const rec = {
      handoffId,
      sessionId: session.sessionId,
      pageId: input.pageId,
      runId: input.runId || null,
      reasonCode: input.reasonCode || 'needsHuman',
      state: 'paused',
      method,
      controlOwner: 'paused',
      controlEpoch: paused.fence,
      eventSequence: 0,
      events: [],
      expiresAt: clock.now() + ttlMs,
      viewerUrl,
      resumeEligible: false,
      blocker: null,
      requestKey,
      principalId: principal.id,
      inviteHash: H_sha(code),
      privateInput: false,
      viewerInstance: null,
      documentEpoch: page.documentEpoch,
    };
    pushEvent(rec, 'paused', 'agent input fenced; human control is not yet acquired');
    records.set(handoffId, rec);
    session.lastHandoffVersion = 2;
    if (requestKey) keys.set(`${principal.id}:${requestKey}`, { digest, handoffId });
    session.invalidateAll();
    persist();
    return { record: dto(rec), replayed: false, invitationCode: code };
  }

  function get(handoffId) {
    return records.get(handoffId) || null;
  }

  function status(handoffId, { afterSequence = 0, maxEvents = 30 } = {}) {
    const rec = records.get(handoffId);
    if (!rec) throw H.v2Error('ACCESS_REVOKED', 'unknown handoff');
    if (rec.state !== 'closed' && clock.now() > rec.expiresAt) {
      rec.state = 'closed';
      rec.blocker = 'ACCESS_EXPIRED';
      rec.resumeEligible = false;
      pushEvent(rec, 'expired', 'access expired');
      persist();
    }
    const events = rec.events.filter((e) => e.sequence > afterSequence).slice(0, maxEvents);
    // Exclusive cursor: last event consumed, passed back as afterSequence.
    return { ...dto(rec), events, nextSequence: events.length ? events[events.length - 1].sequence : afterSequence };
  }

  function redeem(handoffId, code) {
    const rec = records.get(handoffId);
    assertLive(rec);
    const hash = H_sha(String(code || ''));
    if (!rec.inviteHash || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(rec.inviteHash))) {
      throw H.v2Error('ACCESS_REVOKED', 'redemption was rejected');
    }
    rec.inviteHash = null; // one use
    persist();
    return rec;
  }

  function acquire(handoffId, { viewerInstance, expectedControlEpoch }) {
    const rec = records.get(handoffId);
    assertLive(rec);
    if (rec.privateInput && rec.viewerInstance && rec.viewerInstance !== viewerInstance) {
      throw H.v2Error('PRIVATE_INPUT_ACTIVE', 'private input is active for the controlling viewer');
    }
    if (expectedControlEpoch !== undefined && expectedControlEpoch !== rec.controlEpoch) {
      throw H.v2Error('STALE_CONTROL_EPOCH', 'control epoch does not match');
    }
    if (rec.viewerInstance && rec.viewerInstance !== viewerInstance && rec.state === 'human') {
      throw H.v2Error('CONTROL_BUSY', 'another viewer holds control');
    }
    return { rec };
  }

  function markAcquired(rec, session, viewerInstance) {
    let result;
    try { result = session.lease.acquire(); }
    catch (e) {
      if (e.code === 'CONTROL_BUSY') throw H.v2Error('CONTROL_BUSY', 'another viewer holds control');
      if (e.code === 'RECONCILE_BEFORE_HANDOFF') throw H.v2Error('RECONCILIATION_REQUIRED', 'session needs reconciliation', { effectUnknown: true });
      throw H.v2Error('CONTROL_BUSY', 'human control could not be acquired');
    }
    rec.state = 'human';
    rec.controlOwner = 'human';
    rec.controlEpoch = result.fence;
    rec.viewerInstance = viewerInstance;
    rec.documentEpoch = session.page(rec.pageId).documentEpoch;
    pushEvent(rec, 'acquired', 'human control acquired');
    session.invalidateAll();
    persist();
    return dto(rec);
  }

  function release(rec, session) {
    if (session.lease.owner === 'human') {
      const result = session.lease.releaseToPaused();
      rec.controlEpoch = result.fence;
    }
    rec.state = 'paused';
    rec.controlOwner = 'paused';
    rec.viewerInstance = null;
    rec.resumeEligible = false;
    if (session.privateInput) endPrivate(rec, session);
    pushEvent(rec, 'released', 'human input fenced; agent was not resumed');
    session.invalidateAll();
    persist();
    return dto(rec);
  }

  function beginPrivate(rec, session) {
    assertLive(rec);
    if (rec.state !== 'human') throw H.v2Error('CONTROL_BUSY', 'private input requires the controlling human');
    session.privateInput = true;
    rec.privateInput = true;
    session.privacyEpoch = (session.privacyEpoch || 0) + 1;
    session.invalidateAll();
    pushEvent(rec, 'private-began', 'private input began');
    persist();
    return dto(rec);
  }

  function endPrivate(rec, session) {
    session.privateInput = false;
    rec.privateInput = false;
    session.privacyEpoch = (session.privacyEpoch || 0) + 1;
    session.invalidateAll();
    for (const p of session.pages.values()) p.owned.documentEpoch += 0;
    pushEvent(rec, 'private-ended', 'private input ended');
    persist();
    return dto(rec);
  }

  function authorizeResume(rec, session, { principalId, consumerId = rec.principalId, runId, expectedControlEpoch }) {
    assertLive(rec);
    if (expectedControlEpoch !== undefined && expectedControlEpoch !== rec.controlEpoch) {
      throw H.v2Error('STALE_CONTROL_EPOCH', 'control epoch does not match');
    }
    if (rec.state !== 'paused' && rec.state !== 'human') {
      throw H.v2Error('RESUME_NOT_AUTHORIZED', 'handoff is not waiting for a return to the agent');
    }
    const grantId = C.newId('grant');
    const grant = {
      grantId,
      handoffId: rec.handoffId,
      sessionId: session.sessionId,
      runId: runId || rec.runId,
      controlEpoch: rec.controlEpoch,
      principalId,
      consumerId,
      expiresAt: Math.min(rec.expiresAt, clock.now() + 5 * 60 * 1000),
      used: false,
    };
    grants.set(grantId, grant);
    rec.resumeEligible = true;
    rec.state = rec.state === 'human' ? 'human' : 'readyToResume';
    pushEvent(rec, 'resume-authorized', 'a one-use return-to-agent grant was recorded');
    persist();
    return grant;
  }

  function consumeResume(session, { handoffId, runId, expectedControlEpoch, requestKey, principal }) {
    const digest = digestOf({ handoffId, runId: runId || null, expectedControlEpoch, requestKey });
    const replay = sameRequest(principal, requestKey, digest);
    if (replay && replay.resumeResult) return { ...replay.resumeResult, replayed: true };
    const rec = records.get(handoffId);
    assertLive(rec);
    if (rec.sessionId !== session.sessionId) throw H.v2Error('RESUME_NOT_AUTHORIZED', 'handoff is for a different session');
    if (expectedControlEpoch !== rec.controlEpoch) throw H.v2Error('STALE_CONTROL_EPOCH', 'control epoch does not match');
    const grant = [...grants.values()].find((g) => !g.used && g.handoffId === handoffId && g.controlEpoch === rec.controlEpoch
      && g.consumerId === principal.id
      && (g.runId || null) === (runId || rec.runId || null) && clock.now() <= g.expiresAt);
    if (!grant) throw H.v2Error('RESUME_NOT_AUTHORIZED', 'no matching return-to-agent grant');
    if (session.lease.owner === 'human') session.lease.releaseToPaused();
    if (session.privateInput) endPrivate(rec, session);
    let result;
    try { result = session.lease.resumeFromPaused(); }
    catch (e) {
      if (e.code === 'NOT_PAUSED' || e.code === 'NOT_HUMAN_OWNED') throw H.v2Error('RESUME_NOT_AUTHORIZED', 'session is not paused for return');
      throw e;
    }
    grant.used = true;
    rec.resumeEligible = false;
    rec.state = 'closed';
    rec.controlOwner = 'agent';
    rec.controlEpoch = result.fence;
    rec.blocker = null;
    const resumeResult = {
      handoffId, runId: runId || rec.runId, controlOwner: 'agent', controlEpoch: result.fence,
      requireFreshObservation: true, resumed: true,
    };
    rec.resumeResult = resumeResult;
    if (requestKey) keys.set(`${principal.id}:${requestKey}`, { digest, handoffId });
    pushEvent(rec, 'resumed', 'agent control restored on the same session');
    session.invalidateAll();
    persist();
    return { ...resumeResult, replayed: false };
  }

  function revoke(handoffId) {
    const rec = records.get(handoffId);
    if (!rec || rec.state === 'closed') return rec ? dto(rec) : null;
    rec.state = 'closed';
    rec.blocker = 'ACCESS_REVOKED';
    rec.resumeEligible = false;
    rec.inviteHash = null;
    rec.viewerInstance = null;
    for (const g of grants.values()) if (g.handoffId === handoffId) g.used = true;
    pushEvent(rec, 'revoked', 'viewer access revoked');
    persist();
    return dto(rec);
  }

  function onSessionClosed(sessionId) {
    for (const rec of records.values()) {
      if (rec.sessionId === sessionId && rec.state !== 'closed') revoke(rec.handoffId);
    }
  }

  // Test/trusted-channel only. Never copied into an MCP projection.
  function peekInvitation() { return null; }

  async function writeOnce(rec, { principalId, requestKey, expectedControlEpoch, action, payload }, fn) {
    if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(requestKey)) {
      throw H.v2Error('IDEMPOTENCY_CONFLICT', 'a bounded request key is required');
    }
    const key = `${principalId}:${requestKey}`;
    const digest = digestOf({ action, expectedControlEpoch, payload });
    rec.writeReceipts ||= {};
    const previous = rec.writeReceipts[key];
    if (previous) {
      if (previous.digest !== digest) throw H.v2Error('IDEMPOTENCY_CONFLICT', 'request content changed');
      if (!previous.complete) throw H.v2Error('RECONCILIATION_REQUIRED', 'previous dispatch has an unknown outcome', { effectUnknown: true });
      if (previous.error) throw H.v2Error(previous.error, 'the original request was rejected');
      return previous.value;
    }
    assertLive(rec);
    if (expectedControlEpoch !== rec.controlEpoch) throw H.v2Error('STALE_CONTROL_EPOCH', 'control epoch does not match');
    if (Object.keys(rec.writeReceipts).length >= 4000) throw H.v2Error('ACCESS_REVOKED', 'episode request budget exhausted');
    rec.writeReceipts[key] = { digest, complete: false };
    persist(); // Persist acceptance before any effect. Never replay an uncertain input.
    let value;
    try { value = await fn(); } catch (error) {
      if (error.v2Code && error.publicError?.effectUnknown !== true) {
        rec.writeReceipts[key] = { digest, complete: true, error: error.v2Code };
        persist();
      }
      throw error;
    }
    rec.writeReceipts[key] = { digest, complete: true, value };
    persist();
    return value;
  }

  async function pauseOnce(session, input, principal, fn) {
    const key = `${principal.id}:${input.requestKey}`;
    const digest = digestOf({ sessionId: session.sessionId, runId: input.runId, epoch: input.expectedControlEpoch });
    const previous = controls.get(key);
    if (previous) {
      if (previous.digest !== digest) throw H.v2Error('IDEMPOTENCY_CONFLICT', 'pause request content changed');
      if (!previous.complete) throw H.v2Error('RECONCILIATION_REQUIRED', 'previous pause has not settled');
      return previous.value;
    }
    if (input.expectedControlEpoch !== session.lease.fence) throw H.v2Error('STALE_CONTROL_EPOCH', 'control epoch does not match');
    if (controls.size >= 4000) throw H.v2Error('ACCESS_REVOKED', 'control request budget exhausted');
    controls.set(key, { digest, complete: false }); persist();
    const value = await fn(); controls.set(key, { digest, complete: true, value }); persist(); return value;
  }

  return {
    hasLiveSession: (sessionId) => [...records.values()].some((r) => r.sessionId === sessionId && (r.state !== 'closed' || r.controlOwner !== 'agent')),
    withLock, pause, requestHandoff, status, get, redeem, acquire, markAcquired, release,
    beginPrivate, endPrivate, authorizeResume, consumeResume, revoke, onSessionClosed, peekInvitation, dto, assertLive, writeOnce, pauseOnce,
    revokeRun: (runId) => { for (const rec of records.values()) if (rec.runId === runId) revoke(rec.handoffId); },
  };
}

function H_sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { createHandoffCoordinator, DEFAULT_TTL_MS, FRAME_STALE_MS };
