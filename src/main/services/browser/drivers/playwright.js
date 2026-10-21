'use strict';
// Playwright driver: true headless or visible Chromium behind the DriverSession /
// DriverPage interface of docs/AGENT_RUNTIME_CONTRACT.md.
//
// Generalised from the audit's createPlaywrightSession (bootstrap) and
// createObservedButtonRuntime (observed-ref action slice):
//   * `mode` is chosen at launch ('headless' | 'visible'). There is NO setHeadless.
//   * chromiumSandbox:true. acceptDownloads:false unless a download grant is
//     passed at open(). Permissions default-deny (Playwright's
//     --deny-permission-prompts + an empty grant list). Never force:true.
//   * Refs are server-side: { ElementHandle, fingerprint, scope, expiry }. The
//     agent only ever holds an opaque refId. A ref is never re-resolved by
//     selector, never `.first()`: duplicates are reported AMBIGUOUS_TARGET.
//   * Every action runs: scope/epoch check -> live describe (connected,
//     fingerprint, uniqueness, secret) -> real-Playwright trial click
//     (actionability, no dispatch) -> control.beforeDispatch() -> exactly one
//     dispatch. beforeDispatch() is NOT an atomic DOM-version lock (audit): the
//     handle + fingerprint + epoch narrow the window, they do not close it.
//   * Any frame navigation (document, same-document/SPA, sub-frame) or frame
//     detach bumps documentEpoch and invalidates every ref (conservative).
//   * Dialogs are observed, never blanket-accepted: the default is DISMISS after a
//     short deadline unless the broker decides explicitly via resolveDialog().
//   * Cross-origin frames are reported with their own frameId/origin; they are
//     never flattened into top-level refs.
//
// Page content is untrusted: everything read from the page is bounded and
// sanitised by drivers/observe.js before leaving this module.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const probe = require('../../../../webview/probe');
const obs = require('./observe');

const { driverError, clipText, fingerprintOf, parseKey, validateNavigationUrl, normalizeFocus } = obs;

const DRIVER_VERSION = '1.0.0';
const MODES = Object.freeze(['headless', 'visible']);
const ACTIONS = Object.freeze(['click', 'fill', 'press', 'select', 'check', 'navigate']);
const OWNERS = Object.freeze(['agent', 'human', 'quarantined', 'none']);
const REF_TTL_MS = 60000;
const MAX_REFS = 600;
const NOOP_CONTROL = Object.freeze({ check() {}, beforeDispatch() {}, signal: null });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(String(err.message)));
}

function isGone(err) {
  return /Execution context was destroyed|Target (page, context or browser )?has been closed|Frame was detached|Element is not attached|detached|Cannot find context|Session closed/i
    .test(String((err && err.message) || err));
}

// Map Playwright's actionability failure to a driver-authored reason (never page text).
function actionabilityReason(err) {
  const m = String((err && err.message) || err);
  if (/intercepts pointer events/i.test(m)) return 'covered';
  if (/not enabled/i.test(m)) return 'disabled';
  if (/not visible/i.test(m)) return 'not-visible';
  if (/not stable/i.test(m)) return 'not-stable';
  if (/outside of the viewport/i.test(m)) return 'outside-viewport';
  if (/not editable|readonly/i.test(m)) return 'not-editable';
  return 'not-actionable';
}

class PlaywrightPage extends EventEmitter {
  constructor(session, raw) {
    super();
    this.pageId = rid('pg');
    this.session = session;
    this.openerPageId = null;
    this.documentEpoch = 0;
    this.state = 'ready'; // ready | crashed | closed
    this.owner = 'agent';
    this._raw = raw;
    this._opts = session._opts;
    this._refs = new Map();
    this._issued = [];
    this._snapshots = new obs.SnapshotStore();
    this._frameIds = new WeakMap();
    this._dialogs = [];
    this._pendingDialog = null;
    this._dialogWaiters = new Set();
    this._lane = Promise.resolve();
    this._barrier = null;
    this._ready = Promise.resolve();
    this._disposed = false;
    this._wire();
  }

  // ---- identity ---------------------------------------------------------
  // Chromium's own error document (failed / blocked navigation) is reported as about:blank: it carries no remote
  // content, and the broker's destination policy must not mistake it for a destination.
  url() {
    const u = this._raw.url();
    return u.startsWith('chrome-error:') ? 'about:blank' : u;
  }

  // The broker subscribes to `driverPage.events` (navigated | crashed | closed | popup | download | dialog).
  get events() { return this; }

  get closed() { return this.state === 'closed' || this._raw.isClosed(); }

  _frameId(frame) {
    let id = this._frameIds.get(frame);
    if (!id) { id = rid('fr'); this._frameIds.set(frame, id); }
    return id;
  }

  _assertUsable() {
    if (this.state === 'crashed') throw driverError('UNAVAILABLE', 'The page crashed.', { detail: 'PAGE_CRASHED' });
    if (this.closed) throw driverError('UNAVAILABLE', 'The page is closed.', { detail: 'PAGE_CLOSED' });
  }

  // ---- lifecycle wiring ---------------------------------------------------
  _wire() {
    const raw = this._raw;
    this._on = {
      framenavigated: (frame) => {
        this._bumpEpoch('navigated');
        const main = frame === raw.mainFrame();
        // `url` is always the PAGE url: the broker runs its destination policy on it. A sub-frame's own
        // URL (possibly another origin) travels separately as `frameUrl`.
        this.emit('navigated', { documentEpoch: this.documentEpoch, url: this.url(), frameUrl: main ? undefined : clipText(frame.url(), 512), frameId: this._frameId(frame), mainFrame: main });
        this._emitSession({ type: 'navigated', documentEpoch: this.documentEpoch, mainFrame: main });
      },
      framedetached: () => {
        this._bumpEpoch('frame-detached');
        this.emit('navigated', { documentEpoch: this.documentEpoch, url: this.url(), mainFrame: false, kind: 'frame-detached' });
        this._emitSession({ type: 'navigated', documentEpoch: this.documentEpoch, mainFrame: false });
      },
      domcontentloaded: () => { this._reapplyBadge(); },
      crash: () => {
        this.state = 'crashed';
        this._invalidateRefs('PAGE_CRASHED');
        this.emit('crashed', {});
        this._emitSession({ type: 'crashed' });
      },
      close: () => {
        this.state = 'closed';
        this._invalidateRefs('PAGE_CLOSED');
        this._settleDialog('dismiss', 'page-closed');
        this._ready.then(() => {
          this.emit('closed', {});
          this._emitSession({ type: 'closed' });
          this.session._forget(this);
        });
      },
      dialog: (dialog) => this._onDialog(dialog),
      download: (download) => this._onDownload(download),
      filechooser: () => {
        // Observed only. Uploads need an owner-selected artifact capability (not implemented);
        // having a listener also keeps a native picker from opening in visible mode.
        this.emit('filechooser', { pageId: this.pageId });
        this._emitSession({ type: 'filechooser' });
      },
    };
    for (const [event, handler] of Object.entries(this._on)) raw.on(event, handler);
  }

