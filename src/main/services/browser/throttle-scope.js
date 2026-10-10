'use strict';
// Scoped background-throttling override.
//
// Chromium parks occluded / background renderers, which turns a video export
// into a few frozen frames. Previously the app disabled throttling for EVERY
// window and guest, forever (CPU/battery cost with many busy tabs). Now the
// override is held only while something that needs it (video export / replay
// filming) is active, ref-counted per webContents, with a hard time limit so a
// forgotten release cannot leave a tab unthrottled indefinitely.
//
//   const release = scope.acquire('video-export', [shellWc, guestWc], { maxMs });
//   ... later ...
//   release();   // idempotent
//
// Electron-free: only calls webContents.setBackgroundThrottling(bool) when the
// method exists (needs native confirmation on the pinned Electron version).

const DEFAULT_MAX_MS = 30 * 60 * 1000;

function createThrottleScope(options) {
  const o = options || {};
  const setTimer = o.setTimeout || setTimeout;
  const clearTimer = o.clearTimeout || clearTimeout;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const counts = new Map(); // webContents -> number of active holders

  function setThrottling(wc, allowed) {
    try {
      if (wc && typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
      if (wc && typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(allowed);
    } catch (err) {
      log('[throttle] ' + ((err && err.message) || err));
    }
  }

  function acquire(reason, webContentsList, opts) {
    const targets = Array.from(new Set((webContentsList || []).filter(Boolean)));
    const maxMs = opts && Number.isFinite(opts.maxMs) ? opts.maxMs : DEFAULT_MAX_MS;
    for (const wc of targets) {
      const n = counts.get(wc) || 0;
      counts.set(wc, n + 1);
      if (n === 0) setThrottling(wc, false);
    }
    let released = false;
    let timer = null;
    const release = () => {
      if (released) return;
      released = true;
      if (timer != null) clearTimer(timer);
      for (const wc of targets) {
        const n = (counts.get(wc) || 1) - 1;
        if (n <= 0) { counts.delete(wc); setThrottling(wc, true); } else counts.set(wc, n);
      }
      log(`[throttle] released ${reason}`);
    };
    timer = setTimer(release, maxMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return release;
  }

  return { acquire, activeCount: () => counts.size };
}

// One process-wide scope so video export and replay holds ref-count against each
// other instead of fighting over setBackgroundThrottling.
let shared = null;
function getSharedThrottleScope() {
  if (!shared) shared = createThrottleScope({ log: (m) => { try { console.log(m); } catch (_e) { /* ignore */ } } });
  return shared;
}

module.exports = { createThrottleScope, getSharedThrottleScope, DEFAULT_MAX_MS };
