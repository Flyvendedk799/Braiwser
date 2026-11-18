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
  const saveButton = guest.doc.getElementById('save'); // absent when a test brings its own markup
  if (saveButton) saveButton.addEventListener('click', () => { guest.doc.getElementById('status').textContent = 'Saved'; });
  const broker = createDebuggerBroker();
  const driver = createElectronDriver({ debuggerBroker: broker });
  const events = [];
  const pageId = driver.registerGuest(guest.wc);
  return { guest, broker, driver, events, pageId, open: () => driver.open({ onPageEvent: (e) => events.push(e) }) };
}

const byName = (o, name, role) => o.nodes.find((n) => n.name === name && (!role || n.role === role));
const clickCmd = (o, node, extra) => ({ driverDocumentEpoch: o.documentEpoch, observationId: o.observationId, action: { kind: 'click', refId: node.refId, ...(extra || {}) } });
const control = (calls) => ({ signal: null, check() { calls.check += 1; }, beforeDispatch() { calls.before += 1; } });

test('capabilities are conservative: only what electron.native.test.js proved on real Electron is switched on', () => {
  const caps = createElectronDriver().capabilities();
  assert.equal(caps.driver, 'electron-embedded');
  for (const k of ['frames', 'canvas', 'popups', 'downloads', 'uploads', 'dialogs', 'permissions', 'viewport']) {
    assert.equal(caps[k], false, k);
  }
  // natively confirmed (see electron.native.test.js); everything else above stays off
  assert.equal(caps.shadowDom, true);
  assert.equal(caps.notes.shadowDom, 'open-only');
  assert.equal(caps.screenshots, true);
  assert.deepEqual(caps.actions, ['click', 'fill', 'press', 'select', 'check', 'navigate']);
  assert.deepEqual(caps.modes, ['visible']);
  assert.equal(caps.liveModeSwitch, false);
  assert.match(caps.notes.status, /native confirmation/);
  assert.match(caps.notes.select, /script-made/);
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
  await assert.rejects(page.setOwnerBadge('root'), (e) => e.code === 'UNSUPPORTED');
});

test('screenshot: viewport or a clip inside it; an empty image and a zero-sized viewport are refused', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const whole = await page.screenshot();
  assert.deepEqual(whole.meta.viewport, { width: 1280, height: 8000 });
  assert.deepEqual([whole.meta.clip, whole.meta.transformed, whole.meta.documentEpoch], [null, false, page.documentEpoch]);
  assert.ok(Buffer.isBuffer(whole.bytes) && whole.bytes.length > 0);
  assert.deepEqual(guest.wc.captures.at(-1), { badgeHidden: true }, 'no rectangle is passed for the whole viewport');

  const clipped = await page.screenshot({ clip: { x: 10.4, y: 20.6, width: 100, height: 50 } });
  assert.deepEqual(clipped.meta.clip, { x: 10, y: 21, width: 100, height: 50 });
  assert.deepEqual(guest.wc.captures.at(-1).rect, { x: 10, y: 21, width: 100, height: 50 });

  const before = guest.wc.captures.length;
  for (const clip of [{ x: -1, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 1281, height: 5 }, { x: 0, y: 7990, width: 5, height: 11 },
    { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: 0, width: NaN, height: 5 }, { x: 0, y: 0, width: 5 }]) {
    await assert.rejects(page.screenshot({ clip }), (e) => e.code === 'UNSUPPORTED' && e.detail === 'CLIP_INVALID');
  }
  assert.equal(guest.wc.captures.length, before, 'an invalid clip never reaches capturePage');

  guest.wc.captureEmpty = true; // what a hidden or zero-sized view returns
  await assert.rejects(page.screenshot(), (e) => e.code === 'UNAVAILABLE' && e.detail === 'CAPTURE_EMPTY');
  await assert.rejects(page.capture(), (e) => e.code === 'UNAVAILABLE' && e.detail === 'CAPTURE_EMPTY');
  guest.wc.captureEmpty = false;
  Object.defineProperty(guest.win, 'innerWidth', { value: 0, configurable: true });
  await assert.rejects(page.screenshot(), (e) => e.code === 'UNAVAILABLE' && e.detail === 'NOT_CAPTURABLE');
  await session.close();
});

