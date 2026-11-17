'use strict';
const IDLE_RELEASE_MS = 750; // how long an idle page keeps its debugger lease
// Electron-embedded driver: main-owned guest registry + CDP observation / input.
//
// STATUS: implemented against the contract and unit-tested with fake
// webContents / fake debugger leases (a jsdom-backed CDP shim runs the real probe).
// Only a slice has been run inside real Electron (electron.native.test.js: observe,
// click, select, screenshots and open shadow roots on a WebContentsView and a
// <webview>, Linux under Xvfb). Capability flags are deliberately conservative;
// anything marked "needs native confirmation" below must be proven by an
// Electron-native test before the flag is raised.
//
// Ownership model (audit "Embedded browser migration"):
//   * Shell tabs are still <webview> elements. The main process registers each
//     attached guest and hands out opaque pageIds.
//   * A new embedded page, when createGuest is installed, is a WebContentsView
//     owned by the main process. Without that factory, newPage stays unsupported.
//   * One shared debugger broker (../debugger-broker.js) owns webContents.debugger.
//     This driver only holds ref-counted LEASES: closing a lease never detaches an
//     attachment another feature (screenshot capture) uses, and a lease that is
//     LOST (DevTools, crash, process swap) turns the page 'paused': every ref is
//     invalidated and a new observation is required.
//   * Input is CDP Input.* via cdp-pointer.js (sendInputEvent needs window focus).
//   * Observation / highlight / badge run src/webview/probe.js inside an ISOLATED
//     world (Page.createIsolatedWorld) so page script cannot tamper with the probe
//     and there is no bridge exposed to the page.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const probe = require('../../../../webview/probe');
const obs = require('./observe');
const { CdpPointer } = require('./cdp-pointer');

const { driverError, clipText, fingerprintOf, parseKey, validateNavigationUrl, normalizeFocus } = obs;

const DRIVER_VERSION = '0.1.0';
const ACTIONS = Object.freeze(['click', 'fill', 'press', 'select', 'check', 'navigate']);
const OWNERS = Object.freeze(['agent', 'human', 'quarantined', 'none']);
const REF_TTL_MS = 60000;
const MAX_REFS = 600;
const WORLD_NAME = 'braiwser-probe';
const NOOP_CONTROL = Object.freeze({ check() {}, beforeDispatch() {}, signal: null });
const rid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Clamp a renderer-reported content rectangle to the real window content bounds
// (audit Stage B: "main process clamps it to actual window bounds"). Pure.
function clampViewBounds(rect, bounds) {
  const r = rect || {};
  const b = bounds || {};
  if (![r.x, r.y, r.width, r.height, b.width, b.height].every(Number.isFinite)) {
    throw driverError('UNSUPPORTED', 'View bounds must be finite numbers.', { detail: 'BOUNDS_INVALID' });
  }
  const bw = Math.max(0, Math.floor(b.width));
  const bh = Math.max(0, Math.floor(b.height));
  const x = Math.min(bw, Math.max(0, Math.round(r.x)));
  const y = Math.min(bh, Math.max(0, Math.round(r.y)));
  return {
    x,
    y,
    width: Math.min(bw - x, Math.max(0, Math.round(r.width))),
    height: Math.min(bh - y, Math.max(0, Math.round(r.height))),
  };
}

function isWebContentsLike(wc) {
  return !!wc && typeof wc === 'object' && wc.debugger && typeof wc.on === 'function'
    && typeof wc.isDestroyed === 'function' && typeof wc.getURL === 'function';
}

class ElectronPage extends EventEmitter {
  constructor(session, wc, meta) {
    super();
    this.pageId = rid('pg');
    this.session = session;
    this.openerPageId = null;
    this.documentEpoch = 0;
    this.state = 'ready'; // ready | paused | crashed | closed
    this.owner = 'agent';
    this.ownerLabel = (meta && meta.ownerLabel) || 'guest';
    this._wc = wc;
    this._refs = new Map();
    this._issued = [];
    this._snapshots = new obs.SnapshotStore();
    this._lease = null;
    this._ctx = null;
    this._busy = 0; // in-flight CDP users (sends, pointer actions) of the lease
    this._idleTimer = null;
    this._lane = Promise.resolve();
    this._disposed = false;
    this._wire();
  }

  url() { try { return this._wc.getURL(); } catch (_e) { return ''; } }

  // The broker subscribes to `driverPage.events` (navigated | crashed | closed | popup | download | dialog).
  get events() { return this; }

  get closed() { return this.state === 'closed'; }

  _emitSession(event) { this.session._emitPageEvent({ pageId: this.pageId, ...event }); }

  // ---- lifecycle ----------------------------------------------------------------
  _wire() {
    const wc = this._wc;
    const bump = (kind, payload) => {
      this._bumpEpoch();
      this.emit('navigated', { documentEpoch: this.documentEpoch, url: this.url(), ...payload });
      this._emitSession({ type: 'navigated', documentEpoch: this.documentEpoch, kind });
    };
    this._on = {
      'did-navigate': () => bump('document', { mainFrame: true }),
      'did-navigate-in-page': (_e, _url, isMainFrame) => bump('same-document', { mainFrame: isMainFrame !== false }),
      'did-frame-navigate': (_e, _url, _code, _text, isMainFrame) => { if (isMainFrame === false) bump('frame', { mainFrame: false }); },
      'dom-ready': () => { if (this.session.mode === 'visible' && this.owner !== 'none') this._applyBadge().catch(() => {}); },
      'render-process-gone': () => {
        this.state = 'crashed';
        this._invalidateRefs('PAGE_CRASHED');
        this._dropLease();
        this.emit('crashed', {});
        this._emitSession({ type: 'crashed' });
      },
      destroyed: () => this._onDestroyed(),
    };
    for (const [event, handler] of Object.entries(this._on)) wc.on(event, handler);
  }

