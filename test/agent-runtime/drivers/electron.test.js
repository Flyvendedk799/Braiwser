'use strict';
// Electron driver tests against FAKE webContents / debugger (jsdom-backed CDP shim).
// These prove driver logic, not Electron behaviour: native-only claims stay unflagged
// in the capability document ("needs native confirmation").

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createElectronDriver, clampViewBounds } = require('../../../src/main/services/browser/drivers/electron');
const { createDebuggerBroker } = require('../../../src/main/services/browser/debugger-broker');
const { createFakeGuest } = require('./_fake-guest');

const PAGE = `<!doctype html><html><head><title>Fixture</title></head><body>
<main>
  <h1>Settings</h1>
  <label>Display name <input id="name" type="text"></label>
  <label>Password <input id="pw" type="password"></label>
  <label><input id="terms" type="checkbox"> Accept terms</label>
  <button id="save" type="button">Save</button>
  <button id="off" type="button" disabled>Off</button>
  <button type="button">Delete</button><button type="button">Delete</button>
  <div role="status" id="status">Pending</div>
</main>
<script>
document.getElementById('save').addEventListener('click', function () { document.getElementById('status').textContent = 'Saved'; });
</script></body></html>`;

function setup(opts) {
  const guest = createFakeGuest({ html: PAGE, ...(opts || {}) });
  // the page script above only runs in jsdom when scripts run; wire the handler directly instead
  guest.doc.getElementById('save').addEventListener('click', () => { guest.doc.getElementById('status').textContent = 'Saved'; });
  const broker = createDebuggerBroker();
  const driver = createElectronDriver({ debuggerBroker: broker });
  const events = [];
  const pageId = driver.registerGuest(guest.wc);
  return { guest, broker, driver, events, pageId, open: () => driver.open({ onPageEvent: (e) => events.push(e) }) };
}

const byName = (o, name, role) => o.nodes.find((n) => n.name === name && (!role || n.role === role));
const clickCmd = (o, node, extra) => ({ driverDocumentEpoch: o.documentEpoch, observationId: o.observationId, action: { kind: 'click', refId: node.refId, ...(extra || {}) } });
const control = (calls) => ({ signal: null, check() { calls.check += 1; }, beforeDispatch() { calls.before += 1; } });

test('capabilities are conservative until native tests exist', () => {
  const caps = createElectronDriver().capabilities();
  assert.equal(caps.driver, 'electron-embedded');
  for (const k of ['frames', 'shadowDom', 'canvas', 'popups', 'downloads', 'uploads', 'dialogs', 'permissions', 'screenshots']) {
    assert.equal(caps[k], false, k);
  }
  assert.deepEqual(caps.modes, ['visible']);
  assert.equal(caps.liveModeSwitch, false);
  assert.match(caps.notes.status, /native confirmation/);
  assert.ok(!caps.actions.includes('select'));
});

test('guest registry: opaque ids, idempotent, validated, auto-forgotten, watchHost wiring', async () => {
  const { guest, driver, pageId } = setup();
  assert.match(pageId, /^pg_[0-9a-f]{16}$/);
  assert.ok(!String(pageId).includes(String(guest.wc.id)), 'no raw webContents id leaks');
  assert.equal(driver.registerGuest(guest.wc), pageId, 'idempotent per webContents');
  assert.throws(() => driver.registerGuest({}), (e) => e.code === 'UNSUPPORTED');
  assert.throws(() => driver.registerGuest(null), (e) => e.code === 'UNSUPPORTED');

  const host = new EventEmitter();
  const off = driver.watchHost(host);
  const second = createFakeGuest({ html: PAGE });
  host.emit('did-attach-webview', {}, second.wc);
  assert.equal(driver.guestPageIds().length, 2);
  off();
  host.emit('did-attach-webview', {}, createFakeGuest({ html: PAGE }).wc);
  assert.equal(driver.guestPageIds().length, 2, 'unsubscribed host registers nothing');

  const session = await driver.open();
  assert.equal(session.pages.size, 2);
  const closed = [];
  session.pages.get(pageId).on('closed', () => closed.push(pageId));
  guest.wc.destroy();
  assert.deepEqual(closed, [pageId]);
  assert.equal(session.pages.has(pageId), false);
  assert.equal(driver.unregisterGuest(pageId), false);
  await assert.rejects(driver.open(), (e) => e.detail === 'SESSION_EXISTS');
  await session.close();
});

