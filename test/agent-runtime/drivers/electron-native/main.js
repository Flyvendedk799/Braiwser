'use strict';
// REAL Electron. This is an Electron MAIN script, started by ../electron.native.test.js:
//
//   electron test/agent-runtime/drivers/electron-native/main.js
//
// It drives the production Electron-embedded driver (drivers/electron.js) with the production debugger broker
// against two real guests showing LOCAL fixtures (127.0.0.1):
//   * `view`     a main-owned WebContentsView created by guest-views.js (what newPage() makes in the app)
//   * `webview`  a <webview> tag inside the window, registered through watchHost() (what a shell tab is)
// and checks, for each of them, the things the capability document claims: open shadow roots, the `select`
// action, and screenshots (viewport, clip, one element), with the pixels compared against known colours.
//
// Output: one line `NATIVE_RESULT <json>` with { electron, chrome, checks: [{ guest, name, ok, error }] }.
// Exit code 0 only when every check passed.

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const { createElectronDriver } = require(path.join(ROOT, 'src/main/services/browser/drivers/electron'));
const { createDebuggerBroker } = require(path.join(ROOT, 'src/main/services/browser/debugger-broker'));
const { createGuestViews } = require(path.join(ROOT, 'src/main/services/browser/guest-views'));
const { startFixtureServer } = require(path.join(ROOT, 'test/fixtures/agent-sites/server'));

const WIDTH = 1000;
const HALF = 350;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const control = { signal: null, check() {}, beforeDispatch() {} };
const byName = (o, name, role) => o.nodes.find((n) => n.name === name && (!role || n.role === role));
const cmd = (o, action) => ({ driverDocumentEpoch: o.documentEpoch, observationId: o.observationId, action });

