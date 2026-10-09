// Agent Runs controller: the per-run event reducer plus the commands the trusted
// shell can issue (cancel, take control, resume, approve/deny, connections).
//
// Rules this file exists to enforce
//   * The UI only PROJECTS persisted run state. On open it rehydrates from the
//     journal (browser:run-get). It never synthesizes success from a missing or
//     failed reply: an error leaves the last known state, marked as such.
//   * Stale or reordered replies are refused (snapshot sequence, owner fence).
//   * Gaps / truncation are surfaced, never papered over (see agent-run-reducer).
//   * An approval is bound to its action digest. If the request the person is
//     looking at is not the request the runtime currently holds, "Allow" is
//     refused here AND re-checked in the main process.
//   * destroy() unsubscribes every listener and ignores in-flight replies.
import {
  CH, AgentBridgeError,
} from '../lib/agent-bridge.js';
import {
  createRunView, applySnapshot, applyEvents, openGap, markGapUnfilled, completeness,
  normalizeOwner, mergeOwner, isRunDto, uncertainStep, lastProvenStep, stepsOf,
} from '../lib/agent-run-reducer.js';
import { runGroup, displayVerdict } from '../lib/agent-ui.js';

const MAX_VIEWS = 200;
const PAGE = 100;
const MAX_PAGES = 50;

const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;

export function normalizeApproval(p, now = Date.now()) {
  if (!obj(p) || typeof p.approvalId !== 'string' || !ID_RE.test(p.approvalId)) return null;
  const a = obj(p.action) ? p.action : {};
  const exp = typeof p.expiresAt === 'number' ? p.expiresAt : Date.parse(p.expiresAt);
  return {
    approvalId: p.approvalId,
    runId: clip(p.runId, 160),
    sessionId: clip(p.sessionId, 160),
    pageId: clip(p.pageId, 160),
    origin: clip(p.origin, 300),
    action: {
      kind: clip(a.kind, 40),
      label: clip(a.label || a.summary, 300),
      target: clip(a.target, 300),
      detail: clip(a.detail, 500),
    },
    destination: clip(p.destination, 500),
    dataSummary: clip(p.dataSummary, 500),
    scope: Array.isArray(p.scope) ? p.scope.filter((s) => typeof s === 'string').slice(0, 20).map((s) => clip(s, 120)) : [],
    expiresAt: Number.isFinite(exp) ? exp : null,
    actionDigest: clip(p.actionDigest, 200),
    documentEpoch: Number.isSafeInteger(p.documentEpoch) ? p.documentEpoch : null,
    status: 'pending',
    invalid: '',
    error: '',
    receivedAt: now,
  };
}