test('open() refuses headless mode, foreign profiles and an empty registry', async () => {
  const driver = createElectronDriver({ debuggerBroker: createDebuggerBroker() });
  await assert.rejects(driver.open({ mode: 'headless' }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(driver.open({ profile: 'work' }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(driver.open(), (e) => e.detail === 'NO_GUESTS');
  const { driver: d2, pageId } = setup();
  await assert.rejects(d2.open({ pageId: 'pg_missing' }), (e) => e.code === 'STALE_REF');
  const s = await d2.open({ pageId });
  assert.equal(s.pages.keys().next().value, pageId);
  await assert.rejects(s.newPage(), (e) => e.detail === 'NEW_PAGE_UNSUPPORTED');
});

test('observe runs the probe in an isolated world and returns a bounded untrusted snapshot', async () => {
  const { guest, driver, pageId, open } = setup({ childFrames: ['F-child'] });
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  assert.equal(o.trust, 'untrusted-page');
  assert.ok(guest.dbg.calls.some((c) => c.method === 'Page.createIsolatedWorld'), 'probe runs in an isolated world');
  assert.ok(guest.dbg.calls.every((c) => !['Runtime.evaluate', 'Runtime.compileScript'].includes(c.method)), 'no general eval path');
  const save = byName(o, 'Save', 'button');
  assert.ok(save.refId && save.enabled === true);
  assert.equal(byName(o, 'Off').enabled, false);
  assert.equal(byName(o, 'Password').secret, true);
  const del = o.nodes.filter((n) => n.name === 'Delete');
  assert.ok(del.length === 2 && del.every((n) => n.ambiguous));
  assert.equal(o.coverage.framesSeen, 2);
  assert.equal(o.coverage.framesUnavailable, 1, 'child frames are reported as unobserved, not flattened');
  assert.ok(o.coverage.limitations.includes('frames-unavailable'));
  assert.ok(!JSON.stringify(o).includes('objectId'));
  assert.ok(driver.capabilities().frames === false);
  await session.close();
});

test('click: real CDP pointer sequence at the element, beforeDispatch before every input event', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const calls = { check: 0, before: 0 };
  const res = await page.act(clickCmd(o, byName(o, 'Save'), { expect: { kind: 'text', op: 'equals', selector: '#status', expected: 'Saved' } }), control(calls));
  assert.equal(res.status, 'verified');
  assert.equal(res.evidence.at(-1).kind, 'text');
  const mouse = guest.dbg.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type);
  assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(calls.before, 3);
  assert.equal(guest.doc.getElementById('status').textContent, 'Saved');
  // a plain click is verified by delivery attestation: the trusted click that reached the exact target
  const plain = await page.act(clickCmd(o, byName(o, 'Save')), control(calls));
  assert.equal(plain.status, 'verified');
});

test('refusals send no input: disabled, covered, ambiguous, secret, stale document, unknown action', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const inputs = () => guest.dbg.calls.filter((c) => c.method.startsWith('Input.')).length;
  const refuse = async (cmd, code, detail) => {
    const before = inputs();
    const err = await page.act(cmd).then(() => null, (e) => e);
    assert.ok(err, `${code} expected`);
    assert.equal(err.code, code, `${err.code}/${err.detail}`);
    if (detail) assert.equal(err.detail, detail);
    assert.equal(err.dispatched, false);
    assert.equal(inputs(), before, 'no Input.* command may be sent');
  };
  await refuse(clickCmd(o, byName(o, 'Off')), 'UNAVAILABLE', 'NOT_ACTIONABLE');
  await refuse(clickCmd(o, o.nodes.find((n) => n.name === 'Delete')), 'AMBIGUOUS_TARGET');
  await refuse({ action: { kind: 'fill', refId: byName(o, 'Password').refId, text: 'hunter2' } }, 'DENIED', 'SECRET_FIELD');
  await refuse({ action: { kind: 'press', refId: byName(o, 'Password').refId, key: 'a' } }, 'DENIED', 'SECRET_FIELD');
  await refuse({ action: { kind: 'select', refId: byName(o, 'Save').refId, value: 'x' } }, 'UNSUPPORTED');
  await refuse({ driverDocumentEpoch: o.documentEpoch + 5, action: { kind: 'click', refId: byName(o, 'Save').refId } }, 'STALE_REF', 'STALE_DOCUMENT');
  // a covering overlay is detected by the hit test
  guest.state.coverBy = guest.doc.body;
  await refuse(clickCmd(o, byName(o, 'Save')), 'UNAVAILABLE', 'NOT_ACTIONABLE');
  guest.state.coverBy = null;
  assert.equal(guest.doc.getElementById('status').textContent, 'Pending');
});

test('fill: focus by pointer, Input.insertText, readback evidence; value never in the observation', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const res = await page.act({ action: { kind: 'fill', refId: byName(o, 'Display name').refId, text: 'Ada' } });
  assert.equal(res.status, 'verified');
  assert.deepEqual(res.evidence, [{ kind: 'value', observed: true, matches: true, length: 3, documentEpoch: page.documentEpoch }]);
  assert.equal(guest.doc.getElementById('name').value, 'Ada');
  assert.ok(guest.dbg.calls.some((c) => c.method === 'Input.insertText' && c.params.text === 'Ada'));
  assert.ok(!JSON.stringify(await page.observe()).includes('Ada'));
});

