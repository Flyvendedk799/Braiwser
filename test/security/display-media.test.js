'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayMediaGrants } = require('../../src/main/security/display-media-grant');
const { createDisplayMediaController } = require('../../src/main/security/display-media');
const { createThrottleScope } = require('../../src/main/services/browser/throttle-scope');

function clock() {
  const c = { t: 1000, timers: [] };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const h = { fn, at: c.t + ms, cleared: false }; c.timers.push(h); return h; };
  c.clearTimeout = (h) => { if (h) h.cleared = true; };
  c.advance = (ms) => {
    c.t += ms;
    for (const h of c.timers.filter((x) => !x.cleared && x.at <= c.t)) { h.cleared = true; h.fn(); }
  };
  return c;
}

test('grant is one-shot and bound to the arming frame', () => {
  const c = clock();
  const g = createDisplayMediaGrants({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, newRunId: () => 'run-1' });
  assert.equal(g.arm({ frameKey: '7:1', targetId: 42, hostId: 1 }), 'run-1');
  assert.deepEqual(g.consume('9:9'), { ok: false, reason: 'WRONG_FRAME' });
  assert.ok(g.peek(), 'a hostile frame must not burn the grant');
  assert.deepEqual(g.consume('7:1'), { ok: true, targetId: 42, runId: 'run-1', hostId: 1 });
  assert.deepEqual(g.consume('7:1'), { ok: false, reason: 'NO_GRANT' });
});

test('grant expires after the TTL and via the timer', () => {
  const c = clock();
  const events = [];
  const g = createDisplayMediaGrants({ ttlMs: 5000, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onChange: (e) => events.push(e.type + ':' + (e.reason || '')) });
  g.arm({ frameKey: 'a:1', targetId: 3 });
  c.advance(5001);
  assert.equal(g.peek(), null);
  assert.deepEqual(g.consume('a:1'), { ok: false, reason: 'NO_GRANT' });
  assert.ok(events.includes('cleared:expired'));
});

