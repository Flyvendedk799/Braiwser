'use strict';
// Narrow, trusted-shell IPC for the agent runtime UI (`browser:*` channels).
//
// Every handler:
//   1. runs only for the registered shell window's TOP-LEVEL frame (the
//      security guard wraps it when index.js passes `handle`; `isTrustedSender`
//      below re-checks it, so this module is safe on its own),
//   2. validates its payload against a closed schema BEFORE touching the broker,
//   3. acts through `broker.forPrincipal({ kind: 'ui' })` — the shell has no
//      back door, and "possession of an id" is never authority,
//   4. answers `{ ok: true, data }` or `{ ok: false, error: <public error DTO> }`.
//      It never throws a raw error across IPC and never leaks stacks/paths.
//
// Pushes (`browser:run-event`, `browser:approval-requested`, `browser:owner-changed`,
// `browser:session-closed`) go to the shell window ONLY.
//
// Approvals: the broker issues one-use approvals bound to an action digest. This
// module additionally remembers each approval it pushed to the shell, with its
// digest, and refuses an "allow" whose digest differs from the one the runtime
// announced, whose id it never announced (a forged id), or that expired. The
// broker's own check remains the authority; this is a second, independent gate.
//
// Contract assumptions beyond docs/AGENT_RUNTIME_CONTRACT.md (reported to the
// broker owner): broker.listConnections / enableConnection / revokeConnection
// (optional — reported UNSUPPORTED if absent) and approval payloads carrying
// { approvalId, runId, sessionId, pageId, origin, action, destination,
//   dataSummary, scope, expiresAt, actionDigest, documentEpoch }.

const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const URI_RE = /^braiwser:\/\/(capabilities|runs\/[A-Za-z0-9_.:-]{1,160}\/manifest|runs\/[A-Za-z0-9_.:-]{1,160}\/observations\/[A-Za-z0-9_.:-]{1,160})$/;
const MAX_REPLY_BYTES = 256 * 1024;
const UI_PRINCIPAL = Object.freeze({ id: 'shell-ui', kind: 'ui', scopes: Object.freeze(['ui']) });

const CHANNELS = Object.freeze({
  status: 'browser:status',
  runsList: 'browser:runs-list',
  runGet: 'browser:run-get',
  runCancel: 'browser:run-cancel',
  handoff: 'browser:session-handoff',
  resume: 'browser:session-resume',
  approvalDecide: 'browser:approval-decide',
  approvalsPending: 'browser:approvals-pending',
  capabilities: 'browser:capabilities',
  connections: 'browser:connections',
  connectionEnable: 'browser:connection-enable',
  connectionRevoke: 'browser:connection-revoke',
  resourceRead: 'browser:resource-read',
  observe: 'browser:observe',
});
const PUSH = Object.freeze({
  runEvent: 'browser:run-event',
  approval: 'browser:approval-requested',
  owner: 'browser:owner-changed',
  sessionClosed: 'browser:session-closed',
});

class BadRequest extends Error {
  constructor(message) { super(message); this.name = 'BadRequest'; }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (msg) => { throw new BadRequest(msg); };

const v = {
  id(x, name) { if (typeof x !== 'string' || !ID_RE.test(x)) fail(`${name} must be an id`); return x; },
  optId(x, name) { return x === undefined || x === null || x === '' ? undefined : v.id(x, name); },
  int(x, name, min, max) {
    if (!Number.isSafeInteger(x) || x < min || x > max) fail(`${name} must be an integer between ${min} and ${max}`);
    return x;
  },
  text(x, name, max) {
    if (typeof x !== 'string' || x.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x)) fail(`${name} must be short text`);
    return x;
  },
  obj(x) { if (!isObj(x)) fail('payload must be an object'); return x; },
  only(x, keys) {
    for (const k of Object.keys(x)) if (!keys.includes(k)) fail(`unexpected field ${k}`);
    return x;
  },
};