test('capture: the whole viewport, or exactly the box of one observed element; never a stale or oversized one', async () => {
  const { guest, pageId, open } = setup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const whole = await page.capture();
  assert.equal(whole.meta.clip, null);

  const save = byName(o, 'Save', 'button');
  const box = guest.doc.getElementById('save').getBoundingClientRect();
  const shot = await page.capture({ refId: save.refId });
  assert.deepEqual(shot.meta.clip, { x: box.left, y: box.top, width: box.width, height: box.height });
  assert.deepEqual(guest.wc.captures.at(-1).rect, shot.meta.clip);
  assert.equal(shot.meta.transformed, false);
  assert.ok(guest.dbg.calls.every((c) => !['Runtime.evaluate', 'Runtime.compileScript'].includes(c.method)), 'no general eval path');

  const before = guest.wc.captures.length;
  await assert.rejects(page.capture({ refId: 'r_nope' }), (e) => e.code === 'STALE_REF' && e.detail === 'REF_UNKNOWN');
  await assert.rejects(page.capture({ refId: byName(o, 'Delete').refId }), (e) => e.code === 'AMBIGUOUS_TARGET');
  // an element that does not fit in the viewport is refused rather than cropped
  Object.defineProperty(guest.win, 'innerHeight', { value: box.top + 5, configurable: true });
  await assert.rejects(page.capture({ refId: save.refId }), (e) => e.code === 'UNAVAILABLE' && e.detail === 'NOT_CAPTURABLE');
  Object.defineProperty(guest.win, 'innerHeight', { value: 8000, configurable: true });
  // a node that was hidden since it was observed is a changed target
  guest.doc.getElementById('save').setAttribute('hidden', '');
  await assert.rejects(page.capture({ refId: save.refId }), (e) => e.code === 'STALE_REF' && e.detail === 'TARGET_CHANGED');
  guest.doc.getElementById('save').removeAttribute('hidden');
  // the document moved on
  guest.wc.emit('did-navigate', {}, 'http://guest.test/next');
  await assert.rejects(page.capture({ refId: save.refId }), (e) => e.code === 'STALE_REF');
  assert.equal(guest.wc.captures.length, before, 'no refused capture ever reached capturePage');
  await session.close();
});

const SELECT_PAGE = `<!doctype html><html><head><title>Select</title></head><body><main>
  <label>Plan <select id="plan">
    <option value="free">Free</option><option value="pro">Pro tier</option>
    <option value="legacy" disabled>Legacy</option>
    <optgroup label="Retired" disabled><option value="retired">Retired plan</option></optgroup>
    <option value="dup">Duplicate A</option><option value="dup">Duplicate B</option>
    <option value="x1">Same label</option><option value="x2">Same label</option>
  </select></label>
  <label>Locked <select id="locked" disabled><option value="a">A</option><option value="b">B</option></select></label>
  <button id="apply" type="button">Apply</button>
</main></body></html>`;

function selectSetup() {
  const s = setup({ html: SELECT_PAGE });
  const seen = [];
  const plan = s.guest.doc.getElementById('plan');
  for (const type of ['input', 'change']) plan.addEventListener(type, (e) => seen.push(`${type}:${plan.value}:${e.bubbles}`));
  return { ...s, seen, plan };
}
const selectCmd = (o, node, value) => ({ driverDocumentEpoch: o.documentEpoch, observationId: o.observationId, action: { kind: 'select', refId: node.refId, value } });