  _onDestroyed() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this._invalidateRefs('PAGE_CLOSED');
    this._dropLease();
    this.emit('closed', {});
    this._emitSession({ type: 'closed' });
    this.session.driver._forgetGuest(this);
  }

  _bumpEpoch() {
    this.documentEpoch += 1;
    this._ctx = null;
    this._invalidateRefs('STALE_DOCUMENT');
    this._snapshots.clear();
  }

  _invalidateRefs(reason) { for (const ref of this._refs.values()) this._killRef(ref, reason); }

  _killRef(ref, reason) {
    if (ref.dead) return;
    ref.dead = reason;
    ref.diedAt = Date.now();
    if (ref.objectId && this._lease && this._lease.active !== false) {
      this._lease.send('Runtime.releaseObject', { objectId: ref.objectId }).catch(() => {});
    }
    ref.objectId = null;
  }

  _gcRefs() {
    const now = Date.now();
    for (const [id, ref] of this._refs) {
      if (ref.dead && now - ref.diedAt > 30000) this._refs.delete(id);
      else if (!ref.dead && now > ref.expiresAt) this._killRef(ref, 'REF_EXPIRED');
    }
    while (this._refs.size >= MAX_REFS) {
      const oldest = this._refs.keys().next().value;
      this._killRef(this._refs.get(oldest), 'REF_EVICTED');
      this._refs.delete(oldest);
    }
  }

  // Debugger lease lost (DevTools opened, process swap, ...): paused, refs invalid,
  // a fresh observe() re-acquires. We do NOT silently re-attach and continue an action.
  _onLeaseLost(reason) {
    if (this.state === 'closed' || this.state === 'crashed') return;
    this.state = 'paused';
    this._lease = null;
    this._ctx = null;
    this._invalidateRefs('DEBUGGER_LOST');
    this._snapshots.clear();
    this.emit('paused', { reason: clipText(reason || 'detached', 40) });
    // The broker invalidates its cached refs / observations on 'navigated'; a lost debugger must do the same.
    this.emit('navigated', { documentEpoch: this.documentEpoch, url: this.url(), mainFrame: true, kind: 'debugger-lost' });
    this._emitSession({ type: 'paused', reason: clipText(reason || 'detached', 40) });
  }

  // The debugger is a shared resource (full-page capture, DevTools). Hold the lease only while work is
  // in flight and give it back shortly after, so an idle page never blocks other features.
  _scheduleIdleRelease() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._busy === 0) this._dropLease();
    }, IDLE_RELEASE_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _dropLease() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    const lease = this._lease;
    this._lease = null;
    this._ctx = null;
    if (lease && typeof lease.release === 'function') { try { lease.release(); } catch (_e) { /* ignore */ } }
  }

  _assertUsable() {
    if (this.state === 'crashed') throw driverError('UNAVAILABLE', 'The page crashed.', { detail: 'PAGE_CRASHED' });
    if (this.state === 'closed' || this._wc.isDestroyed()) throw driverError('UNAVAILABLE', 'The page is closed.', { detail: 'PAGE_CLOSED' });
  }

  async _acquire() {
    this._assertUsable();
    if (this._lease && !this._lease.lost && !this._lease.released) return this._lease;
    let lease;
    try {
      lease = this.session.driver._debugger().acquire(this._wc, { owner: 'agent-driver' });
    } catch (err) {
      throw driverError('UNAVAILABLE', 'The page debugger is not available.', { detail: (err && err.code) || 'DEBUGGER_UNAVAILABLE', retry: !!err && err.code === 'DEBUGGER_BUSY' });
    }
    this._lease = lease;
    this._ctx = null;
    if (typeof lease.onLost === 'function') lease.onLost((reason) => { if (this._lease === lease) this._onLeaseLost(reason); });
    return lease;
  }

  // ---- CDP plumbing -------------------------------------------------------------------
  async _send(method, params) {
    const lease = await this._acquire();
    this._busy++;
    try {
      return await lease.send(method, params);
    } catch (err) {
      if (err && err.code === 'DRIVER_DISCONNECTED') {
        this._onLeaseLost('disconnected');
        throw driverError('UNAVAILABLE', 'The page debugger disconnected; observe again.', { detail: 'DRIVER_DISCONNECTED', retry: true });
      }
      throw err;
    } finally {
      this._busy--;
      this._scheduleIdleRelease();
    }
  }

  async _world() {
    if (this._ctx && this._ctx.epoch === this.documentEpoch) return this._ctx.id;
    const tree = await this._send('Page.getFrameTree', {});
    const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    if (!frameId) throw driverError('UNAVAILABLE', 'No main frame.', { detail: 'NO_FRAME' });
    const world = await this._send('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: false });
    this._ctx = { epoch: this.documentEpoch, id: world.executionContextId, frames: countFrames(tree.frameTree) };
    return this._ctx.id;
  }

  _unwrap(res) {
    if (!res || res.exceptionDetails) throw driverError('UNAVAILABLE', 'Page script could not run.', { detail: 'PROBE_FAILED' });
    return res.result ? res.result.value : undefined;
  }

  // Run ONE probe command. cmd is a closed set (probe.COMMANDS); args are driver-authored JSON.
  async _probe(cmd, args, target) {
    if (!probe.COMMANDS.includes(cmd)) throw driverError('INTERNAL', 'Unknown probe command.');
    const decl = target
      ? `function(){ return (${probe.PROBE_SOURCE})(${JSON.stringify(cmd)}, Object.assign(${JSON.stringify(args || {})}, { el: this })); }`
      : `function(){ return (${probe.PROBE_SOURCE})(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})}); }`;
    const params = target
      ? { objectId: target.objectId, functionDeclaration: decl, returnByValue: true }
      : { executionContextId: await this._world(), functionDeclaration: decl, returnByValue: true };
    return this._unwrap(await this._send('Runtime.callFunctionOn', params));
  }

  // Like _probe but keeps the (non-serializable) result alive and returns its objectId.
  async _probeHandle(cmd, args, target) {
    if (!probe.COMMANDS.includes(cmd)) throw driverError('INTERNAL', 'Unknown probe command.');
    const res = await this._send('Runtime.callFunctionOn', {
      objectId: target.objectId,
      functionDeclaration: `function(){ return (${probe.PROBE_SOURCE})(${JSON.stringify(cmd)}, Object.assign(${JSON.stringify(args || {})}, { el: this })); }`,
      returnByValue: false,
    });
    if (!res || res.exceptionDetails || !res.result || !res.result.objectId) return null;
    return res.result.objectId;
  }

  async _readWatch(objectId) {
    try {
      const res = await this._send('Runtime.callFunctionOn', { objectId, returnByValue: true,
        functionDeclaration: 'function(){ var o = { n: this.n, trusted: this.trusted }; this.stop(); return o; }' });
      this._release(objectId);
      return res && !res.exceptionDetails && res.result ? res.result.value : null;
    } catch (_e) { return null; }
  }

  // Fixed, driver-authored readbacks / focus on a ref'd node (no caller-supplied code).
  async _onNode(ref, body, argValue) {
    const res = await this._send('Runtime.callFunctionOn', {
      objectId: ref.objectId,
      functionDeclaration: `function(a){ ${body} }`,
      arguments: [{ value: argValue === undefined ? null : argValue }],
      returnByValue: true,
    });
    return this._unwrap(res);
  }

  // ---- navigation ------------------------------------------------------------------------
  async navigate(url, { signal, timeoutMs } = {}) {
    this._assertUsable();
    const target = validateNavigationUrl(url);
    if (signal && signal.aborted) return { outcome: 'cancelled', url: this.url() };
    const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));
    let stopped = null;
    let timer;
    let onAbort;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => { stopped = 'timeout'; resolve(); }, timeout);
      if (signal) { onAbort = () => { stopped = 'cancelled'; resolve(); }; signal.addEventListener('abort', onAbort, { once: true }); }
    });
    const load = Promise.resolve().then(() => this._wc.loadURL(target)).then(
      () => ({ outcome: 'ready' }),
      (err) => {
        if (stopped) return { outcome: stopped };
        const m = /ERR_[A-Z_]+/.exec(String((err && (err.code || err.message)) || ''));
        return { outcome: 'failed', error: m ? m[0] : 'NAVIGATION_FAILED' };
      });
    try {
      const first = await Promise.race([load, guard.then(() => ({ outcome: stopped }))]);
      if (first.outcome === 'timeout' || first.outcome === 'cancelled') {
        try { this._wc.stop(); } catch (_e) { /* ignore */ }
      }
      return { ...first, url: this.url() };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  // ---- observation ---------------------------------------------------------------------------
  async observe({ maxNodes, focus, cursor, baseObservationId, maxBytes } = {}) {
    this._assertUsable();
    if (this.state === 'paused') this.state = 'ready'; // an explicit new observation is the recovery path
    const want = obs.clampNodes(maxNodes);
    const f = normalizeFocus(focus);
    const offset = cursor ? obs.decodeCursor(cursor, { epoch: this.documentEpoch, focus: f }).offset : 0;
    let collected = null;
    for (let attempt = 0; attempt < 3 && !collected; attempt += 1) {
      const epoch = this.documentEpoch;
      const attemptResult = await this._collect({ offset, want, focus: f });
      if (this.documentEpoch !== epoch) {
        for (const e of attemptResult.entries) this._release(e.objectId);
        continue;
      }
      collected = attemptResult;
    }
    if (!collected) throw driverError('UNAVAILABLE', 'The document kept changing; observe again.', { detail: 'DOCUMENT_UNSTABLE', retry: true });
    this._gcRefs();
    const expiresAt = Date.now() + REF_TTL_MS;
    const refs = {
      mint: (e, observationId) => {
        if (!e.objectId) return null;
        const refId = rid('r');
        this._refs.set(refId, {
          refId, objectId: e.objectId, fingerprint: e.fingerprint, key: e.key, role: e.node.role,
          secret: e.node.secret === true, ambiguous: e.node.ambiguous === true,
          scope: { pageId: this.pageId, documentEpoch: this.documentEpoch, frameId: null, observationId },
          observationIds: new Set([observationId]), expiresAt, dead: null,
        });
        e.objectId = null;
        return refId;
      },
      rebind: (refId, observationId) => {
        const ref = this._refs.get(refId);
        if (!ref || ref.dead) return false;
        ref.observationIds.add(observationId);
        ref.expiresAt = expiresAt;
        return true;
      },
      kill: (refId, reason) => { const ref = this._refs.get(refId); if (ref) this._killRef(ref, reason); },
      dispose: (e) => { if (e.objectId) { this._release(e.objectId); e.objectId = null; } },
    };
    const result = obs.assembleObservation({
      pageId: this.pageId, documentEpoch: this.documentEpoch, url: this.url(), snapshots: this._snapshots,
      newId: rid, offset, want, focus: f, baseObservationId, maxBytes, extra: { ownerBadge: this.owner },
    }, collected, refs);
    this._issued.push(result.observationId);
    if (this._issued.length > 64) this._issued.shift();
    return result;
  }

  _release(objectId) {
    if (objectId && this._lease && !this._lease.lost) this._lease.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }

  async _collect({ offset, want, focus }) {
    const ctxId = await this._world();
    const call = await this._send('Runtime.callFunctionOn', {
      executionContextId: ctxId,
      functionDeclaration: `function(){ return (${probe.PROBE_SOURCE})('collect', ${JSON.stringify({ offset, max: want, focus })}); }`,
      returnByValue: false,
    });
    if (!call || call.exceptionDetails || !call.result || !call.result.objectId) {
      throw driverError('UNAVAILABLE', 'Observation script could not run.', { detail: 'PROBE_FAILED' });
    }
    const container = call.result.objectId;
    const entries = [];
    try {
      const meta = this._unwrap(await this._send('Runtime.callFunctionOn', {
        objectId: container, functionDeclaration: 'function(){ return { items: this.items, total: this.total, stats: this.stats }; }', returnByValue: true }));
      const arr = await this._send('Runtime.callFunctionOn', {
        objectId: container, functionDeclaration: 'function(){ return this.elements; }', returnByValue: false });
      const handles = [];
      if (arr && arr.result && arr.result.objectId) {
        const props = await this._send('Runtime.getProperties', { objectId: arr.result.objectId, ownProperties: true });
        for (const p of (props && props.result) || []) {
          if (/^\d+$/.test(p.name) && p.value && p.value.objectId) handles[Number(p.name)] = p.value.objectId;
        }
        this._release(arr.result.objectId);
      }
      for (const item of meta.items) {
        const objectId = item.hi >= 0 ? handles[item.hi] || null : null;
        entries.push({ item, objectId, fingerprint: fingerprintOf(item), frameId: null, node: obs.publicNode(item, null) });
      }
      // Frames are NOT observed (frames:false): report them so the gap is visible.
      const framesTotal = (this._ctx && this._ctx.frames) || 1;
      const frames = [{ frameId: 'main', parentFrameId: null, origin: obs.originOf(this.url()), crossOrigin: false, nodes: meta.total, available: true }];
      for (let i = 1; i < framesTotal; i += 1) frames.push({ frameId: `unobserved_${i}`, parentFrameId: 'main', origin: '', crossOrigin: false, nodes: 0, available: false });
      return { entries, frames, stats: { ...meta.stats, framesCapped: false }, total: meta.total };
    } finally {
      this._release(container);
    }
  }

  // ---- refs -----------------------------------------------------------------------------------------
  resolve(refId) {
    const ref = this._refs.get(refId);
    if (!ref) throw driverError('STALE_REF', 'Unknown reference.', { detail: 'REF_UNKNOWN' });
    if (ref.dead) throw driverError('STALE_REF', 'Reference is no longer valid.', { detail: ref.dead });
    if (Date.now() > ref.expiresAt) {
      this._killRef(ref, 'REF_EXPIRED');
      throw driverError('STALE_REF', 'Reference expired.', { detail: 'REF_EXPIRED' });
    }
    return { fingerprint: ref.fingerprint, scope: { ...ref.scope } };
  }

  _sameEpoch(ref) {
    if (ref.dead || ref.scope.documentEpoch !== this.documentEpoch || this.state !== 'ready') {
      throw driverError('STALE_REF', 'The document changed.', { detail: 'STALE_DOCUMENT' });
    }
  }

  async _describe(ref) {
    const live = await this._probe('describe', {}, ref).catch((err) => {
      if (err && err.code === 'UNAVAILABLE' && err.detail === 'PROBE_FAILED') {
        throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' });
      }
      throw err;
    });
    return live;
  }

  _assertLive(ref, live) {
    if (!live || !live.connected) throw driverError('STALE_REF', 'The target is no longer in the document.', { detail: 'NODE_DETACHED' });
    if (fingerprintOf({ tag: live.tag, role: live.role, type: live.type, name: live.name, ctx: live.ctx }) !== ref.fingerprint) {
      throw driverError('STALE_REF', 'The target changed since it was observed; observe again.', { detail: 'TARGET_CHANGED' });
    }
    if (live.dupCount > 1) {
      throw driverError('AMBIGUOUS_TARGET', `${live.dupCount} controls share this role and name; refusing to guess.`, { detail: 'AMBIGUOUS_TARGET' });
    }
  }

  // ---- actions ----------------------------------------------------------------------------------------------
  act(cmd, control) {
    const run = this._lane.then(() => this._act(cmd || {}, control || NOOP_CONTROL));
    this._lane = run.then(() => {}, () => {});
    return run;
  }

  async _act(cmd, control) {
    this._assertUsable();
    if (this.state === 'paused') {
      throw driverError('UNAVAILABLE', 'The page debugger was lost; observe again before acting.', { detail: 'DRIVER_PAUSED', retry: true });
    }
    const action = cmd.action || {};
    if (!ACTIONS.includes(action.kind)) {
      throw driverError('UNSUPPORTED', `Action ${clipText(action.kind, 20)} is not supported by this driver.`, { detail: 'ACTION_UNSUPPORTED' });
    }
    const epochBefore = this.documentEpoch;
    if (action.kind === 'navigate') {
      const target = validateNavigationUrl(action.url);
      control.check();
      control.beforeDispatch();
      const nav = await this.navigate(target, { signal: control.signal || undefined, timeoutMs: action.timeoutMs });
      const ok = nav.outcome === 'ready';
      if (nav.outcome === 'timeout' || nav.outcome === 'cancelled') {
        throw driverError(nav.outcome === 'timeout' ? 'TIMEOUT' : 'CANCELLED', `Navigation ${nav.outcome}.`, { dispatched: true, effectUnknown: true, detail: 'NAVIGATION_' + nav.outcome.toUpperCase() });
      }
      if (!ok) throw driverError('UNAVAILABLE', 'Navigation failed.', { dispatched: true, detail: nav.error || 'NAVIGATION_FAILED' });
      return { status: 'verified', evidence: [obs.evidence.navigation({ url: nav.url, outcome: nav.outcome, matches: true, fromEpoch: epochBefore, documentEpoch: this.documentEpoch })] };
    }
    if (action.kind === 'fill' && (typeof action.text !== 'string' || action.text.length > 10000)) {
      throw driverError('UNSUPPORTED', 'fill needs text (<= 10000 chars).', { detail: 'TEXT_INVALID' });
    }
    if (action.kind === 'check' && typeof action.checked !== 'boolean') {
      throw driverError('UNSUPPORTED', 'check needs a boolean.', { detail: 'CHECKED_INVALID' });
    }
    if (action.kind === 'select' && (typeof action.value !== 'string' || action.value.length > 500)) {
      throw driverError('UNSUPPORTED', 'select needs a value.', { detail: 'VALUE_INVALID' });
    }
    let printable = false;
    if (action.kind === 'press') {
      printable = parseKey(action.key).printable;
    }
    const { ref, live } = await this._prepare(cmd, action, control, printable);
    const evidence = [];
    // select: decide WHICH option before anything is dispatched. Zero or several matches are refused, never guessed.
    let option = null;
    if (action.kind === 'select') {
      await this._actionablePoint(ref, control);
      option = await this._onNode(ref, SELECT_PLAN, action.value);
      control.check(); this._sameEpoch(ref);
      if (!option || option.ok !== true) throw selectRefusal(option && option.reason, option && option.matches);
    }
    // Attest delivery for plain clicks: a listener (isolated world) counts trusted clicks reaching the target.
    const watchId = action.kind === 'click' ? await this._probeHandle('watchClick', {}, ref).catch(() => null) : null;
    let dispatched = false;
    const guarded = { signal: control.signal, check: () => control.check(), beforeDispatch: () => { control.beforeDispatch(); dispatched = true; } };
    const pointer = new CdpPointer(await this._acquire());
    this._busy++;
    try {
      try {
        if (action.kind === 'check') {
          if (live.role === 'radio' && action.checked === false) throw driverError('UNSUPPORTED', 'A radio button cannot be unchecked directly.', { detail: 'CHECK_UNSUPPORTED' });
          if ((live.checked === true) !== action.checked || live.checked === 'mixed') await this._clickRef(pointer, ref, guarded);
          const now = await this._onNode(ref, 'return this.checked === true;');
          evidence.push(obs.evidence.checked(now === action.checked, now, this.documentEpoch));
        } else if (action.kind === 'click') {
          await this._clickRef(pointer, ref, guarded);
          const seen = watchId ? await this._readWatch(watchId) : null;
          if (seen) evidence.push(obs.evidence.clicked(seen.trusted > 0, seen.trusted, this.documentEpoch));
        } else if (action.kind === 'fill') {
          await this._clickRef(pointer, ref, guarded); // places focus with a real pointer event
          await this._onNode(ref, 'if (typeof this.select === "function") this.select(); return true;');
          await pointer.insertText(action.text, guarded);
          const matches = await this._onNode(ref, 'return this.value === a;', action.text);
          evidence.push(obs.evidence.value(matches === true, action.text.length, this.documentEpoch));
        } else if (action.kind === 'select') {
          // No pointer or key input: a native <select> popup is an OS widget outside the page. The option is set on
          // the element and `input` + `change` are fired when the selection actually changed (what Playwright's
          // selectOption does); those events are script-made (isTrusted:false).
          guarded.beforeDispatch();
          const done = await this._onNode(ref, SELECT_APPLY, { index: option.index, value: option.value, label: option.label });
          if (!done || done.ok !== true) throw driverError('STALE_REF', 'The options changed before the selection; observe again.', { detail: 'TARGET_CHANGED' });
          const chosen = Array.isArray(done.values) ? done.values : [];
          evidence.push(obs.evidence.selected(chosen.length === 1 && chosen[0] === action.value, chosen.length, this.documentEpoch));
        } else {
          guarded.beforeDispatch();
          await this._onNode(ref, 'this.focus(); return true;');
          await pointer.pressKey(action.key, guarded);
        }
      } catch (err) {
        if (!dispatched) throw err;
        if (!err || (!err.publicError && (!err.code || err.code === 'DRIVER_DISCONNECTED'))) {
          throw driverError('UNAVAILABLE', 'Browser input failed after dispatch started; the effect is unknown.',
            { dispatched: true, effectUnknown: true, detail: 'DISPATCH_FAILED', cause: err });
        }
        // A driver error or a control-originated error (ownership lost, stale epoch): keep its code, add the truth.
        try { err.dispatched = true; err.effectUnknown = true; } catch (_e) { /* frozen */ }
        throw err;
      }
    } finally { pointer.close(); this._busy--; this._scheduleIdleRelease(); }
    let expectOutcome = null;
    if (action.expect && typeof action.expect === 'object') {
      const { timeoutMs: _t, ...assertion } = action.expect;
      const deadline = Date.now() + Math.max(0, Math.min(10000, Number(action.expect.timeoutMs) || 3000));
      let last;
      do {
        last = await this.evaluateAssertion(assertion);
        if (last.status === 'passed') break;
        await sleep(40);
      } while (Date.now() < deadline);
      expectOutcome = { status: last.status, evidence: last.evidence[0] };
    }
    return obs.composeResult({ evidence, expectOutcome, epochBefore, epochNow: this.documentEpoch, url: this.url(), dialogOpened: false, navigateAction: false });
  }

  async _prepare(cmd, action, control, printable) {
    const refId = action.refId || action.ref;
    if (typeof refId !== 'string') throw driverError('UNSUPPORTED', 'This action needs a ref.', { detail: 'REF_REQUIRED' });
    this.resolve(refId);
    const ref = this._refs.get(refId);
    // `cmd.documentEpoch` is the broker's (checked by control.check()); the driver's own epoch is `driverDocumentEpoch`.
    if (cmd.driverDocumentEpoch !== undefined && cmd.driverDocumentEpoch !== null && cmd.driverDocumentEpoch !== this.documentEpoch) {
      throw driverError('STALE_REF', 'The document epoch changed.', { detail: 'STALE_DOCUMENT' });
    }
    this._sameEpoch(ref);
    if (cmd.observationId && this._issued.includes(cmd.observationId) && !ref.observationIds.has(cmd.observationId)) {
      throw driverError('STALE_REF', 'The reference belongs to a different observation.', { detail: 'WRONG_OBSERVATION' });
    }
    control.check();
    const live = await this._describe(ref);
    control.check(); this._sameEpoch(ref);
    this._assertLive(ref, live);
    if ((action.kind === 'fill' || (action.kind === 'press' && printable)) && (live.secret || ref.secret)) {
      throw driverError('DENIED', 'Secret fields (passwords, one-time codes, payment data) are never filled by an agent.', { detail: 'SECRET_FIELD' });
    }
    if (live.kind !== 'interactable') {
      throw driverError('UNSUPPORTED', 'Only interactive controls can be acted on (this node is observation-only).', { detail: 'NOT_INTERACTABLE' });
    }
    if ((live.traits || []).includes('file-input')) {
      throw driverError('UNSUPPORTED', 'File inputs are not supported (no native picker / upload capability).', { detail: 'UPLOAD_UNSUPPORTED' });
    }
    if (!live.rendered) throw driverError('UNAVAILABLE', 'The target is not visible.', { detail: 'NOT_ACTIONABLE' });
    if (!live.enabled) throw driverError('UNAVAILABLE', 'The target is disabled.', { detail: 'NOT_ACTIONABLE' });
    if (action.kind === 'fill' && !live.editable) throw driverError('UNAVAILABLE', 'The target is not an editable field.', { detail: 'NOT_EDITABLE' });
    if (action.kind === 'check' && !['checkbox', 'radio', 'switch'].includes(live.role)) {
      throw driverError('UNSUPPORTED', 'The target is not a checkable control.', { detail: 'CHECK_UNSUPPORTED' });
    }
    if (action.kind === 'select' && live.tag !== 'select') {
      throw driverError('UNSUPPORTED', 'Only native <select> elements are supported.', { detail: 'SELECT_UNSUPPORTED' });
    }
    return { ref, live };
  }

  // Scroll into view, hit-test, re-verify identity, then ONE real CDP click.
  async _clickRef(pointer, ref, control) {
    const point = await this._actionablePoint(ref, control);
    return pointer.clickCssPoint({ x: point.x, y: point.y, viewportWidth: point.viewportWidth, viewportHeight: point.viewportHeight }, control);
  }

  // Scroll into view and hit-test: the target must be in the viewport, have a box and not be covered, and still be
  // the node that was observed. Dispatches nothing.
  async _actionablePoint(ref, control) {
    let point = null;
    for (let i = 0; i < 4; i += 1) {
      point = await this._probe('clickPoint', {}, ref);
      control.check(); this._sameEpoch(ref);
      if (point && point.connected && !point.empty && point.inViewport && !point.occluded) break;
      if (i < 3) await sleep(80);
    }
    if (!point || !point.connected) throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' });
    if (point.empty || !point.inViewport || point.occluded) {
      throw driverError('UNAVAILABLE', `The target is not actionable (${point.occluded ? 'covered' : point.empty ? 'not-visible' : 'outside-viewport'}); nothing was dispatched.`, { detail: 'NOT_ACTIONABLE' });
    }
    const live = await this._describe(ref);
    control.check(); this._sameEpoch(ref);
    this._assertLive(ref, live);
    return point;
  }

  // ---- assertions (closed DSL) ------------------------------------------------------------------------------------
  async evaluateAssertion(assertion, { timeoutMs = 0, pollMs = 50 } = {}) {
    const shared = require('../../../../shared/assertions');
    const step = assertion && typeof assertion === 'object' ? { ...assertion } : assertion;
    if (step && typeof step === 'object' && step.selector == null && typeof step.target === 'string') step.selector = step.target;
    // `target` may also be a semantic locator (plans use { by:'role'|'label'|'testId', ... }).
    let locator = null;
    if (step && typeof step === 'object' && step.target && typeof step.target === 'object') {
      locator = obs.normalizeLocator(step.target);
      if (!locator) return { status: 'failed', actual: '', evidence: [{ kind: 'exists', observed: false, status: 'failed', error: 'invalid-target', documentEpoch: this.documentEpoch }] };
      if (step.selector == null) step.selector = obs.locatorLabel(locator);
    }
    const norm = shared.normalizeAssertion(step);
    const evidenceOf = (a, status, actual, extra) => [obs.evidence.assertion(a, status, actual, this.documentEpoch, extra)];
    if (!norm.ok) return { status: 'failed', actual: '', evidence: [{ kind: 'exists', observed: false, status: 'failed', error: clipText(norm.error, 120), documentEpoch: this.documentEpoch }] };
    const a = norm.assertion;
    const deadline = Date.now() + Math.max(0, Math.min(10000, timeoutMs));
    let result;
    for (;;) {
      const epoch = this.documentEpoch;
      try {
        this._assertUsable();
        const facts = { url: this.url() };
        if (a.kind !== 'url') {
          const raw = await this._probe('assertFacts', locator ? { target: locator } : { selector: a.selector });
          if (raw.error) { result = { status: 'failed', actual: '', evidence: evidenceOf(a, 'failed', '', { error: raw.error }) }; break; }
          Object.assign(facts, raw);
        }
        if (this.documentEpoch !== epoch) throw driverError('STALE_REF', 'Document changed during assertion.', { detail: 'STALE_DOCUMENT' });
        const out = shared.evaluate(a, facts);
        result = { status: out.status, actual: out.actual, evidence: evidenceOf(a, out.status, out.actual) };
      } catch (err) {
        result = { status: 'unknown', actual: 'ENGINE_UNAVAILABLE', evidence: evidenceOf(a, 'unknown', 'ENGINE_UNAVAILABLE', { error: clipText(err && err.detail ? err.detail : 'ENGINE_ERROR', 60) }) };
      }
      if (result.status === 'passed' || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    return result;
  }

  // ---- screenshots / presentation ---------------------------------------------------------------------------------------
  // Unmodified pixels of the guest's viewport (wc.capturePage), of a rectangle inside it, or of the single element
  // behind an observed ref (never a selector). The agent badge is Braiwser UI and is hidden for the shot. The image
  // is what Electron returns, at the device scale: nothing is masked, annotated or resized (meta.transformed false).
  async screenshot({ clip } = {}) {
    this._assertUsable();
    const view = await this._viewport();
    let region = null;
    if (clip) {
      const ok = ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(clip[k]))
        && clip.x >= 0 && clip.y >= 0 && clip.width > 0 && clip.height > 0
        && clip.x + clip.width <= view.width && clip.y + clip.height <= view.height;
      if (!ok) throw driverError('UNSUPPORTED', 'clip must lie inside the viewport.', { detail: 'CLIP_INVALID' });
      region = roundRect(clip);
    }
    return this._shoot(view, region);
  }

  // Evidence capture: the whole viewport, or the single element behind an observed ref.
  async capture({ refId } = {}) {
    this._assertUsable();
    if (!refId) return this._shoot(await this._viewport(), null);
    if (this.state === 'paused') throw driverError('UNAVAILABLE', 'The page debugger was lost; observe again.', { detail: 'DRIVER_PAUSED', retry: true });
    this.resolve(refId); // unknown / dead / expired -> STALE_REF
    const ref = this._refs.get(refId);
    this._sameEpoch(ref);
    const live = await this._describe(ref);
    this._sameEpoch(ref);
    this._assertLive(ref, live);
    // Scrolls the element to the centre of the viewport first (same probe command a click uses).
    const point = await this._probe('clickPoint', {}, ref);
    if (!point || !point.connected) throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' });
    const box = await this._onNode(ref, 'var r = this.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };');
    this._sameEpoch(ref);
    if (!box || !(box.width > 0 && box.height > 0)) throw driverError('UNAVAILABLE', 'The target has no visible box to capture.', { detail: 'NOT_CAPTURABLE' });
    const view = await this._viewport();
    const region = roundRect(box);
    // A partial picture would be passed off as the element: refuse instead of cropping silently.
    if (region.x < 0 || region.y < 0 || region.x + region.width > view.width || region.y + region.height > view.height) {
      throw driverError('UNAVAILABLE', 'The target does not fit inside the viewport; it cannot be captured whole.', { detail: 'NOT_CAPTURABLE' });
    }
    const shot = await this._shoot(view, region);
    this._sameEpoch(ref);
    return shot;
  }

  async _viewport() {
    const view = await this._probe('viewportInfo', {});
    if (!view || !(view.width > 0 && view.height > 0)) {
      // A main-owned view is kept at zero size until the shell places it: there is nothing to photograph.
      throw driverError('UNAVAILABLE', 'The page has no visible viewport to capture.', { detail: 'NOT_CAPTURABLE' });
    }
    return view;
  }

  async _shoot(view, region) {
    const epoch = this.documentEpoch;
    let hidden = false;
    if (this.owner !== 'none') hidden = await this._setBadgeVisibility(false);
    try {
      const image = await (region ? this._wc.capturePage(region) : this._wc.capturePage());
      const bytes = image && !(typeof image.isEmpty === 'function' && image.isEmpty()) ? image.toPNG() : null;
      if (!bytes || !bytes.length) throw driverError('UNAVAILABLE', 'The page returned no pixels (hidden or zero-sized view).', { detail: 'CAPTURE_EMPTY' });
      if (this.documentEpoch !== epoch) throw driverError('STALE_REF', 'The document changed during the capture.', { detail: 'STALE_DOCUMENT' });
      return {
        bytes,
        meta: {
          url: clipText(this.url(), obs.LIMITS.urlChars), documentEpoch: this.documentEpoch,
          viewport: { width: view.width, height: view.height },
          scale: view.scale || 1, scroll: { x: view.scrollX, y: view.scrollY }, clip: region,
          capturedAt: new Date().toISOString(), transformed: false,
        },
      };
    } finally { if (hidden) await this._setBadgeVisibility(true); }
  }

  // capturePage copies the last frame the compositor PRESENTED, so after hiding the badge the driver waits until a
  // frame without it has been produced (two animation frames, bounded) before any pixels are taken.
  async _setBadgeVisibility(visible) {
    try {
      const ctx = await this._world();
      const r = await this._send('Runtime.callFunctionOn', { executionContextId: ctx, returnByValue: true, awaitPromise: true,
        functionDeclaration: `function(){
          var b = document.querySelector('[data-caos="agent-badge"]');
          if (!b) return false;
          b.style.visibility = ${visible ? "''" : "'hidden'"};
          if (${visible ? 'true' : 'false'}) return true;
          return new Promise(function (resolve) {
            var done = false;
            var finish = function () { if (!done) { done = true; resolve(true); } };
            setTimeout(finish, 500);
            requestAnimationFrame(function () { requestAnimationFrame(finish); });
          });
        }` });
      return this._unwrap(r) === true;
    } catch (_e) { return false; }
  }

  async highlight(refId, label) {
    const ref = this._refs.get(refId);
    if (!ref || ref.dead) throw driverError('STALE_REF', 'Reference is not valid.', { detail: ref ? ref.dead : 'REF_UNKNOWN' });
    this._sameEpoch(ref);
    return this._probe('highlight', { label }, ref);
  }

  async clearHighlight() { return this._probe('clearHighlight', {}); }

  async setOwnerBadge(owner) {
    if (!OWNERS.includes(owner)) throw driverError('UNSUPPORTED', 'Unknown owner.', { detail: 'OWNER_INVALID' });
    this.owner = owner;
    await this._applyBadge();
  }

  async _applyBadge() {
    if (this.state === 'closed' || this.state === 'crashed') return;
    try { await this._probe('setBadge', { owner: this.owner }); } catch (_e) { /* cosmetic; the trusted shell shows ownership */ }
  }

  async badgeState() { return this._probe('badgeState', {}); }

  // ---- teardown -----------------------------------------------------------------------------------------------------------------
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._invalidateRefs('PAGE_DISPOSED');
    this._refs.clear();
    for (const [event, handler] of Object.entries(this._on)) {
      try { this._wc.removeListener(event, handler); } catch (_e) { /* destroyed */ }
    }
    this._dropLease();
  }

  detachFromSession() {
    this._invalidateRefs('SESSION_CLOSED');
    this._refs.clear();
    this._snapshots.clear();
    this._dropLease();
  }

  async close() {
    // The guest belongs to Electron / the renderer: the driver only lets go of it.
    this.dispose();
  }
}