// ---- sender trust ------------------------------------------------------------
// True only for the registered shell window's top-level frame. `win` is the
// registered shell BrowserWindow. Guests, subframes and other windows fail.
function isTrustedSender(event, win) {
  try {
    if (!event || !event.sender || !win || (win.isDestroyed && win.isDestroyed())) return false;
    const wc = win.webContents;
    if (!wc || event.sender !== wc) return false;
    if (typeof event.sender.getType === 'function' && event.sender.getType() === 'webview') return false;
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    if (wc.mainFrame && frame !== wc.mainFrame
      && !(frame.processId === wc.mainFrame.processId && frame.routingId === wc.mainFrame.routingId)) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

// ---- errors ------------------------------------------------------------------
const CODES = new Set(['STALE_REF', 'AMBIGUOUS_TARGET', 'DENIED', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED', 'UNAVAILABLE', 'INTERNAL']);
const RETRY = new Set(['refresh', 'safe-read', 'after-approval', 'never']);

function publicError(err) {
  if (err instanceof BadRequest) {
    return { code: 'DENIED', message: `Invalid request: ${err.message}`.slice(0, 300), dispatched: false, effectUnknown: false, retry: 'never' };
  }
  const p = err && err.publicError;
  if (isObj(p) && CODES.has(p.code)) {
    return {
      code: p.code,
      message: typeof p.message === 'string' ? p.message.slice(0, 500) : 'The runtime reported an error.',
      dispatched: p.dispatched === true,
      effectUnknown: p.effectUnknown === true,
      retry: RETRY.has(p.retry) ? p.retry : 'never',
    };
  }
  // Anything else is an internal fault: say so without leaking its message.
  return { code: 'INTERNAL', message: 'The agent runtime failed unexpectedly.', dispatched: false, effectUnknown: false, retry: 'never' };
}

const denied = (message) => Object.assign(new Error(message), { publicError: { code: 'DENIED', message, dispatched: false, effectUnknown: false, retry: 'never' } });
const unsupported = (message) => Object.assign(new Error(message), { publicError: { code: 'UNSUPPORTED', message, dispatched: false, effectUnknown: false, retry: 'never' } });
const unavailable = (message) => Object.assign(new Error(message), { publicError: { code: 'UNAVAILABLE', message, dispatched: false, effectUnknown: false, retry: 'never' } });

// Bounded, JSON-safe copy. Anything that cannot be cloned is dropped, not thrown.
function safeClone(value, maxBytes = MAX_REPLY_BYTES) {
  let text;
  try { text = JSON.stringify(value === undefined ? null : value); } catch (_e) { return null; }
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) return null;
  return JSON.parse(text);
}

// ---- factory -----------------------------------------------------------------
// deps:
//   getWindow()       -> the registered shell BrowserWindow (or null)
//   getBroker()/broker-> broker facade (createBroker result)
//   flag()            -> boolean, evaluated per call (default: BRAIWSER_AGENT_RUNTIME=1)
//   now()             -> ms clock (tests)
function createBrowserIpc(deps = {}) {
  const now = deps.now || (() => Date.now());
  const flag = deps.flag || (() => process.env.BRAIWSER_AGENT_RUNTIME === '1');
  const approvals = new Map(); // approvalId -> record announced to the shell
  const disposers = []; // broker event listeners
  const handlerDisposers = []; // ipcMain handlers (fallback path)

  const rawBroker = () => {
    if (deps.broker) return deps.broker;
    if (typeof deps.getBroker === 'function') { const b = deps.getBroker(); if (b) return b; }
    try {
      const m = require('../services/browser/broker');
      if (m && typeof m.getBroker === 'function') return m.getBroker() || null;
    } catch (_e) { /* broker module not present in this build */ }
    return null;
  };
  const ui = () => {
    if (!flag()) throw unavailable('The agent runtime is turned off.');
    const b = rawBroker();
    if (!b || typeof b.forPrincipal !== 'function') throw unavailable('The agent runtime is not running.');
    attach(); // the broker may have been created after register(); idempotent
    return b.forPrincipal(UI_PRINCIPAL);
  };

  // ---- approval ledger (second gate) ------------------------------------------
  function rememberApproval(p) {
    if (!isObj(p) || typeof p.approvalId !== 'string' || !ID_RE.test(p.approvalId)) return null;
    const exp = typeof p.expiresAt === 'number' ? p.expiresAt : Date.parse(p.expiresAt);
    const rec = {
      approvalId: p.approvalId,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : '',
      pageId: typeof p.pageId === 'string' ? p.pageId : '',
      digest: typeof p.actionDigest === 'string' ? p.actionDigest : '',
      documentEpoch: Number.isSafeInteger(p.documentEpoch) ? p.documentEpoch : null,
      expiresAt: Number.isFinite(exp) ? exp : null,
      status: 'pending',
    };
    approvals.set(rec.approvalId, rec);
    if (approvals.size > 500) {
      for (const [id, r] of approvals) { if (r.status !== 'pending') approvals.delete(id); if (approvals.size <= 400) break; }
    }
    return rec;
  }

  // ---- handlers --------------------------------------------------------------
  // Each handler is (payload, event) -> data. Wrapped below.
  const H = {};

  H[CHANNELS.status] = () => {
    const on = !!flag();
    const hasBroker = !!rawBroker();
    if (on && hasBroker) attach(); // start forwarding as soon as the shell asks
    return {
      enabled: on && hasBroker,
      flagOn: on,
      brokerAvailable: hasBroker,
      source: process.env.BRAIWSER_AGENT_RUNTIME === '1' ? 'env' : 'setting',
      reason: !on ? 'disabled' : (!hasBroker ? 'broker-unavailable' : ''),
    };
  };

  H[CHANNELS.runsList] = async (p) => {
    const q = v.only(v.obj(p || {}), ['reviewSessionId']);
    const b = ui();
    const runs = await b.listRuns({ reviewSessionId: v.optId(q.reviewSessionId, 'reviewSessionId') });
    return { runs: Array.isArray(runs) ? runs.slice(0, 500) : [] };
  };

  H[CHANNELS.runGet] = async (p) => {
    const q = v.only(v.obj(p), ['runId', 'afterSequence', 'maxEvents']);
    const runId = v.id(q.runId, 'runId');
    const afterSequence = q.afterSequence === undefined ? 0 : v.int(q.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER);
    const maxEvents = q.maxEvents === undefined ? 100 : v.int(q.maxEvents, 'maxEvents', 1, 100);
    return ui().getRun({ runId, afterSequence, maxEvents });
  };

  H[CHANNELS.runCancel] = async (p) => {
    const q = v.only(v.obj(p), ['runId']);
    return ui().cancelRun({ runId: v.id(q.runId, 'runId') });
  };

  H[CHANNELS.handoff] = async (p) => {
    const q = v.only(v.obj(p), ['sessionId', 'pageId', 'runId', 'reason']);
    const arg = {
      sessionId: v.id(q.sessionId, 'sessionId'),
      pageId: v.id(q.pageId, 'pageId'),
      runId: v.optId(q.runId, 'runId'),
      reason: q.reason === undefined ? 'Take control' : v.text(q.reason, 'reason', 200),
    };
    return ui().handoff(arg);
  };

  H[CHANNELS.resume] = async (p) => {
    const q = v.only(v.obj(p), ['sessionId', 'pageId']);
    return ui().resume({ sessionId: v.id(q.sessionId, 'sessionId'), pageId: v.id(q.pageId, 'pageId') });
  };

  H[CHANNELS.observe] = async (p) => {
    const q = v.only(v.obj(p), ['sessionId', 'pageId', 'maxNodes']);
    return ui().observe({
      sessionId: v.id(q.sessionId, 'sessionId'),
      pageId: v.id(q.pageId, 'pageId'),
      maxNodes: q.maxNodes === undefined ? 100 : v.int(q.maxNodes, 'maxNodes', 1, 200),
    });
  };

  H[CHANNELS.approvalsPending] = async () => {
    ui(); // flag + broker gate
    const out = [];
    for (const r of approvals.values()) if (r.status === 'pending' && r.payload) out.push(r.payload);
    return { approvals: out };
  };

  H[CHANNELS.approvalDecide] = async (p) => {
    const q = v.only(v.obj(p), ['approvalId', 'decision', 'actionDigest', 'documentEpoch']);
    const approvalId = v.id(q.approvalId, 'approvalId');
    if (q.decision !== 'allow' && q.decision !== 'deny') fail('decision must be allow or deny');
    const digest = q.actionDigest === undefined ? '' : v.text(q.actionDigest, 'actionDigest', 200);
    const broker = ui();
    const rec = approvals.get(approvalId);
    if (!rec) throw denied('That approval request is not known to this window.');
    if (rec.status !== 'pending') throw denied('That approval request has already been answered or withdrawn.');
    if (rec.expiresAt !== null && rec.expiresAt <= now()) { rec.status = 'expired'; throw denied('That approval request expired.'); }
    if (q.decision === 'allow') {
      if (!rec.digest) throw denied('The request carries no action digest, so it cannot be approved.');
      if (digest !== rec.digest) throw denied('The action changed since you opened the request. It was not approved.');
      if (rec.documentEpoch !== null && Number.isSafeInteger(q.documentEpoch) && q.documentEpoch !== rec.documentEpoch) {
        throw denied('The page changed since you opened the request. It was not approved.');
      }
    }
    // Mark first so a double click cannot send two decisions.
    rec.status = 'deciding';
    let reply;
    try {
      reply = await broker.approve({ approvalId, decision: q.decision });
    } catch (err) {
      rec.status = 'pending'; // the broker refused: nothing was decided
      throw err;
    }
    rec.status = q.decision === 'allow' ? 'allowed' : 'denied';
    const said = isObj(reply) ? String(reply.decision || reply.status || '') : '';
    return { approvalId, decision: q.decision, status: said || rec.status };
  };

  H[CHANNELS.capabilities] = async () => {
    const b = ui();
    return safeClone(await b.readResource('braiwser://capabilities'));
  };

  H[CHANNELS.resourceRead] = async (p) => {
    const q = v.only(v.obj(p), ['uri']);
    if (typeof q.uri !== 'string' || !URI_RE.test(q.uri)) fail('uri is not a run evidence link');
    const data = await ui().readResource(q.uri);
    const copy = safeClone(data);
    if (copy === null) return { truncated: true, message: 'This evidence is too large to preview here.' };
    return copy;
  };

  H[CHANNELS.connections] = async () => {
    const b = ui();
    if (typeof b.listConnections !== 'function') return { supported: false, connections: [] };
    const list = await b.listConnections();
    return { supported: true, connections: (Array.isArray(list) ? list : []).slice(0, 100).map((c) => safeClone(c)).filter(Boolean) };
  };

  for (const [channel, method, verb] of [
    [CHANNELS.connectionEnable, 'enableConnection', 'enabling'],
    [CHANNELS.connectionRevoke, 'revokeConnection', 'revoking'],
  ]) {
    H[channel] = async (p) => {
      const q = v.only(v.obj(p), ['clientId']);
      const clientId = v.id(q.clientId, 'clientId');
      const b = ui();
      if (typeof b[method] !== 'function') throw unsupported(`This runtime does not support ${verb} clients from the shell.`);
      return b[method]({ clientId });
    };
  }

  // ---- registration ------------------------------------------------------------
  // `handle(channel, fn, { withEvent:true })` is security.handle-style (already
  // sender-guarded); without it we fall back to ipcMain.handle + our own check.
  function bind(channel, fn) {
    const wrapped = async (event, payload) => {
      if (!isTrustedSender(event, deps.getWindow && deps.getWindow())) {
        return { ok: false, error: { code: 'DENIED', message: 'This request did not come from the Braiwser window.', dispatched: false, effectUnknown: false, retry: 'never' } };
      }
      try {
        const data = await fn(payload, event);
        const copy = safeClone(data === undefined ? null : data);
        if (copy === null && data !== null && data !== undefined) throw unavailable('The runtime reply was too large or not serialisable.');
        return { ok: true, data: copy };
      } catch (err) {
        return { ok: false, error: publicError(err) };
      }
    };
    if (typeof deps.handle === 'function') {
      deps.handle(channel, wrapped, { withEvent: true });
    } else if (deps.ipcMain) {
      if (deps.ipcMain.removeHandler) deps.ipcMain.removeHandler(channel);
      deps.ipcMain.handle(channel, wrapped);
      handlerDisposers.push(() => { try { deps.ipcMain.removeHandler(channel); } catch (_e) { /* ignore */ } });
    }
  }
  for (const [channel, fn] of Object.entries(H)) bind(channel, fn);

  // ---- pushes: broker events -> shell window only --------------------------------
  function sendToShell(channel, payload) {
    const win = deps.getWindow && deps.getWindow();
    try {
      if (!win || (win.isDestroyed && win.isDestroyed())) return false;
      const wc = win.webContents;
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return false;
      if (deps.isShellWebContents && !deps.isShellWebContents(wc)) return false;
      const copy = safeClone(payload, 128 * 1024);
      if (copy === null) return false; // dropped; the renderer sees a sequence gap and rereads the journal
      wc.send(channel, copy);
      return true;
    } catch (_e) {
      return false;
    }
  }

  let attachedTo = null;
  function attach() {
    const b = rawBroker();
    if (!b || !b.events || typeof b.events.on !== 'function' || attachedTo === b.events) return false;
    if (attachedTo && attachedTo.removeListener) detach();
    const on = (name, fn) => { b.events.on(name, fn); disposers.push(() => b.events.removeListener && b.events.removeListener(name, fn)); };
    on('run-event', (payload) => { if (flag() && isObj(payload) && typeof payload.runId === 'string') sendToShell(PUSH.runEvent, payload); });
    on('approval-requested', (payload) => {
      if (!flag()) return;
      const rec = rememberApproval(payload);
      if (!rec) return;
      rec.payload = safeClone(payload, 64 * 1024);
      sendToShell(PUSH.approval, payload);
    });
    on('owner-changed', (payload) => {
      if (!flag() || !isObj(payload)) return;
      const ownerName = typeof payload.owner === 'string' ? payload.owner : (isObj(payload.owner) ? payload.owner.controller : payload.controller);
      // Control moved away from the agent, or the page changed: pending approvals
      // for that session are withdrawn here too.
      for (const r of approvals.values()) {
        if (r.status !== 'pending' || r.sessionId !== payload.sessionId) continue;
        if (ownerName && ownerName !== 'agent') r.status = 'withdrawn';
        else if (r.pageId === payload.pageId && Number.isSafeInteger(payload.documentEpoch) && r.documentEpoch !== null && payload.documentEpoch !== r.documentEpoch) r.status = 'withdrawn';
      }
      sendToShell(PUSH.owner, payload);
    });
    on('session-closed', (payload) => {
      if (!flag() || !isObj(payload)) return;
      for (const r of approvals.values()) if (r.sessionId === payload.sessionId && r.status === 'pending') r.status = 'withdrawn';
      sendToShell(PUSH.sessionClosed, payload);
    });
    for (const name of ['approval-resolved', 'approval-cancelled', 'approval-expired']) {
      on(name, (payload) => {
        const r = isObj(payload) ? approvals.get(payload.approvalId) : null;
        if (r && r.status !== 'allowed' && r.status !== 'denied') r.status = name === 'approval-expired' ? 'expired' : 'withdrawn';
      });
    }
    attachedTo = b.events;
    return true;
  }
  function detach() {
    while (disposers.length) { try { disposers.pop()(); } catch (_e) { /* ignore */ } }
    attachedTo = null;
  }
  function dispose() {
    detach();
    while (handlerDisposers.length) { try { handlerDisposers.pop()(); } catch (_e) { /* ignore */ } }
  }

  attach();
  return {
    channels: CHANNELS,
    handlers: H,
    attach, // call again once the broker exists, if it was created after register()
    dispose,
    _approvals: approvals,
    _bind: bind,
  };
}

// index.js entry: require('./browser').register({ ... }) — only when the flag is on.
function register(deps) {
  return createBrowserIpc(deps);
}

module.exports = {
  register, createBrowserIpc, isTrustedSender, publicError, CHANNELS, PUSH, UI_PRINCIPAL, BadRequest,
};