test('select: exactly one option by value, input+change when the selection changed, selection read back', async () => {
  const { guest, pageId, open, seen, plan } = selectSetup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const node = byName(o, 'Plan', 'combobox');
  const calls = { check: 0, before: 0 };
  const res = await page.act(selectCmd(o, node, 'pro'), control(calls));
  assert.equal(res.status, 'verified');
  assert.deepEqual(res.evidence, [{ kind: 'selected', observed: true, matches: true, count: 1, documentEpoch: o.documentEpoch }]);
  assert.equal(plan.value, 'pro');
  assert.deepEqual(seen, ['input:pro:true', 'change:pro:true']);
  assert.equal(calls.before, 1, 'beforeDispatch ran once, right before the selection');
  assert.ok(guest.dbg.calls.every((c) => !c.method.startsWith('Input.')), 'no pointer or key input is sent for a select');
  assert.ok(guest.dbg.calls.every((c) => !['Runtime.evaluate', 'Runtime.compileScript'].includes(c.method)), 'no general eval path');

  // selecting what is already selected changes nothing and fires nothing
  const again = await page.act(selectCmd(o, node, 'pro'), control(calls));
  assert.equal(again.status, 'verified');
  assert.equal(seen.length, 2);

  // no option has the VALUE "Free", exactly one has that LABEL: it is selected, but not verified as value "Free"
  const byLabel = await page.act(selectCmd(o, node, 'Free'), control(calls));
  assert.equal(plan.value, 'free');
  assert.equal(byLabel.status, 'dispatched');
  assert.equal(byLabel.evidence[0].matches, false);

  // an expectation is evaluated after the selection
  const expected = await page.act({ ...selectCmd(o, node, 'pro'), action: { kind: 'select', refId: node.refId, value: 'pro', expect: { kind: 'exists', selector: '#plan' } } }, control(calls));
  assert.equal(expected.status, 'verified');
  await session.close();
});

test('select refusals dispatch nothing: unknown, disabled, ambiguous, wrong element, bad value, covered, stale', async () => {
  const { guest, pageId, open, seen, plan } = selectSetup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const node = byName(o, 'Plan', 'combobox');
  const calls = { check: 0, before: 0 };
  const refuse = async (target, value, code, detail) => {
    const err = await page.act(selectCmd(o, target, value), control(calls)).then(() => null, (e) => e);
    assert.ok(err, `${value} should be refused`);
    assert.deepEqual([err.code, err.detail, err.dispatched], [code, detail, false], err.message);
  };
  await refuse(node, 'nope', 'UNAVAILABLE', 'OPTION_NOT_FOUND');
  await refuse(node, 'legacy', 'UNAVAILABLE', 'OPTION_DISABLED');
  await refuse(node, 'retired', 'UNAVAILABLE', 'OPTION_DISABLED');
  await refuse(node, 'dup', 'AMBIGUOUS_TARGET', 'OPTION_AMBIGUOUS');
  await refuse(node, 'Same label', 'AMBIGUOUS_TARGET', 'OPTION_AMBIGUOUS');
  await refuse(byName(o, 'Locked', 'combobox'), 'b', 'UNAVAILABLE', 'NOT_ACTIONABLE');
  await refuse(byName(o, 'Apply', 'button'), 'pro', 'UNSUPPORTED', 'SELECT_UNSUPPORTED');
  await refuse(node, 'x'.repeat(501), 'UNSUPPORTED', 'VALUE_INVALID');
  await assert.rejects(page.act({ ...selectCmd(o, node, 'pro'), action: { kind: 'select', refId: node.refId } }, control(calls)), (e) => e.detail === 'VALUE_INVALID');
  guest.state.coverBy = guest.doc.getElementById('apply');
  await refuse(node, 'pro', 'UNAVAILABLE', 'NOT_ACTIONABLE');
  guest.state.coverBy = null;
  plan.multiple = true;
  await refuse(node, 'pro', 'STALE_REF', 'TARGET_CHANGED'); // it is a different control now (listbox)
  plan.multiple = false;
  guest.wc.emit('did-navigate', {}, 'http://guest.test/next');
  await refuse(node, 'pro', 'STALE_REF', 'STALE_DOCUMENT');
  assert.equal(calls.before, 0, 'beforeDispatch was never reached');
  assert.deepEqual(seen, []);
  assert.equal(plan.value, 'free', 'the selection never changed');
  await session.close();
});