test('check clicks only when the state differs and reads the state back', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const terms = byName(o, 'Accept terms');
  const res = await page.act({ action: { kind: 'check', refId: terms.refId, checked: true } });
  assert.equal(res.status, 'verified');
  assert.equal(guest.doc.getElementById('terms').checked, true);
  const again = await page.act({ action: { kind: 'check', refId: terms.refId, checked: true } });
  assert.equal(again.status, 'verified');
});

test('navigation events bump the epoch and invalidate refs; replaced nodes are stale', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const save = byName(o, 'Save');
  const e0 = page.documentEpoch;
  guest.wc.emit('did-navigate-in-page', {}, 'http://guest.test/page#x', true);
  assert.equal(page.documentEpoch, e0 + 1);
  await assert.rejects(page.act(clickCmd(o, save)), (e) => e.code === 'STALE_REF');
  const o2 = await page.observe();
  guest.wc.emit('did-frame-navigate', {}, 'http://x/', 200, 'OK', false);
  assert.equal(page.documentEpoch, e0 + 2, 'sub-frame navigation also invalidates (conservative)');
  guest.wc.emit('did-frame-navigate', {}, 'http://x/', 200, 'OK', true);
  assert.equal(page.documentEpoch, e0 + 2, 'main-frame did-frame-navigate is covered by did-navigate');
  void o2;

  const o3 = await page.observe();
  const target = byName(o3, 'Save');
  const old = guest.doc.getElementById('save');
  const fresh = guest.doc.createElement('button');
  fresh.textContent = 'Save';
  old.replaceWith(fresh);
  await assert.rejects(page.act(clickCmd(o3, target)), (e) => e.code === 'STALE_REF' && e.detail === 'NODE_DETACHED' && e.dispatched === false);
  assert.equal(guest.doc.getElementById('status').textContent, 'Pending');
});

test('debugger loss pauses the page: refs invalidated, act refused, observe recovers with a fresh lease', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const paused = [];
  page.on('paused', (e) => paused.push(e));
  guest.dbg.detach(); // DevTools took the debugger
  assert.equal(page.state, 'paused');
  assert.equal(paused.length, 1);
  await assert.rejects(page.act(clickCmd(o, byName(o, 'Save'))), (e) => e.code === 'UNAVAILABLE' && e.detail === 'DRIVER_PAUSED' && e.retry === true && e.dispatched === false);
  assert.throws(() => page.resolve(o.nodes.find((n) => n.refId).refId), (e) => e.detail === 'DEBUGGER_LOST');
  const o2 = await page.observe();
  assert.equal(page.state, 'ready');
  const res = await page.act(clickCmd(o2, byName(o2, 'Save')));
  assert.equal(res.status, 'verified');
  assert.equal(guest.doc.getElementById('status').textContent, 'Saved');
});

test('the debugger is shared: disposing the driver never detaches another feature\'s lease', async () => {
  const { guest, broker, pageId, open } = setup();
  const capture = broker.acquire(guest.wc, { owner: 'capture' });
  const session = await open();
  const page = session.pages.get(pageId);
  await page.observe();
  assert.deepEqual(broker.inspect(guest.wc).owners.sort(), ['agent-driver', 'capture']);
  await session.close();
  assert.equal(guest.dbg.isAttached(), true, 'capture still holds the attachment');
  assert.deepEqual(broker.inspect(guest.wc).owners, ['capture']);
  assert.equal(capture.active, true);
  capture.release();
  assert.equal(guest.dbg.isAttached(), false);
});

test('a busy debugger (held exclusively elsewhere) is UNAVAILABLE and retryable, never stolen', async () => {
  const { guest, broker, pageId, open } = setup();
  const exclusive = broker.acquire(guest.wc, { owner: 'viewport-emulation', exclusive: true });
  const session = await open();
  const page = session.pages.get(pageId);
  await assert.rejects(page.observe(), (e) => e.code === 'UNAVAILABLE' && e.retry === true && e.detail === 'DEBUGGER_BUSY');
  exclusive.release();
  assert.ok((await page.observe()).nodes.length > 0);
});

