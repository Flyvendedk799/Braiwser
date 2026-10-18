'use strict';
// One-shot display-media grant — pure state machine (no Electron import).
//
// The shell arms a grant ("film guest webContents N") from a specific shell
// frame, then calls getDisplayMedia() from that same frame. The session's
// display-media handler redeems the grant:
//
//   idle --arm--> armed --consume(frame matches)--> consumed (grant cleared)
//                   |--clear / TTL expiry / re-arm--> idle
//
// Properties enforced here:
//   * bound to the requesting shell frame (process:routing id) AND a run id;
//   * redeemable once — a second getDisplayMedia, from anywhere, gets nothing;
//   * short TTL — a grant nobody redeems cannot linger and be hijacked later;
//   * a request from another frame (a guest page, a subframe) is denied AND does
//     not burn the grant, so a hostile page cannot grief a legitimate run.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 15000;

function createDisplayMediaGrants(options) {
  const o = options || {};
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_TTL_MS;
  const now = o.now || Date.now;
  const newRunId = o.newRunId || (() => crypto.randomUUID());
  const setTimer = o.setTimeout || setTimeout;
  const clearTimer = o.clearTimeout || clearTimeout;
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};

  let grant = null; // { runId, frameKey, targetId, hostId, expiresAt, timer }

  function drop(reason) {
    if (!grant) return null;
    const g = grant;
    grant = null;
    if (g.timer != null) clearTimer(g.timer);
    try { onChange({ type: 'cleared', reason, runId: g.runId, targetId: g.targetId }); } catch (_e) { /* ignore */ }
    return g;
  }

  return {
    // Arm for { frameKey, targetId, hostId }. Replaces any previous grant.
    // Returns the run id.
    arm({ frameKey, targetId, hostId }) {
      if (!frameKey) throw new Error('grant must be bound to a shell frame');
      if (!Number.isInteger(targetId) || targetId < 1) throw new Error('grant needs a target webContents id');
      drop('replaced');
      const runId = newRunId();
      const g = { runId, frameKey, targetId, hostId: hostId == null ? null : hostId, expiresAt: now() + ttlMs, timer: null };
      g.timer = setTimer(() => { if (grant === g) drop('expired'); }, ttlMs);
      if (g.timer && typeof g.timer.unref === 'function') g.timer.unref();
      grant = g;
      try { onChange({ type: 'armed', runId, targetId }); } catch (_e) { /* ignore */ }
      return runId;
    },

    // Redeem for a request coming from `frameKey`. Returns
    // { ok: true, targetId, runId, hostId } (grant spent) or { ok: false, reason }.
    consume(frameKey) {
      if (!grant) return { ok: false, reason: 'NO_GRANT' };
      if (now() > grant.expiresAt) { drop('expired'); return { ok: false, reason: 'EXPIRED' }; }
      if (!frameKey || frameKey !== grant.frameKey) return { ok: false, reason: 'WRONG_FRAME' };
      const g = drop('consumed');
      return { ok: true, targetId: g.targetId, runId: g.runId, hostId: g.hostId };
    },

    // Explicit clear (recording finished or cancelled). Only the frame that armed
    // the grant may clear it when `frameKey` is supplied.
    clear(frameKey, reason) {
      if (!grant) return false;
      if (frameKey && frameKey !== grant.frameKey) return false;
      drop(reason || 'cleared');
      return true;
    },

    peek() {
      return grant ? { runId: grant.runId, targetId: grant.targetId, frameKey: grant.frameKey, expiresAt: grant.expiresAt } : null;
    },
  };
}

module.exports = { createDisplayMediaGrants, DEFAULT_TTL_MS };