const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

// Driver-authored bodies for Runtime.callFunctionOn on a ref'd <select> (`this`); `a` is the only argument.
// PLAN reads only. An option matches by exact value; if no value matches, by exact label. Anything but exactly one
// enabled match is reported, never resolved by picking the first.
const SELECT_PLAN = `
  if (this.multiple) return { ok: false, reason: 'multiple' };
  var opts = Array.prototype.slice.call(this.options || []);
  if (opts.length > 5000) return { ok: false, reason: 'too-many-options' };
  var hit = [];
  for (var i = 0; i < opts.length; i++) if (opts[i].value === a) hit.push(i);
  if (!hit.length) for (var j = 0; j < opts.length; j++) if (String(opts[j].label) === a) hit.push(j);
  if (hit.length !== 1) return { ok: false, reason: hit.length ? 'ambiguous' : 'not-found', matches: hit.length };
  var o = opts[hit[0]];
  var group = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
  if (o.disabled || (group && group.disabled)) return { ok: false, reason: 'disabled' };
  return { ok: true, index: hit[0], value: String(o.value), label: String(o.label) };`;
// APPLY re-checks that the planned option is still the same one, selects exactly it, and reads the selection back.
const SELECT_APPLY = `
  var opts = Array.prototype.slice.call(this.options || []);
  var o = opts[a.index];
  var group = o && o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
  if (!o || String(o.value) !== a.value || String(o.label) !== a.label || o.disabled || (group && group.disabled) || this.disabled) return { ok: false };
  var before = opts.map(function (x) { return x.selected === true; });
  if (typeof this.focus === 'function') this.focus();
  for (var i = 0; i < opts.length; i++) { var want = i === a.index; if (opts[i].selected !== want) opts[i].selected = want; }
  var changed = false;
  for (var k = 0; k < opts.length; k++) if ((opts[k].selected === true) !== before[k]) changed = true;
  if (changed) {
    var E = this.ownerDocument.defaultView.Event;
    this.dispatchEvent(new E('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new E('change', { bubbles: true }));
  }
  var values = [];
  for (var m = 0; m < opts.length; m++) if (opts[m].selected === true) values.push(String(opts[m].value));
  return { ok: true, changed: changed, values: values };`;