test('select: options that change between the decision and the selection are not guessed at', async () => {
  const { pageId, open, seen, plan } = selectSetup();
  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const node = byName(o, 'Plan', 'combobox');
  // the page swaps the option list at the last moment (here: when the broker's final check runs)
  const hostile = { signal: null, check() {}, beforeDispatch() { plan.options[1].value = 'enterprise'; } };
  const err = await page.act(selectCmd(o, node, 'pro'), hostile).then(() => null, (e) => e);
  assert.deepEqual([err.code, err.detail], ['STALE_REF', 'TARGET_CHANGED']);
  assert.equal(err.dispatched, true, 'the dispatch gate was passed, so the driver does not claim "nothing happened"');
  assert.equal(plan.selectedIndex, 0);
  assert.deepEqual(seen, []);
  await session.close();
});

const SHADOW_PAGE = `<!doctype html><html><head><title>Shadow</title></head><body><main>
  <div id="open-host"></div><div id="closed-host"></div><div id="nested-host"></div>
  <div role="status" id="log">idle</div>
</main></body></html>`;

test('open shadow roots are traversed (also nested), closed roots are not, and a shadow node is clicked at its own point', async () => {
  const s = setup({ html: SHADOW_PAGE });
  const { guest, pageId, open } = s;
  const doc = guest.doc;
  const log = doc.getElementById('log');
  const openRoot = doc.getElementById('open-host').attachShadow({ mode: 'open' });
  openRoot.innerHTML = '<button id="shadow-btn" type="button">Shadow action</button>';
  openRoot.getElementById('shadow-btn').addEventListener('click', () => { log.textContent = 'shadow clicked'; });
  doc.getElementById('closed-host').attachShadow({ mode: 'closed' }).innerHTML = '<button type="button">Closed action</button>';
  const outer = doc.getElementById('nested-host').attachShadow({ mode: 'open' });
  outer.innerHTML = '<div id="inner-host"></div>';
  const inner = outer.getElementById('inner-host').attachShadow({ mode: 'open' });
  inner.innerHTML = '<button id="deep" type="button">Deep action</button>';
  inner.getElementById('deep').addEventListener('click', () => { log.textContent = 'deep clicked'; });

  const session = await open();
  const page = session.pages.get(pageId);
  const o = await page.observe();
  const shadowBtn = byName(o, 'Shadow action', 'button');
  const deep = byName(o, 'Deep action', 'button');
  assert.ok(shadowBtn && shadowBtn.refId && deep && deep.refId);
  assert.ok(!byName(o, 'Closed action'), 'a closed root is never traversed');
  assert.equal(o.coverage.shadowRootsOpen, 3);

  const calls = { check: 0, before: 0 };
  const r1 = await page.act(clickCmd(o, shadowBtn), control(calls));
  assert.equal(log.textContent, 'shadow clicked');
  assert.equal(r1.status, 'verified');
  const pressed = guest.dbg.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed').at(-1).params;
  const box = openRoot.getElementById('shadow-btn').getBoundingClientRect();
  assert.deepEqual([pressed.x, pressed.y], [box.left + box.width / 2, box.top + box.height / 2], 'the click lands on the shadow node, not its host');
  const r2 = await page.act(clickCmd(o, deep), control(calls));
  assert.equal(log.textContent, 'deep clicked');
  assert.equal(r2.status, 'verified');

  // a shadow node that is replaced is stale, exactly like a light-DOM node
  openRoot.innerHTML = '<button type="button">Shadow action</button>';
  const err = await page.act(clickCmd(o, shadowBtn), control(calls)).then(() => null, (e) => e);
  assert.equal(err.code, 'STALE_REF');
  // the element behind a shadow ref can be captured on its own
  const o2 = await page.observe();
  const shot = await page.capture({ refId: byName(o2, 'Deep action').refId });
  const deepBox = inner.getElementById('deep').getBoundingClientRect();
  assert.deepEqual(shot.meta.clip, { x: deepBox.left, y: deepBox.top, width: deepBox.width, height: deepBox.height });
  await session.close();
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
