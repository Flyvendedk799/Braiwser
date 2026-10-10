'use strict';
// Shared Chrome DevTools Protocol broker for guest webContents.
//
// Why: screenshot capture and the (upcoming) Electron input driver both need
// webContents.debugger. Electron allows ONE debugger client per webContents, and
// the debugger can detach under us at any time (DevTools opening, page crash,
// navigation to a process swap). Without a single owner, one feature detaches
// the other's session or a stale handle detaches a newer owner's attachment.
//
// Contract (no Electron import; works on any webContents-like object):
//   const broker = createDebuggerBroker();
//   const lease = broker.acquire(wc, { owner: 'capture', exclusive: true, allowBorrow: true });
//   await lease.send('Page.getLayoutMetrics');
//   lease.release();
//
// Rules:
//   * ONE attachment per webContents, shared by ref-counted leases. The broker
//     attaches on first lease and detaches when the last lease is released —
//     but ONLY if the broker itself performed the attach.
//   * If the debugger is already attached by someone else, acquire() throws
//     DEBUGGER_BUSY unless { allowBorrow: true }; a borrowed attachment is never
//     detached by us.
//   * { exclusive: true } refuses to share: fails DEBUGGER_BUSY while any other
//     lease exists, and blocks later leases until released (use for operations
//     that mutate page state, e.g. viewport emulation).
//   * A 'detach' event marks every live lease LOST. A lost lease rejects send()
//     with DRIVER_DISCONNECTED and its release() is a no-op: it can never detach
//     an attachment that a newer lease generation owns. Callers should treat
//     lost as "paused/disconnected": invalidate refs and re-observe.
//   * A stale lease (after loss) is never revived; acquire() again.

const DEFAULT_PROTOCOL = '1.3';