function selectRefusal(reason, matches) {
  if (reason === 'ambiguous') {
    return driverError('AMBIGUOUS_TARGET', `${Number(matches) || 'Several'} options match that value; refusing to guess.`, { detail: 'OPTION_AMBIGUOUS' });
  }
  if (reason === 'disabled') return driverError('UNAVAILABLE', 'That option is disabled.', { detail: 'OPTION_DISABLED' });
  if (reason === 'too-many-options') return driverError('UNSUPPORTED', 'The list has too many options.', { detail: 'SELECT_UNSUPPORTED' });
  if (reason === 'multiple') return driverError('UNSUPPORTED', 'Multiple-selection lists are not supported.', { detail: 'SELECT_UNSUPPORTED' });
  return driverError('UNAVAILABLE', 'No option has that value or label.', { detail: 'OPTION_NOT_FOUND' });
}

function countFrames(tree) {
  let n = 1;
  for (const child of (tree && tree.childFrames) || []) n += countFrames(child);
  return n;
}

class ElectronSession {
  constructor(driver, { onPageEvent }) {
    this.driver = driver;
    this.mode = 'visible';
    this.pages = new Map();
    this.limits = Object.freeze({ maxNodes: obs.LIMITS.maxNodes, maxBytes: obs.LIMITS.maxBytes, refTtlMs: REF_TTL_MS });
    this.capabilities = Object.freeze(ElectronDriver.describe());
    this._onPageEvent = typeof onPageEvent === 'function' ? onPageEvent : () => {};
    this._closed = false;
  }

