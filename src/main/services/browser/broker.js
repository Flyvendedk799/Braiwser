// BrowserBroker: the ONE facade for MCP, CLI, skills and the Braiwser UI.
//
// Everything is principal-scoped: possession of an id is never authority. The
// feature is OFF unless `featureFlag === true` or BRAIWSER_AGENT_RUNTIME=1.
// Drivers are injected (`drivers: { playwright, 'electron-embedded' }`); this
// module imports neither Electron nor Playwright.
//
// Layering for one action (act):
//   validate -> owner/session/page -> grant+budget -> server-side ref resolve ->
//   action policy (secret fields, write-like => one-use approval) -> OwnedPage
//   lane (idempotency, ledger accepted, ownership/epoch recheck, approval
//   consume + ledger dispatch_started committed BEFORE input, deadline barrier)
//   -> receipt journaled -> public receipt + evidence artifact.
'use strict';
const path = require('node:path');
const nodeFs = require('node:fs');
const { EventEmitter } = require('node:events');
const C = require('../../../shared/browser-contracts');
const { redactUrl, redactText } = require('../../../shared/browser-redact');
const { createPolicy } = require('./policy');
const { createLedger } = require('./ledger');
const { createEvidenceStore } = require('./evidence');
const { createRunStore, gradeRun, stateFor, runToDTO, runPlanLoop, decideTerminal, waitForEvent } = require('./run');
const { createHandoff } = require('./human-handoff');
const { createHandoffCoordinator } = require('./handoff-coordinator');
const { BrowserSession } = require('./session');

