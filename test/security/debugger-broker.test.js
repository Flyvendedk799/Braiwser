'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDebuggerBroker } = require('../../src/main/services/browser/debugger-broker');
const { captureFullPage } = require('../../src/main/services/browser/fullpage-capture');

// Mirrors the audit's cdp-pointer fixture, extended with webContents events.
function fixture() {
  const debug = new EventEmitter();
  debug.attached = false;
  debug.calls = [];
  debug.attachCount = 0;
  debug.isAttached = () => debug.attached;
  debug.attach = () => { debug.attached = true; debug.attachCount++; };
  debug.detach = () => { debug.attached = false; debug.emit('detach', {}, 'target closed'); };
  debug.sendCommand = async (method, args) => { debug.calls.push({ method, args }); return {}; };
  const wc = new EventEmitter();
  wc.debugger = debug;
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  return { debug, wc };
}

test('first lease attaches, last release detaches (broker owns the attachment)', () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const a = broker.acquire(wc, { owner: 'driver' });
  const b = broker.acquire(wc, { owner: 'observer' });
  assert.equal(debug.attachCount, 1, 'one attachment shared by both leases');
  assert.deepEqual(broker.inspect(wc).owners, ['driver', 'observer']);
  a.release();
  assert.equal(debug.isAttached(), true);
  b.release();
  assert.equal(debug.isAttached(), false);
  b.release(); // idempotent
});

test('closing a detached old driver cannot detach a new debugger owner', () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const driver = broker.acquire(wc, { owner: 'driver' });
  debug.detach();                 // DevTools took over / target gone
  assert.equal(driver.lost, true);
  debug.attach();                 // another client owns the attachment now
  driver.release();
  assert.equal(debug.isAttached(), true);
  assert.equal(debug.attachCount, 2);
});

test('a lost lease rejects send() with DRIVER_DISCONNECTED and fires onLost once', async () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const lease = broker.acquire(wc, { owner: 'driver' });
  const reasons = [];
  lease.onLost((r) => reasons.push(r));
  await lease.send('Page.enable');
  debug.detach();
  assert.deepEqual(reasons, ['target closed']);
  await assert.rejects(lease.send('Page.enable'), (e) => e.code === 'DRIVER_DISCONNECTED');
  // a later acquire starts a fresh generation and re-attaches
  const next = broker.acquire(wc, { owner: 'driver' });
  assert.equal(debug.isAttached(), true);
  assert.equal(next.lost, false);
  lease.release();
  assert.equal(debug.isAttached(), true, 'stale lease must not touch the new generation');
  next.release();
  assert.equal(debug.isAttached(), false);
});

test('foreign attachment: refused by default, borrowed on request and never detached', () => {
  const { debug, wc } = fixture();
  debug.attach(); // some other client
  const broker = createDebuggerBroker();
  assert.throws(() => broker.acquire(wc, { owner: 'driver' }), (e) => e.code === 'DEBUGGER_BUSY');
  const lease = broker.acquire(wc, { owner: 'capture', allowBorrow: true });
  assert.equal(lease.borrowed, true);
  lease.release();
  assert.equal(debug.isAttached(), true, 'borrowed attachment is left alone');
});

test('exclusive leases refuse to share in either direction', () => {
  const { wc } = fixture();
  const broker = createDebuggerBroker();
  const shared = broker.acquire(wc, { owner: 'driver' });
  assert.throws(() => broker.acquire(wc, { owner: 'capture', exclusive: true }), (e) => e.code === 'DEBUGGER_BUSY');
  shared.release();
  const ex = broker.acquire(wc, { owner: 'capture', exclusive: true });
  assert.throws(() => broker.acquire(wc, { owner: 'driver' }), (e) => e.code === 'DEBUGGER_BUSY');
  ex.release();
  broker.acquire(wc, { owner: 'driver' }).release();
});

