'use strict';
// Display-media (video export) controller. Electron-free core: dependencies are
// injected so the policy can be tested with fake events / frames / webContents.
//
// Flow (replaces the old global `videoSourceId`):
//   1. shell calls caos:video.source(guestId)  -> arm(event, guestId)
//        - sender is already validated as the shell top frame by the IPC guard
//        - the guest must be a <webview> hosted by THAT sender
//        - grant is bound to the sender frame + a fresh run id, 15 s TTL
//        - background throttling is lifted for shell + guest while filming
//   2. shell calls getDisplayMedia()           -> handleRequest(request, cb)
//        - request.frame must be the same top-level shell frame
//        - grant is spent on first valid use; nothing else can redeem it
//   3. shell calls caos:video.source(null)     -> arm(event, null) ends the run
//        (also: sender gone, or the max recording time elapses)

const { createDisplayMediaGrants } = require('./display-media-grant');
const { frameKey } = require('./ipc-guard');
const { getSharedThrottleScope } = require('../services/browser/throttle-scope');

function createDisplayMediaController(deps) {
  const d = deps || {};
  const fromId = d.fromId;
  const setTimer = d.setTimeout || setTimeout;
  const clearTimer = d.clearTimeout || clearTimeout;
  // An unredeemed grant that times out also ends the run (nothing is being filmed).
  const grants = createDisplayMediaGrants({
    ...(d.grantOptions || {}),
    onChange: (ev) => { if (ev.type === 'cleared' && ev.reason === 'expired') endRun('grant-expired'); },
  });
  const throttle = d.throttle || getSharedThrottleScope();
  const log = typeof d.log === 'function' ? d.log : () => {};
  const maxRecordingMs = Number.isFinite(d.maxRecordingMs) ? d.maxRecordingMs : 30 * 60 * 1000;
  let releaseThrottle = null;
  let recordingFrameKey = null;
  let maxTimer = null;
  let currentRunId = null;

  function endRun(reason) {
    if (maxTimer != null) { clearTimer(maxTimer); maxTimer = null; }
    grants.clear(null, reason || 'ended');
    if (releaseThrottle) { releaseThrottle(); releaseThrottle = null; }
    recordingFrameKey = null;
    currentRunId = null;
  }

  function guestOf(id, host) {
    const guest = fromId(id);
    if (!guest || (typeof guest.isDestroyed === 'function' && guest.isDestroyed())) throw new Error('guest webContents not found');
    if (guest.getType() !== 'webview') throw new Error('not a guest webContents');
    if (!guest.hostWebContents || guest.hostWebContents.id !== host.id) throw new Error('guest is not hosted by the requesting window');
    return guest;
  }

  return {
    // IPC entry: arm for `id`, or end the run when `id` is null.
    arm(event, id) {
      const key = frameKey(event && event.senderFrame);
      if (!key) throw new Error('video source must be requested from a shell frame');
      if (id == null) {
        // Only the frame that started the run may end it.
        if (!recordingFrameKey || recordingFrameKey === key) endRun('shell-ended');
        return true;
      }
      const host = event.sender;
      const guest = guestOf(id, host);
      endRun('replaced');
      const runId = grants.arm({ frameKey: key, targetId: guest.id, hostId: host.id });
      recordingFrameKey = key;
      currentRunId = runId;
      maxTimer = setTimer(() => endRun('max-duration'), maxRecordingMs);
      if (maxTimer && typeof maxTimer.unref === 'function') maxTimer.unref();
      releaseThrottle = throttle.acquire(`video-export:${runId}`, [host, guest], { maxMs: maxRecordingMs });
      // If either side disappears mid-run, drop everything.
      const stop = () => { if (currentRunId === runId) endRun('webcontents-destroyed'); };
      try { guest.once('destroyed', stop); host.once('destroyed', stop); } catch (_e) { /* fakes may lack once */ }
      return true;
    },

    // Session display-media request handler: (request, callback).
    handleRequest(request, callback) {
      const deny = (why) => { log('[video] denied: ' + why); callback({}); };
      try {
        const frame = request && request.frame;
        if (!frame) return deny('no requesting frame');
        if (frame.parent) return deny('request from a subframe');
        if (request.audioRequested) return deny('audio capture is not granted');
        const verdict = grants.consume(frameKey(frame));
        if (!verdict.ok) return deny(verdict.reason);
        const guest = fromId(verdict.targetId);
        if (!guest || (typeof guest.isDestroyed === 'function' && guest.isDestroyed())) return deny('guest is gone');
        if (guest.getType() !== 'webview') return deny('target is not a guest');
        if (!guest.hostWebContents || guest.hostWebContents.id !== verdict.hostId) return deny('guest host changed');
        callback({ video: guest.mainFrame });
      } catch (err) {
        deny((err && err.message) || String(err));
      }
    },

    // Test / diagnostics hooks.
    endRun,
    peek: () => grants.peek(),
    isRecording: () => recordingFrameKey != null,
    isActive: () => recordingFrameKey != null || grants.peek() != null,
  };
}

let controller = null;
function getController() {
  if (!controller) {
    const { webContents } = require('electron');
    controller = createDisplayMediaController({ fromId: (id) => webContents.fromId(id), log: (m) => console.log(m) });
  }
  return controller;
}

const sessionHooked = new WeakSet();
// Install the session handler (idempotent per session).
function installDisplayMediaHandler(session) {
  const target = session || require('electron').session.defaultSession;
  if (sessionHooked.has(target)) return;
  sessionHooked.add(target);
  target.setDisplayMediaRequestHandler((request, callback) => getController().handleRequest(request, callback), { useSystemPicker: false });
}

module.exports = { createDisplayMediaController, installDisplayMediaHandler, getController };