async function rejects(promise, code, detail) {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected ${code}/${detail} but the call resolved`);
  assert.equal(`${err.code}/${err.detail}`, `${code}/${detail}`);
  return err;
}

// Decode the PNG the driver returned and read pixels from it (BGRA rows).
function decode(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 8, 'bytes');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  return {
    size,
    at(x, y) { const i = (y * size.width + x) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]; }, // -> [r, g, b]
  };
}

const RED = [255, 0, 0];
const GREEN = [0, 128, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

function checksFor(page, url) {
  const statusText = async () => (await page.evaluateAssertion({ kind: 'text', target: { by: 'role', role: 'status' }, expected: '' }));
  const logIs = async (expected) => {
    const r = await page.evaluateAssertion({ kind: 'text', selector: '#log', expected, match: 'equals' }, { timeoutMs: 1500 });
    assert.equal(r.status, 'passed', `#log: ${JSON.stringify(r.actual)}`);
  };
  void statusText;
  return {
    async 'shadow: an element inside an OPEN shadow root is observed, clicked with a trusted click, and the closed root stays invisible'() {
      assert.equal((await page.navigate(url('shadow.html'))).outcome, 'ready');
      const o = await page.observe();
      const inner = byName(o, 'Shadow action', 'button');
      assert.ok(inner && inner.refId, 'the button inside the open root has a ref');
      assert.ok(!byName(o, 'Closed action'), 'nothing inside the closed root is observed');
      assert.ok(o.coverage.shadowRootsOpen >= 1, JSON.stringify(o.coverage));
      const r = await page.act(cmd(o, { kind: 'click', refId: inner.refId }), control);
      const clicked = r.evidence.find((e) => e.kind === 'clicked');
      assert.ok(clicked && clicked.matches === true && clicked.trusted >= 1, JSON.stringify(r));
      assert.equal(r.status, 'verified');
      await logIs('shadow clicked');
    },

    async 'select: the option is chosen by value, the page sees input+change, and the selection is read back'() {
      assert.equal((await page.navigate(url('select.html'))).outcome, 'ready');
      let o = await page.observe();
      const plan = byName(o, 'Plan', 'combobox');
      assert.ok(plan && plan.refId, 'the <select> is observed');
      const r = await page.act(cmd(o, { kind: 'select', refId: plan.refId, value: 'pro' }), control);
      assert.equal(r.status, 'verified', JSON.stringify(r));
      assert.deepEqual(r.evidence.find((e) => e.kind === 'selected'), { kind: 'selected', observed: true, matches: true, count: 1, documentEpoch: o.documentEpoch });
      await logIs('input:plan=pro:script | change:plan=pro:script');
      // the same value again changes nothing and fires nothing
      const again = await page.act(cmd(o, { kind: 'select', refId: plan.refId, value: 'pro' }), control);
      assert.equal(again.status, 'verified');
      await logIs('input:plan=pro:script | change:plan=pro:script');
      // by label when no value matches: selected, but not "verified" as that value
      const byLabel = await page.act(cmd(o, { kind: 'select', refId: plan.refId, value: 'Free' }), control);
      assert.equal(byLabel.status, 'dispatched', JSON.stringify(byLabel));
      await logIs('input:plan=pro:script | change:plan=pro:script | input:plan=free:script | change:plan=free:script');
    },

    async 'select: unknown, disabled and duplicate options, a disabled list and a non-select are refused with nothing dispatched'() {
      assert.equal((await page.navigate(url('select.html'))).outcome, 'ready');
      const o = await page.observe();
      const plan = byName(o, 'Plan', 'combobox');
      const calls = { before: 0 };
      const counting = { signal: null, check() {}, beforeDispatch() { calls.before += 1; } };
      const refuse = async (refId, value, code, detail) => {
        const err = await rejects(page.act(cmd(o, { kind: 'select', refId, value }), counting), code, detail);
        assert.equal(err.dispatched, false);
      };
      await refuse(plan.refId, 'nope', 'UNAVAILABLE', 'OPTION_NOT_FOUND');
      await refuse(plan.refId, 'legacy', 'UNAVAILABLE', 'OPTION_DISABLED');
      await refuse(plan.refId, 'retired', 'UNAVAILABLE', 'OPTION_DISABLED');
      await refuse(plan.refId, 'dup', 'AMBIGUOUS_TARGET', 'OPTION_AMBIGUOUS');
      const locked = byName(o, 'Locked', 'combobox');
      if (locked && locked.refId) await refuse(locked.refId, 'b', 'UNAVAILABLE', 'NOT_ACTIONABLE');
      // select on something that is not a <select>
      const save = byName(o, 'Apply', 'button');
      await refuse(save.refId, 'pro', 'UNSUPPORTED', 'SELECT_UNSUPPORTED');
      // a multiple-selection list is observed but gets no ref from the shared probe, so it cannot be targeted at all
      const toppings = o.nodes.find((n) => n.role === 'listbox');
      assert.ok(!toppings || !toppings.refId, JSON.stringify(toppings));
      assert.equal(calls.before, 0, 'beforeDispatch was never reached');
      await logIs('idle');
    },

    async 'screenshot: the viewport PNG has the viewport size and the page\'s real pixels'() {
      assert.equal((await page.navigate(url('pixels.html'))).outcome, 'ready');
      await sleep(250); // let the first frame paint
      const shot = await page.screenshot();
      assert.equal(shot.meta.transformed, false);
      assert.equal(shot.meta.clip, null);
      assert.deepEqual(shot.meta.viewport, { width: WIDTH, height: HALF });
      const img = decode(shot.bytes);
      assert.deepEqual(img.size, { width: Math.round(WIDTH * shot.meta.scale), height: Math.round(HALF * shot.meta.scale) });
      const s = shot.meta.scale;
      const px = (x, y) => img.at(Math.round(x * s), Math.round(y * s));
      assert.deepEqual(px(10, 10), GREEN, 'background');
      assert.deepEqual(px(140, 110), RED, 'inside the red block');
      assert.deepEqual(px(360, 100), BLUE, 'inside the blue block');
      assert.deepEqual(px(260, 100), GREEN, 'between the blocks');
    },

    async 'screenshot: a clip returns exactly that rectangle; a clip outside the viewport is refused'() {
      assert.equal((await page.navigate(url('pixels.html'))).outcome, 'ready');
      await sleep(250);
      const clip = { x: 30, y: 50, width: 60, height: 40 }; // straddles the red block's top-left corner (40, 60)
      const shot = await page.screenshot({ clip });
      assert.deepEqual(shot.meta.clip, clip);
      const img = decode(shot.bytes);
      const s = shot.meta.scale;
      assert.deepEqual(img.size, { width: Math.round(60 * s), height: Math.round(40 * s) });
      assert.deepEqual(img.at(Math.round(3 * s), Math.round(3 * s)), GREEN, 'outside the block');
      assert.deepEqual(img.at(Math.round(30 * s), Math.round(25 * s)), RED, 'inside the block');
      await rejects(page.screenshot({ clip: { x: 0, y: 0, width: WIDTH + 1, height: 10 } }), 'UNSUPPORTED', 'CLIP_INVALID');
      await rejects(page.screenshot({ clip: { x: -1, y: 0, width: 10, height: 10 } }), 'UNSUPPORTED', 'CLIP_INVALID');
    },

    async 'capture: one observed element, also after scrolling to it; an element larger than the viewport is refused'() {
      assert.equal((await page.navigate(url('pixels.html'))).outcome, 'ready');
      await sleep(250);
      const o = await page.observe();
      const whole = await page.capture();
      assert.equal(whole.meta.clip, null);
      assert.deepEqual(decode(whole.bytes).size, { width: Math.round(WIDTH * whole.meta.scale), height: Math.round(HALF * whole.meta.scale) });

      const blue = await page.capture({ refId: byName(o, 'Blue block').refId });
      const s = blue.meta.scale;
      const b = decode(blue.bytes);
      assert.deepEqual([blue.meta.clip.width, blue.meta.clip.height], [120, 80]);
      assert.deepEqual(b.size, { width: Math.round(120 * s), height: Math.round(80 * s) });
      for (const [x, y] of [[2, 2], [60, 40], [117, 77]]) assert.deepEqual(b.at(Math.round(x * s), Math.round(y * s)), BLUE, `blue at ${x},${y}`);

      // 3000px down the page: the driver scrolls it into view first and reports where the viewport ended up
      const far = await page.capture({ refId: byName(o, 'Far block').refId });
      const f = decode(far.bytes);
      assert.deepEqual(f.size, { width: Math.round(90 * s), height: Math.round(50 * s) });
      assert.deepEqual(f.at(Math.round(45 * s), Math.round(25 * s)), YELLOW);
      assert.ok(far.meta.scroll.y > 2000, JSON.stringify(far.meta.scroll));

      await rejects(page.capture({ refId: byName(o, 'Huge block').refId }), 'UNAVAILABLE', 'NOT_CAPTURABLE');
      await rejects(page.capture({ refId: 'r_0000000000000000' }), 'STALE_REF', 'REF_UNKNOWN');
      await page.navigate(url('task.html'));
      await rejects(page.capture({ refId: byName(o, 'Blue block').refId }), 'STALE_REF', 'STALE_DOCUMENT');
    },

    async 'screenshot: the owner badge is not in the picture and is back afterwards'() {
      assert.equal((await page.navigate(url('pixels.html'))).outcome, 'ready');
      await page.setOwnerBadge('agent');
      await sleep(250);
      const state = await page.badgeState();
      assert.equal(state.owner, 'agent');
      const img = decode((await page.screenshot()).bytes);
      const colours = new Set();
      // every pixel inside the two scrollbars; the badge (coloured, with a shadow) would add colours of its own
      const k = img.size.width / WIDTH;
      const right = img.size.width - Math.round(40 * k);
      const bottom = img.size.height - Math.round(40 * k);
      for (let y = 0; y < bottom; y += 1) for (let x = 0; x < right; x += 1) colours.add(img.at(x, y).join(','));
      assert.deepEqual([...colours].sort(), [BLUE, GREEN, RED].map((c) => c.join(',')).sort(), 'only the page\'s own three colours');
      assert.equal((await page.badgeState()).owner, 'agent', 'the badge is still there after the shot');
      await page.setOwnerBadge('none');
    },
  };
}