  _emitPageEvent(event) { try { this._onPageEvent(event); } catch (_e) { /* listener errors never break the driver */ } }

  async newPage() {
    const create = this.driver._createGuest;
    if (typeof create !== 'function') {
      throw driverError('UNSUPPORTED', 'The embedded driver cannot create tabs yet (renderer owns <webview> lifetime).', { detail: 'NEW_PAGE_UNSUPPORTED' });
    }
    const wc = await create();
    return this.driver._pageFor(wc) || this.driver.registerGuestPage(wc);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    // Guests belong to Electron: let go of leases and refs, keep tracking lifecycle so a later open() works.
    for (const page of Array.from(this.pages.values())) page.detachFromSession();
    this.pages.clear();
    this.driver._session = null;
  }
}

class ElectronDriver {
  constructor(options) {
    const o = options || {};
    this.name = 'electron-embedded';
    this._debuggerBroker = o.debuggerBroker || null;
    this._createGuest = typeof o.createGuest === 'function' ? o.createGuest : null;
    this._guests = new Map(); // pageId -> ElectronPage (registered, whether or not a session is open)
    this._byWc = new WeakMap();
    this._session = null;
    this.clampViewBounds = clampViewBounds;
  }

  // Conservative. Three things were confirmed against real Electron (test/agent-runtime/drivers/electron.native.test.js:
  // a WebContentsView and a <webview>, Linux under Xvfb): open shadow roots, the `select` action and screenshots.
  // "needs native confirmation" still applies to every OTHER true flag here (their unit tests use fakes).
  static describe() {
    return {
      driver: 'electron-embedded',
      version: DRIVER_VERSION,
      dom: true,
      frames: false, // OOPIF / child-session routing must pass its own native tests first
      shadowDom: true, // OPEN roots only (the shared probe); closed roots are reported as a limitation
      canvas: false,
      popups: false, // main denies guest popups (web-contents-created) until managed popups exist
      downloads: false,
      uploads: false,
      dialogs: false,
      permissions: false,
      screenshots: true, // wc.capturePage: viewport, a clip inside it, or one observed element that fits in it
      viewport: false, // a guest <webview> is sized by the app window; no emulated viewport in this driver
      humanHandoff: 'native',
      liveModeSwitch: false,
      modes: ['visible'],
      actions: ACTIONS.slice(),
      assertions: ['visible', 'text', 'exists', 'count', 'url'],
      notes: {
        status: 'shadowDom, select and screenshots were confirmed on real Electron (Linux, Xvfb); every other flag still needs native confirmation',
        frames: 'main frame only; child frames are reported as unavailable',
        shadowDom: 'open-only',
        select: 'native single <select> only; the option is set by exact value (else exact label) and input+change are script-made events; zero or several matching options are refused',
        screenshots: 'pixels at the device scale; an element must fit inside the viewport; a zero-sized or hidden view is refused',
      },
    };
  }

