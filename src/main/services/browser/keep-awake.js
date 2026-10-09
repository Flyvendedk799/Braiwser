'use strict';
// Keep one guest unthrottled while a replay / recording runs in it.
//
// Background throttling used to be disabled for every guest forever; it is now on
// by default. A replay keeps running when the user switches to another tab (the
// original tab is hidden, and Chromium would otherwise pause its timers /
// animation frames), so the shell asks to hold that guest awake for the run:
//
//   caos:throttle.hold(guestWebContentsId)   start (replaces this window's previous hold)
//   caos:throttle.hold(null)                 end
//
// Holds are ref-counted with video export through the shared throttle scope and
// have a hard time limit, so a forgotten release cannot pin a tab forever.

const { getSharedThrottleScope } = require('./throttle-scope');

const DEFAULT_MAX_MS = 30 * 60 * 1000;

function createKeepAwake(deps) {
  const d = deps || {};
  const throttle = d.throttle || getSharedThrottleScope();
  const maxMs = Number.isFinite(d.maxMs) ? d.maxMs : DEFAULT_MAX_MS;
  const holds = new Map(); // host webContents id -> release()

  function release(hostId) {
    const r = holds.get(hostId);
    if (r) { holds.delete(hostId); r(); }
  }

  return {
    // `host` is the requesting shell webContents (already validated by the IPC guard).
    hold(host, guestId) {
      release(host.id);
      if (guestId == null) return true;
      const guest = d.fromId(guestId);
      if (!guest || (typeof guest.isDestroyed === 'function' && guest.isDestroyed())) throw new Error('guest webContents not found');
      if (guest.getType() !== 'webview' || !guest.hostWebContents || guest.hostWebContents.id !== host.id) {
        throw new Error('not a guest of the requesting window');
      }
      holds.set(host.id, throttle.acquire(`replay:${guestId}`, [guest], { maxMs }));
      try { guest.once('destroyed', () => release(host.id)); } catch (_e) { /* fakes */ }
      return true;
    },
    size: () => holds.size,
  };
}

let instance = null;
function getKeepAwake() {
  if (!instance) {
    const { webContents } = require('electron');
    instance = createKeepAwake({ fromId: (id) => webContents.fromId(id) });
  }
  return instance;
}

module.exports = { createKeepAwake, getKeepAwake };