async function main() {
  const fixtures = await startFixtureServer();
  const url = (file) => `${fixtures.origin}/${file}`;
  const win = new BrowserWindow({ width: WIDTH, height: HALF * 2, useContentSize: true, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const views = createGuestViews({ getWindow: () => win });
  const driver = createElectronDriver({ debuggerBroker: createDebuggerBroker(), createGuest: () => views.create() });
  driver.watchHost(win.webContents);

  // <webview> guest in the lower half; it registers itself through did-attach-webview.
  const host = `<!doctype html><body style="margin:0;background:#888"><webview src="${url('task.html')}" style="position:fixed;left:0;top:${HALF}px;width:${WIDTH}px;height:${HALF}px"></webview></body>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(host)}`);
  for (let i = 0; i < 100 && driver.guestPageIds().length === 0; i += 1) await sleep(50);
  assert.equal(driver.guestPageIds().length, 1, 'the <webview> guest registered itself');

  const session = await driver.open({ mode: 'visible' });
  const webviewPage = session.pages.values().next().value;
  // Main-owned view in the upper half (zero-sized until placed, exactly as in the app).
  const viewPage = await session.newPage();
  const checks = [];
  const record = async (guest, name, fn) => {
    try { await fn(); checks.push({ guest, name, ok: true }); } catch (err) {
      checks.push({ guest, name, ok: false, error: String((err && (err.stack || err.message)) || err).slice(0, 1500) });
    }
  };

  await record('view', 'a zero-sized main-owned view cannot be photographed (honest refusal, not an empty image)', async () => {
    assert.equal((await viewPage.navigate(url('pixels.html'))).outcome, 'ready');
    const err = await viewPage.screenshot().then(() => null, (e) => e);
    assert.ok(err && err.code === 'UNAVAILABLE' && ['NOT_CAPTURABLE', 'CAPTURE_EMPTY'].includes(err.detail), String(err && `${err.code}/${err.detail}`));
  });
  views.place({ x: 0, y: 0, width: WIDTH, height: HALF });
  await sleep(300);

  for (const [guest, page] of [['view', viewPage], ['webview', webviewPage]]) {
    for (const [name, fn] of Object.entries(checksFor(page, url))) await record(guest, name, fn);
  }

  const caps = driver.capabilities();
  process.stdout.write(`NATIVE_RESULT ${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome,
    platform: process.platform, capabilities: { shadowDom: caps.shadowDom, screenshots: caps.screenshots, actions: caps.actions }, checks })}\n`);
  await session.close().catch(() => {});
  views.closeAll();
  await fixtures.close();
  app.exit(checks.every((c) => c.ok) ? 0 : 1);
}

app.on('window-all-closed', () => {});
app.whenReady().then(main).catch((err) => {
  process.stdout.write(`NATIVE_RESULT ${JSON.stringify({ fatal: String((err && (err.stack || err.message)) || err).slice(0, 2000), checks: [] })}\n`);
  app.exit(2);
});