test('crash and destroy are terminal for the page', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  guest.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(page.state, 'crashed');
  await assert.rejects(page.act(clickCmd(o, byName(o, 'Save'))), (e) => e.code === 'UNAVAILABLE' && e.detail === 'PAGE_CRASHED');
  await assert.rejects(page.observe(), (e) => e.detail === 'PAGE_CRASHED');
});

test('owner badge is drawn via the probe overlay and hidden for screenshots', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  await page.setOwnerBadge('human');
  assert.equal((await page.badgeState()).owner, 'human');
  assert.ok(guest.doc.querySelector('[data-caos="agent-badge"]'));
  const shot = await page.screenshot();
  assert.equal(shot.meta.transformed, false);
  assert.deepEqual(guest.wc.captures, [{ badgeHidden: true }], 'the badge is hidden while pixels are captured');
  assert.notEqual(guest.doc.querySelector('[data-caos="agent-badge"]').style.visibility, 'hidden');
  const o = await page.observe();
  assert.ok(!o.nodes.some((n) => /control/i.test(n.name)), 'the overlay is never observed');
  await assert.rejects(page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(page.setOwnerBadge('root'), (e) => e.code === 'UNSUPPORTED');
});

test('highlight marks only the referenced node', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  await page.highlight(byName(o, 'Save').refId, 'here');
  assert.equal(guest.doc.querySelectorAll('[data-caos="agent-highlight"]').length, 1);
  await page.clearHighlight();
  assert.equal(guest.doc.querySelectorAll('[data-caos="agent-highlight"]').length, 0);
});

test('navigate outcomes map ready / failed / timeout / cancelled and stop the load', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  assert.equal((await page.navigate('http://guest.test/next')).outcome, 'ready');
  guest.wc.loadBehavior = () => Promise.reject(Object.assign(new Error('ERR_CONNECTION_REFUSED (-102) loading'), { code: 'ERR_CONNECTION_REFUSED' }));
  assert.deepEqual(await page.navigate('http://guest.test/x').then((r) => [r.outcome, r.error]), ['failed', 'ERR_CONNECTION_REFUSED']);
  guest.wc.loadBehavior = () => new Promise(() => {});
  const t0 = Date.now();
  assert.equal((await page.navigate('http://guest.test/slow', { timeoutMs: 1000 })).outcome, 'timeout');
  assert.ok(Date.now() - t0 >= 900);
  assert.equal(guest.wc.stopped, 1);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  assert.equal((await page.navigate('http://guest.test/slow2', { signal: ac.signal, timeoutMs: 5000 })).outcome, 'cancelled');
  assert.equal(guest.wc.stopped, 2);
  await assert.rejects(page.navigate('file:///etc/passwd'), (e) => e.code === 'DENIED');
});

test('evaluateAssertion uses the shared DSL over probe facts; unavailable engine is unknown', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  assert.equal((await page.evaluateAssertion({ kind: 'text', op: 'equals', selector: '#status', expected: 'Pending' })).status, 'passed');
  assert.equal((await page.evaluateAssertion({ kind: 'count', selector: 'button', expected: 4 })).status, 'passed');
  assert.equal((await page.evaluateAssertion({ kind: 'exists', target: '.nope' })).status, 'failed');
  assert.equal((await page.evaluateAssertion({ kind: 'url', op: 'contains', expected: 'guest.test' })).status, 'passed');
  assert.equal((await page.evaluateAssertion({ kind: 'bogus' })).status, 'failed');
  guest.wc.destroy();
  assert.equal((await page.evaluateAssertion({ kind: 'exists', selector: 'a' })).status, 'unknown');
});

test('clampViewBounds keeps a renderer-reported rectangle inside the window', () => {
  const bounds = { width: 1000, height: 700 };
  assert.deepEqual(clampViewBounds({ x: 10.4, y: 20.6, width: 300, height: 200 }, bounds), { x: 10, y: 21, width: 300, height: 200 });
  assert.deepEqual(clampViewBounds({ x: -50, y: -5, width: 5000, height: 5000 }, bounds), { x: 0, y: 0, width: 1000, height: 700 });
  assert.deepEqual(clampViewBounds({ x: 900, y: 600, width: 500, height: 500 }, bounds), { x: 900, y: 600, width: 100, height: 100 });
  assert.deepEqual(clampViewBounds({ x: 2000, y: 2000, width: 50, height: 50 }, bounds), { x: 1000, y: 700, width: 0, height: 0 });
  for (const bad of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 }, null]) {
    assert.throws(() => clampViewBounds(bad, bounds), (e) => e.code === 'UNSUPPORTED');
  }
  assert.throws(() => clampViewBounds({ x: 0, y: 0, width: 1, height: 1 }, { width: NaN, height: 1 }), (e) => e.code === 'UNSUPPORTED');
});