test('re-arming replaces the previous grant; clear is limited to the arming frame', () => {
  const c = clock();
  const g = createDisplayMediaGrants({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  g.arm({ frameKey: 'a:1', targetId: 3 });
  g.arm({ frameKey: 'a:1', targetId: 4 });
  assert.equal(g.peek().targetId, 4);
  assert.equal(g.clear('b:2'), false);
  assert.equal(g.clear('a:1'), true);
  assert.equal(g.peek(), null);
  assert.throws(() => g.arm({ frameKey: '', targetId: 4 }), /bound to a shell frame/);
  assert.throws(() => g.arm({ frameKey: 'a:1', targetId: 'x' }), /target/);
});

// ---- controller ----------------------------------------------------------
function world() {
  const c = clock();
  const throttleLog = [];
  const host = { id: 1, getType: () => 'window', isDestroyed: () => false, setBackgroundThrottling: (v) => throttleLog.push(['host', v]), once() {} };
  const guest = {
    id: 42, hostWebContents: host, mainFrame: { tag: 'guest-main-frame' },
    isDestroyed: () => false, getType: () => 'webview',
    setBackgroundThrottling: (v) => throttleLog.push(['guest', v]), once() {},
  };
  const other = { id: 43, hostWebContents: { id: 2 }, isDestroyed: () => false, getType: () => 'webview', mainFrame: {} };
  const byId = { 1: host, 42: guest, 43: other };
  const throttle = createThrottleScope({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const ctl = createDisplayMediaController({
    fromId: (id) => byId[id], throttle, maxRecordingMs: 60000,
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    grantOptions: { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, newRunId: () => 'run-x' },
  });
  const shellFrame = { processId: 7, routingId: 1, parent: null };
  const ev = { sender: host, senderFrame: shellFrame };
  const request = (frame, extra) => new Promise((resolve) => ctl.handleRequest({ frame, videoRequested: true, audioRequested: false, ...extra }, resolve));
  return { c, ctl, host, guest, ev, shellFrame, request, throttleLog };
}

test('shell arms, requests from the same frame, receives only the guest main frame; second request gets nothing', async () => {
  const w = world();
  assert.equal(w.ctl.arm(w.ev, 42), true);
  const first = await w.request(w.shellFrame);
  assert.deepEqual(first, { video: w.guest.mainFrame });
  const second = await w.request(w.shellFrame);
  assert.deepEqual(second, {});
});

test('requests from another frame, a subframe, an audio request, or an un-armed state are denied', async () => {
  const w = world();
  assert.deepEqual(await w.request(w.shellFrame), {}, 'nothing armed');
  w.ctl.arm(w.ev, 42);
  assert.deepEqual(await w.request({ processId: 99, routingId: 3, parent: null }), {}, 'guest page frame');
  assert.deepEqual(await w.request({ ...w.shellFrame, parent: {} }), {}, 'subframe');
  assert.deepEqual(await w.request(w.shellFrame, { audioRequested: true }), {}, 'audio');
  assert.deepEqual(await w.request(null), {}, 'no frame');
  // none of the denials spent the legitimate grant
  assert.deepEqual(await w.request(w.shellFrame), { video: w.guest.mainFrame });
});

test('arming refuses a webContents that is not a guest of the requesting window', () => {
  const w = world();
  assert.throws(() => w.ctl.arm(w.ev, 43), /not hosted by the requesting window/);
  assert.throws(() => w.ctl.arm(w.ev, 1), /not a guest webContents/);
  assert.throws(() => w.ctl.arm(w.ev, 999), /not found/);
  assert.throws(() => w.ctl.arm({ sender: w.host, senderFrame: null }, 42), /shell frame/);
});

test('unredeemed grant expires and ends the run (throttling restored)', () => {
  const w = world();
  w.ctl.arm(w.ev, 42);
  assert.equal(w.ctl.isRecording(), true);
  w.c.advance(15001);
  assert.equal(w.ctl.peek(), null);
  assert.equal(w.ctl.isRecording(), false);
  assert.ok(w.throttleLog.some(([, v]) => v === true), 'throttling restored');
});

test('throttling is lifted only while the run is active and restored when it ends', async () => {
  const w = world();
  w.ctl.arm(w.ev, 42);
  assert.deepEqual(w.throttleLog.filter(([, v]) => v === false).map(([n]) => n).sort(), ['guest', 'host']);
  await w.request(w.shellFrame); // consumed: still recording
  assert.equal(w.ctl.isRecording(), true);
  assert.equal(w.ctl.arm(w.ev, null), true); // shell ends the run
  assert.equal(w.ctl.isRecording(), false);
  assert.deepEqual(w.throttleLog.filter(([, v]) => v === true).map(([n]) => n).sort(), ['guest', 'host']);
});

test('a run cannot be ended by a different frame, and times out on its own', () => {
  const w = world();
  w.ctl.arm(w.ev, 42);
  w.ctl.arm({ sender: w.host, senderFrame: { processId: 8, routingId: 8, parent: null } }, null);
  assert.equal(w.ctl.isRecording(), true, 'foreign frame cannot end the run');
  w.c.advance(60001);
  assert.equal(w.ctl.isRecording(), false);
});

test('throttle scope is ref-counted per webContents and idempotent', () => {
  const log = [];
  const wc = { setBackgroundThrottling: (v) => log.push(v), isDestroyed: () => false };
  const c = clock();
  const scope = createThrottleScope({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const r1 = scope.acquire('a', [wc]);
  const r2 = scope.acquire('b', [wc]);
  assert.deepEqual(log, [false]);
  r1(); r1();
  assert.deepEqual(log, [false]);
  r2();
  assert.deepEqual(log, [false, true]);
  assert.equal(scope.activeCount(), 0);
  const r3 = scope.acquire('c', [wc], { maxMs: 100 });
  c.advance(101);
  assert.deepEqual(log, [false, true, false, true], 'hard time limit releases');
  r3();
});

// ---- keep-awake (replay in a hidden tab) -----------------------------------
const { createKeepAwake } = require('../../src/main/services/browser/keep-awake');

test('keep-awake holds one guest of the requesting window, replaces and releases holds', () => {
  const c = clock();
  const log = [];
  const mkGuest = (id, hostId) => ({
    id, getType: () => 'webview', hostWebContents: { id: hostId }, isDestroyed: () => false,
    setBackgroundThrottling: (v) => log.push([id, v]), once() {},
  });
  const guests = { 10: mkGuest(10, 1), 11: mkGuest(11, 1), 20: mkGuest(20, 2) };
  const scope = createThrottleScope({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const ka = createKeepAwake({ fromId: (id) => guests[id], throttle: scope, maxMs: 1000 });
  const host = { id: 1 };
  assert.equal(ka.hold(host, 10), true);
  assert.deepEqual(log, [[10, false]]);
  ka.hold(host, 11); // replaces: 10 released, 11 held
  assert.deepEqual(log, [[10, false], [10, true], [11, false]]);
  assert.throws(() => ka.hold(host, 20), /not a guest of the requesting window/);
  assert.throws(() => ka.hold(host, 999), /not found/);
  ka.hold(host, null);
  assert.deepEqual(log.slice(-1), [[11, true]]);
  assert.equal(ka.size(), 0);
  ka.hold(host, 10);
  c.advance(1001);
  assert.deepEqual(log.slice(-1), [[10, true]], 'hard time limit releases a forgotten hold');
});