function brokerError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function createDebuggerBroker(options) {
  const protocolVersion = (options && options.protocolVersion) || DEFAULT_PROTOCOL;
  /** @type {WeakMap<object, Entry>} */
  const entries = new WeakMap();
  let leaseSeq = 0;

  function liveEntry(wc) {
    const e = entries.get(wc);
    return e && e.alive ? e : null;
  }

  function markLost(entry, reason) {
    if (!entry.alive) return;
    entry.alive = false;
    entry.detachFrom();
    if (entries.get(entry.wc) === entry) entries.delete(entry.wc);
    const leases = Array.from(entry.leases);
    entry.leases.clear();
    for (const lease of leases) lease._markLost(reason);
  }

  function createEntry(wc, ownsAttachment) {
    const dbg = wc.debugger;
    const entry = {
      wc,
      alive: true,
      ownsAttachment,
      leases: new Set(),
      detachFrom() {
        try { dbg.removeListener('detach', onDetach); } catch (_e) { /* ignore */ }
        if (typeof wc.removeListener === 'function') {
          try { wc.removeListener('destroyed', onDestroyed); } catch (_e) { /* ignore */ }
        }
      },
    };
    function onDetach(_event, reason) { markLost(entry, reason || 'detached'); }
    function onDestroyed() { markLost(entry, 'destroyed'); }
    dbg.on('detach', onDetach);
    if (typeof wc.once === 'function') wc.once('destroyed', onDestroyed);
    return entry;
  }

  class Lease {
    constructor(entry, opts) {
      this.id = ++leaseSeq;
      this.owner = opts.owner || 'unknown';
      this.exclusive = !!opts.exclusive;
      this.borrowed = !entry.ownsAttachment;
      this._entry = entry;
      this._lost = false;
      this._lostReason = null;
      this._released = false;
      this._lostCbs = new Set();
      this._msgListeners = new Set();
    }

    get lost() { return this._lost; }
    get lostReason() { return this._lostReason; }
    get released() { return this._released; }
    get active() { return !this._lost && !this._released; }

    // Send one CDP command. Rejects DRIVER_DISCONNECTED when the lease is lost,
    // released, or the webContents is gone — never silently re-attaches.
    async send(method, params) {
      if (!this.active || this._entry.wc.isDestroyed()) {
        throw brokerError('DRIVER_DISCONNECTED', `Debugger lease ${this.owner}#${this.id} is not connected`);
      }
      return this._entry.wc.debugger.sendCommand(method, params);
    }

    // Subscribe to this attachment's CDP events. Returns an unsubscribe function.
    onEvent(cb) {
      if (!this.active) return () => {};
      const dbg = this._entry.wc.debugger;
      const listener = (_e, method, params, sessionId) => cb(method, params, sessionId);
      dbg.on('message', listener);
      this._msgListeners.add(listener);
      return () => {
        this._msgListeners.delete(listener);
        try { dbg.removeListener('message', listener); } catch (_e) { /* ignore */ }
      };
    }

    // Called once if the attachment is lost. Fires immediately when already lost.
    onLost(cb) {
      if (this._lost) { try { cb(this._lostReason); } catch (_e) { /* ignore */ } return () => {}; }
      this._lostCbs.add(cb);
      return () => this._lostCbs.delete(cb);
    }

    _markLost(reason) {
      if (this._lost) return;
      this._lost = true;
      this._lostReason = reason || 'detached';
      this._dropMessageListeners();
      for (const cb of Array.from(this._lostCbs)) { try { cb(this._lostReason); } catch (_e) { /* ignore */ } }
      this._lostCbs.clear();
    }

    _dropMessageListeners() {
      const dbg = this._entry.wc && this._entry.wc.debugger;
      for (const l of this._msgListeners) { try { dbg.removeListener('message', l); } catch (_e) { /* ignore */ } }
      this._msgListeners.clear();
    }

    // Idempotent. Detaches the debugger only if this was the last lease of a
    // still-live attachment that the broker itself created.
    release() {
      if (this._released) return;
      this._released = true;
      this._dropMessageListeners();
      const entry = this._entry;
      if (this._lost || !entry.alive) return; // stale generation: touch nothing
      entry.leases.delete(this);
      if (entry.leases.size > 0) return;
      entry.alive = false;
      entry.detachFrom();
      if (entries.get(entry.wc) === entry) entries.delete(entry.wc);
      const dbg = entry.wc.debugger;
      if (entry.ownsAttachment) {
        try { if (!entry.wc.isDestroyed() && dbg.isAttached()) dbg.detach(); } catch (_e) { /* ignore */ }
      }
    }
  }

  function acquire(wc, opts) {
    const o = opts || {};
    if (!wc || !wc.debugger) throw brokerError('DEBUGGER_UNAVAILABLE', 'webContents has no debugger');
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
      throw brokerError('DRIVER_DISCONNECTED', 'webContents is destroyed');
    }
    let entry = liveEntry(wc);
    if (entry) {
      const others = Array.from(entry.leases);
      if (o.exclusive && others.length > 0) {
        throw brokerError('DEBUGGER_BUSY', `Debugger is in use by ${others.map((l) => l.owner).join(', ')}`);
      }
      const holder = others.find((l) => l.exclusive);
      if (holder) throw brokerError('DEBUGGER_BUSY', `Debugger is held exclusively by ${holder.owner}`);
    } else {
      const dbg = wc.debugger;
      let owns = false;
      if (dbg.isAttached()) {
        if (!o.allowBorrow) throw brokerError('DEBUGGER_BUSY', 'Debugger is attached by another client');
      } else {
        try { dbg.attach(o.protocolVersion || protocolVersion); owns = true; } catch (err) {
          const e = brokerError('DEBUGGER_ATTACH_FAILED', (err && err.message) || 'attach failed');
          e.cause = err;
          throw e;
        }
      }
      entry = createEntry(wc, owns);
      entries.set(wc, entry);
    }
    const lease = new Lease(entry, o);
    entry.leases.add(lease);
    return lease;
  }

  // Introspection for diagnostics / tests.
  function inspect(wc) {
    const entry = liveEntry(wc);
    return entry
      ? { attached: true, ownsAttachment: entry.ownsAttachment, owners: Array.from(entry.leases).map((l) => l.owner) }
      : { attached: false, ownsAttachment: false, owners: [] };
  }

  // Release every lease on a webContents (e.g. guest closed / tab replaced).
  function releaseAll(wc) {
    const entry = liveEntry(wc);
    if (!entry) return;
    for (const lease of Array.from(entry.leases)) lease.release();
  }

  return { acquire, inspect, releaseAll };
}

// Process-wide default instance for main-process consumers that share one broker
// (screenshot capture and the Electron driver import this).
let shared = null;
function getSharedBroker() {
  if (!shared) shared = createDebuggerBroker();
  return shared;
}

module.exports = { createDebuggerBroker, getSharedBroker, DEFAULT_PROTOCOL };