export function createAgentRunsController({ bridge, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) } = {}) {
  const views = new Map(); // runId -> RunView
  const owners = new Map(); // sessionId -> owner
  const approvals = new Map(); // approvalId -> approval
  const listeners = new Set();
  const inflight = new Map(); // runId -> Promise (hydrate de-dupe)
  const offs = [];
  const timers = new Set();
  const st = {
    enabled: false,
    flag: null, // last browser:status reply
    ready: false,
    destroyed: false,
    filter: 'all',
    selectedRunId: null,
    capabilities: null,
    connections: { supported: null, items: [], error: '' },
    listError: '',
    listLoading: false,
  };

  const emit = (type, detail) => {
    for (const fn of Array.from(listeners)) {
      try { fn({ type, ...(detail || {}) }); } catch (_e) { /* a bad listener must not break the others */ }
    }
  };
  const live = () => !st.destroyed;

  function viewFor(runId) {
    let v = views.get(runId);
    if (!v) {
      v = createRunView(runId);
      views.set(runId, v);
      if (views.size > MAX_VIEWS) evict();
    }
    return v;
  }
  function evict() {
    const keep = (id) => id === st.selectedRunId;
    const candidates = Array.from(views.values()).filter((v) => !keep(v.runId)).sort((a, b) => a.updatedAt - b.updatedAt);
    while (views.size > MAX_VIEWS && candidates.length) views.delete(candidates.shift().runId);
  }

  // ---- lifecycle -----------------------------------------------------------
  async function init() {
    let flag;
    try {
      flag = await bridge.invoke(CH.status, {});
    } catch (err) {
      st.flag = { enabled: false, reason: err.message };
      st.enabled = false;
      st.ready = true;
      emit('status');
      return false;
    }
    if (!live()) return false;
    st.flag = flag || {};
    st.enabled = !!(flag && flag.enabled === true);
    st.ready = true;
    if (!st.enabled) { emit('status'); return false; }
    subscribe();
    await Promise.allSettled([refreshCapabilities(), refreshRuns(), refreshApprovals()]);
    emit('status');
    return true;
  }

  function subscribe() {
    offs.push(bridge.on(CH.evRun, onRunPush));
    offs.push(bridge.on(CH.evApproval, onApprovalPush));
    offs.push(bridge.on(CH.evOwner, onOwnerPush));
    offs.push(bridge.on(CH.evSession, onSessionClosed));
  }

  function destroy() {
    st.destroyed = true;
    for (const off of offs.splice(0)) { try { off(); } catch (_e) { /* ignore */ } }
    for (const t of timers) cancel(t);
    timers.clear();
    listeners.clear();
    inflight.clear();
  }

  // ---- runs ----------------------------------------------------------------
  async function refreshRuns(query) {
    st.listLoading = true;
    emit('runs');
    try {
      const reply = await bridge.invoke(CH.runsList, query && query.reviewSessionId ? { reviewSessionId: query.reviewSessionId } : {});
      if (!live()) return;
      const list = Array.isArray(reply) ? reply : (reply && Array.isArray(reply.runs) ? reply.runs : null);
      if (!list) throw new AgentBridgeError({ message: 'The run list was not in a recognised shape.', replyMissing: true });
      for (const dto of list) if (isRunDto(dto)) applySnapshot(viewFor(dto.runId), dto);
      st.listError = '';
    } catch (err) {
      if (!live()) return;
      st.listError = err.message || 'Could not load runs.';
    } finally {
      st.listLoading = false;
      if (live()) emit('runs');
    }
  }

  function runSummaries() {
    return Array.from(views.values())
      .filter((v) => v.dto)
      .sort((a, b) => String(b.dto.startedAt || b.dto.deadlineAt || '').localeCompare(String(a.dto.startedAt || a.dto.deadlineAt || '')) || b.updatedAt - a.updatedAt)
      .map((v) => ({ runId: v.runId, dto: v.dto, group: runGroup(v.dto), display: displayVerdict(v.dto), sync: v.sync }));
  }

  function counts() {
    const c = { all: 0, active: 0, needsInput: 0, completed: 0 };
    for (const s of runSummaries()) { c.all++; c[s.group]++; }
    return c;
  }

  function filteredRuns() {
    const all = runSummaries();
    return st.filter === 'all' ? all : all.filter((s) => s.group === st.filter);
  }

  function setFilter(id) {
    if (!['all', 'active', 'needsInput', 'completed'].includes(id)) return;
    st.filter = id;
    emit('filter');
  }

  async function openRun(runId) {
    if (typeof runId !== 'string' || !ID_RE.test(runId)) return null;
    st.selectedRunId = runId;
    viewFor(runId);
    emit('select');
    await hydrate(runId, { fromStart: true });
    return views.get(runId) || null;
  }

  function closeRun() {
    st.selectedRunId = null;
    emit('select');
  }

  // Read the journal for one run. A failure leaves whatever was already known
  // and marks the view unavailable — it does not clear it and does not "pass" it.
  function hydrate(runId, opts = {}) {
    if (inflight.has(runId)) return inflight.get(runId);
    const p = (async () => {
      const view = viewFor(runId);
      const fromStart = opts.fromStart || view.lastSequence === null;
      view.sync = 'loading';
      emit('run', { runId });
      let after = fromStart ? 0 : (view.lastSequence || 0);
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const dto = await bridge.invoke(CH.runGet, { runId, afterSequence: after, maxEvents: PAGE });
          if (!live()) return view;
          const res = applySnapshot(view, dto, { fromStart: fromStart && page === 0, now: now() });
          if (!res.accepted && res.reason === 'invalid') throw new AgentBridgeError({ message: 'The run report was not in a recognised shape.', replyMissing: true });
          const n = Array.isArray(dto.events) ? dto.events.length : 0;
          const next = Number.isSafeInteger(dto.nextSequence) ? dto.nextSequence : after;
          if (n < PAGE || next <= after) break;
          after = next;
        }
        view.needsHydrate = false;
        view.hydrated = view.lastSequence !== null;
        view.sync = 'ok';
        // If a buffered event still has no predecessor, the journal does not
        // have it: record the hole instead of leaving the timeline "waiting".
        if (openGap(view)) markGapUnfilled(view);
      } catch (err) {
        if (!live()) return view;
        view.sync = 'unavailable';
        view.syncError = err.message || 'The run could not be read.';
      }
      emit('run', { runId });
      return view;
    })().finally(() => inflight.delete(runId));
    inflight.set(runId, p);
    return p;
  }

  function onRunPush(payload) {
    if (!live() || !obj(payload) || typeof payload.runId !== 'string' || !ID_RE.test(payload.runId)) return;
    const view = viewFor(payload.runId);
    if (isRunDto(payload.run) && payload.run.runId === payload.runId) {
      applySnapshot(view, { ...payload.run, events: Array.isArray(payload.run.events) ? payload.run.events : [] }, { now: now() });
    }
    const evs = Array.isArray(payload.events) ? payload.events : (obj(payload.event) ? [payload.event] : (payload.sequence !== undefined && payload.kind ? [payload] : []));
    if (evs.length) applyEvents(view, evs, { now: now() });
    emit('run', { runId: payload.runId });
    if (view.needsHydrate || openGap(view)) {
      // Ask the journal for what we missed. One attempt; if the hole persists it
      // is recorded as unfilled, not hidden.
      const t = schedule(() => {
        timers.delete(t);
        if (live()) hydrate(payload.runId, { fromStart: view.lastSequence === null });
      }, 0);
      timers.add(t);
    }
    if (!st.selectedRunId || st.selectedRunId !== payload.runId) scheduleListRefresh(payload.runId);
  }

  let listTimer = null;
  const unknownRuns = new Set();
  function scheduleListRefresh(runId) {
    const v = views.get(runId);
    if (v && v.dto) return;
    unknownRuns.add(runId);
    if (listTimer) return;
    listTimer = schedule(() => { listTimer = null; unknownRuns.clear(); if (live()) refreshRuns(); }, 50);
    timers.add(listTimer);
  }

  function getView(runId) { return views.get(runId) || null; }

  async function cancelRun(runId) {
    const view = viewFor(runId);
    try {
      const dto = await bridge.invoke(CH.runCancel, { runId });
      if (!live()) return { ok: false };
      // Only the returned report changes what we show.
      applySnapshot(view, { ...dto, events: Array.isArray(dto && dto.events) ? dto.events : [] }, { now: now() });
      emit('run', { runId });
      return { ok: true, cancelRequested: !!(dto && dto.cancelRequested) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  // ---- owners / handoff ----------------------------------------------------
  function onOwnerPush(payload) { applyOwner(payload); }

  function applyOwner(payload) {
    const incoming = normalizeOwner(payload);
    if (!incoming) return null;
    const { owner, accepted } = mergeOwner(owners.get(incoming.sessionId), incoming);
    if (!accepted) return owners.get(incoming.sessionId) || null;
    owners.set(incoming.sessionId, owner);
    invalidateApprovalsFor(owner);
    emit('owner', { sessionId: owner.sessionId });
    return owner;
  }

  function onSessionClosed(payload) {
    if (!obj(payload) || typeof payload.sessionId !== 'string') return;
    owners.delete(payload.sessionId);
    for (const a of approvals.values()) {
      if (a.sessionId === payload.sessionId && a.status === 'pending') a.invalid = 'The session closed.';
    }
    emit('owner', { sessionId: payload.sessionId });
    emit('approvals');
  }

  function getOwner(sessionId) { return owners.get(sessionId) || null; }
  function ownerList() { return Array.from(owners.values()); }

  // Agent-facing controls (Observe / Pause / Take control) exist only while the
  // agent is the controller. After a takeover they are off until a verified Resume.
  function agentControlsEnabled(sessionId) {
    const o = owners.get(sessionId);
    return !!o && o.controller === 'agent' && !o.busy;
  }

  async function takeControl({ sessionId, pageId, runId, reason }) {
    const o = owners.get(sessionId);
    if (o) { o.busy = 'handoff'; emit('owner', { sessionId }); }
    try {
      const reply = await bridge.invoke(CH.handoff, { sessionId, pageId, runId: runId || undefined, reason: clip(reason || 'Take control', 200) });
      if (!live()) return { ok: false };
      const updated = applyOwner({ sessionId, pageId, runId, ...(obj(reply) ? reply : {}), owner: reply && (reply.owner || 'handoff-pending'), at: new Date(now()).toISOString() });
      const cur = owners.get(sessionId);
      if (cur) delete cur.busy;
      emit('owner', { sessionId });
      return { ok: true, owner: updated, method: reply && reply.method };
    } catch (err) {
      const cur = owners.get(sessionId);
      if (cur) { delete cur.busy; emit('owner', { sessionId }); }
      return { ok: false, error: err };
    }
  }

  // Resume is a trusted-shell action. It does not flip the strip to "agent
  // control" by itself: only an owner record from the runtime does.
  async function resume({ sessionId, pageId }) {
    const o = owners.get(sessionId);
    if (!o || o.controller !== 'human') return { ok: false, error: new AgentBridgeError({ code: 'DENIED', message: 'Resume is available only while you have control.' }) };
    o.busy = 'resume';
    emit('owner', { sessionId });
    try {
      const reply = await bridge.invoke(CH.resume, { sessionId, pageId: pageId || o.pageId });
      if (!live()) return { ok: false };
      const cur = owners.get(sessionId);
      if (cur) delete cur.busy;
      applyOwner({ sessionId, pageId: pageId || o.pageId, ...(obj(reply) ? reply : {}), owner: reply && (reply.owner || reply.controller), at: new Date(now()).toISOString() });
      emit('owner', { sessionId });
      return { ok: true, reply };
    } catch (err) {
      const cur = owners.get(sessionId);
      if (cur) delete cur.busy;
      emit('owner', { sessionId });
      return { ok: false, error: err };
    }
  }

  // ---- approvals -----------------------------------------------------------
  async function refreshApprovals() {
    try {
      const reply = await bridge.invoke(CH.approvalsPending, {});
      if (!live()) return;
      const list = Array.isArray(reply) ? reply : (reply && Array.isArray(reply.approvals) ? reply.approvals : []);
      for (const p of list) ingestApproval(p);
    } catch (_e) { /* pending approvals arrive by push too; nothing to fabricate */ }
  }

  function ingestApproval(payload) {
    const a = normalizeApproval(payload, now());
    if (!a) return null;
    const prev = approvals.get(a.approvalId);
    if (prev && prev.status !== 'pending') return prev; // decided / withdrawn: never reopen
    if (prev && prev.actionDigest !== a.actionDigest) a.superseded = prev.actionDigest;
    approvals.set(a.approvalId, a);
    emit('approvals');
    if (!prev || prev.actionDigest !== a.actionDigest) emit('approval', { approvalId: a.approvalId });
    return a;
  }

  function onApprovalPush(payload) { if (live()) ingestApproval(payload); }

  function invalidateApprovalsFor(owner) {
    let changed = false;
    for (const a of approvals.values()) {
      if (a.status !== 'pending' || a.sessionId !== owner.sessionId) continue;
      if (owner.controller === 'human' || owner.controller === 'quarantined') {
        a.invalid = 'Control moved away from the agent, so this request was withdrawn.';
        changed = true;
      } else if (owner.documentEpoch !== null && a.documentEpoch !== null && a.pageId && a.pageId === owner.pageId && owner.documentEpoch !== a.documentEpoch) {
        a.invalid = 'The page changed after this was requested. It will be asked again if still needed.';
        changed = true;
      }
    }
    if (changed) emit('approvals');
  }

  function getApproval(id) { return approvals.get(id) || null; }
  function pendingApprovals() { return Array.from(approvals.values()).filter((a) => a.status === 'pending'); }

  // Can THIS shown request (identified by the digest the person saw) be allowed
  // right now? Returns { ok, reason }.
  function canAllow(approvalId, shownDigest) {
    const cur = approvals.get(approvalId);
    if (!cur) return { ok: false, reason: 'unknown', message: 'This request is no longer pending.' };
    if (cur.status !== 'pending') return { ok: false, reason: 'closed', message: 'This request has already been answered.' };
    if (cur.invalid) return { ok: false, reason: 'invalid', message: cur.invalid };
    if (cur.expiresAt !== null && cur.expiresAt <= now()) return { ok: false, reason: 'expired', message: 'This request expired.' };
    if (!cur.actionDigest) return { ok: false, reason: 'no-digest', message: 'The request carried no action digest, so it cannot be approved safely.' };
    if (shownDigest !== cur.actionDigest) return { ok: false, reason: 'digest-mismatch', message: 'The action changed after you opened this request. Review the new request before allowing.' };
    return { ok: true };
  }

  async function decide(approvalId, decision, shownDigest) {
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, reason: 'invalid' };
    const cur = approvals.get(approvalId);
    if (decision === 'allow') {
      const gate = canAllow(approvalId, shownDigest);
      if (!gate.ok) return gate;
    } else if (!cur || cur.status !== 'pending') {
      return { ok: false, reason: 'closed', message: 'This request has already been answered.' };
    }
    cur.status = 'deciding';
    cur.error = '';
    emit('approvals');
    try {
      const reply = await bridge.invoke(CH.approvalDecide, {
        approvalId, decision, actionDigest: shownDigest, documentEpoch: cur.documentEpoch,
      });
      if (!live()) return { ok: false };
      const said = obj(reply) ? String(reply.decision || reply.status || '') : '';
      if (said === 'allow' || said === 'allowed') cur.status = 'allowed';
      else if (said === 'deny' || said === 'denied') cur.status = 'denied';
      else {
        // The runtime acknowledged but did not say what it recorded. Do not claim
        // an outcome; re-read from the runtime.
        cur.status = 'pending';
        cur.error = 'The runtime did not confirm the decision. It is still pending.';
      }
      emit('approvals');
      return { ok: cur.status === 'allowed' || cur.status === 'denied', status: cur.status, message: cur.error };
    } catch (err) {
      cur.status = 'pending';
      cur.error = err.replyMissing
        ? 'No confirmation from the runtime. The request is still shown as pending — check it before trying again.'
        : (err.message || 'The decision was not accepted.');
      emit('approvals');
      return { ok: false, reason: 'error', message: cur.error, error: err };
    }
  }

  // ---- capabilities / connections / evidence -------------------------------
  async function refreshCapabilities() {
    try {
      const caps = await bridge.invoke(CH.capabilities, {});
      if (!live()) return;
      st.capabilities = obj(caps) ? caps : null;
    } catch (_e) { st.capabilities = null; }
    emit('capabilities');
  }

  async function loadConnections() {
    try {
      const reply = await bridge.invoke(CH.connections, {});
      if (!live()) return;
      const items = Array.isArray(reply) ? reply : (reply && Array.isArray(reply.connections) ? reply.connections : []);
      st.connections = {
        supported: reply && reply.supported === false ? false : true,
        items: items.filter(obj).slice(0, 100).map(normalizeConnection),
        error: '',
      };
    } catch (err) {
      st.connections = { ...st.connections, error: err.message || 'Connections are unavailable.' };
    }
    emit('connections');
  }

  async function connectionAction(channel, clientId) {
    if (typeof clientId !== 'string' || !ID_RE.test(clientId)) return { ok: false, error: new AgentBridgeError({ code: 'DENIED', message: 'Invalid client.' }) };
    try {
      await bridge.invoke(channel, { clientId });
      await loadConnections();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }
  const revokeConnection = (clientId) => connectionAction(CH.connectionRevoke, clientId);
  const enableConnection = (clientId) => connectionAction(CH.connectionEnable, clientId);

  // Ask the runtime for a FRESH observation of a page (read-only). The reply is
  // summarised; the node list itself stays in the evidence store.
  async function observe({ sessionId, pageId }) {
    if (!ID_RE.test(String(sessionId || '')) || !ID_RE.test(String(pageId || ''))) {
      return { ok: false, error: new AgentBridgeError({ code: 'DENIED', message: 'No page to observe.' }) };
    }
    try {
      const o = await bridge.invoke(CH.observe, { sessionId, pageId, maxNodes: 100 });
      if (!obj(o) || typeof o.observationId !== 'string') {
        return { ok: false, error: new AgentBridgeError({ code: 'UNAVAILABLE', message: 'The runtime did not return an observation.', replyMissing: true }) };
      }
      return {
        ok: true,
        observation: {
          observationId: clip(o.observationId, 160), url: clip(o.url, 2000), documentEpoch: Number.isSafeInteger(o.documentEpoch) ? o.documentEpoch : null,
          nodeCount: Array.isArray(o.nodes) ? o.nodes.length : 0, truncated: !!o.truncated, evidenceUri: clip(o.evidenceUri, 300), at: now(),
        },
      };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  async function readEvidence(uri) {
    if (typeof uri !== 'string' || !/^braiwser:\/\/runs\/[A-Za-z0-9_.:-]{1,160}\/(manifest|observations\/[A-Za-z0-9_.:-]{1,160})$/.test(uri)) {
      return { ok: false, error: new AgentBridgeError({ code: 'DENIED', message: 'That is not a run evidence link.' }) };
    }
    try {
      return { ok: true, data: await bridge.invoke(CH.resourceRead, { uri }) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  return {
    state: st,
    init, destroy,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    refreshRuns, runSummaries, filteredRuns, counts, setFilter,
    openRun, closeRun, hydrate, getView, cancelRun,
    completeness: (runId) => (views.get(runId) ? completeness(views.get(runId)) : null),
    uncertainStep: (runId) => (views.get(runId) ? uncertainStep(views.get(runId)) : null),
    lastProvenStep: (runId) => (views.get(runId) ? lastProvenStep(views.get(runId)) : null),
    steps: (runId) => (views.get(runId) ? stepsOf(views.get(runId)) : []),
    getOwner, ownerList, applyOwner, agentControlsEnabled, takeControl, resume,
    getApproval, pendingApprovals, canAllow, decide, ingestApproval, refreshApprovals,
    refreshCapabilities, loadConnections, revokeConnection, enableConnection, readEvidence, observe,
    // exposed for tests / e2e
    _views: views,
  };
}

function normalizeConnection(c) {
  const exp = typeof c.expiresAt === 'number' ? c.expiresAt : Date.parse(c.expiresAt);
  return {
    clientId: clip(c.clientId || c.id, 160),
    client: clip(c.client || c.name, 120),
    kind: clip(c.kind, 40),
    profile: clip(c.profile, 120),
    status: ['pending', 'active', 'revoked', 'expired'].includes(c.status) ? c.status : 'pending',
    scope: Array.isArray(c.scope) ? c.scope.filter((s) => typeof s === 'string').slice(0, 30).map((s) => clip(s, 160)) : [],
    destinations: Array.isArray(c.destinations) ? c.destinations.filter((s) => typeof s === 'string').slice(0, 30).map((s) => clip(s, 200)) : [],
    expiresAt: Number.isFinite(exp) ? exp : null,
    lastSeenAt: c.lastSeenAt || '',
  };
}