const DEFAULT_LIMITS = Object.freeze({
  maxSessions: 8, maxSessionsPerPrincipal: 4, maxPagesPerSession: 4, refTtlMs: 5 * 60 * 1000,
  maxResponseBytes: C.DEFAULT_MAX_RESPONSE_BYTES, approvalWaitMs: 10 * 60 * 1000, humanWaitMs: 30 * 60 * 1000,
  stepTimeoutMs: 15000, observeTimeoutMs: 15000, maxNodes: 200, drainTimeoutMs: 5000,
});
const MAX_INPUT_CHARS = 10000;
const STRUCT_MAX_BYTES = 28 * 1024; // one table/list payload inside an observation
const EVIDENCE_KINDS = new Set(['visible', 'text', 'exists', 'count', 'url', 'navigation', 'state-change', 'value', 'focus', 'checked', 'selected', 'clicked']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('driver timeout'), { code: 'DEADLINE_EXCEEDED' })), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function createBroker(options = {}) {
  const { dataDir, drivers = {}, clock: clockOpt, env = process.env, skills = null, fs = nodeFs, appVersion = 'dev' } = options;
  const clock = { now: () => Date.now(), monotonic: () => Number(process.hrtime.bigint() / 1000000n), ...(clockOpt || {}) };
  const enabled = options.featureFlag === undefined ? env.BRAIWSER_AGENT_RUNTIME === '1' : options.featureFlag === true;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const emit = (name, payload) => { try { events.emit(name, payload); } catch { /* listener errors never break the broker */ } };

  // ---- disabled broker: every call is UNAVAILABLE, nothing touches disk -------------
  const methodNames = ['openSession', 'closeSession', 'observe', 'act', 'startRun', 'getRun', 'cancelRun', 'retryRun', 'handoff', 'resume', 'approve', 'listApprovals', 'listRuns', 'getManifest', 'readResource', 'requestHandoff', 'pauseRun', 'handoffStatus', 'resumeRun', 'startTask'];
  function bindFacade(broker, principal) {
    const out = {};
    for (const m of methodNames) out[m] = (input, extra) => broker[m](input, { ...(extra || {}), principal });
    out.events = events;
    return Object.freeze(out);
  }
  if (!enabled) {
    const off = async () => { throw C.brokerError('UNAVAILABLE', 'agent runtime is disabled (set BRAIWSER_AGENT_RUNTIME=1)', { detail: 'FEATURE_OFF' }); };
    const broker = { enabled: false, events, limits, close: async () => {}, forPrincipal: (p) => bindFacade(broker, p), stats: () => ({ enabled: false }) };
    for (const m of methodNames) broker[m] = off;
    return Object.freeze(broker);
  }
  if (!dataDir) throw new TypeError('createBroker: dataDir is required when enabled');

  const policy = options.policy || createPolicy({ clock, fs });
  const base = path.join(dataDir, 'browser');
  const ledger = createLedger({ dir: path.join(base, 'ledger'), fs, clock });
  const evidence = createEvidenceStore({ dir: path.join(base, 'evidence'), fs, clock, ...(options.evidence || {}) });
  const runStore = createRunStore({ dir: path.join(base, 'runs'), fs, clock, ledgerLookup: (s, o) => ledger.get(s, o) });
  const handoffs = createHandoff({ policy, emit, clock, drainTimeoutMs: limits.drainTimeoutMs });
  let viewerConfig = options.viewer && options.viewer.enabled ? { ...options.viewer } : null;
  const handoffCoord = createHandoffCoordinator({
    clock, dataDir, ttlMs: limits.humanWaitMs,
    getViewer: () => viewerConfig,
  });

  const sessions = new Map();
  const profilesInUse = new Map();
  const runtimes = new Map(); // runId -> { controller, principal, inputs, done, approvals, ... }
  const inflight = new Map(); // sessionId + operationId -> Promise<public receipt> (duplicates share it)
  const receiptMeta = new Map(); // `${sessionId}\0${operationId}` -> {afterObservationId, evidenceUri}

  // ======================================================================
  // helpers
  // ======================================================================
  const dtoError = (code, msg, o) => C.brokerError(code, msg, o);
  function principalOf(ctx) {
    if (!ctx || typeof ctx !== 'object') throw dtoError('DENIED', 'missing request context', { detail: 'NO_CTX' });
    return C.validatePrincipal(ctx.principal);
  }
  // Every thrown error leaves the broker with .publicError set.
  async function guard(fn) {
    try { return await fn(); } catch (e) { throw C.toBrokerError(e); }
  }
  function ownedSession(sessionId, principal, { allowUi = false } = {}) {
    const s = sessions.get(sessionId);
    // Same error for unknown and foreign: ids are not authority, existence is not leaked.
    if (!s || s.closed || (s.ownerId !== principal.id && !(allowUi && principal.kind === 'ui'))) throw dtoError('DENIED', 'unknown or unauthorized session', { detail: 'UNKNOWN_SESSION' });
    return s;
  }
  function ownedRun(runId, principal) {
    const r = runStore.get(runId);
    if (!r || (r.ownerId !== principal.id && principal.kind !== 'ui')) throw dtoError('DENIED', 'unknown or unauthorized run', { detail: 'UNKNOWN_RUN' });
    return r;
  }
  const containerFor = (session, runId) => (runId ? (runStore.get(runId) || {}).evidenceRunId || runId : session.adhocRunId);
  function runForAct(runId, session, principal) {
    if (!runId) return null;
    const r = ownedRun(runId, principal);
    if (r.sessionId !== session.sessionId) throw dtoError('DENIED', 'run does not belong to this session', { detail: 'RUN_SESSION' });
    return r;
  }
  const safePut = (runContainer, spec) => {
    try { return evidence.putArtifact(runContainer, spec); } catch { return null; }
  };

  // ---- evidence trust (sync, default-deny): only driver-produced, observed facts ------
  function isTrustedEvidence(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (!EVIDENCE_KINDS.has(e.kind) || e.observed !== true) return false;
    if (e.documentEpoch !== undefined && !Number.isSafeInteger(e.documentEpoch)) return false;
    return JSON.stringify(e).length < 4096;
  }
  function makeValidateEvidence() {
    return (cmd, result, scope) => Array.isArray(result.evidence) && result.evidence.length > 0 && result.evidence.length <= 20
      && scope.sessionId === cmd.sessionId && scope.pageId === cmd.pageId && result.evidence.every(isTrustedEvidence);
  }
  // A document change during an action is legitimate only when the driver itself
  // observed a navigation to a destination the grant allows.
  function makeAcceptTransition(session) {
    return (cmd, result, scope) => scope.sessionId === cmd.sessionId && scope.pageId === cmd.pageId && scope.documentEpoch > cmd.documentEpoch
      && Array.isArray(result.evidence) && result.evidence.some((e) => isTrustedEvidence(e)
        && ((e.kind === 'navigation' && typeof e.url === 'string' && policy.checkDestination(session.grant, e.url).allowed)
          // Resizing re-evaluates layout/media queries: the driver bumps its epoch and reports the observed size.
          || (cmd.action.kind === 'setViewport' && e.kind === 'state-change' && e.change === 'viewport' && e.width === cmd.action.width && e.height === cmd.action.height)));
  }

  // ======================================================================
  // pages
  // ======================================================================
  function registerPage(session, driverPage, opener = null) {
    if (session.pages.size >= limits.maxPagesPerSession) {
      try { driverPage.dispose && driverPage.dispose(); } catch { /* ignore */ }
      throw dtoError('UNAVAILABLE', 'too many pages in this session', { detail: 'PAGE_CAP' });
    }
    const pageId = C.newId('page');
    const journal = {
      accept: (cmd, digest) => {
        const r = ledger.accept({ sessionId: cmd.sessionId, operationId: cmd.operationId, pageId: cmd.pageId, runId: cmd.runId, principalId: cmd.principalId, commandHash: digest, summary: ledger.summarize(cmd) });
        if (r.duplicate && !r.receipt) throw Object.assign(new Error('operation in flight'), { code: 'IDEMPOTENCY_IN_FLIGHT' });
        return r.duplicate ? { receipt: r.receipt } : null;
      },
      dispatchStarted: (cmd) => ledger.dispatchStarted({ sessionId: cmd.sessionId, operationId: cmd.operationId, documentEpoch: cmd.documentEpoch }),
      result: (cmd, receipt) => ledger.resultRecorded({ sessionId: cmd.sessionId, operationId: cmd.operationId, receipt }),
    };
    const rec = session.addPage({
      pageId, driverPage, opener,
      ownedOptions: {
        execute: (cmd, control) => executeCommand(session, rec, cmd, control),
        validateEvidence: makeValidateEvidence(), acceptTransition: makeAcceptTransition(session),
        journal, digest: (cmd) => cmd.requestHash,
      },
    });
    rec.violation = null;
    try { rec.currentUrl = driverPage.url && driverPage.url(); } catch { rec.currentUrl = null; }
    try { driverPage.setOwnerBadge && driverPage.setOwnerBadge(session.lease.owner === 'agent' ? 'agent' : 'human'); } catch { /* cosmetic */ }
    // A popup may already be somewhere forbidden when we first see it.
    if (opener && rec.currentUrl && !policy.checkDestination(session.grant, rec.currentUrl).allowed) {
      rec.violation = { at: clock.now(), url: redactUrl(rec.currentUrl) };
      rec.owned.quarantine('DESTINATION_DENIED');
      Promise.resolve().then(() => driverPage.navigate && driverPage.navigate('about:blank', { timeoutMs: 3000 })).catch(() => {});
    }
    const ev = driverPage.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('navigated', (p) => onPageEvent(session, rec, 'navigated', p));
      ev.on('crashed', (p) => onPageEvent(session, rec, 'crashed', p));
      ev.on('closed', (p) => onPageEvent(session, rec, 'closed', p));
      ev.on('popup', (p) => onPageEvent(session, rec, 'popup', p));
      ev.on('download', (p) => emit('page-event', { sessionId: session.sessionId, pageId, type: 'download' }));
      ev.on('dialog', (p) => emit('page-event', { sessionId: session.sessionId, pageId, type: 'dialog' }));
    }
    return rec;
  }

  function onPageEvent(session, rec, type, payload) {
    if (session.closed || rec.closed) return;
    if (type === 'navigated') {
      rec.owned.navigated();
      rec.invalidate();
      let url = (payload && payload.url) || null;
      try { if (!url && rec.driverPage.url) url = rec.driverPage.url(); } catch { /* ignore */ }
      rec.currentUrl = url;
      // Arrival check: navigation-only enforcement of the destination policy.
      if (url && !policy.checkDestination(session.grant, url).allowed) {
        rec.violation = { at: clock.now(), url: redactUrl(url) };
        rec.owned.quarantine('DESTINATION_DENIED');
        emit('owner-changed', { sessionId: session.sessionId, pageId: rec.pageId, owner: 'quarantined', reason: 'DESTINATION_DENIED' });
        Promise.resolve().then(() => rec.driverPage.navigate && rec.driverPage.navigate('about:blank', { timeoutMs: 3000 })).catch(() => {});
      }
    } else if (type === 'crashed') {
      rec.owned.quarantine('PAGE_CRASHED');
      rec.invalidate();
      emit('owner-changed', { sessionId: session.sessionId, pageId: rec.pageId, owner: 'quarantined', reason: 'PAGE_CRASHED' });
    } else if (type === 'closed') {
      rec.owned.quarantine('PAGE_CLOSED');
      session.removePage(rec.pageId);
      emit('owner-changed', { sessionId: session.sessionId, pageId: rec.pageId, owner: 'quarantined', reason: 'PAGE_CLOSED' });
    } else if (type === 'popup' && payload && payload.page) {
      try { registerPage(session, payload.page, rec.pageId); } catch { /* cap reached: page disposed */ }
    }
  }

  // Driver-level events that are not tied to a registered page (new popups).
  function sessionPageEventHandler(getSession) {
    return (ev) => {
      const session = getSession();
      if (!session || session.closed || !ev || !ev.page) return;
      const known = [...session.pages.values()].find((p) => p.driverPage === ev.page);
      if (known) return; // page-level emitter already handles registered pages
      if (ev.type === 'popup' || ev.type === 'page') {
        const opener = ev.opener ? [...session.pages.values()].find((p) => p.driverPage === ev.opener) : null;
        try { registerPage(session, ev.page, opener ? opener.pageId : null); } catch { /* cap */ }
      }
    };
  }

  // ======================================================================
  // dispatch (runs inside the OwnedPage lane)
  // ======================================================================
  async function executeCommand(session, rec, cmd, control) {
    const a = cmd.action;
    const preDispatch = () => {
      // Recheck, after every awaited step and immediately before input.
      control.check();
      if (session.closed) throw Object.assign(new Error('session closed'), { code: 'CANCELLED' });
      policy.assertActive(session.grant, { id: cmd.principalId });
      if (a.kind === 'navigate' && !policy.checkDestination(session.grant, a.url).allowed) throw Object.assign(new Error('destination denied'), { code: 'DESTINATION_DENIED' });
      if (cmd.approval) policy.consumeApproval(cmd.approval.approvalId, cmd.approval.bound);
      control.beforeDispatch(); // ledger dispatch_started is fsynced HERE
    };
    if (a.kind === 'navigate') {
      preDispatch();
      const r = await rec.driverPage.navigate(a.url, { signal: control.signal, timeoutMs: cmd.timeoutMs, operationId: cmd.operationId, sessionId: cmd.sessionId, pageId: cmd.pageId });
      const outcome = r && r.outcome;
      if (outcome === 'timeout') throw Object.assign(new Error('navigation timeout'), { code: 'DEADLINE_EXCEEDED' });
      if (outcome === 'cancelled') throw Object.assign(new Error('navigation cancelled'), { code: 'CANCELLED' });
      if (outcome !== 'ready') return { status: 'dispatched', code: 'NAVIGATION_FAILED', evidence: [] };
      return { status: 'verified', evidence: [{ kind: 'navigation', observed: true, url: r.url }] };
    }
    if (a.kind === 'setViewport') {
      if (typeof rec.driverPage.setViewport !== 'function') throw Object.assign(new Error('driver cannot set a viewport'), { code: 'UNSUPPORTED' });
      const epochBefore = rec.documentEpoch;
      // Like every input, the driver calls beforeDispatch() immediately before the resize (after its own validation).
      const r = await rec.driverPage.setViewport({ width: a.width, height: a.height }, { signal: control.signal, check: control.check, beforeDispatch: preDispatch });
      // A resize is a state change: refs, cursors and observations die with the epoch even if the driver did not say so.
      if (rec.documentEpoch === epochBefore) { rec.owned.navigated(); rec.invalidate(); }
      return r;
    }
    const driverCmd = {
      operationId: cmd.operationId, sessionId: cmd.sessionId, pageId: cmd.pageId, runId: cmd.runId, observationId: cmd.observationId,
      documentEpoch: cmd.documentEpoch, driverDocumentEpoch: cmd.target.driverDocumentEpoch,
      action: { kind: a.kind, refId: cmd.target.refId, ...(a.kind === 'fill' ? { text: a.text } : {}), ...(a.kind === 'press' ? { key: a.key } : {}),
        ...(a.kind === 'select' ? { value: a.value } : {}), ...(a.kind === 'check' ? { checked: a.checked } : {}) },
      target: { refId: cmd.target.refId, frameId: cmd.target.frameId, nodeIdentity: cmd.target.nodeIdentity, role: cmd.target.role, name: cmd.target.name },
    };
    const wrapped = { signal: control.signal, check: control.check, beforeDispatch: preDispatch };
    return rec.driverPage.act(driverCmd, wrapped);
  }

  // ======================================================================
  // observe
  // ======================================================================
  const publicNode = (n) => ({ ref: n.ref, role: clip(n.role, 80), name: clip(n.name, 200), ...(typeof n.enabled === 'boolean' ? { enabled: n.enabled } : {}), ...(typeof n.editable === 'boolean' ? { editable: n.editable } : {}),
    ...(n.table ? { table: n.table } : {}), ...(n.list ? { list: n.list } : {}) });
  // Bounded structure payloads (tables/lists) from the driver: redacted like names, shape-checked, never trusted for size.
  const structOf = (n, key) => {
    const v = n[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const clean = evidence.redactor.value(v);
    return Buffer.byteLength(JSON.stringify(clean)) <= STRUCT_MAX_BYTES ? clean : undefined;
  };
  // Pagination hints are refs to ordinary link/button nodes found by accessible name only.
  const paginationOf = (raw, refOf) => {
    if (!raw || typeof raw !== 'object') return undefined;
    const out = {};
    for (const dir of ['next', 'prev']) {
      const h = raw[dir];
      if (h && typeof h.refId === 'string' && refOf.has(h.refId)) out[dir] = { ref: refOf.get(h.refId), name: clip(evidence.redactor.text(clip(h.name, 120), 120), 120), enabled: h.enabled !== false };
    }
    if (Array.isArray(raw.ambiguous)) out.ambiguous = raw.ambiguous.filter((x) => x === 'next' || x === 'prev');
    return Object.keys(out).length ? out : undefined;
  };

  async function observeCore(session, rec, { maxNodes = 200, focus, cursor, noSpend = false }, principal, runId) {
    if (session.privateInput) throw dtoError('DENIED', 'PRIVATE_INPUT_ACTIVE: observations are suspended while private input is on', { detail: 'PRIVATE_INPUT_ACTIVE' });
    policy.assertActive(session.grant, principal);
    policy.assertClass(session.grant, 'observe');
    if (!noSpend) policy.spend(session.grant, 'observations');
    const now = clock.now();
    const container = containerFor(session, runId);
    let obs; let start = 0; let driverCursor;
    if (cursor) {
      const c = rec.takeCursor(cursor, now);
      if (c.kind === 'local') {
        obs = rec.observations.get(c.observationId);
        if (!obs || obs.stale || !obs.nodes) throw dtoError('STALE_REF', 'cursor is no longer valid; observe again', { retry: 'refresh', detail: 'STALE_CURSOR' });
        start = c.offset;
      } else driverCursor = c.driverCursor;
    }
    if (!obs) {
      let read;
      try {
        read = await rec.owned.read(() => withTimeout(Promise.resolve().then(() => rec.driverPage.observe({ maxNodes: Math.min(maxNodes, limits.maxNodes), focus, cursor: driverCursor })), limits.observeTimeoutMs));
      } catch (e) {
        if (e.publicError) throw e;
        if (e.code === 'OWNERSHIP_LOST') throw dtoError('DENIED', 'the page is under human control or not available to the agent', { retry: 'refresh', detail: 'OWNERSHIP_LOST' });
        if (e.code === 'STALE_DOCUMENT') throw dtoError('STALE_REF', 'the document changed during observation; observe again', { retry: 'refresh', detail: 'STALE_DOCUMENT' });
        throw dtoError('UNAVAILABLE', 'driver could not observe the page', { retry: 'safe-read', detail: 'OBSERVE_FAILED' });
      }
      const res = read.value || {};
      const rawNodes = Array.isArray(res.nodes) ? res.nodes.filter((n) => n && typeof n.refId === 'string' && typeof n.role === 'string').slice(0, limits.maxNodes) : [];
      const cleaned = rawNodes.map((n) => ({ ...n, name: evidence.redactor.text(clip(n.name, 200), 200), role: clip(n.role, 80), table: structOf(n, 'table'), list: structOf(n, 'list') }));
      const observationId = C.newId('observation');
      const refIds = rec.addObservation({ observationId, documentEpoch: read.documentEpoch, nodes: cleaned, driverNextCursor: res.nextCursor || null, now });
      obs = rec.observations.get(observationId);
      const driverEpoch = (() => { try { return rec.driverPage.documentEpoch; } catch { return undefined; } })();
      obs.nodes = cleaned.map((n, i) => ({ ref: refIds[i], role: n.role, name: n.name, enabled: n.enabled, editable: n.editable, testId: typeof n.testId === 'string' ? clip(n.testId, 200) : undefined, frameId: n.frameId || null, traits: n.traits, table: n.table, list: n.list }));
      obs.pagination = paginationOf(res.pagination, new Map(cleaned.map((n, i) => [n.refId, refIds[i]])));
      for (const id of refIds) { const r = rec.refs.get(id); if (r) r.driverEpoch = driverEpoch; }
      obs.coverage = res.coverage && typeof res.coverage === 'object' ? evidence.redactor.value(res.coverage) : { nodesReturned: obs.nodes.length };
      obs.driverTruncated = res.truncated === true;
      obs.url = rec.currentUrl || (() => { try { return rec.driverPage.url(); } catch { return null; } })();
      safePut(container, { id: observationId, kind: 'observation', data: { observationId, sessionId: session.sessionId, pageId: rec.pageId, documentEpoch: obs.documentEpoch, url: redactUrl(obs.url || '') || null, trust: 'untrusted-page', coverage: obs.coverage, nodes: obs.nodes.map(publicNode), ...(obs.pagination ? { pagination: obs.pagination } : {}), truncated: obs.driverTruncated } });
    }
    const evidenceUri = C.uris.observation(container, obs.observationId);
    const shell = (slice, end) => {
      let nextCursor = null;
      if (end < obs.nodes.length) nextCursor = rec.mintCursor({ kind: 'local', observationId: obs.observationId, offset: end }, now, limits.refTtlMs);
      else if (obs.driverNextCursor) nextCursor = rec.mintCursor({ kind: 'driver', driverCursor: obs.driverNextCursor }, now, limits.refTtlMs);
      return { sessionId: session.sessionId, pageId: rec.pageId, observationId: obs.observationId, documentEpoch: obs.documentEpoch, url: redactUrl(obs.url || '') || null, trust: 'untrusted-page',
        nodes: slice.map(publicNode), ...(obs.pagination ? { pagination: obs.pagination } : {}), coverage: obs.coverage, truncated: nextCursor !== null || obs.driverTruncated, nextCursor, evidenceUri };
    };
    let end = Math.min(obs.nodes.length, start + Math.min(maxNodes, limits.maxNodes));
    let out = shell(obs.nodes.slice(start, end), end);
    while (Buffer.byteLength(JSON.stringify(out)) > limits.maxResponseBytes && end > start + 1) {
      end = start + Math.max(1, Math.floor((end - start) * 0.8));
      out = shell(obs.nodes.slice(start, end), end);
    }
    return { out, internalNodes: obs.nodes.slice(start, end), observation: obs };
  }

  async function observe(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const v = C.validateObserve(input);
      const session = ownedSession(v.sessionId, principal);
      const rec = session.page(v.pageId);
      const r = await observeCore(session, rec, v, principal, null);
      return r.out;
    });
  }

  // ======================================================================
  // act
  // ======================================================================
  function describeTarget(node) { return node ? `${clip(node.role, 40)} "${redactText(clip(node.name, 80), 80)}"` : ''; }

  async function doAct(input, ctx, { afterObserve = true } = {}) {
    const principal = principalOf(ctx);
    const v = C.validateAct(input);
    const session = ownedSession(v.sessionId, principal);
    const rec = session.page(v.pageId);
    const runRec = runForAct(v.runId, session, principal);
    if (runRec && C.TERMINAL_STATES.includes(runRec.state)) throw dtoError('DENIED', 'run has finished', { detail: 'RUN_FINISHED' });
    const container = containerFor(session, v.runId);
    const key = `${session.sessionId}\u0000${v.operationId}`;
    const requestHash = ledger.commandHash({ sessionId: v.sessionId, pageId: v.pageId, runId: v.runId || null, observationId: v.observationId || null, documentEpoch: v.documentEpoch, operationId: v.operationId, action: v.action });

    // ---- duplicate: return the recorded outcome; never re-validate refs (a lost ack
    // after a navigation must still return the original receipt) ----
    const known = ledger.get(session.sessionId, v.operationId);
    if (known || rec.owned.operations.has(v.operationId)) {
      const pending = inflight.get(key);
      if (pending && (!known || known.commandHash === requestHash)) return pending;
      if (known && known.commandHash !== requestHash) throw dtoError('DENIED', 'operationId was already used with a different command', { detail: 'IDEMPOTENCY_CONFLICT' });
      const receipt = await rec.owned.act({ operationId: v.operationId, sessionId: v.sessionId, pageId: v.pageId, documentEpoch: v.documentEpoch, requestHash }, { timeoutMs: v.timeoutMs, signal: ctx.signal });
      const meta = receiptMeta.get(key) || {};
      return C.buildReceipt(receipt, { afterObservationId: meta.afterObservationId || null, evidenceUri: meta.evidenceUri || C.uris.manifest(container) });
    }

    policy.assertActive(session.grant, principal);
    let node = null;
    const refless = C.REFLESS_ACTIONS.includes(v.action.kind);
    if (!refless) node = rec.resolveRef(v.action.ref, { observationId: v.observationId, documentEpoch: v.documentEpoch, now: clock.now(), ttlMs: limits.refTtlMs });
    else if (v.documentEpoch !== rec.documentEpoch) throw dtoError('STALE_REF', 'document changed; observe again', { retry: 'refresh', detail: 'STALE_DOCUMENT' });
    const targetInfo = node ? { role: node.role, name: node.name, traits: node.traits } : {};
    const auth = policy.authorizeAction({ grant: session.grant, principal, action: v.action, target: targetInfo });
    if (v.action.kind === 'navigate') {
      const d = policy.checkDestination(session.grant, v.action.url);
      if (!d.allowed) throw dtoError('DENIED', `destination not allowed (${d.reason})`, { detail: 'DESTINATION_DENIED' });
    }
    let approval = null;
    if (auth.needsApproval) {
      const destination = v.action.kind === 'navigate' ? v.action.url : (rec.currentUrl || null);
      const digest = policy.actionDigest({ action: v.action, target: node, observationId: v.observationId, destination });
      const bound = { principalId: principal.id, runId: v.runId || null, sessionId: v.sessionId, pageId: v.pageId, documentEpoch: v.documentEpoch, digest, destination: destination ? (redactUrl(destination) || null) : null };
      if (!v.approvalId) {
        const req = policy.requestApproval(bound, { action: `${v.action.kind} (${auth.toolClass})`, target: describeTarget(node), destination, data: v.action.kind === 'fill' ? `${v.action.text.length} characters` : '' });
        emit('approval-requested', req);
        throw dtoError('DENIED', `approval_required: approvalId=${req.approvalId}`, { retry: 'after-approval', detail: 'APPROVAL_REQUIRED', extra: { approvalRequired: true, approvalId: req.approvalId } });
      }
      const st = policy.approvalState(v.approvalId);
      if (!st || st.status !== 'allowed' || st.principalId !== principal.id) throw dtoError('DENIED', 'approval is not usable', { retry: 'after-approval', detail: 'APPROVAL_STATE' });
      approval = { approvalId: v.approvalId, bound };
    }
    policy.spend(session.grant, 'actions');
    if (v.action.kind === 'navigate') policy.spend(session.grant, 'navigations');

    const cmd = {
      operationId: v.operationId, sessionId: v.sessionId, pageId: v.pageId, runId: v.runId || null, principalId: principal.id,
      documentEpoch: v.documentEpoch, observationId: v.observationId || null, requestHash, timeoutMs: v.timeoutMs,
      action: refless ? v.action : (({ ref, ...rest }) => rest)(v.action),
      target: node ? { refId: node.driverRefId, frameId: node.frameId, nodeIdentity: node.nodeIdentity, role: node.role, name: node.name, traits: node.traits, driverDocumentEpoch: node.driverEpoch } : null,
      approval,
    };
    const finishing = (async () => {
      const startedAt = clock.now();
      const receipt = await rec.owned.act(cmd, { timeoutMs: v.timeoutMs, signal: ctx.signal });

      let code = receipt.code;
      if (rec.violation && rec.violation.at >= startedAt && receipt.status !== 'not_attempted') code = 'DESTINATION_DENIED';
      let afterObservationId = null;
      if (afterObserve && (receipt.status === 'verified' || receipt.status === 'dispatched') && rec.owned.owner === 'agent') {
        try { afterObservationId = (await observeCore(session, rec, { maxNodes: 50, noSpend: true }, principal, v.runId)).out.observationId; } catch { /* best effort */ }
      }
      const art = safePut(container, { kind: 'receipt', data: { receipt: { ...receipt, code }, action: ledger.summarize(cmd), afterObservationId } });
      const evidenceUri = art ? art.uri : C.uris.manifest(container);
      receiptMeta.set(key, { afterObservationId, evidenceUri });
      if (receiptMeta.size > 5000) receiptMeta.delete(receiptMeta.keys().next().value);
      return C.buildReceipt(receipt, { afterObservationId, evidenceUri, code });
    })();
    inflight.set(key, finishing);
    try { return await finishing; } finally { inflight.delete(key); }
  }
  const act = (input, ctx) => guard(() => doAct(input, ctx));

  // ======================================================================
  // sessions
  // ======================================================================
  async function openSession(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const v = C.validateOpenSession(input);
      if (sessions.size >= limits.maxSessions) throw dtoError('UNAVAILABLE', 'session limit reached', { detail: 'SESSION_CAP' });
      if ([...sessions.values()].filter((s) => s.ownerId === principal.id).length >= limits.maxSessionsPerPrincipal) throw dtoError('UNAVAILABLE', 'per-principal session limit reached', { detail: 'SESSION_CAP' });
      const driver = drivers[v.driver];
      if (!driver) throw dtoError('UNAVAILABLE', `driver '${v.driver}' is not installed`, { detail: 'NO_DRIVER' });
      const caps = driver.capabilities({ mode: v.mode });
      if (Array.isArray(caps.modes) && !caps.modes.includes(v.mode)) throw dtoError('UNSUPPORTED', `driver does not support mode '${v.mode}'`, { detail: 'MODE_UNSUPPORTED' });
      const sessionId = C.newId('session');
      const grant = policy.createGrant(v.grant, principal, { sessionId });
      if (v.profile) {
        if (grant.profile !== v.profile) throw dtoError('DENIED', 'profile is not covered by the grant', { detail: 'PROFILE_SCOPE' });
        if (profilesInUse.has(v.profile)) throw dtoError('DENIED', 'profile is already open in another session (single writer)', { detail: 'PROFILE_IN_USE' });
        profilesInUse.set(v.profile, sessionId);
      }
      const adhocRunId = C.newId('run');
      let session;
      try {
        evidence.registerRun(adhocRunId, { ownerId: principal.id, sessionId, reviewSessionId: v.reviewSessionId || null, kind: 'adhoc' });
        ledger.sessionOpened({ sessionId, principalId: principal.id, driver: v.driver, mode: v.mode, reviewSessionId: v.reviewSessionId });
        const driverSession = await driver.open({ mode: v.mode, viewport: v.viewport, locale: v.locale, timezoneId: v.timezoneId, profile: v.profile,
          onPageEvent: sessionPageEventHandler(() => session), requestFilter: caps.requestInterception ? policy.requestFilter(grant) : undefined });
        const publicCaps = { ...caps, liveModeSwitch: false, requestInterception: caps.requestInterception === true, policyEnforcement: caps.requestInterception ? 'request-level' : 'navigation-only', schemaVersion: C.SCHEMA_VERSION };
        session = new BrowserSession({ sessionId, ownerId: principal.id, driverName: v.driver, mode: v.mode, grant, reviewSessionId: v.reviewSessionId || null, capabilities: publicCaps, driverSession, adhocRunId });
        sessions.set(sessionId, session);
        const first = driverSession.pages && [...driverSession.pages.values()][0];
        if (!first) throw dtoError('UNAVAILABLE', 'driver opened a session without a page', { detail: 'NO_PAGE' });
        const rec = registerPage(session, first);
        emit('session-opened', { sessionId, ownerId: principal.id });
        return { sessionId, pageId: rec.pageId, capabilities: publicCaps, limits: { ...limits, grantExpiresAt: new Date(grant.expiresAt).toISOString(), budgets: { ...grant.budgets } } };
      } catch (e) {
        sessions.delete(sessionId);
        if (v.profile && profilesInUse.get(v.profile) === sessionId) profilesInUse.delete(v.profile);
        try { ledger.sessionClosed({ sessionId, reason: 'open_failed' }); } catch { /* ignore */ }
        try { if (session && session.driverSession) await session.driverSession.close(); } catch { /* ignore */ }
        throw e;
      }
    });
  }

  async function closeSession(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.sessionId)) throw C.invalid('sessionId');
      const session = sessions.get(input.sessionId);
      if (!session) return { closed: true };
      if (session.ownerId !== principal.id && principal.kind !== 'ui') throw dtoError('DENIED', 'unknown or unauthorized session', { detail: 'UNKNOWN_SESSION' });
      if (session.closed) return { closed: true };
      session.closed = true;
      // Stop future dispatch first, then let runs settle.
      const pending = [];
      for (const runId of session.runs) {
        const rt = runtimes.get(runId);
        if (rt && !rt.finished) { rt.controller.abort('SESSION_CLOSED'); pending.push(rt.done); }
      }
      await Promise.race([Promise.allSettled(pending), sleep(1500)]);
      policy.revokeApprovals({ sessionId: session.sessionId });
      for (const runId of session.runs) { const rt = runtimes.get(runId); if (rt) { rt.inputs = {}; rt.args = {}; runtimes.delete(runId); } } // run inputs live in memory only, and only this long
      for (const p of [...session.pages.values()]) {
        p.owned.quarantine('SESSION_CLOSED');
        try { p.driverPage.dispose && p.driverPage.dispose(); } catch { /* ignore */ }
        session.removePage(p.pageId);
      }
      try { await Promise.race([session.driverSession.close(), sleep(Math.min(limits.drainTimeoutMs, 2500))]); } catch { /* ignore */ }
      try { ledger.sessionClosed({ sessionId: session.sessionId, reason: 'closed' }); } catch { /* ignore */ }
      evidence.markClosed(session.adhocRunId);
      sessions.delete(session.sessionId);
      for (const [pf, sid] of profilesInUse) if (sid === session.sessionId) profilesInUse.delete(pf);
      try { handoffCoord.onSessionClosed(session.sessionId); } catch { /* ledger best effort */ }
      emit('session-closed', { sessionId: session.sessionId, ownerId: session.ownerId });
      return { closed: true };
    });
  }

  // ======================================================================
  // handoff / approvals
  // ======================================================================
  async function handoff(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || typeof input !== 'object') throw C.invalid('request must be an object');
      const base = C.validateSessionPage({ sessionId: input.sessionId, pageId: input.pageId });
      const session = ownedSession(base.sessionId, principal, { allowUi: true });
      const runId = input.runId === undefined ? null : C.isClientId(input.runId) ? input.runId : (() => { throw C.invalid('runId'); })();
      if (runId) { const r = ownedRun(runId, principal); if (r.sessionId !== session.sessionId) throw dtoError('DENIED', 'run does not belong to this session', { detail: 'RUN_SESSION' }); }
      return handoffs.handoff(session, { pageId: base.pageId, runId, reason: input.reason }, principal);
    });
  }
  async function requestHandoff(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || typeof input !== 'object') throw C.invalid('request must be an object');
      const base = C.validateSessionPage({ sessionId: input.sessionId, pageId: input.pageId });
      const session = ownedSession(base.sessionId, principal, { allowUi: true });
      const runId = input.runId === undefined || input.runId === null ? null : (C.isClientId(input.runId) ? input.runId : (() => { throw C.invalid('runId'); })());
      if (runId) { const r = ownedRun(runId, principal); if (r.sessionId !== session.sessionId) throw dtoError('DENIED', 'run does not belong to this session', { detail: 'RUN_SESSION' }); }
      const requestKey = input.requestKey === undefined || input.requestKey === null ? null : (C.isClientId(input.requestKey) ? input.requestKey : (() => { throw C.invalid('requestKey'); })());
      const out = await handoffCoord.withLock(session.sessionId, () => handoffCoord.requestHandoff(session, {
        pageId: base.pageId, runId, requestKey, reasonCode: input.reasonCode || 'needsHuman', drainTimeoutMs: limits.drainTimeoutMs,
      }, principal));
      policy.revokeApprovals({ sessionId: session.sessionId });
      emit('owner-changed', { sessionId: session.sessionId, owner: 'paused', handoffId: out.record.handoffId, fence: out.record.controlEpoch });
      // The invitation code stays out of the tool result. Callers that are the
      // trusted UI may read it once from the return value's side channel.
      const value = out.record;
      if (principal.kind === 'ui' && out.invitationCode) value.invitationCode = out.invitationCode;
      return value;
    });
  }
  async function pauseRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.runId)) throw C.invalid('runId');
      const run = ownedRun(input.runId, principal);
      const session = ownedSession(run.sessionId, principal, { allowUi: true });
      if (input.expectedControlEpoch !== undefined && input.expectedControlEpoch !== session.lease.fence) {
        throw C.brokerError('DENIED', 'STALE_CONTROL_EPOCH: control epoch does not match', { detail: 'STALE_CONTROL_EPOCH' });
      }
      const requestKey = input.requestKey === undefined ? null : (C.isClientId(input.requestKey) ? input.requestKey : (() => { throw C.invalid('requestKey'); })());
      const digest = C.sha256({ runId: run.runId, requestKey, epoch: input.expectedControlEpoch || null });
      const result = await handoffCoord.withLock(session.sessionId, async () => {
        const paused = await handoffCoord.pause(session, { acknowledgeUncertain: principal.kind === 'ui', drainTimeoutMs: limits.drainTimeoutMs });
        return paused;
      });
      session.invalidateAll();
      policy.revokeApprovals({ sessionId: session.sessionId });
      emit('owner-changed', { sessionId: session.sessionId, owner: result.owner, fence: result.fence, runId: run.runId });
      return {
        runId: run.runId, sessionId: session.sessionId, state: result.owner === 'quarantined' ? 'quarantined' : 'paused',
        controlEpoch: result.fence, affectedRunIds: [...session.runs], requestKey, digest,
      };
    });
  }
  async function handoffStatus(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.handoffId)) throw C.invalid('handoffId');
      const rec = handoffCoord.get(input.handoffId);
      if (!rec) throw C.brokerError('DENIED', 'unknown or unauthorized handoff', { detail: 'UNKNOWN_HANDOFF' });
      ownedSession(rec.sessionId, principal, { allowUi: true });
      const afterSequence = input.afterSequence === undefined ? 0 : input.afterSequence;
      const maxEvents = input.maxEvents === undefined ? 30 : input.maxEvents;
      return handoffCoord.status(input.handoffId, { afterSequence, maxEvents });
    });
  }
  async function resumeRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || typeof input !== 'object') throw C.invalid('request must be an object');
      if (!C.isClientId(input.handoffId)) throw C.invalid('handoffId');
      if (!C.isClientId(input.requestKey)) throw C.invalid('requestKey');
      const rec = handoffCoord.get(input.handoffId);
      if (!rec) throw C.brokerError('DENIED', 'RESUME_NOT_AUTHORIZED: unknown handoff', { detail: 'RESUME_NOT_AUTHORIZED' });
      const session = ownedSession(rec.sessionId, principal, { allowUi: true });
      const runId = input.runId === undefined || input.runId === null ? rec.runId : (C.isClientId(input.runId) ? input.runId : (() => { throw C.invalid('runId'); })());
      if (runId) { const r = ownedRun(runId, principal); if (r.sessionId !== session.sessionId) throw dtoError('DENIED', 'run does not belong to this session', { detail: 'RUN_SESSION' }); }
      const out = await handoffCoord.withLock(session.sessionId, () => handoffCoord.consumeResume(session, {
        handoffId: input.handoffId, runId, expectedControlEpoch: input.expectedControlEpoch, requestKey: input.requestKey, principal,
      }));
      policy.revokeApprovals({ sessionId: session.sessionId });
      emit('owner-changed', { sessionId: session.sessionId, owner: 'agent', fence: out.controlEpoch, requireFreshObservation: true, handoffId: input.handoffId });
      return out;
    });
  }
  async function startTask(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!options.taskRunner || typeof options.taskRunner.start !== 'function') {
        throw dtoError('UNAVAILABLE', 'in-app agent runner is not configured', { detail: 'NO_TASK_RUNNER' });
      }
      return options.taskRunner.start(input, principal, ctx && ctx.signal);
    });
  }
  function attachViewer(config) {
    viewerConfig = config && config.enabled ? { enabled: true, baseUrl: config.baseUrl, deployment: config.deployment || 'local' } : null;
  }
  async function resume(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const v = C.validateSessionPage(input);
      const session = ownedSession(v.sessionId, principal, { allowUi: true });
      return handoffs.resume(session, { pageId: v.pageId }, principal);
    });
  }
  async function approve(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.approvalId)) throw C.invalid('approvalId');
      const r = policy.decide(input.approvalId, input.decision, principal);
      emit('approval-decided', r);
      return r;
    });
  }
  async function listApprovals(input, ctx) { return guard(async () => policy.listApprovals({ principal: principalOf(ctx) })); }

  // ======================================================================
  // runs
  // ======================================================================
  function recordEvent(run, kind, summary, stepId) {
    const e = runStore.event(run.runId, { kind, summary, stepId });
    emit('run-event', { runId: run.runId, ownerId: run.ownerId, sequence: e.sequence, kind: e.kind, summary: e.summary, stepId: e.stepId });
    return e;
  }
  const dto = (run, o) => runToDTO(run, o);

  function manifestFacts(run, grade, terminal, state, reason, rt) {
    const results = [...run.results.values()];
    const stepsById = new Map(run.plan.steps.map((s) => [s.id, s]));
    return {
      urls: [{ url: redactUrl((sessions.get(run.sessionId)?.pages.get(run.pageId)?.currentUrl) || '') || null }],
      versions: { app: appVersion, driver: (sessions.get(run.sessionId)?.capabilities || {}).driver || run.driverName, driverVersion: (sessions.get(run.sessionId)?.capabilities || {}).version || null, skill: `${run.skillId}@${run.skillVersion}`, schema: C.SCHEMA_VERSION },
      digests: { plan: C.sha256(run.plan), inputs: run.inputsDigest },
      counts: { planned: grade.planned, executed: grade.executed, passed: grade.passed, failed: grade.failed, skipped: grade.skipped, pending: grade.pending, unknown: grade.unknown, cancelled: grade.cancelled, timedOut: grade.timedOut, requiredAssertions: grade.requiredAssertions, passedAssertions: grade.passedAssertions },
      terminal: { state, terminal, reason: reason || null, cancelRequested: run.cancelRequested, cancelledBeforeDispatch: run.cancelRequested && !results.some((r) => r.effect !== 'notDispatched'), uncertainEffect: grade.uncertainEffect, evidenceComplete: grade.evidenceComplete, verdict: grade.status },
      steps: results.map((r) => ({ stepId: r.stepId, type: (stepsById.get(r.stepId) || {}).type, status: r.status, effect: r.effect, evidenceIds: r.evidenceIds, code: r.code || null })),
      assertions: results.filter((r) => (stepsById.get(r.stepId) || {}).type === 'assert').map((r) => { const s = stepsById.get(r.stepId); return { stepId: r.stepId, kind: s.kind, op: s.op, expected: s.expected, status: r.status, evidenceIds: r.evidenceIds }; }),
      approvals: (rt && rt.approvals) || [],
    };
  }

  function finalizeRun(run, rt) {
    const signal = rt.controller.signal;
    const terminal = decideTerminal({ run, signal, results: run.results });
    const reason = signal.aborted ? String(signal.reason || 'CANCELLED') : (terminal === 'unknown' ? 'EFFECT_UNKNOWN' : null);
    const evidenceIds = [...run.results.values()].flatMap((r) => r.evidenceIds);
    let complete = false;
    try { complete = evidence.verify(run.evidenceRunId, evidenceIds).complete; } catch { complete = false; }
    let grade = gradeRun(run, { evidenceComplete: complete, terminal });
    let state = stateFor(terminal, grade.status);
    let committed = false;
    try {
      evidence.commitManifest(run.evidenceRunId, manifestFacts(run, grade, terminal, state, reason, rt));
      committed = true;
    } catch (e) {
      // A pass needs a COMMITTED manifest. Re-grade without evidence completeness.
      complete = false;
      grade = gradeRun(run, { evidenceComplete: false, terminal });
      state = stateFor(terminal, grade.status);
    }
    if (!committed) recordEvent(run, 'manifest_failed', 'evidence manifest could not be committed; result is not provable');
    runStore.transition(run.runId, state, { terminal, reason, evidenceComplete: committed && complete });
    recordEvent(run, 'finished', `run ${state}${reason ? ` (${reason})` : ''}`);
    rt.finished = true;
  }

  function makeHost(run, rt, session, rec) {
    const principal = rt.principal;
    const ctx = { principal, signal: rt.controller.signal };
    const container = run.evidenceRunId;
    const opId = (step, attempt, tag = '') => `${run.runId}.${run.plan.steps.findIndex((s) => s.id === step.id)}.${attempt}${tag}`;
    const setState = (state, why) => {
      const cur = runStore.get(run.runId).state;
      if (cur === state || C.TERMINAL_STATES.includes(cur)) return;
      if (!C.canTransition(cur, state)) return;
      runStore.transition(run.runId, state);
      recordEvent(run, state, why);
    };
    const fromThrown = (e, extra = {}) => {
      const p = (e && e.publicError) || C.publicError(e);
      return { status: 'not_attempted', code: (e && e.code && /^[A-Z_]+$/.test(e.code) ? e.code : p.code), dispatched: false, effectUnknown: false, ...extra };
    };
    let counter = 0;
    const host = {
      async observe({ maxNodes, cursor }) {
        const r = await observeCore(session, rec, { maxNodes, cursor, noSpend: false }, principal, run.runId);
        return { observationId: r.out.observationId, documentEpoch: r.out.documentEpoch, nodes: r.internalNodes, nextCursor: r.out.nextCursor };
      },
      async navigate(url, step, attempt = 0) {
        const operationId = opId(step, attempt, `n${counter++}`);
        runStore.stepStarted(run.runId, step.id, operationId);
        try {
          return await doAct({ sessionId: session.sessionId, pageId: rec.pageId, runId: run.runId, documentEpoch: rec.documentEpoch, operationId, action: { kind: 'navigate', url }, timeoutMs: limits.stepTimeoutMs }, ctx, { afterObserve: false });
        } catch (e) { return fromThrown(e); }
      },
      async setViewport(width, height, step, attempt = 0) {
        const operationId = opId(step, attempt, `v${counter++}`);
        runStore.stepStarted(run.runId, step.id, operationId);
        try {
          return await doAct({ sessionId: session.sessionId, pageId: rec.pageId, runId: run.runId, documentEpoch: rec.documentEpoch, operationId, action: { kind: 'setViewport', width, height }, timeoutMs: limits.stepTimeoutMs }, ctx, { afterObserve: false });
        } catch (e) { return fromThrown(e); }
      },
      // Read-only evidence: an unmodified screenshot of the viewport (or of one resolved element). The pixels go to the
      // evidence store as an internal binary artifact; only a bounded metadata record and ids ever leave this method.
      async capture(step, found) {
        try {
          policy.assertActive(session.grant, principal);
          policy.assertClass(session.grant, 'observe');
          policy.spend(session.grant, 'observations');
          let refId;
          if (found) {
            const node = rec.resolveRef(found.node.ref, { observationId: found.observation.observationId, documentEpoch: found.observation.documentEpoch, now: clock.now(), ttlMs: limits.refTtlMs });
            refId = node.driverRefId;
          }
          if (typeof rec.driverPage.capture !== 'function') return { status: 'failed', code: 'UNSUPPORTED' };
          const read = await rec.owned.read(() => withTimeout(Promise.resolve().then(() => rec.driverPage.capture(refId ? { refId } : {})), limits.stepTimeoutMs));
          const shot = read.value || {};
          const m = shot.meta || {};
          const size = (o) => (o && Number.isFinite(o.width) && Number.isFinite(o.height) ? { width: Math.round(o.width), height: Math.round(o.height) } : null);
          if (!Buffer.isBuffer(shot.bytes) || !shot.bytes.length || m.transformed !== false || !size(m.viewport)) return { status: 'failed', code: 'CAPTURE_INVALID' };
          const label = clip(evidence.redactor.text(clip(step.label, 200), 200), 200);
          const png = evidence.putArtifact(container, { kind: 'screenshot', mime: 'image/png', data: shot.bytes, visibility: 'internal', label });
          const meta = evidence.putArtifact(container, { kind: 'capture', label, data: {
            stepId: step.id, label, screenshot: { artifactId: png.artifactId, bytes: png.bytes },
            url: redactUrl(m.url || '') || null, viewport: size(m.viewport), scale: Number.isFinite(m.scale) ? m.scale : 1,
            scroll: { x: Number(m.scroll && m.scroll.x) || 0, y: Number(m.scroll && m.scroll.y) || 0 },
            ...(m.clip ? { clip: size(m.clip) && { x: Number(m.clip.x) || 0, y: Number(m.clip.y) || 0, ...size(m.clip) } } : {}),
            ...(found ? { target: describeTarget(found.node) } : {}),
            capturedAt: typeof m.capturedAt === 'string' ? clip(m.capturedAt, 40) : new Date(clock.now()).toISOString(), transformed: false,
          } });
          return { status: 'captured', code: 'OK', evidenceIds: [png.artifactId, meta.artifactId] };
        } catch (e) {
          const p = (e && e.publicError) || null;
          return { status: 'failed', code: (e && e.code && /^[A-Z_]+$/.test(e.code) ? e.code : p && p.code) || 'CAPTURE_FAILED' };
        }
      },
      async act(action, { step, attempt, observation }) {
        let approvalId;
        for (let round = 0; round < 2; round++) {
          const operationId = opId(step, attempt, round ? 'a' : '');
          runStore.stepStarted(run.runId, step.id, operationId);
          try {
            return await doAct({ sessionId: session.sessionId, pageId: rec.pageId, runId: run.runId, observationId: observation.observationId, documentEpoch: observation.documentEpoch, operationId, action, approvalId, timeoutMs: limits.stepTimeoutMs }, ctx, { afterObserve: false });
          } catch (e) {
            if (!(e && e.approvalRequired) || round > 0) return fromThrown(e);
            // needsApproval: headless clients can only wait; the trusted UI decides.
            setState('needsApproval', 'waiting for a one-use approval');
            const id = e.approvalId;
            const w = await waitForEvent(events, 'approval-decided', (a) => a.approvalId === id, { signal: rt.controller.signal, timeoutMs: limits.approvalWaitMs });
            rt.approvals.push({ approvalIdHash: C.sha256(id).slice(0, 16), decision: w === 'event' ? policy.approvalState(id)?.status || 'unknown' : w, action: action.kind });
            if (w !== 'event' || (policy.approvalState(id) || {}).status !== 'allowed') {
              return { status: 'not_attempted', code: w === 'aborted' ? 'CANCELLED' : w === 'timeout' ? 'APPROVAL_WAIT_EXPIRED' : 'DENIED', dispatched: false, effectUnknown: false };
            }
            approvalId = id;
            setState('running', 'approval granted');
          }
        }
        return { status: 'not_attempted', code: 'DENIED', dispatched: false, effectUnknown: false };
      },
      async assert(assertion) {
        let timer;
        try {
          const read = await rec.owned.read(() => Promise.race([rec.driverPage.evaluateAssertion(assertion), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('assertion timeout'), { code: 'DEADLINE_EXCEEDED' })), limits.stepTimeoutMs); })]));
          const r = read.value || {};
          return { status: ['passed', 'failed', 'unknown'].includes(r.status) ? r.status : 'unknown', actual: r.actual, code: r.code };
        } catch (e) { return { status: 'unknown', code: e.code || 'ASSERTION_ERROR' }; } finally { clearTimeout(timer); }
      },
      async record(kind, data) {
        const a = evidence.putArtifact(container, { kind, data });
        return a.artifactId;
      },
      async waitForAgent() {
        const owner = rec.owned.owner;
        if (owner === 'quarantined') return 'quarantined';
        setState('needsHuman', 'waiting for the human to finish and resume');
        if (session.lease.isAgent()) { setState('running', 'agent control restored'); return 'resumed'; }
        const w = await waitForEvent(events, 'owner-changed', (e) => e.sessionId === session.sessionId && e.owner === 'agent', { signal: rt.controller.signal, timeoutMs: limits.humanWaitMs });
        if (w === 'event') { setState('running', 'agent control restored after fresh observation'); return 'resumed'; }
        return w;
      },
    };
    return host;
  }

  async function execRun(run, rt) {
    const session = sessions.get(run.sessionId);
    const finish = () => { try { finalizeRun(run, rt); } catch (e) { rt.error = e; try { runStore.transition(run.runId, 'uncertain', { terminal: 'unknown', reason: 'FINALIZE_ERROR', evidenceComplete: false }); } catch { /* ignore */ } rt.finished = true; } };
    if (rt.controller.signal.aborted || !session || session.closed) {
      if (!rt.controller.signal.aborted) rt.controller.abort('SESSION_CLOSED');
      return finish();
    }
    try {
      const rec = session.page(run.pageId);
      runStore.transition(run.runId, 'running');
      recordEvent(run, 'running', 'run started');
      const host = makeHost(run, rt, session, rec);
      await runPlanLoop({
        plan: run.plan, inputs: rt.inputs, host, signal: rt.controller.signal,
        onStepStart: (step, i) => { if (clock.monotonic() >= rt.deadlineMono) rt.controller.abort('DEADLINE'); recordEvent(run, 'step_started', `step ${i + 1}/${run.plan.steps.length}: ${step.type}`, step.id); },
        onStepResult: (r) => { runStore.stepResult(run.runId, { stepId: r.stepId, status: r.status, effect: r.effect, evidenceIds: r.evidenceIds, code: r.code }); recordEvent(run, 'step_result', `${r.status}${r.code ? ` (${r.code})` : ''}`, r.stepId); },
      });
    } catch (e) {
      rt.error = e;
      recordEvent(run, 'error', 'run executor error');
    }
    finish();
  }

  function launchRun(run, rt, session) {
    runtimes.set(run.runId, rt);
    session.runs.add(run.runId);
    if (runtimes.size > 200) { for (const [id, old] of runtimes) { if (old.finished) { old.inputs = {}; old.args = {}; runtimes.delete(id); } if (runtimes.size <= 150) break; } }
    // Monotonic deadline (immune to wall-clock jumps); the wall deadline is persisted for recovery/display.
    rt.deadlineMono = clock.monotonic() + Math.max(0, run.deadlineAt - clock.now());
    rt.timer = setTimeout(() => rt.controller.abort('DEADLINE'), Math.max(0, rt.deadlineMono - clock.monotonic()));
    rt.timer.unref && rt.timer.unref();
    // One run at a time per session (single writer); others stay `queued`.
    const prev = session.runChain || Promise.resolve();
    rt.done = prev.then(() => execRun(run, rt)).catch(() => {}).then(() => { clearTimeout(rt.timer); rt.finished = true; });
    session.runChain = rt.done;
  }

  // Plan inputs = the values the executor feeds into fill/select steps. They come from two places and only for keys the plan
  // DECLARES: strings the client passed, and strings the skill resolver derived (e.g. the typed text of a recording).
  // The resolver is the authority for the keys it returns. Everything else the client sent must be an argument the
  // resolver consumed itself (`resolved.argumentKeys`); an undeclared key is refused rather than ignored.
  function planInputsOf(plan, args, resolved) {
    const declared = new Set(plan.inputKeys);
    const argumentKeys = new Set(Array.isArray(resolved.argumentKeys) ? resolved.argumentKeys.filter((k) => typeof k === 'string').slice(0, 20) : []);
    const out = {};
    for (const [k, val] of Object.entries(args)) {
      if (declared.has(k)) {
        if (typeof val !== 'string') throw C.invalid(`input ${clip(k, 40)} must be a string`);
        out[k] = val;
      } else if (!argumentKeys.has(k)) throw C.invalid(`undeclared input ${clip(k, 40)}`);
    }
    const derived = resolved.inputs;
    if (derived && typeof derived === 'object' && !Array.isArray(derived)) {
      for (const [k, val] of Object.entries(derived)) {
        if (declared.has(k) && typeof val === 'string' && val.length <= MAX_INPUT_CHARS) out[k] = val;
      }
    }
    return out;
  }

  function prepareRun(v, ctx, principal, { parent = null } = {}) {
    const session = ownedSession(v.sessionId, principal);
    const rec = session.page(v.pageId);
    policy.assertActive(session.grant, principal);
    if (!skills || typeof skills.resolve !== 'function') throw dtoError('UNAVAILABLE', 'no skill registry is installed', { detail: 'NO_SKILLS' });
    // The resolver gets a copy: the broker, not the resolver, decides what becomes a plan input.
    const resolved = skills.resolve({ skillId: v.skillId, skillVersion: v.skillVersion, inputs: C.clone(v.inputs), principal });
    if (!resolved || !resolved.plan) throw dtoError('DENIED', 'unknown skill or version', { detail: 'UNKNOWN_SKILL' });
    const plan = C.validatePlan(resolved.plan);
    if (plan.skillId !== v.skillId || plan.version !== v.skillVersion) throw dtoError('DENIED', 'skill pin mismatch', { detail: 'SKILL_PIN' });
    const planInputs = planInputsOf(plan, v.inputs, resolved);
    for (const s of plan.steps) {
      if ((s.type === 'fill' || s.type === 'select') && typeof planInputs[s.inputKey] !== 'string') throw C.invalid(`missing input ${clip(s.inputKey, 40)}`);
      if (s.type === 'navigate' && !policy.checkDestination(session.grant, s.url).allowed) throw dtoError('DENIED', `plan navigates outside the grant (${clip(redactUrl(s.url), 80)})`, { detail: 'DESTINATION_DENIED' });
    }
    if (session.capabilities.dom === false) throw dtoError('UNSUPPORTED', 'driver cannot drive DOM targets', { detail: 'CAP_DOM' });
    // Unsupported capabilities are discovered BEFORE any dispatch, never half way through a plan.
    if (plan.steps.some((s) => s.type === 'setViewport') && session.capabilities.viewport !== true) throw dtoError('UNSUPPORTED', 'driver cannot set a viewport', { detail: 'CAP_VIEWPORT' });
    if (plan.steps.some((s) => s.type === 'capture') && session.capabilities.screenshots !== true) throw dtoError('UNSUPPORTED', 'driver cannot capture screenshots', { detail: 'CAP_SCREENSHOTS' });
    const maxDurationMs = Math.min(v.maxDurationMs, plan.maxDurationMs, session.grant.budgets.maxDurationMs);
    const inputsDigest = ledger.commandHash({ args: v.inputs, plan: planInputs });
    const requestHash = C.sha256({ sessionId: v.sessionId, pageId: v.pageId, skillId: v.skillId, skillVersion: v.skillVersion, maxDurationMs: v.maxDurationMs, inputsDigest, planDigest: C.sha256(plan), parent: parent ? parent.runId : null });
    return { session, rec, plan, maxDurationMs, inputsDigest, requestHash, planInputs };
  }

  function createRun(v, principal, prep, { parent = null } = {}) {
    const runId = C.newId('run');
    const now = clock.now();
    const meta = { runId, evidenceRunId: runId, ownerId: principal.id, sessionId: v.sessionId, pageId: v.pageId, reviewSessionId: prep.session.reviewSessionId, requestKey: v.requestKey, requestHash: prep.requestHash,
      skillId: v.skillId, skillVersion: v.skillVersion, plan: prep.plan, inputKeys: Object.keys(prep.planInputs), inputsDigest: prep.inputsDigest, maxDurationMs: prep.maxDurationMs,
      deadlineAt: now + prep.maxDurationMs, parentRunId: parent ? parent.runId : null, attempt: parent ? parent.attempt + 1 : 1, driverName: prep.session.driverName };
    const { run, existing } = runStore.create(meta);
    if (existing) return { run, existing: true };
    evidence.registerRun(runId, { ownerId: principal.id, sessionId: v.sessionId, pageId: v.pageId, reviewSessionId: prep.session.reviewSessionId, kind: 'run', attempt: meta.attempt, parentRunId: meta.parentRunId });
    // `args` (what the client asked for) is kept only for retries; `inputs` (plan inputs) is all the executor ever reads. Memory only.
    const rt = { controller: new AbortController(), principal, inputs: { ...prep.planInputs }, args: C.clone(v.inputs), approvals: [], finished: false, done: null };
    launchRun(run, rt, prep.session);
    return { run, existing: false };
  }

  async function startRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const v = C.validateStartRun(input);
      const prep = prepareRun(v, ctx, principal);
      const { run } = createRun(v, principal, prep);
      return dto(run);
    });
  }

  async function retryRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.runId) || !C.isClientId(input.requestKey)) throw C.invalid('runId and requestKey are required');
      const parent = ownedRun(input.runId, principal);
      if (!C.TERMINAL_STATES.includes(parent.state) || parent.state === 'passed') throw dtoError('DENIED', 'only a finished, non-passing run can be retried', { detail: 'RETRY_STATE' });
      const grade = gradeRun(parent);
      if (grade.uncertainEffect && !(principal.kind === 'ui' && input.acknowledgeUncertain === true)) {
        throw dtoError('DENIED', 'the previous attempt has an unknown external effect; reconcile it in the UI before retrying', { effectUnknown: true, detail: 'RETRY_UNCERTAIN' });
      }
      const inputs = input.inputs && typeof input.inputs === 'object' ? input.inputs : (runtimes.get(parent.runId) || {}).args || {};
      const v = C.validateStartRun({ sessionId: input.sessionId || parent.sessionId, pageId: input.pageId || parent.pageId, requestKey: input.requestKey, skillId: parent.skillId, skillVersion: parent.skillVersion, maxDurationMs: parent.maxDurationMs, inputs });
      const prep = prepareRun(v, ctx, principal, { parent });
      if (prep.inputsDigest !== parent.inputsDigest) throw dtoError('DENIED', 'retry inputs differ from the original run', { detail: 'RETRY_INPUTS' });
      const { run } = createRun(v, principal, prep, { parent });
      return dto(run);
    });
  }

  async function getRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const v = C.validateGetRun(input);
      return dto(ownedRun(v.runId, principal), v);
    });
  }
  async function cancelRun(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.runId)) throw C.invalid('runId');
      const run = ownedRun(input.runId, principal);
      const rt = runtimes.get(run.runId);
      if (!C.TERMINAL_STATES.includes(run.state)) {
        runStore.requestCancel(run.runId);
        recordEvent(run, 'cancel_requested', 'cancellation requested; future dispatch is stopped, in-flight work stays uncertain');
        if (rt) {
          rt.controller.abort('CANCELLED'); // the fence: no new dispatch after this line
          await Promise.race([rt.done, sleep(250)]);
        }
      }
      return dto(run);
    });
  }
  async function listRuns(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const reviewSessionId = input && input.reviewSessionId !== undefined ? (C.isClientId(input.reviewSessionId) ? input.reviewSessionId : (() => { throw C.invalid('reviewSessionId'); })()) : undefined;
      return runStore.list({ ownerId: principal.kind === 'ui' ? undefined : principal.id, reviewSessionId }).map((r) => dto(r, { maxEvents: 0 }));
    });
  }
  async function getManifest(input, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      if (!input || !C.isClientId(input.runId)) throw C.invalid('runId');
      const run = ownedRun(input.runId, principal);
      return evidence.getManifest(run.evidenceRunId, principal);
    });
  }

  async function readResource(uri, ctx) {
    return guard(async () => {
      const principal = principalOf(ctx);
      const p = C.parseUri(uri);
      if (!p) throw dtoError('DENIED', 'unknown resource', { detail: 'BAD_URI' });
      const cap = (obj) => { const t = C.capText(JSON.stringify(obj), { maxBytes: limits.maxResponseBytes }); return { uri, mimeType: 'application/json', encoding: 'utf8', text: t.text, truncated: t.truncated, totalBytes: t.totalBytes, returnedBytes: t.returnedBytes, nextCursor: t.nextOffset === null ? null : String(t.nextOffset) }; };
      if (p.kind === 'capabilities') {
        return cap({ schemaVersion: C.SCHEMA_VERSION, runtime: 'braiwser-agent-runtime', featureFlag: true, toolClasses: C.TOOL_CLASSES, actions: C.ACTION_KINDS,
          drivers: Object.fromEntries(Object.entries(drivers).map(([k, d]) => { try { return [k, { ...d.capabilities(), liveModeSwitch: false }]; } catch { return [k, { available: false }]; } })),
          limits: { ...limits }, policyEnforcement: 'navigation-only unless a driver reports requestInterception' });
      }
      if (p.kind === 'catalog') return cap({ skills: skills && typeof skills.catalog === 'function' ? skills.catalog({ principal }) : [] });
      try { return evidence.read(uri, principal); } catch (e) {
        if (e.code === 'NOT_FOUND' || e.code === 'BAD_ID') throw dtoError('DENIED', 'unknown or unauthorized resource', { detail: 'UNKNOWN_RESOURCE' });
        throw e;
      }
    });
  }

  try { evidence.prune(); } catch { /* retention is best effort */ }

  // ======================================================================
  // startup recovery: interrupted runs get a committed (non-passing) manifest
  // ======================================================================
  for (const runId of runStore.recovered) {
    const run = runStore.get(runId);
    try {
      if (!evidence.hasRun(run.evidenceRunId)) continue;
      const grade = gradeRun(run, { evidenceComplete: false, terminal: 'unknown' });
      evidence.commitManifest(run.evidenceRunId, manifestFacts(run, grade, 'unknown', 'interrupted', 'APP_RESTART', null));
    } catch { /* the run store already says interrupted */ }
  }

  async function close() {
    await Promise.all([...sessions.values()].map(async (s) => { try { await closeSession({ sessionId: s.sessionId }, { principal: { id: s.ownerId, kind: 'ui', scopes: [] } }); } catch { /* ignore */ } }));
    try { runStore.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
  }

  const broker = {
    enabled: true, events, limits,
    openSession, closeSession, observe, act, startRun, getRun, cancelRun, retryRun, handoff, resume, approve, listApprovals, listRuns, getManifest, readResource,
    requestHandoff, pauseRun, handoffStatus, resumeRun, startTask, attachViewer,
    forPrincipal: (principal) => bindFacade(broker, C.validatePrincipal(principal)),
    close, stats: () => ({ enabled: true, sessions: sessions.size, runs: runStore.list().length, ledger: ledger.stats(), evidence: evidence.usage() }),
    // internals exposed for tests / the app shell only
    _internals: { ledger, evidence, runStore, policy, sessions, runtimes, handoffs: handoffCoord },
  };
  return broker;
}

module.exports = { createBroker, DEFAULT_LIMITS };
