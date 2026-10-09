'use strict';
// Audit §G regression tests (ported) + lease-mode and key/text input tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CdpPointer } = require('../../../src/main/services/browser/drivers/cdp-pointer');
const { createDebuggerBroker } = require('../../../src/main/services/browser/debugger-broker');

function fixture() {
  const debug = new EventEmitter();
  debug.attached = false; debug.calls = [];
  debug.isAttached = () => debug.attached;
  debug.attach = () => { debug.attached = true; };
  debug.detach = () => { debug.attached = false; debug.emit('detach'); };
  debug.sendCommand = async (method, args) => { debug.calls.push({ method, args }); };
  const wc = { debugger: debug, isDestroyed: () => false };
  return { debug, wc };
}

// ---- audit §G (verbatim intent) ----------------------------------------------------------
test('CDP input uses viewport CSS points and never claims verification', async () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  let checks = 0;
  const result = await driver.clickCssPoint({ x: 23, y: 45, viewportWidth: 800, viewportHeight: 600 },
    { beforeDispatch: () => { checks++; } });
  assert.equal(result.status, 'dispatched'); assert.equal(checks, 3);
  assert.deepEqual(debug.calls.map((x) => x.args.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(debug.calls[0].args.x, 23);
  driver.close(); assert.equal(debug.isAttached(), false);
});

test('CDP input rejects out-of-viewport points without dispatch', async () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  await assert.rejects(driver.clickCssPoint({ x: 800, y: 45, viewportWidth: 800, viewportHeight: 600 },
    { beforeDispatch() {} }), /INVALID_VIEWPORT_POINT/);
  assert.equal(debug.calls.length, 0); driver.close();
});

test('CDP input does not release on a changed document after mouse-down', async () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  let checks = 0;
  await assert.rejects(driver.clickCssPoint({ x: 23, y: 45, viewportWidth: 800, viewportHeight: 600 },
    { beforeDispatch() { if (++checks === 3) throw new Error('STALE_DOCUMENT'); } }), /STALE_DOCUMENT/);
  assert.equal(driver.closed, true);
  assert.deepEqual(debug.calls.map((x) => x.args.type), ['mouseMoved', 'mousePressed']);
  driver.close();
});

test('closing a detached old driver cannot detach a new debugger owner', () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  debug.detach();
  debug.attach(); // another broker/client owns this attachment now
  driver.close();
  assert.equal(debug.isAttached(), true);
});

// ---- additions ---------------------------------------------------------------------------------
test('a busy debugger is never stolen (wc mode)', () => {
  const { debug, wc } = fixture();
  debug.attached = true;
  assert.throws(() => new CdpPointer(wc), /DEBUGGER_BUSY/);
});

test('after a detach every further call fails DRIVER_DISCONNECTED without sending', async () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  debug.detach();
  await assert.rejects(driver.clickCssPoint({ x: 1, y: 1, viewportWidth: 10, viewportHeight: 10 }, { beforeDispatch() {} }),
    (e) => e.code === 'DRIVER_DISCONNECTED');
  assert.equal(debug.calls.length, 0);
});

test('lease mode: sends through the shared lease and never detaches a borrowed attachment', async () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const other = broker.acquire(wc, { owner: 'capture' });
  const lease = broker.acquire(wc, { owner: 'agent-driver' });
  const pointer = new CdpPointer(lease);
  await pointer.clickCssPoint({ x: 5, y: 5, viewportWidth: 100, viewportHeight: 100 }, { beforeDispatch() {} });
  assert.equal(debug.calls.length, 3);
  pointer.close();
  assert.equal(pointer.closed, true);
  assert.equal(lease.released, false, 'a handed-in lease is not released unless ownsLease');
  assert.equal(debug.isAttached(), true);
  lease.release(); other.release();
  assert.equal(debug.isAttached(), false);
});

test('lease mode: a lost lease quarantines the pointer', async () => {
  const { debug, wc } = fixture();
  const broker = createDebuggerBroker();
  const lease = broker.acquire(wc, { owner: 'agent-driver' });
  const pointer = new CdpPointer(lease, { ownsLease: true });
  debug.detach(); // e.g. DevTools took over
  assert.equal(pointer.closed, true);
  await assert.rejects(pointer.insertText('x', { beforeDispatch() {} }), (e) => e.code === 'DRIVER_DISCONNECTED');
  assert.equal(debug.calls.length, 0);
  pointer.close();
});

test('insertText and pressKey dispatch behind beforeDispatch and quarantine on a half-sent key', async () => {
  const { debug, wc } = fixture();
  const driver = new CdpPointer(wc);
  let checks = 0;
  await driver.insertText('hello', { beforeDispatch: () => { checks++; } });
  await driver.pressKey('Enter', { beforeDispatch: () => { checks++; } });
  await driver.pressKey('Shift+Tab', { beforeDispatch: () => { checks++; } });
  assert.equal(checks, 5);
  assert.deepEqual(debug.calls.map((c) => c.method), ['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  assert.equal(debug.calls[3].args.modifiers, 8);
  await assert.rejects(driver.pressKey('Hyper+x', { beforeDispatch() {} }), /INVALID_KEY/);
  await assert.rejects(driver.insertText(5, { beforeDispatch() {} }), /INVALID_TEXT/);

  let n = 0;
  await assert.rejects(driver.pressKey('a', { beforeDispatch() { if (++n === 2) throw new Error('STALE_DOCUMENT'); } }), /STALE_DOCUMENT/);
  assert.equal(driver.closed, true, 'a key left down quarantines the pointer');
  driver.close();
});