  capabilities() { return ElectronDriver.describe(); }

  _debugger() {
    if (!this._debuggerBroker) this._debuggerBroker = require('../debugger-broker').getSharedBroker();
    return this._debuggerBroker;
  }

  // Wire a HOST webContents (the app window): every <webview> guest that attaches is registered.
  // Call from the main process, e.g. inside app.on('web-contents-created'):
  //   driver.watchHost(contents)
  // Returns an unsubscribe function.
  watchHost(host) {
    const onAttach = (_event, guest) => { try { this.registerGuest(guest, { ownerLabel: 'webview' }); } catch (_e) { /* not a usable guest */ } };
    host.on('did-attach-webview', onAttach);
    return () => { try { host.removeListener('did-attach-webview', onAttach); } catch (_e) { /* destroyed */ } };
  }

  // Register an attached guest. Returns its opaque pageId (idempotent per webContents).
  registerGuest(wc, meta) {
    if (!isWebContentsLike(wc)) throw driverError('UNSUPPORTED', 'Not a guest webContents.', { detail: 'GUEST_INVALID' });
    const existing = this._byWc.get(wc);
    if (existing && !existing.closed) return existing.pageId;
    return this.registerGuestPage(wc, meta).pageId;
  }

  registerGuestPage(wc, meta) {
    // A registry-only shell session is used until open(); pages always point at the live session when one exists.
    const holder = this._session || this._shell || (this._shell = new ElectronSession(this, {}));
    const page = new ElectronPage(holder, wc, meta);
    this._byWc.set(wc, page);
    this._guests.set(page.pageId, page);
    if (this._session) {
      this._session.pages.set(page.pageId, page);
      this._session._emitPageEvent({ type: 'page', pageId: page.pageId, openerPageId: null });
    }
    return page;
  }