  _emitSession(event) {
    this.session._emitPageEvent({ pageId: this.pageId, ...event });
  }

  _bumpEpoch() {
    this.documentEpoch += 1;
    this._invalidateRefs('STALE_DOCUMENT');
    this._snapshots.clear();
  }

  _invalidateRefs(reason) {
    for (const ref of this._refs.values()) this._killRef(ref, reason);
  }

  _killRef(ref, reason) {
    if (!ref.dead) {
      ref.dead = reason;
      if (ref.handle) { ref.handle.dispose().catch(() => {}); ref.handle = null; }
    }
  }

  _gcRefs() {
    const now = Date.now();
    for (const [id, ref] of this._refs) {
      if (ref.dead && now - (ref.diedAt || (ref.diedAt = now)) > 30000) this._refs.delete(id);
      else if (!ref.dead && now > ref.expiresAt) this._killRef(ref, 'REF_EXPIRED');
    }
    while (this._refs.size >= MAX_REFS) {
      const oldest = this._refs.keys().next().value;
      this._killRef(this._refs.get(oldest), 'REF_EVICTED');
      this._refs.delete(oldest);
    }
  }

  // ---- dialogs ------------------------------------------------------------
  _onDialog(dialog) {
    const rec = { id: rid('dlg'), type: dialog.type(), message: clipText(dialog.message(), 300),
      openedAt: new Date().toISOString(), state: 'open', decision: null, handledBy: null };
    this._dialogs.push(rec);
    if (this._dialogs.length > 20) this._dialogs.shift();
    this._pendingDialog = { rec, dialog, timer: null };
    this._pendingDialog.timer = setTimeout(() => this._settleDialog('dismiss', 'policy-deadline'),
      this._opts.dialogDeadlineMs);
    for (const w of this._dialogWaiters) w(rec);
    this._dialogWaiters.clear();
    this.emit('dialog', { ...rec });
    this._emitSession({ type: 'dialog', dialog: { ...rec } });
  }

  _settleDialog(decision, handledBy) {
    const pending = this._pendingDialog;
    if (!pending) return false;
    this._pendingDialog = null;
    clearTimeout(pending.timer);
    pending.rec.state = 'closed';
    pending.rec.decision = decision;
    pending.rec.handledBy = handledBy;
    const done = decision === 'accept' ? pending.dialog.accept() : pending.dialog.dismiss();
    Promise.resolve(done).catch(() => {}).then(() => {
      this.emit('dialog', { ...pending.rec });
      this._emitSession({ type: 'dialog', dialog: { ...pending.rec } });
    });
    return true;
  }

  // The ONLY way a dialog is accepted. The broker calls this after policy + (if needed)
  // a trusted-UI approval. Pages cannot reach it.
  resolveDialog(dialogId, decision) {
    if (decision !== 'accept' && decision !== 'dismiss') {
      throw driverError('UNSUPPORTED', 'Dialog decision must be accept or dismiss.', { detail: 'DIALOG_DECISION' });
    }
    if (!this._pendingDialog || this._pendingDialog.rec.id !== dialogId) {
      throw driverError('STALE_REF', 'That dialog is no longer open.', { detail: 'DIALOG_GONE' });
    }
    return this._settleDialog(decision, 'broker');
  }

  pendingDialog() { return this._pendingDialog ? { ...this._pendingDialog.rec } : null; }

  dialogs() { return this._dialogs.map((d) => ({ ...d })); }

  // ---- downloads ------------------------------------------------------------
  async _onDownload(download) {
    const grant = this.session._downloadGrant;
    const rec = { id: rid('dl'), filename: obs.sanitizeFilename(download.suggestedFilename()), state: 'started',
      origin: obs.originOf(download.url()), reason: null, bytes: null, sha256: null };
    const emit = (extra) => {
      Object.assign(rec, extra);
      this.emit('download', { ...rec });
      this._emitSession({ type: 'download', download: { ...rec } });
    };
    emit({});
    if (!grant) {
      await download.cancel().catch(() => {});
      emit({ state: 'rejected', reason: 'not-granted' });
      return;
    }
    try {
      const failure = await download.failure();
      if (failure) { emit({ state: 'failed', reason: clipText(failure, 60) }); return; }
      const file = await download.path();
      const stat = await fs.promises.stat(file);
      if (stat.size > grant.maxBytes) {
        await fs.promises.rm(file, { force: true });
        emit({ state: 'rejected', reason: 'too-large', bytes: stat.size });
        return;
      }
      const hash = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
      this.session._downloads.set(rec.id, { file, bytes: stat.size, sha256: hash, filename: rec.filename });
      emit({ state: 'completed', bytes: stat.size, sha256: hash });
    } catch (err) {
      emit({ state: 'failed', reason: isGone(err) ? 'page-closed' : 'error' });
    }
  }