test('destroyed webContents marks leases lost and never detaches', () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const lease = broker.acquire(wc, { owner: 'driver' });
  wc.destroyed = true;
  wc.emit('destroyed');
  assert.equal(lease.lost, true);
  assert.equal(lease.lostReason, 'destroyed');
  const detaches = debug.listenerCount('detach');
  lease.release();
  assert.equal(debug.listenerCount('detach'), detaches);
  assert.throws(() => broker.acquire(wc, { owner: 'x' }), (e) => e.code === 'DRIVER_DISCONNECTED');
});

test('event subscription is scoped to the lease', () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const lease = broker.acquire(wc, { owner: 'driver' });
  const seen = [];
  lease.onEvent((m) => seen.push(m));
  debug.emit('message', {}, 'Page.frameNavigated', {});
  lease.release();
  debug.emit('message', {}, 'Page.frameNavigated', {});
  assert.deepEqual(seen, ['Page.frameNavigated']);
  assert.equal(debug.listenerCount('message'), 0);
});

// ---- full-page capture on top of the broker ------------------------------------
function captureFixture({ failScreenshot } = {}) {
  const f = fixture();
  const js = [];
  f.debug.sendCommand = async (method, args) => {
    f.debug.calls.push({ method, args });
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1000, height: 3000 } };
    if (method === 'Page.captureScreenshot') { if (failScreenshot) throw new Error('boom'); return { data: 'QUJD' }; }
    return {};
  };
  f.wc.executeJavaScript = async (code) => { js.push(code); };
  f.wc.capturePage = async () => ({ getSize: () => ({ width: 800, height: 600 }), toDataURL: () => 'data:image/png;base64,VIEW' });
  return { ...f, js };
}
const noSleep = () => Promise.resolve();

test('full-page export is flagged transformed and restores the page and the debugger', async () => {
  const { debug, wc, js } = captureFixture();
  const broker = createDebuggerBroker();
  const r = await captureFullPage(wc, { broker, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.transformed, true);
  assert.equal(r.mode, 'fullpage');
  assert.equal(r.cssWidth, 1000);
  assert.equal(r.cssHeight, 3000);
  assert.equal(r.dataUrl, 'data:image/png;base64,QUJD');
  assert.ok(debug.calls.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(js.some((c) => /__braiwserFixedRestore &&/.test(c)));
  assert.equal(debug.isAttached(), false, 'detached after use (we attached it)');
});

test('capture failure falls back to the UNMODIFIED viewport, after undoing the transforms', async () => {
  const { debug, wc } = captureFixture({ failScreenshot: true });
  const order = [];
  const origSend = debug.sendCommand;
  debug.sendCommand = async (m, a) => { order.push(m); return origSend(m, a); };
  const origCapture = wc.capturePage;
  wc.capturePage = async () => { order.push('capturePage'); return origCapture(); };
  const r = await captureFullPage(wc, { broker: createDebuggerBroker(), sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.transformed, false);
  assert.equal(r.viewportOnly, true);
  assert.equal(r.mode, 'viewport');
  assert.ok(order.indexOf('Emulation.clearDeviceMetricsOverride') < order.indexOf('capturePage'),
    'viewport fallback must be taken after the override is cleared');
});

test('capture does not detach a debugger it did not attach, and yields to an active driver', async () => {
  const { debug, wc } = captureFixture();
  debug.attach(); // DevTools-style foreign client
  const r = await captureFullPage(wc, { broker: createDebuggerBroker(), sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(debug.isAttached(), true, 'foreign attachment survives');

  const f2 = captureFixture();
  const broker = createDebuggerBroker();
  const driver = broker.acquire(f2.wc, { owner: 'driver' });
  const r2 = await captureFullPage(f2.wc, { broker, sleep: noSleep });
  assert.equal(r2.transformed, false, 'no viewport emulation while the driver holds the debugger');
  assert.match(r2.note, /DEBUGGER_BUSY/);
  assert.equal(f2.debug.isAttached(), true);
  assert.ok(!f2.debug.calls.some((c) => c.method.startsWith('Emulation.')));
  driver.release();
});