  _pageFor(wc) { return this._byWc.get(wc) || null; }

  _forgetGuest(page) {
    this._guests.delete(page.pageId);
    if (this._session) this._session.pages.delete(page.pageId);
    page.dispose();
  }

  unregisterGuest(idOrWc) {
    const page = typeof idOrWc === 'string' ? this._guests.get(idOrWc) : this._byWc.get(idOrWc);
    if (page) this._forgetGuest(page);
    return !!page;
  }

  guestPageIds() { return Array.from(this._guests.keys()); }

  async open(options) {
    const o = options || {};
    if (o.mode && o.mode !== 'visible') {
      throw driverError('UNSUPPORTED', 'The embedded driver is visible-only (no headless mode).', { detail: 'UNSUPPORTED_MODE' });
    }
    if (o.profile != null && o.profile !== 'default-embedded' && o.profile !== 'ephemeral') {
      throw driverError('UNSUPPORTED', 'The embedded driver uses the app\'s own browser profile.', { detail: 'PROFILE_UNSUPPORTED' });
    }
    if (this._session) {
      throw driverError('UNAVAILABLE', 'An embedded session is already open.', { detail: 'SESSION_EXISTS' });
    }
    const session = new ElectronSession(this, { onPageEvent: o.onPageEvent });
    this._session = session;
    for (const page of this._guests.values()) {
      page.session = session;
      session.pages.set(page.pageId, page);
    }
    if (o.pageId && !session.pages.has(o.pageId)) {
      this._session = null;
      throw driverError('STALE_REF', 'That guest is not registered.', { detail: 'PAGE_UNKNOWN' });
    }
    if (session.pages.size === 0) {
      this._session = null;
      throw driverError('UNAVAILABLE', 'No embedded browser tab is registered.', { detail: 'NO_GUESTS', retry: true });
    }
    if (o.pageId) {
      // Initial page first, so `pages.values().next()` is the requested one.
      const first = session.pages.get(o.pageId);
      session.pages.delete(o.pageId);
      const rest = Array.from(session.pages.entries());
      session.pages.clear();
      session.pages.set(first.pageId, first);
      for (const [k, v] of rest) session.pages.set(k, v);
    }
    return session;
  }
}

function createElectronDriver(options) { return new ElectronDriver(options); }

module.exports = { createElectronDriver, ElectronDriver, ElectronPage, ElectronSession, clampViewBounds, DRIVER_VERSION };