  // ---- navigation -------------------------------------------------------------
  async navigate(url, { signal, timeoutMs } = {}) {
    this._assertUsable();
    const target = validateNavigationUrl(url);
    if (signal && signal.aborted) return { outcome: 'cancelled', url: this.url() };
    // Only yield when a prior operation is still in flight, so the barrier below is installed
    // synchronously for the common case (a following act() then waits for this navigation).
    if (this._barrier) await this._awaitBarrier();
    const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || this._opts.navigationTimeoutMs));
    let aborted = false;
    let onAbort;
    const abortP = new Promise((resolve) => {
      if (!signal) return;
      onAbort = () => { aborted = true; resolve({ outcome: 'cancelled' }); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const started = Date.now();
    const attemptGoto = (budget) => this._raw.goto(target, { waitUntil: 'load', timeout: budget });
    const gotoP = attemptGoto(timeout)
      .catch(async (err) => {
        // A failed navigation commits Chromium's error page a moment LATER; a goto issued in that window is
        // reported as "interrupted by another navigation to chrome-error://". That is the previous failure
        // landing, not a failure of this navigation: let the error page settle and issue it once more.
        if (!aborted && /interrupted by another navigation/i.test(String((err && err.message) || ''))) {
          await this._settleErrorPage();
          const left = timeout - (Date.now() - started);
          if (left > 500) return attemptGoto(left);
        }
        throw err;
      })
      .then((response) => ({ outcome: 'ready', status: response ? response.status() : null }))
      .catch(async (err) => {
        if (aborted) return { outcome: 'cancelled' };
        if (isTimeout(err)) return { outcome: 'timeout' };
        const m = /net::(ERR_[A-Z_]+)/.exec(String((err && err.message) || ''));
        // Let the error page commit now so it cannot interrupt the NEXT navigation.
        if (m) await this._settleErrorPage();
        return { outcome: 'failed', error: m ? m[1] : 'NAVIGATION_FAILED' };
      });
    // A deadline is a result deadline, not proof the browser stopped: keep the
    // in-flight navigation as a barrier so the next operation waits for it.
    this._barrier = gotoP.then(() => {}, () => {});
    try {
      const result = await Promise.race([gotoP, abortP]);
      if (result.outcome === 'timeout' || result.outcome === 'cancelled') {
        // A deadline is a result deadline, not proof the load stopped: ask the browser to stop it so a late
        // commit cannot change the document after the caller was told otherwise. Best effort; the barrier
        // and the epoch bump on commit still protect correctness if this does not win the race.
        await this._stopLoading();
      }
      return { ...result, url: this.url() };
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  // Page.stopLoading cancels the in-flight navigation (window.stop() does not reliably, and Chromium
  // dedupes a re-navigation to the exact URL of a still-pending one into ERR_ABORTED).
  async _stopLoading() {
    const stop = async () => {
      const cdp = await this._raw.context().newCDPSession(this._raw);
      try { await cdp.send('Page.stopLoading'); } finally { await cdp.detach().catch(() => {}); }
    };
    await Promise.race([stop().catch(() => {}), sleep(1000)]);
  }

  async _settleErrorPage() {
    const end = Date.now() + 1500;
    while (Date.now() < end && !this._raw.isClosed()) {
      if (this._raw.url().startsWith('chrome-error://')) return;
      await sleep(25);
    }
  }

  async _awaitBarrier() {
    const b = this._barrier;
    if (!b) return;
    await Promise.race([b, sleep(this._opts.navigationTimeoutMs)]);
    if (this._barrier === b) this._barrier = null;
  }

  // ---- observation ----------------------------------------------------------------
  _frames() {
    const main = this._raw.mainFrame();
    const list = [];
    const queue = [{ frame: main, parent: null }];
    let capped = false;
    while (queue.length) {
      const { frame, parent } = queue.shift();
      if (list.length >= obs.LIMITS.maxFrames) { capped = true; break; }
      const origin = obs.originOf(frame.url());
      const topOrigin = obs.originOf(main.url());
      list.push({
        frame,
        frameId: this._frameId(frame),
        parentFrameId: parent ? this._frameId(parent) : null,
        origin,
        crossOrigin: !!(parent && origin && topOrigin && origin !== topOrigin),
        isMain: frame === main,
      });
      for (const child of frame.childFrames()) queue.push({ frame: child, parent: frame });
    }
    return { list, capped };
  }

  async _collectFrame(info, { offset, max, focus }) {
    const container = await info.frame.evaluateHandle(probe.run, { cmd: 'collect', args: { offset, max, focus } });
    try {
      const meta = await container.evaluate((o) => ({ items: o.items, total: o.total, stats: o.stats }));
      const elementsHandle = await container.getProperty('elements');
      const handles = [];
      try {
        const props = await elementsHandle.getProperties();
        for (let i = 0; i < meta.items.length; i += 1) handles[i] = null;
        for (const [k, h] of props) {
          const idx = Number(k);
          if (Number.isInteger(idx) && h.asElement()) handles[idx] = h.asElement(); else h.dispose().catch(() => {});
        }
      } finally { elementsHandle.dispose().catch(() => {}); }
      return { ...meta, handles };
    } finally { container.dispose().catch(() => {}); }
  }

  async observe({ maxNodes, focus, cursor, baseObservationId, maxBytes } = {}) {
    this._assertUsable();
    await this._awaitBarrier();
    const want = obs.clampNodes(maxNodes);
    const f = normalizeFocus(focus);
    const epoch0 = this.documentEpoch;
    const offset = cursor ? obs.decodeCursor(cursor, { epoch: epoch0, focus: f }).offset : 0;
    let collected = null;
    for (let attempt = 0; attempt < 3 && !collected; attempt += 1) {
      const startEpoch = this.documentEpoch;
      let attemptResult = null;
      try {
        attemptResult = await this._collectAll({ offset, want, focus: f });
      } catch (err) {
        if (this.documentEpoch !== startEpoch && isGone(err)) continue;
        if (isGone(err)) throw driverError('UNAVAILABLE', 'The page changed while it was observed.', { detail: 'DOCUMENT_UNSTABLE', retry: true });
        throw err;
      }
      if (this.documentEpoch !== startEpoch) {
        for (const e of attemptResult.entries) if (e.handle) e.handle.dispose().catch(() => {});
        continue;
      }
      collected = attemptResult;
    }
    if (!collected) throw driverError('UNAVAILABLE', 'The document kept changing; observe again.', { detail: 'DOCUMENT_UNSTABLE', retry: true });
    return this._assemble(collected, { offset, want, focus: f, cursorFocus: f, baseObservationId, maxBytes });
  }

  async _collectAll({ offset, want, focus }) {
    const { list, capped } = this._frames();
    const entries = [];
    const frames = [];
    const stats = { candidates: 0, candidatesCapped: false, structuresCapped: false, shadowRootsOpen: 0, possibleClosedShadowHosts: 0,
      canvases: 0, iframes: 0, framesCapped: capped, title: '' };
    let prefix = 0;
    try {
      for (const info of list) {
        const record = { frameId: info.frameId, parentFrameId: info.parentFrameId, origin: info.origin,
          crossOrigin: info.crossOrigin, nodes: 0, available: true };
        frames.push(record);
        const remaining = Math.max(0, want - entries.length);
        let res;
        try {
          res = await this._collectFrame(info, { offset: Math.max(0, offset - prefix), max: remaining, focus });
        } catch (err) {
          if (this.state !== 'ready' || this.closed) throw err;
          record.available = false;
          continue;
        }
        record.nodes = res.total;
        prefix += res.total;
        stats.candidates += res.stats.candidates;
        stats.candidatesCapped = stats.candidatesCapped || res.stats.candidatesCapped;
        stats.structuresCapped = stats.structuresCapped || res.stats.structuresCapped === true;
        stats.shadowRootsOpen += res.stats.shadowRootsOpen;
        stats.possibleClosedShadowHosts += res.stats.possibleClosedShadowHosts;
        stats.canvases += res.stats.canvases;
        stats.iframes += res.stats.iframes;
        if (info.isMain) stats.title = res.stats.title;
        res.items.forEach((item, i) => {
          const handle = item.hi >= 0 ? res.handles[item.hi] : null;
          entries.push({
            item,
            handle,
            frame: info.frame,
            frameId: info.isMain ? null : info.frameId,
            fingerprint: fingerprintOf(item),
            node: obs.publicNode(item, info.isMain ? null : info.frameId),
          });
          void i;
        });
        // unused handles (non-interactable items never have one)
        res.handles.forEach((h, idx) => {
          if (h && !res.items.some((it) => it.hi === idx)) h.dispose().catch(() => {});
        });
      }
    } catch (err) {
      for (const e of entries) if (e.handle) e.handle.dispose().catch(() => {});
      throw err;
    }
    return { entries, frames, stats, total: prefix };
  }

  _assemble(collected, { offset, want, focus, baseObservationId, maxBytes }) {
    this._gcRefs();
    const expiresAt = Date.now() + this._opts.refTtlMs;
    const refs = {
      mint: (e, observationId) => {
        if (!e.handle) return null;
        const refId = rid('r');
        const frameId = e.frameId || this._frameId(e.frame);
        this._refs.set(refId, {
          refId, handle: e.handle, frame: e.frame, frameId, fingerprint: e.fingerprint, key: e.key,
          role: e.node.role, secret: e.node.secret === true, ambiguous: e.node.ambiguous === true,
          scope: { pageId: this.pageId, documentEpoch: this.documentEpoch, frameId, observationId },
          observationIds: new Set([observationId]), expiresAt, dead: null,
        });
        e.handle = null; // ownership moved to the ref
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
      dispose: (e) => { if (e.handle) { e.handle.dispose().catch(() => {}); e.handle = null; } },
    };
    const result = obs.assembleObservation({
      pageId: this.pageId, documentEpoch: this.documentEpoch, url: this.url(), title: '',
      snapshots: this._snapshots, newId: rid, offset, want, focus, baseObservationId, maxBytes,
      extra: { pendingDialog: this.pendingDialog(), ownerBadge: this.owner },
    }, collected, refs);
    this._issued.push(result.observationId);
    if (this._issued.length > 64) this._issued.shift();
    return result;
  }

  // ---- refs -----------------------------------------------------------------------
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

  async _describe(ref) {
    try {
      return await ref.frame.evaluate(probe.run, { cmd: 'describe', args: { el: ref.handle } });
    } catch (err) {
      if (isGone(err)) throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' });
      throw err;
    }
  }

  _sameEpoch(ref) {
    if (ref.dead || ref.scope.documentEpoch !== this.documentEpoch || this.closed) {
      throw driverError('STALE_REF', 'The document changed.', { detail: 'STALE_DOCUMENT' });
    }
  }

  // Everything that must hold BEFORE any input is dispatched. Throws a driver error with
  // dispatched:false on every failure path. Returns { ref, live }.
  async _prepare(cmd, action, control, kind, printable) {
    const refId = action.refId || action.ref;
    if (typeof refId !== 'string') {
      throw driverError('UNSUPPORTED', 'This action needs a ref.', { detail: 'REF_REQUIRED' });
    }
    this.resolve(refId); // unknown / dead / expired -> STALE_REF
    const ref = this._refs.get(refId);
    // `cmd.documentEpoch` belongs to the broker's OwnedPage (it is checked by control.check()); the
    // driver's own epoch travels as `driverDocumentEpoch` (recorded when the ref was observed).
    if (cmd.driverDocumentEpoch !== undefined && cmd.driverDocumentEpoch !== null && cmd.driverDocumentEpoch !== this.documentEpoch) {
      throw driverError('STALE_REF', 'The document epoch changed.', { detail: 'STALE_DOCUMENT' });
    }
    this._sameEpoch(ref);
    if (cmd.observationId && this._issued.includes(cmd.observationId) && !ref.observationIds.has(cmd.observationId)) {
      throw driverError('STALE_REF', 'The reference belongs to a different observation.', { detail: 'WRONG_OBSERVATION' });
    }
    this._assertUsable();
    control.check();

    let live = await this._describe(ref);
    control.check(); this._sameEpoch(ref);
    this._assertLive(ref, live);
    if ((kind === 'fill' || (kind === 'press' && printable)) && (live.secret || ref.secret)) {
      throw driverError('DENIED', 'Secret fields (passwords, one-time codes, payment data) are never filled by an agent.',
        { detail: 'SECRET_FIELD' });
    }
    if (live.kind !== 'interactable') {
      throw driverError('UNSUPPORTED', 'Only interactive controls can be acted on (this node is observation-only).', { detail: 'NOT_INTERACTABLE' });
    }
    if ((live.traits || []).includes('file-input')) {
      throw driverError('UNSUPPORTED', 'File inputs are not supported (no native picker / upload capability).', { detail: 'UPLOAD_UNSUPPORTED' });
    }
    if (!live.rendered) throw driverError('UNAVAILABLE', 'The target is not visible.', { detail: 'NOT_ACTIONABLE', reason: 'not-visible' });
    if (!live.enabled) throw driverError('UNAVAILABLE', 'The target is disabled.', { detail: 'NOT_ACTIONABLE' });
    if (kind === 'fill' && !live.editable) throw driverError('UNAVAILABLE', 'The target is not an editable field.', { detail: 'NOT_EDITABLE' });
    if (kind === 'select' && live.tag !== 'select') throw driverError('UNSUPPORTED', 'Only native <select> elements are supported.', { detail: 'SELECT_UNSUPPORTED' });
    if (kind === 'check' && !['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(live.role)) {
      throw driverError('UNSUPPORTED', 'The target is not a checkable control.', { detail: 'CHECK_UNSUPPORTED' });
    }

    // Real Playwright actionability (visible, stable, enabled, receives events) WITHOUT dispatching.
    // May scroll the page. Never force:true.
    try {
      await ref.handle.click({ trial: true, timeout: this._opts.actionabilityTimeoutMs });
    } catch (err) {
      if (isGone(err)) throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' });
      const reason = actionabilityReason(err);
      throw driverError('UNAVAILABLE', `The target is not actionable (${reason}); nothing was dispatched.`,
        { detail: 'NOT_ACTIONABLE', retry: reason === 'not-stable' });
    }
    control.check(); this._sameEpoch(ref);
    live = await this._describe(ref);
    control.check(); this._sameEpoch(ref);
    this._assertLive(ref, live);
    return { ref, live };
  }

  _assertLive(ref, live) {
    if (!live.connected) throw driverError('STALE_REF', 'The target is no longer in the document.', { detail: 'NODE_DETACHED' });
    if (fingerprintOf({ tag: live.tag, role: live.role, type: live.type, name: live.name, ctx: live.ctx }) !== ref.fingerprint) {
      throw driverError('STALE_REF', 'The target changed since it was observed; observe again.', { detail: 'TARGET_CHANGED' });
    }
    if (live.dupCount > 1) {
      throw driverError('AMBIGUOUS_TARGET', `${live.dupCount} controls share this role and name; refusing to guess.`,
        { detail: 'AMBIGUOUS_TARGET' });
    }
  }

  // ---- actions ----------------------------------------------------------------------
  act(cmd, control) {
    const run = this._lane.then(() => this._act(cmd || {}, control || NOOP_CONTROL));
    this._lane = run.then(() => {}, () => {});
    return run;
  }

  async _act(cmd, control) {
    this._assertUsable();
    await this._awaitBarrier();
    const action = cmd.action || {};
    if (!ACTIONS.includes(action.kind)) {
      throw driverError('UNSUPPORTED', 'Unsupported action kind.', { detail: 'ACTION_UNSUPPORTED' });
    }
    const epochBefore = this.documentEpoch;
    if (action.kind === 'navigate') {
      const target = validateNavigationUrl(action.url);
      control.check();
      control.beforeDispatch();
      const nav = await this.navigate(target, { signal: control.signal || undefined, timeoutMs: action.timeoutMs });
      const sameOrigin = obs.originOf(nav.url) === obs.originOf(target) || target === 'about:blank';
      const evidence = [obs.evidence.navigation({ url: nav.url, outcome: nav.outcome, matches: nav.outcome === 'ready' && sameOrigin,
        fromEpoch: epochBefore, documentEpoch: this.documentEpoch })];
      if (nav.outcome === 'timeout' || nav.outcome === 'cancelled') {
        throw driverError(nav.outcome === 'timeout' ? 'TIMEOUT' : 'CANCELLED', `Navigation ${nav.outcome}.`,
          { dispatched: true, effectUnknown: true, detail: 'NAVIGATION_' + nav.outcome.toUpperCase() });
      }
      if (nav.outcome === 'failed') {
        throw driverError('UNAVAILABLE', 'Navigation failed.', { dispatched: true, detail: nav.error || 'NAVIGATION_FAILED' });
      }
      return this._finish(action, evidence, epochBefore, control, { navigateAction: true });
    }
    const printable = action.kind === 'press' ? parseKey(action.key).printable : false;
    if (action.kind === 'fill' && (typeof action.text !== 'string' || action.text.length > 10000)) {
      throw driverError('UNSUPPORTED', 'fill needs text (<= 10000 chars).', { detail: 'TEXT_INVALID' });
    }
    if (action.kind === 'select' && (typeof action.value !== 'string' || action.value.length > 500)) {
      throw driverError('UNSUPPORTED', 'select needs a value.', { detail: 'VALUE_INVALID' });
    }
    if (action.kind === 'check' && typeof action.checked !== 'boolean') {
      throw driverError('UNSUPPORTED', 'check needs a boolean.', { detail: 'CHECKED_INVALID' });
    }

    const { ref, live } = await this._prepare(cmd, action, control, action.kind, printable);
    if (action.kind === 'check' && live.role === 'radio' && action.checked === false) {
      throw driverError('UNSUPPORTED', 'A radio button cannot be unchecked directly.', { detail: 'CHECK_UNSUPPORTED' });
    }
    // Attest delivery for plain clicks: listen for the trusted click that reaches the exact target.
    const watch = action.kind === 'click'
      ? await ref.frame.evaluateHandle(probe.run, { cmd: 'watchClick', args: { el: ref.handle } }).catch(() => null)
      : null;
    control.beforeDispatch();
    const evidence = [];
    const opts = {};
    const timeout = this._opts.dispatchTimeoutMs;
    const dialogOpened = new Promise((resolve) => { this._dialogWaiters.add(resolve); });
    let op;
    switch (action.kind) {
      case 'click': op = ref.handle.click({ timeout }); break;
      case 'fill': op = ref.handle.fill(action.text, { timeout }); break;
      case 'press': op = ref.handle.press(action.key, { timeout }); break;
      case 'select': op = ref.handle.selectOption(action.value, { timeout }); break;
      default: op = ref.handle.setChecked(action.checked, { timeout }); break;
    }
    // Keep the underlying promise as a lane barrier even if we return early on a dialog.
    const settled = Promise.resolve(op).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    this._barrier = settled.then(() => {});
    const first = await Promise.race([settled, dialogOpened.then(() => ({ dialog: true }))]);
    this._dialogWaiters.clear();
    if (watch && (first.dialog || !first.ok)) {
      settled.then(() => watch.evaluate((r) => r.stop()).catch(() => {})).then(() => watch.dispose().catch(() => {}));
    }
    if (first.dialog) {
      const dlg = this.pendingDialog() || this._dialogs[this._dialogs.length - 1];
      evidence.push(obs.evidence.dialog(dlg && dlg.type, dlg && dlg.id, this.documentEpoch));
      opts.dialogOpened = true;
    } else if (!first.ok) {
      const e = first.e;
      throw driverError(isTimeout(e) ? 'TIMEOUT' : 'UNAVAILABLE',
        'Browser input failed after dispatch started; the effect is unknown.',
        { dispatched: true, effectUnknown: true, detail: isTimeout(e) ? 'DISPATCH_TIMEOUT' : 'DISPATCH_FAILED' });
    } else if (action.kind === 'click') {
      const seen = watch ? await watch.evaluate((r) => { const o = { n: r.n, trusted: r.trusted }; r.stop(); return o; }).catch(() => null) : null;
      if (watch) watch.dispose().catch(() => {});
      if (seen) evidence.push(obs.evidence.clicked(seen.trusted > 0, seen.trusted, this.documentEpoch));
    } else if (action.kind === 'fill') {
      const matches = await ref.handle.inputValue({ timeout: 500 }).then((v) => v === action.text, () => false);
      evidence.push(obs.evidence.value(matches, action.text.length, this.documentEpoch));
    } else if (action.kind === 'select') {
      const chosen = Array.isArray(first.v) ? first.v : [];
      evidence.push(obs.evidence.selected(chosen.includes(action.value), chosen.length, this.documentEpoch));
    } else if (action.kind === 'check') {
      const now = await ref.handle.isChecked({ timeout: 500 }).then((v) => v, () => null);
      evidence.push(obs.evidence.checked(now === action.checked, now, this.documentEpoch));
    }
    return this._finish(action, evidence, epochBefore, control, opts);
  }

  // Compose the driver result. 'verified' ONLY when a named, observable postcondition
  // produced evidence (readback or an `expect` assertion). Navigation/doc change is
  // reported as evidence, never silently as success.
  async _finish(action, evidence, epochBefore, control, opts) {
    const o = opts || {};
    const expectOutcome = action.expect && typeof action.expect === 'object' ? await this._pollExpect(action.expect, control) : null;
    return obs.composeResult({ evidence, expectOutcome, epochBefore, epochNow: this.documentEpoch, url: this.url(),
      dialogOpened: !!o.dialogOpened, navigateAction: !!o.navigateAction });
  }

  async _pollExpect(expect, control) {
    const timeoutMs = Math.max(0, Math.min(10000, Number(expect.timeoutMs) || 3000));
    const { timeoutMs: _t, ...assertion } = expect;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      last = await this.evaluateAssertion(assertion);
      if (last.status === 'passed') break;
      if (control && control.signal && control.signal.aborted) break;
      await sleep(40);
    } while (Date.now() < deadline);
    return { status: last.status, evidence: last.evidence[0] };
  }

  // ---- assertions (closed DSL, semantics from src/shared/assertions.js) -----------------
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
    if (!norm.ok) {
      return { status: 'failed', actual: '', evidence: [{ kind: 'exists', observed: false, status: 'failed', error: clipText(norm.error, 120), documentEpoch: this.documentEpoch }] };
    }
    const a = norm.assertion;
    const deadline = Date.now() + Math.max(0, Math.min(10000, timeoutMs));
    let result;
    for (;;) {
      const epoch = this.documentEpoch;
      try {
        this._assertUsable();
        const facts = { url: this.url() };
        if (a.kind !== 'url') {
          const raw = await this._raw.mainFrame().evaluate(probe.run, { cmd: 'assertFacts', args: locator ? { target: locator } : { selector: a.selector } });
          if (raw.error) {
            result = { status: 'failed', actual: '', evidence: evidenceOf(a, 'failed', '', { error: raw.error }) };
            break;
          }
          Object.assign(facts, raw);
        }
        if (this.documentEpoch !== epoch) throw driverError('STALE_REF', 'Document changed during assertion.', { detail: 'STALE_DOCUMENT' });
        const out = shared.evaluate(a, facts);
        result = { status: out.status, actual: out.actual, evidence: evidenceOf(a, out.status, out.actual) };
      } catch (err) {
        result = { status: 'unknown', actual: 'ENGINE_UNAVAILABLE',
          evidence: evidenceOf(a, 'unknown', 'ENGINE_UNAVAILABLE', { error: clipText(err && err.detail ? err.detail : 'ENGINE_ERROR', 60) }) };
      }
      if (result.status === 'passed' || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    return result;
  }

  // ---- viewport -------------------------------------------------------------------------------
  // Emulated window size. A resize re-evaluates layout and media queries, so it is a document-state change:
  // every ref and observation dies (epoch bump + 'navigated' kind:'viewport'), exactly like a navigation.
  setViewport(size, control) {
    const run = this._lane.then(() => this._setViewport(size || {}, control || NOOP_CONTROL));
    this._lane = run.then(() => {}, () => {});
    return run;
  }

  async _setViewport({ width, height }, control) {
    this._assertUsable();
    await this._awaitBarrier();
    for (const n of [width, height]) {
      if (!Number.isInteger(n) || n < obs.LIMITS.minViewport || n > obs.LIMITS.maxViewport) {
        throw driverError('UNSUPPORTED', `Viewport sizes must be integers ${obs.LIMITS.minViewport}..${obs.LIMITS.maxViewport}.`, { detail: 'INVALID_VIEWPORT' });
      }
    }
    control.check();
    control.beforeDispatch();
    try {
      await this._raw.setViewportSize({ width, height });
    } catch (err) {
      throw driverError(isTimeout(err) ? 'TIMEOUT' : 'UNAVAILABLE', 'Resizing the viewport failed after dispatch started; the effect is unknown.',
        { dispatched: true, effectUnknown: true, detail: 'VIEWPORT_FAILED' });
    }
    this._bumpEpoch();
    this.emit('navigated', { documentEpoch: this.documentEpoch, url: this.url(), mainFrame: true, kind: 'viewport' });
    this._emitSession({ type: 'navigated', documentEpoch: this.documentEpoch, mainFrame: true });
    // Read the size back from the engine AND from the page: only an observed match is "verified".
    const engine = this._raw.viewportSize() || { width: 0, height: 0 };
    const inner = await this._raw.mainFrame().evaluate(probe.run, { cmd: 'viewportInfo', args: {} }).catch(() => ({ width: 0, height: 0 }));
    const matches = engine.width === width && engine.height === height && inner.width === width && inner.height === height;
    return { status: matches ? 'verified' : 'dispatched', evidence: [obs.evidence.viewport(width, height, matches, this.documentEpoch)] };
  }

  // ---- screenshots / presentation -------------------------------------------------------------
  // Unmodified pixels of the viewport (or of one observed element via capture({ refId })). The agent badge is Braiwser
  // UI, not page content, and is hidden for the shot. Nothing is masked, annotated or resized: meta.transformed is false.
  async humanInput(input) {
    this._assertUsable();
    await this._awaitBarrier();
    const privateValues = [];
    let privateEditableFound = false;
    let privateCaptureComplete = true;
    const capturePrivate = async () => {
      if (!input.privateInput) return;
      try {
        for (const frame of this._raw.frames()) {
          const snapshot = await frame.evaluate(() => {
            const nodes = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')];
            const values = nodes.slice(0, 128).map(node => String(node.value ?? node.textContent ?? ''));
            return { values: values.map(value => value.slice(0, 4096)), complete: nodes.length <= 128 && values.every(value => value.length <= 4096) };
          });
          privateValues.push(...snapshot.values);
          privateEditableFound ||= snapshot.values.length > 0;
          privateCaptureComplete &&= snapshot.complete;
        }
      } catch { privateCaptureComplete = false; }
    };
    await capturePrivate();
    if (input.privateInput && ['text', 'key'].includes(input.kind) && !privateEditableFound) privateCaptureComplete = false;
    if (input.expectedDocumentEpoch !== undefined && input.expectedDocumentEpoch !== this.documentEpoch)
      throw driverError('STALE_REF', 'The document changed before human input dispatch.', { detail: 'STALE_DOCUMENT', dispatched: false, effectUnknown: false });
    const { kind, x, y, key, text, deltaX, deltaY } = input;
    const vp = this._raw.viewportSize();
    const bad = () => { throw driverError('UNSUPPORTED', 'Unsupported or invalid human input.'); };
    if (kind === 'click' || kind === 'move') {
      if (!vp || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= vp.width || y >= vp.height) bad();
      if (kind === 'click') await this._raw.mouse.click(x, y, { button: 'left', timeout: this._opts.dispatchTimeoutMs });
      else await this._raw.mouse.move(x, y);
    } else if (kind === 'text') {
      if (typeof text !== 'string' || text.length > 4096 || text.includes('\u0000')) bad();
      await this._raw.keyboard.insertText(text);
    } else if (kind === 'key') {
      if (!/^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(key || '')) bad();
      await this._raw.keyboard.press(key);
    } else if (kind === 'scroll') {
      if (![deltaX, deltaY].every((n) => Number.isFinite(n) && Math.abs(n) <= 4096)) bad();
      await this._raw.mouse.wheel(deltaX, deltaY);
    } else bad();
    await capturePrivate();
    return { dispatched: true, ...(input.privateInput ? { privateValues, privateCaptureComplete } : {}) };
  }

  async screenshot({ clip } = {}) {
    this._assertUsable();
    const vp = this._raw.viewportSize() || { width: 0, height: 0 };
    let region;
    if (clip) {
      const ok = ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(clip[k]))
        && clip.x >= 0 && clip.y >= 0 && clip.width > 0 && clip.height > 0
        && clip.x + clip.width <= vp.width && clip.y + clip.height <= vp.height;
      if (!ok) throw driverError('UNSUPPORTED', 'clip must lie inside the viewport.', { detail: 'CLIP_INVALID' });
      region = { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
    }
    return this._shoot(vp, region, (o) => this._raw.screenshot({ ...o, clip: region }));
  }

  // Evidence capture: the whole viewport, or the single element behind an observed ref (never a selector).
  async capture({ refId } = {}) {
    this._assertUsable();
    await this._awaitBarrier();
    const vp = this._raw.viewportSize() || { width: 0, height: 0 };
    if (!refId) return this._shoot(vp, undefined, (o) => this._raw.screenshot(o));
    this.resolve(refId); // unknown / dead / expired -> STALE_REF
    const ref = this._refs.get(refId);
    this._sameEpoch(ref);
    const live = await this._describe(ref);
    this._sameEpoch(ref);
    this._assertLive(ref, live);
    let box = null;
    try { box = await ref.handle.boundingBox(); } catch (err) { if (isGone(err)) throw driverError('STALE_REF', 'The target is gone.', { detail: 'NODE_DETACHED' }); throw err; }
    if (!box || !(box.width > 0 && box.height > 0)) throw driverError('UNAVAILABLE', 'The target has no visible box to capture.', { detail: 'NOT_CAPTURABLE' });
    const shot = await this._shoot(vp, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      (o) => ref.handle.screenshot({ ...o, timeout: this._opts.dispatchTimeoutMs * 3 }));
    this._sameEpoch(ref);
    return shot;
  }

  async _shoot(vp, region, take) {
    const main = this._raw.mainFrame();
    let hidden = false;
    if (this.session.mode === 'visible' && this.owner !== 'none') {
      hidden = await main.evaluate(() => {
        const b = document.querySelector('[data-caos="agent-badge"]');
        if (!b) return false;
        b.style.visibility = 'hidden';
        return true;
      }).catch(() => false);
    }
    try {
      const bytes = await take({ type: 'png', scale: 'css', animations: 'allow', caret: 'initial' });
      const view = await main.evaluate(probe.run, { cmd: 'viewportInfo', args: {} }).catch(() => ({ scrollX: 0, scrollY: 0, scale: 1 }));
      return {
        bytes,
        meta: {
          url: clipText(this.url(), obs.LIMITS.urlChars),
          documentEpoch: this.documentEpoch,
          viewport: { width: vp.width, height: vp.height },
          scale: this.session._opts.deviceScaleFactor,
          scroll: { x: view.scrollX, y: view.scrollY },
          clip: region || null,
          capturedAt: new Date().toISOString(),
          transformed: false,
        },
      };
    } finally {
      if (hidden) {
        await main.evaluate(() => {
          const b = document.querySelector('[data-caos="agent-badge"]');
          if (b) b.style.visibility = '';
        }).catch(() => {});
      }
    }
  }

  async highlight(refId, label) {
    const ref = this._refs.get(refId);
    if (!ref || ref.dead) throw driverError('STALE_REF', 'Reference is not valid.', { detail: ref ? ref.dead : 'REF_UNKNOWN' });
    this._sameEpoch(ref);
    // Only the referenced node, inside its owning frame.
    return ref.frame.evaluate(probe.run, { cmd: 'highlight', args: { el: ref.handle, label } });
  }

  async clearHighlight() {
    for (const info of this._frames().list) {
      await info.frame.evaluate(probe.run, { cmd: 'clearHighlight', args: {} }).catch(() => {});
    }
  }

  async setOwnerBadge(owner) {
    if (!OWNERS.includes(owner)) throw driverError('UNSUPPORTED', 'Unknown owner.', { detail: 'OWNER_INVALID' });
    this.owner = owner;
    await this._applyBadge();
  }

  async _applyBadge() {
    // Headless has no human watching, and an overlay would only contaminate screenshots.
    if (this.session.mode !== 'visible' || this.closed) return;
    await this._raw.mainFrame().evaluate(probe.run, { cmd: 'setBadge', args: { owner: this.owner } }).catch(() => {});
  }

  _reapplyBadge() {
    if (this.session.mode === 'visible' && this.owner !== 'none') this._applyBadge();
  }

  async badgeState() {
    return this._raw.mainFrame().evaluate(probe.run, { cmd: 'badgeState', args: {} });
  }

  // ---- teardown ---------------------------------------------------------------------------------
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._settleDialog('dismiss', 'dispose');
    this._invalidateRefs('PAGE_DISPOSED');
    this._refs.clear();
    for (const [event, handler] of Object.entries(this._on)) this._raw.off(event, handler);
  }

  async close() {
    // The raw 'close' event (our listener) emits 'closed' to the broker; only afterwards release resources.
    if (!this._raw.isClosed()) await this._raw.close({ runBeforeUnload: false }).catch(() => {});
    await this._ready;
    this.session._forget(this);
  }
}

class PlaywrightSession {
  constructor({ browser, context, mode, opts, onPageEvent, tmpDir, downloadGrant }) {
    this.driver = 'playwright';
    this.mode = mode;
    this.pages = new Map();
    this.limits = Object.freeze({ maxNodes: obs.LIMITS.maxNodes, maxBytes: obs.LIMITS.maxBytes, refTtlMs: opts.refTtlMs });
    this._browser = browser;
    this._context = context;
    this._opts = opts;
    this._onPageEvent = typeof onPageEvent === 'function' ? onPageEvent : () => {};
    this._byRaw = new Map();
    this._tmpDir = tmpDir;
    this._downloadGrant = downloadGrant;
    this._downloads = new Map();
    this._closed = false;
    this._initializing = true;
    this.capabilities = Object.freeze(PlaywrightDriver.describe(mode, !!downloadGrant));
    context.on('page', (raw) => this._register(raw));
    browser.on('disconnected', () => {
      if (this._closed) return;
      this._closed = true;
      for (const page of this.pages.values()) page.state = 'closed';
      this._emitPageEvent({ type: 'disconnected', pageId: null });
    });
  }

  _emitPageEvent(event) {
    try { this._onPageEvent(event); } catch (_e) { /* a listener must not break the driver */ }
  }

  _register(raw) {
    if (this._byRaw.has(raw)) return this._byRaw.get(raw);
    const page = new PlaywrightPage(this, raw);
    this._byRaw.set(raw, page);
    this.pages.set(page.pageId, page);
    if (!this._initializing) {
      page._ready = raw.opener().catch(() => null).then((opener) => {
        const parent = opener ? this._byRaw.get(opener) : null;
        page.openerPageId = parent ? parent.pageId : null;
        if (parent) {
          const info = { type: 'popup', pageId: page.pageId, openerPageId: parent.pageId, url: raw.url(), page, opener: parent };
          parent.emit('popup', info);
          this._emitPageEvent(info);
        } else {
          this._emitPageEvent({ type: 'page', pageId: page.pageId, openerPageId: null, page, opener: null });
        }
      });
    }
    return page;
  }

  _forget(page) {
    this.pages.delete(page.pageId);
    this._byRaw.delete(page._raw);
    page.dispose();
  }

  async newPage() {
    if (this._closed) throw driverError('UNAVAILABLE', 'The session is closed.', { detail: 'SESSION_CLOSED' });
    const raw = await this._context.newPage();
    return this._register(raw);
  }

  // Internal to the broker's evidence store: opaque id -> artifact. Never given to agents.
  takeDownload(downloadId) {
    const d = this._downloads.get(downloadId);
    return d ? { ...d } : null;
  }

  async close() {
    if (this._closed && !this._browser.isConnected()) return;
    this._closed = true;
    for (const page of Array.from(this.pages.values())) page.dispose();
    try { await this._context.close(); } catch (_e) { /* already closed */ }
    try { await this._browser.close(); } catch (_e) { /* already closed */ }
    if (this._tmpDir) await fs.promises.rm(this._tmpDir, { recursive: true, force: true }).catch(() => {});
    this.pages.clear();
  }
}

class PlaywrightDriver {
  constructor(options) {
    const o = options || {};
    this.name = 'playwright';
    this._playwright = o.playwright || null;
    this._executablePath = o.executablePath || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
    // Only the supervisor that owns the process can turn this off (never a tool argument). Inside a locked-down
    // container, running as root, Chromium cannot create its own sandbox; the container is the boundary there.
    this._chromiumSandbox = o.chromiumSandbox !== false;
    this._defaults = {
      actionabilityTimeoutMs: o.actionabilityTimeoutMs || 1500,
      dispatchTimeoutMs: o.dispatchTimeoutMs || 2000,
      navigationTimeoutMs: o.navigationTimeoutMs || 15000,
      dialogDeadlineMs: o.dialogDeadlineMs || 2000,
      refTtlMs: o.refTtlMs || REF_TTL_MS,
    };
  }

  // Flags are truthful: each one is backed by a real-browser test in
  // test/agent-runtime/drivers/playwright.real.test.js (see that file's names).
  static describe(mode, downloadsGranted) {
    return {
      driver: 'playwright',
      version: DRIVER_VERSION,
      dom: true,
      frames: true, // same-origin + cross-origin iframes: per-frame observation, frame-scoped refs
      shadowDom: true, // OPEN roots only; closed roots are reported as a limitation
      canvas: false, // canvases are reported + screenshot-able; no coordinate/pixel actions
      popups: true,
      downloads: !!downloadsGranted, // false => every download is cancelled and reported 'rejected'
      uploads: false,
      requestInterception: true, // honours open({ requestFilter }): every http(s) request incl. redirect hops
      dialogs: true, // observed; default policy DISMISS, accept only via resolveDialog()
      permissions: true, // default deny; no grant API exposed
      screenshots: true,
      viewport: true, // setViewport({ width, height }): emulated size, 240..4096, bumps the document epoch
      // headless: no remote-view transport exists. visible: a person operates the very same headed window
      // while the broker lease keeps the agent from dispatching (ownership enforcement is tested; a real
      // person at a real keyboard is not).
      humanHandoff: mode === 'visible' ? 'native' : 'unsupported',
      liveModeSwitch: false,
      modes: mode ? [mode] : MODES.slice(),
      actions: ACTIONS.slice(),
      assertions: ['visible', 'text', 'exists', 'count', 'url'],
      notes: {
        shadowDom: 'open-only',
        canvas: 'reported-as-limitation',
        downloads: downloadsGranted ? 'granted-for-this-session' : 'rejected-unless-granted-at-open',
        humanHandoff: 'visible: same headed window, ownership enforced by the broker lease; headless: unsupported (no remote view)',
        requestInterception: 'initial request of every http(s) fetch (navigation, frame, subresource). Redirect HOPS are not re-checked (Playwright does not route them); the broker still checks the page URL on arrival',
      },
    };
  }

  // `capabilities({ mode })` returns the mode-specific document (humanHandoff differs); with no
  // argument it is the conservative union over modes.
  capabilities(options) {
    const mode = options && MODES.includes(options.mode) ? options.mode : null;
    return PlaywrightDriver.describe(mode, false);
  }

  _pw() {
    if (!this._playwright) this._playwright = require('playwright-core');
    return this._playwright;
  }

  async open(options) {
    const o = options || {};
    const mode = o.mode || 'headless';
    if (!MODES.includes(mode)) throw driverError('UNSUPPORTED', 'mode must be headless or visible.', { detail: 'UNSUPPORTED_MODE' });
    if (o.profile != null && o.profile !== 'ephemeral') {
      throw driverError('UNSUPPORTED', 'Only isolated ephemeral profiles are supported.', { detail: 'PROFILE_UNSUPPORTED' });
    }
    const viewport = o.viewport || { width: 1280, height: 800 };
    for (const n of [viewport.width, viewport.height]) {
      if (!Number.isInteger(n) || n < 240 || n > 4096) throw driverError('UNSUPPORTED', 'Invalid viewport.', { detail: 'INVALID_VIEWPORT' });
    }
    const locale = o.locale || 'en-US';
    const timezoneId = o.timezoneId || 'UTC';
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw driverError('UNSUPPORTED', 'Invalid locale.', { detail: 'INVALID_LOCALE' });
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezoneId)) throw driverError('UNSUPPORTED', 'Invalid timezone.', { detail: 'INVALID_TIMEZONE' });
    const grant = o.downloads && o.downloads.granted === true
      ? { maxBytes: Math.max(1, Math.min(100 * 1024 * 1024, Number(o.downloads.maxBytes) || 10 * 1024 * 1024)) }
      : null;
    const dsf = Number(viewport.deviceScaleFactor);
    const opts = { ...this._defaults, deviceScaleFactor: Number.isFinite(dsf) && dsf >= 0.5 && dsf <= 4 ? dsf : 1 };
    if (Number.isFinite(o.dialogDeadlineMs)) opts.dialogDeadlineMs = Math.max(0, Math.min(10000, o.dialogDeadlineMs));

    const { chromium } = this._pw();
    const args = [];
    if (mode === 'visible' && o.window && Number.isInteger(o.window.x) && Number.isInteger(o.window.y)) {
      args.push(`--window-position=${o.window.x},${o.window.y}`);
    }
    if (!this._chromiumSandbox) args.push('--disable-dev-shm-usage');
    const browser = await chromium.launch({
      headless: mode === 'headless',
      chromiumSandbox: this._chromiumSandbox,
      args,
      ...(this._executablePath ? { executablePath: this._executablePath } : {}),
    });
    let context;
    let tmpDir = null;
    try {
      context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, locale, timezoneId, deviceScaleFactor: opts.deviceScaleFactor, colorScheme: 'light',
        acceptDownloads: !!grant, permissions: [], javaScriptEnabled: true,
      });
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(opts.navigationTimeoutMs);
      if (typeof o.requestFilter === 'function') {
        // Request-level policy: EVERY http(s) request the browser makes (navigations, redirect hops,
        // subresources, frames) is asked first. Default is block; a throwing filter blocks.
        // Not covered: WebSocket / WebRTC traffic and data:/blob: documents (no network request).
        await context.route('**/*', (route) => {
          let verdict = 'block';
          try { verdict = o.requestFilter(route.request().url(), { navigation: route.request().isNavigationRequest() }); } catch (_e) { verdict = 'block'; }
          return verdict === 'allow' ? route.continue() : route.abort('blockedbyclient');
        });
      }
      if (grant) tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'braiwser-dl-'));
      const session = new PlaywrightSession({ browser, context, mode, opts, onPageEvent: o.onPageEvent, tmpDir, downloadGrant: grant });
      const raw = await context.newPage();
      session._register(raw);
      session._initializing = false;
      return session;
    } catch (err) {
      if (context) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
}

function createPlaywrightDriver(options) { return new PlaywrightDriver(options); }

module.exports = { createPlaywrightDriver, PlaywrightDriver, PlaywrightPage, PlaywrightSession, parseKey,
  validateNavigationUrl, DRIVER_VERSION };
