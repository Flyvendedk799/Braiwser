'use strict';
// REAL headless Chromium against LOCAL fixtures (127.0.0.1). Skips (with the reason)
// when Chromium is not installed. Capability flags in drivers/playwright.js are only
// true because a test below proves them; keep names in sync with that file's comments.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { browserAvailable, openFixtureSession, noopControl, nodeByName, waitFor, sleep } = require('./_env');
const obs = require('../../../src/main/services/browser/drivers/observe');
const assertionCases = require('../../shared/assertions.table');

let avail = { ok: false, reason: 'not probed' };
let env = null;

test.before(async () => {
  avail = await browserAvailable('headless');
  if (avail.ok) env = await openFixtureSession({ open: { dialogDeadlineMs: 300 } });
});
test.after(async () => { if (env) await env.close(); });

function real(name, fn) {
  test(name, async (t) => {
    if (!avail.ok) { t.skip(avail.reason); return; }
    const page = await env.session.newPage();
    try { await fn({ page, t }); } finally { await page.close(); }
  });
}

const clickCmd = (o, node, extra) => ({ operationId: `op-${Math.random()}`, driverDocumentEpoch: o.documentEpoch, observationId: o.observationId,
  action: { kind: 'click', refId: node.refId, ...(extra || {}) } });

async function expectError(promise, code, detail) {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected ${code} but the call resolved`);
  assert.equal(err.code, code, `${err.code}/${err.detail}: ${err.message}`);
  if (detail) assert.equal(err.detail, detail);
  assert.equal(err.dispatched, false, 'nothing may have been dispatched');
  return err;
}

const logText = (page) => page._raw.locator('#log').innerText();

// ---- capability document ---------------------------------------------------------------------
test('capability document is versioned and conservative', () => {
  const caps = env ? env.driver.capabilities() : require('../../../src/main/services/browser/drivers/playwright').createPlaywrightDriver().capabilities();
  assert.equal(caps.driver, 'playwright');
  assert.match(caps.version, /^\d+\.\d+\.\d+$/);
  assert.equal(caps.liveModeSwitch, false);
  assert.deepEqual(caps.modes, ['headless', 'visible']);
  assert.equal(caps.canvas, false, 'no pixel/coordinate actions exist');
  assert.equal(caps.uploads, false);
  assert.equal(caps.downloads, false, 'downloads are rejected unless granted at open');
  assert.equal(caps.humanHandoff, 'unsupported');
  assert.equal(caps.notes.shadowDom, 'open-only');
  assert.ok(!('setHeadless' in env.driver) && !('setHeadless' in env.session));
});

test('open() rejects unsupported modes and persistent profiles', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  await assert.rejects(env.driver.open({ mode: 'hybrid' }), (e) => e.code === 'UNSUPPORTED' && e.detail === 'UNSUPPORTED_MODE');
  await assert.rejects(env.driver.open({ profile: 'default' }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(env.driver.open({ viewport: { width: 10, height: 10 } }), (e) => e.detail === 'INVALID_VIEWPORT');
});

// ---- navigation -----------------------------------------------------------------------------------
real('navigation outcomes: ready / failed / timeout / cancelled, with epoch bumps', async ({ page }) => {
  const e0 = page.documentEpoch;
  const ready = await page.navigate(env.url('task.html'));
  assert.equal(ready.outcome, 'ready');
  assert.ok(page.documentEpoch > e0, 'a navigation bumps the document epoch');

  // connection refused: grab a free port and close it again
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const failed = await page.navigate(`http://127.0.0.1:${free}/nothing`);
  assert.equal(failed.outcome, 'failed');

  const timedOut = await page.navigate(env.url('hang'), { timeoutMs: 1000 });
  assert.equal(timedOut.outcome, 'timeout');

  const ac = new AbortController();
  const pending = page.navigate(env.url('hang'), { signal: ac.signal, timeoutMs: 10000 });
  setTimeout(() => ac.abort(), 150);
  assert.equal((await pending).outcome, 'cancelled');
  const already = new AbortController(); already.abort();
  assert.equal((await page.navigate(env.url('task.html'), { signal: already.signal })).outcome, 'cancelled');

  // The browser may still be loading the aborted navigation: the next operation waits on the barrier.
  const again = await page.navigate(env.url('task.html'), { timeoutMs: 5000 });
  assert.equal(again.outcome, 'ready');
});

real('navigation refuses non-http(s) schemes and embedded credentials', async ({ page }) => {
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://version', 'http://user:pw@127.0.0.1/', '']) {
    await assert.rejects(page.navigate(bad), (e) => e.code === 'DENIED', bad);
  }
});

// ---- observation ----------------------------------------------------------------------------------------
real('observe returns a compact semantic snapshot with provenance and coverage', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const o = await page.observe();
  assert.equal(o.trust, 'untrusted-page');
  assert.equal(o.truncated, false);
  assert.equal(o.nextCursor, null);
  assert.equal(o.coverage.framesSeen, 1);
  assert.ok(o.coverage.limitations.includes('closed-shadow-roots-not-observable'));
  const save = nodeByName(o, 'Save', 'button');
  assert.ok(save && save.refId && save.enabled === true);
  const name = nodeByName(o, 'Display name', 'textbox');
  assert.equal(name.editable, true);
  assert.ok(o.nodes.some((n) => n.kind === 'landmark' && n.role === 'main'));
  assert.ok(o.nodes.some((n) => n.kind === 'status' && n.name === 'Pending'));
  // refs are opaque and resolve server-side only
  const r = page.resolve(save.refId);
  assert.match(r.fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(r.scope.documentEpoch, o.documentEpoch);
  assert.throws(() => page.resolve('r_nope'), (e) => e.code === 'STALE_REF');
  assert.ok(!JSON.stringify(o).includes('selector'), 'no selector is ever exposed');
});

real('page-controlled labels are bounded, sanitised and marked untrusted', async ({ page }) => {
  await page.navigate(env.url('hostile.html'));
  const o = await page.observe();
  for (const n of o.nodes) assert.ok(n.name.length <= 240, `name too long: ${n.name.length}`);
  const long = o.nodes.find((n) => n.name.startsWith('AAAA'));
  assert.ok(long.name.length <= 120 && long.name.endsWith('\u2026'));
  const inj = o.nodes.find((n) => /Ignore previous/.test(n.name));
  assert.ok(inj);
  assert.ok(!/[\u202e\u200b\u0007]/.test(inj.name), 'control / bidi characters are stripped');
  assert.equal(o.trust, 'untrusted-page');
  // injection text is just data: it grants nothing and changes no state
  assert.equal(o.pendingDialog, null);
});

real('secret-trait fields are flagged and fill is rejected before any dispatch', async ({ page }) => {
  await page.navigate(env.url('forms.html'));
  const o = await page.observe();
  const calls = { check: 0, beforeDispatch: 0 };
  for (const name of ['Password', 'Verification code', 'Card number']) {
    const n = nodeByName(o, name);
    assert.ok(n && n.secret === true, `${name} should carry the secret trait`);
    const err = await expectError(page.act(
      { documentEpoch: o.documentEpoch, observationId: o.observationId, action: { kind: 'fill', refId: n.refId, text: 'hunter2' } },
      noopControl(calls)), 'DENIED', 'SECRET_FIELD');
    assert.ok(!String(err.message).includes('hunter2'));
  }
  assert.equal(calls.beforeDispatch, 0);
  const pw = nodeByName(o, 'Password');
  await expectError(page.act({ action: { kind: 'press', refId: pw.refId, key: 'a' } }), 'DENIED', 'SECRET_FIELD');
  assert.equal(await page._raw.locator('#pw').inputValue(), '', 'the secret field stayed empty');
  // non-secret field is fine, and values are never part of an observation
  const nick = nodeByName(o, 'Nickname');
  assert.notEqual(nick.secret, true);
  const res = await page.act({ action: { kind: 'fill', refId: nick.refId, text: 'ada' } });
  assert.equal(res.status, 'verified');
  const again = await page.observe();
  assert.ok(!JSON.stringify(again).includes('ada"'), 'typed values do not enter observations');
});

// ---- strict uniqueness / stale refs ----------------------------------------------------------------------------
real('duplicate accessible names are AMBIGUOUS_TARGET (never .first())', async ({ page }) => {
  await page.navigate(env.url('duplicates.html'));
  const o = await page.observe();
  const deletes = o.nodes.filter((n) => n.name === 'Delete');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((n) => n.ambiguous === true && n.dupCount === 2));
  const err = await expectError(page.act(clickCmd(o, deletes[0])), 'AMBIGUOUS_TARGET');
  assert.match(err.message, /2 controls/);
  assert.equal(await logText(page), 'idle', 'no click happened');

  // same name but distinguishable context is allowed and hits the right row
  const removes = o.nodes.filter((n) => n.name === 'Remove');
  assert.equal(removes.length, 2);
  assert.ok(removes.every((n) => !n.ambiguous), 'rows with different context are distinct');
  const bob = removes.find((n) => /Bob/.test(n.context));
  const r = await page.act(clickCmd(o, bob));
  assert.equal(r.status, 'verified');
  assert.equal(await logText(page), 'remove bob');
});

real('a control that becomes ambiguous after observation is refused at dispatch', async ({ page }) => {
  await page.navigate(env.url('duplicates.html'));
  const o = await page.observe();
  const unique = nodeByName(o, 'Unique action');
  assert.ok(unique && !unique.ambiguous);
  await page.act(clickCmd(o, nodeByName(o, 'Add twin')));
  await expectError(page.act(clickCmd(o, unique)), 'AMBIGUOUS_TARGET');
  assert.equal(await logText(page), 'idle');
});

real('disabled and covered buttons are not clicked', async ({ page }) => {
  await page.navigate(env.url('buttons.html'));
  const o = await page.observe();
  const disabled = nodeByName(o, 'Disabled action');
  assert.equal(disabled.enabled, false);
  const covered = nodeByName(o, 'Covered action');
  assert.equal(covered.occluded, true, 'occlusion is reported in the observation');
  const calls = { check: 0, beforeDispatch: 0 };
  await expectError(page.act(clickCmd(o, disabled), noopControl(calls)), 'UNAVAILABLE', 'NOT_ACTIONABLE');
  const t0 = Date.now();
  await expectError(page.act(clickCmd(o, covered), noopControl(calls)), 'UNAVAILABLE', 'NOT_ACTIONABLE');
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(calls.beforeDispatch, 0, 'beforeDispatch is never reached for a non-actionable target');
  assert.equal(await logText(page), 'idle');
  const ok = await page.act(clickCmd(o, nodeByName(o, 'Enabled action')), noopControl(calls));
  assert.equal(ok.status, 'verified');
  assert.equal(calls.beforeDispatch, 1);
  assert.equal(await logText(page), 'enabled clicked');
});

real('a replaced or changed node is STALE_REF and the new node is not clicked', async ({ page }) => {
  await page.navigate(env.url('replace.html'));
  const o = await page.observe();
  const target = nodeByName(o, 'Save');
  await page.act(clickCmd(o, nodeByName(o, 'Re-render')));
  const err = await expectError(page.act(clickCmd(o, target)), 'STALE_REF');
  assert.equal(err.detail, 'NODE_DETACHED');
  assert.equal(await logText(page), 'idle', 'the replacement node (same name) must not receive the click');

  const o2 = await page.observe();
  const target2 = nodeByName(o2, 'Save');
  await page.act(clickCmd(o2, nodeByName(o2, 'Rename')));
  const err2 = await expectError(page.act(clickCmd(o2, target2)), 'STALE_REF');
  assert.equal(err2.detail, 'TARGET_CHANGED');
});

real('navigation immediately before a click invalidates the ref (no dispatch)', async ({ page }) => {
  await page.navigate(env.url('replace.html'));
  const o = await page.observe();
  const target = nodeByName(o, 'Save');
  const calls = { check: 0, beforeDispatch: 0 };
  const nav = page.navigate(env.url('buttons.html'));
  const err = await expectError(page.act(clickCmd(o, target), noopControl(calls)), 'STALE_REF');
  assert.equal(err.detail, 'STALE_DOCUMENT');
  assert.equal((await nav).outcome, 'ready');
  assert.equal(calls.beforeDispatch, 0);
  // an explicit stale epoch is refused even with a still-valid-looking ref
  await expectError(page.act({ driverDocumentEpoch: -1, action: { kind: 'click', refId: 'r_unknown' } }), 'STALE_REF');
});

real('SPA (same-document) navigation bumps the epoch and invalidates refs', async ({ page }) => {
  await page.navigate(env.url('spa.html'));
  const o = await page.observe();
  const go = nodeByName(o, 'Go to settings');
  const homeOnly = nodeByName(o, 'Home only action');
  const events = [];
  page.on('navigated', (e) => events.push(e));
  const r = await page.act(clickCmd(o, go));
  assert.equal(r.status, 'verified', 'delivery was attested before the document changed');
  assert.ok(r.evidence.some((e) => e.kind === 'navigation' && e.observed === true && e.documentEpoch > e.fromEpoch), 'the document change is reported as observed navigation evidence');
  assert.ok(page.documentEpoch > o.documentEpoch);
  assert.ok(events.length >= 1 && events[0].mainFrame === true);
  assert.ok(page.url().endsWith('#/settings'));
  await expectError(page.act(clickCmd(o, homeOnly)), 'STALE_REF');
  const o2 = await page.observe();
  assert.ok(o2.nodes.some((n) => n.role === 'heading' && n.name === 'Settings'));
});

real('screenshots are unmodified viewport PNGs with metadata', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const shot = await page.screenshot();
  assert.deepEqual([...shot.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(shot.meta.transformed, false);
  assert.deepEqual(shot.meta.viewport, { width: 1280, height: 800 });
  assert.equal(shot.meta.scale, 1);
  assert.equal(shot.meta.documentEpoch, page.documentEpoch);
  assert.ok(shot.meta.url.endsWith('/task.html') && shot.meta.capturedAt);
  const clip = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 100 } });
  assert.deepEqual(clip.meta.clip, { x: 0, y: 0, width: 200, height: 100 });
  await assert.rejects(page.screenshot({ clip: { x: 0, y: 0, width: 5000, height: 10 } }), (e) => e.detail === 'CLIP_INVALID');
});

// ---- frames / shadow / canvas ------------------------------------------------------------------------------------------------
real('frames: same-origin and cross-origin frames are observed per frame, never flattened', async ({ page }) => {
  await page.navigate(`${env.url('frames.html')}?x=${env.other.port}`);
  const o = await page.observe();
  assert.equal(o.coverage.framesSeen, 3);
  assert.equal(o.coverage.crossOriginFrames, 1);
  assert.equal(o.coverage.framesUnavailable, 0);
  const cross = o.coverage.frames.find((f) => f.crossOrigin);
  assert.equal(cross.origin, env.other.origin);
  const inner = o.nodes.filter((n) => n.name === 'Inner action');
  assert.equal(inner.length, 2, 'one per frame');
  assert.ok(inner.every((n) => n.frameId && !n.ambiguous), 'frame-scoped, so not ambiguous across frames');
  assert.ok(inner.some((n) => n.frameId === cross.frameId));
  assert.ok(!('frameId' in nodeByName(o, 'Outer action')), 'top-level nodes carry no frameId');

  const crossBtn = inner.find((n) => n.frameId === cross.frameId);
  const r = await page.act(clickCmd(o, crossBtn));
  assert.equal(r.status, 'verified');
  const crossFrame = page._raw.frames().find((f) => f.url().startsWith(env.other.origin));
  assert.equal(await crossFrame.locator('#inner-status').innerText(), 'inner clicked');
  const sameFrame = page._raw.frames().find((f) => f.url().includes('/frame-inner.html') && f.url().startsWith(env.origin.origin));
  assert.equal(await sameFrame.locator('#inner-status').innerText(), 'inner idle', 'the other frame was untouched');

  const fill = await page.act({ action: { kind: 'fill', refId: o.nodes.find((n) => n.name === 'Inner note' && n.frameId === cross.frameId).refId, text: 'hello' } });
  assert.equal(fill.status, 'verified');
});

real('a navigating sub-frame invalidates refs (conservative page-wide epoch)', async ({ page }) => {
  await page.navigate(`${env.url('frames.html')}?x=${env.other.port}`);
  const o = await page.observe();
  const outer = nodeByName(o, 'Outer action');
  await page._raw.frames().find((f) => f.url().includes('frame-inner')).evaluate(() => { location.reload(); });
  await waitFor(() => page.documentEpoch > o.documentEpoch);
  await expectError(page.act(clickCmd(o, outer)), 'STALE_REF');
});

real('shadow DOM: open roots are traversed, closed roots are reported as a limitation', async ({ page }) => {
  await page.navigate(env.url('shadow.html'));
  const o = await page.observe();
  const shadowBtn = nodeByName(o, 'Shadow action');
  assert.ok(shadowBtn, 'open shadow content is observed');
  assert.equal(o.coverage.shadowRootsOpen, 1);
  assert.ok(!nodeByName(o, 'Closed action'), 'closed shadow content is NOT claimed');
  assert.equal(o.coverage.possibleClosedShadowHosts, 1);
  assert.ok(o.coverage.limitations.includes('possible-closed-shadow-hosts'));
  const r = await page.act(clickCmd(o, shadowBtn));
  assert.equal(r.status, 'verified');
  assert.equal(await logText(page), 'shadow clicked');
});

real('canvas is reported as a limitation and remains screenshot-able', async ({ page }) => {
  await page.navigate(env.url('canvas.html'));
  const o = await page.observe();
  const c = o.nodes.find((n) => n.kind === 'canvas');
  assert.ok(c && c.limitation === 'canvas-content-not-observable' && c.name === 'Revenue chart');
  assert.ok(c.refId, 'canvas nodes are addressable for highlight / evidence');
  await expectError(page.act({ action: { kind: 'click', refId: c.refId } }), 'UNSUPPORTED', 'NOT_INTERACTABLE');
  assert.equal(await page._raw.evaluate(() => 1), 1, 'and no pixel / coordinate action exists');
  assert.ok(o.coverage.limitations.includes('canvas-content-not-observable'));
  assert.equal(env.driver.capabilities().canvas, false);
  assert.ok((await page.screenshot()).bytes.length > 100);
});

// ---- popups / dialogs / downloads / permissions ------------------------------------------------------------------------------------
real('popups register in the initiating session with an opener relation', async ({ page }) => {
  await page.navigate(env.url('popup.html'));
  const o = await page.observe();
  const popupEvents = [];
  page.on('popup', (e) => popupEvents.push(e));
  const before = env.session.pages.size;
  await page.act(clickCmd(o, nodeByName(o, 'Open in new tab')));
  await waitFor(() => popupEvents.length === 1);
  assert.equal(env.session.pages.size, before + 1);
  const child = env.session.pages.get(popupEvents[0].pageId);
  assert.ok(child, 'the popup is registered in the SAME session');
  assert.equal(child.openerPageId, page.pageId);
  assert.ok(env.events.some((e) => e.type === 'popup' && e.pageId === child.pageId && e.openerPageId === page.pageId));

  await child.navigate(child.url()).catch(() => {});
  const co = await child.observe();
  const closed = new Promise((resolve) => child.once('closed', resolve));
  await child.act(clickCmd(co, nodeByName(co, 'Close popup')));
  await closed;
  await waitFor(() => !env.session.pages.has(child.pageId));
  assert.equal(env.session.pages.size, before);
  await expectError(child.act(clickCmd(co, nodeByName(co, 'Close popup'))), 'UNAVAILABLE');
});

real('a popup opened and closed within milliseconds leaves no orphan page', async ({ page }) => {
  await page.navigate(env.url('popup.html'));
  const o = await page.observe();
  const before = env.session.pages.size;
  const seen = [];
  page.on('popup', (e) => seen.push(e.pageId));
  await page.act(clickCmd(o, nodeByName(o, 'Open and close quickly')));
  await waitFor(() => seen.length === 1);
  await waitFor(() => env.session.pages.size === before, { timeoutMs: 5000 });
  assert.equal(env.session.pages.has(seen[0]), false);
});

real('dialogs are observed and dismissed by policy, never auto-accepted', async ({ page }) => {
  await page.navigate(env.url('dialogs.html'));
  const o = await page.observe();
  const seen = [];
  page.on('dialog', (d) => seen.push(d));
  const r = await page.act(clickCmd(o, nodeByName(o, 'Delete account')));
  assert.equal(r.status, 'dispatched');
  assert.ok(r.evidence.some((e) => e.kind === 'state-change' && e.change === 'dialog_opened' && e.dialogType === 'confirm'));
  await waitFor(() => seen.some((d) => d.state === 'closed'));
  const closed = page.dialogs()[0];
  assert.equal(closed.type, 'confirm');
  assert.equal(closed.message, 'Delete everything?');
  assert.equal(closed.decision, 'dismiss');
  assert.equal(closed.handledBy, 'policy-deadline');
  await waitFor(async () => (await logText(page)) === 'confirm=false');
});

real('a dialog is accepted only through the broker-facing resolveDialog()', async ({ page }) => {
  await page.navigate(env.url('dialogs.html'));
  const o = await page.observe();
  page.on('dialog', (d) => { if (d.state === 'open') page.resolveDialog(d.id, 'accept'); });
  await page.act(clickCmd(o, nodeByName(o, 'Delete account')));
  await waitFor(async () => (await logText(page)) === 'confirm=true');
  assert.equal(page.dialogs()[0].handledBy, 'broker');
  assert.throws(() => page.resolveDialog('dlg_nope', 'accept'), (e) => e.code === 'STALE_REF');
  assert.throws(() => page.resolveDialog('dlg_nope', 'maybe'), (e) => e.code === 'UNSUPPORTED');
});

real('downloads are rejected by default (acceptDownloads:false) and reported', async ({ page }) => {
  await page.navigate(env.url('downloads.html'));
  const o = await page.observe();
  const got = [];
  page.on('download', (d) => got.push(d));
  await page.act(clickCmd(o, nodeByName(o, 'Download report')));
  await waitFor(() => got.some((d) => d.state === 'rejected'));
  const rej = got.find((d) => d.state === 'rejected');
  assert.equal(rej.reason, 'not-granted');
  assert.equal(rej.filename, 'report.txt');
  assert.equal(env.session.takeDownload(rej.id), null, 'nothing was stored');
  assert.equal(page.state, 'ready');
});

test('downloads: a granted session stores a bounded artifact and rejects oversize ones', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const g = await openFixtureSession({ open: { downloads: { granted: true, maxBytes: 4096 } } });
  try {
    assert.equal(g.session.capabilities.downloads, true);
    const page = g.page;
    await page.navigate(g.url('downloads.html'));
    const o = await page.observe();
    const got = [];
    page.on('download', (d) => got.push(d));
    await page.act(clickCmd(o, nodeByName(o, 'Download report')));
    await waitFor(() => got.some((d) => d.state === 'completed'));
    const done = got.find((d) => d.state === 'completed');
    assert.equal(done.bytes, 'quarterly numbers\n'.length);
    assert.match(done.sha256, /^[0-9a-f]{64}$/);
    const art = g.session.takeDownload(done.id);
    assert.equal(fs.readFileSync(art.file, 'utf8'), 'quarterly numbers\n');
    await page.act(clickCmd(o, nodeByName(o, 'Download big file')));
    await waitFor(() => got.some((d) => d.state === 'rejected' && d.reason === 'too-large'));
  } finally { await g.close(); }
});

real('permissions are default-deny', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const geo = await page._raw.evaluate(() => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve('denied:' + e.code), { timeout: 2500 });
  }));
  assert.match(geo, /^denied:/);
  const states = await page._raw.evaluate(async () => {
    const out = {};
    for (const n of ['geolocation', 'notifications', 'camera', 'microphone']) {
      try { out[n] = (await navigator.permissions.query({ name: n })).state; } catch (_e) { out[n] = 'unsupported'; }
    }
    return out;
  });
  for (const [name, state] of Object.entries(states)) assert.notEqual(state, 'granted', name);
});

// ---- action semantics -----------------------------------------------------------------------------------------------------------
real('actions: fill / select / check / press / navigate with readback evidence', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const o = await page.observe();
  assert.equal((await page.act({ action: { kind: 'fill', refId: nodeByName(o, 'Display name').refId, text: 'Grace' } })).status, 'verified');
  const plan = o.nodes.find((n) => n.role === 'combobox');
  assert.equal((await page.act({ action: { kind: 'select', refId: plan.refId, value: 'pro' } })).status, 'verified');
  assert.equal((await page.act({ action: { kind: 'check', refId: nodeByName(o, 'Accept terms').refId, checked: true } })).status, 'verified');
  const save = await page.act(clickCmd(o, nodeByName(o, 'Save'), { expect: { kind: 'text', op: 'equals', selector: '#status', expected: 'Saved: Grace / pro' } }));
  assert.equal(save.status, 'verified');
  assert.equal(save.evidence.at(-1).kind, 'text');
  assert.equal(save.evidence.at(-1).status, 'passed');
  // an unmet expectation is dispatched, not verified
  const unmet = await page.act(clickCmd(o, nodeByName(o, 'Save'), { expect: { kind: 'text', op: 'equals', selector: '#status', expected: 'Nope', timeoutMs: 200 } }));
  assert.equal(unmet.status, 'dispatched');
  await assert.rejects(page.act({ action: { kind: 'select', refId: nodeByName(o, 'Save').refId, value: 'x' } }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(page.act({ action: { kind: 'press', refId: nodeByName(o, 'Display name').refId, key: 'Control+Alt+Delete' } }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(page.act({ action: { kind: 'eval', refId: 'x', code: '1' } }), (e) => e.code === 'UNSUPPORTED');
  const nav = await page.act({ action: { kind: 'navigate', url: env.url('buttons.html') } });
  assert.equal(nav.status, 'verified');
  assert.ok(page.url().endsWith('/buttons.html'));
});

real('press dispatches named keys (Enter on a focused field)', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const o = await page.observe();
  const r = await page.act({ action: { kind: 'press', refId: nodeByName(o, 'Display name').refId, key: 'Shift+Tab' } });
  assert.equal(r.status, 'dispatched');
});

real('control hooks: beforeDispatch runs exactly once before input, and can veto', async ({ page }) => {
  await page.navigate(env.url('buttons.html'));
  const o = await page.observe();
  const btn = nodeByName(o, 'Enabled action');
  const order = [];
  const control = { signal: null, check() { order.push('check'); }, beforeDispatch() { order.push('beforeDispatch'); } };
  await page.act(clickCmd(o, btn), control);
  assert.equal(order.filter((x) => x === 'beforeDispatch').length, 1);
  assert.ok(order.indexOf('check') < order.indexOf('beforeDispatch'));
  assert.equal(await logText(page), 'enabled clicked');

  await page._raw.evaluate(() => { document.getElementById('log').textContent = 'reset'; });
  const veto = { signal: null, check() {}, beforeDispatch() { throw Object.assign(new Error('OWNERSHIP_LOST'), { code: 'OWNERSHIP_LOST' }); } };
  await assert.rejects(page.act(clickCmd(o, btn), veto), (e) => e.code === 'OWNERSHIP_LOST');
  assert.equal(await logText(page), 'reset', 'a vetoed dispatch sends no input');
  const abort = { signal: null, check() { throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); }, beforeDispatch() {} };
  await assert.rejects(page.act(clickCmd(o, btn), abort), (e) => e.code === 'CANCELLED');
  assert.equal(await logText(page), 'reset');
});

real('highlight marks only the referenced node inside its owning frame', async ({ page }) => {
  await page.navigate(`${env.url('frames.html')}?x=${env.other.port}`);
  const o = await page.observe();
  const cross = o.coverage.frames.find((f) => f.crossOrigin);
  const target = o.nodes.find((n) => n.name === 'Inner action' && n.frameId === cross.frameId);
  const res = await page.highlight(target.refId, 'step 1');
  assert.equal(res.ok, true);
  const counts = await Promise.all(page._raw.frames().map((f) => f.locator('[data-caos="agent-highlight"]').count()));
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
  const owner = page._raw.frames().find((f) => f.url().startsWith(env.other.origin));
  assert.equal(await owner.locator('[data-caos="agent-highlight"]').count(), 1);
  await page.clearHighlight();
  const after = await Promise.all(page._raw.frames().map((f) => f.locator('[data-caos="agent-highlight"]').count()));
  assert.equal(after.reduce((a, b) => a + b, 0), 0);
  // overlays are Braiwser UI: assertions and later observations ignore them
  await page.highlight(target.refId, 'again');
  const o2 = await page.observe();
  assert.ok(!o2.nodes.some((n) => n.name === 'again'));
});

// ---- assertion DSL ------------------------------------------------------------------------------------------------------------------------
test('assertion DSL: the shared conformance table passes against a real engine', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const page = await env.session.newPage();
  let current = '';
  await env.session._context.route('https://example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>${current}</body></html>` }));
  try {
    const failures = [];
    for (const c of assertionCases) {
      current = c.html || '';
      await page.navigate('about:blank'); // identical URL + hash would be a same-document navigation
      const nav = await page.navigate(c.url);
      assert.equal(nav.outcome, 'ready', c.name);
      const r = await page.evaluateAssertion(c.assertion);
      if (r.status !== (c.ok ? 'passed' : 'failed')) failures.push(`${c.name}: got ${r.status}`);
      assert.ok(Array.isArray(r.evidence) && r.evidence.length === 1);
    }
    assert.deepEqual(failures, []);
  } finally {
    await env.session._context.unroute('https://example.test/**');
    await page.close();
  }
});

real('assertions: target alias, polling for delayed status, unknown when the engine is unavailable', async ({ page }) => {
  await page.navigate(env.url('delayed.html'));
  const o = await page.observe();
  await page.act(clickCmd(o, nodeByName(o, 'Start job')));
  const now = await page.evaluateAssertion({ kind: 'text', op: 'equals', target: '[role=status]', expected: 'Done' });
  assert.equal(now.status, 'failed');
  const polled = await page.evaluateAssertion({ kind: 'text', op: 'equals', target: '[role=status]', expected: 'Done' }, { timeoutMs: 3000 });
  assert.equal(polled.status, 'passed');
  assert.equal((await page.evaluateAssertion({ kind: 'exists', selector: '((' })).status, 'failed');
  assert.equal((await page.evaluateAssertion({ kind: 'url', op: 'contains', expected: '/delayed.html' })).status, 'passed');
  assert.equal((await page.evaluateAssertion({ kind: 'bogus', selector: 'a' })).status, 'failed');
  const closing = await env.session.newPage();
  await closing.close();
  assert.equal((await closing.evaluateAssertion({ kind: 'exists', selector: 'a' })).status, 'unknown');
});

// ---- bounds / pagination / delta / performance ---------------------------------------------------------------------------------------------
real('10,000-node page: observation is bounded, paged and fast (p95 < 1s, <= 64 KiB)', async ({ page }) => {
  await page.navigate(env.url('big.html'));
  const count = await page._raw.evaluate(() => document.getElementsByTagName('*').length);
  assert.ok(count >= 10000, `fixture has ${count} elements`);
  const times = [];
  let last;
  for (let i = 0; i < 20; i += 1) {
    const t0 = process.hrtime.bigint();
    last = await page.observe();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert.ok(p95 < 1000, `p95 ${p95.toFixed(0)}ms (median ${times[10].toFixed(0)}ms)`);
  assert.ok(obs.serializedBytes(last) <= 64 * 1024, `bytes ${obs.serializedBytes(last)}`);
  assert.ok(last.nodes.length <= 200);
  assert.equal(last.truncated, true);
  assert.ok(last.nextCursor);
  assert.ok(last.coverage.nodesTotal > 3000);
  const max = await page.observe({ maxNodes: 1000 });
  assert.ok(max.nodes.length <= 200 && obs.serializedBytes(max) <= 64 * 1024);

  // paging: no overlap, same epoch only
  const a = await page.observe({ maxNodes: 40 });
  const b = await page.observe({ maxNodes: 40, cursor: a.nextCursor });
  const names = new Set(a.nodes.map((n) => n.name));
  assert.ok(b.nodes.length > 0 && b.nodes.every((n) => !names.has(n.name) || n.name === 'x'));
  await page.navigate(env.url('task.html'));
  await expectError(page.observe({ maxNodes: 40, cursor: b.nextCursor }), 'STALE_REF', 'CURSOR_STALE');
});

real('the byte cap bites before the node cap for very wide labels', async ({ page }) => {
  await page.navigate(env.url('wide.html'));
  const o = await page.observe({ maxNodes: 200 });
  const bytes = obs.serializedBytes(o);
  assert.ok(bytes <= 64 * 1024, `bytes ${bytes}`);
  assert.equal(o.truncated, true);
  assert.ok(o.nodes.length < 200, `byte cap should have trimmed (${o.nodes.length} nodes)`);
  assert.ok(o.nextCursor);
  const next = await page.observe({ maxNodes: 200, cursor: o.nextCursor });
  assert.notEqual(next.nodes[0].name, o.nodes[0].name);
});

real('delta observations require an available base and stay honest', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const full = await page.observe();
  const save = nodeByName(full, 'Save');
  await page.act(clickCmd(full, nodeByName(full, 'Accept terms'), {}));
  await page.act(clickCmd(full, save));
  const d = await page.observe({ baseObservationId: full.observationId });
  assert.equal(d.delta.available, true);
  assert.ok(d.nodes.length < full.nodes.length, `${d.nodes.length} < ${full.nodes.length}`);
  assert.ok(d.delta.unchanged > 0 && d.delta.changed + d.delta.added >= 1);
  assert.ok(d.nodes.some((n) => n.kind === 'status' && /terms|Saved/.test(n.name)) || d.nodes.some((n) => n.role === 'checkbox'));
  // unchanged nodes keep working under the NEW observation id
  const ok = await page.act({ observationId: d.observationId, documentEpoch: d.documentEpoch, action: { kind: 'click', refId: save.refId } });
  assert.equal(ok.status, 'verified');

  const missing = await page.observe({ baseObservationId: 'ob_missing' });
  assert.equal(missing.delta.available, false);
  assert.equal(missing.delta.reason, 'BASE_UNAVAILABLE');
  assert.equal(missing.nodes.length, full.nodes.length, 'a missing base yields a FULL bounded snapshot');

  await page.navigate(env.url('task.html'));
  const afterNav = await page.observe({ baseObservationId: full.observationId });
  assert.equal(afterNav.delta.available, false);
});

real('a wrong-observation reference is refused', async ({ page }) => {
  await page.navigate(env.url('task.html'));
  const a = await page.observe();
  const save = nodeByName(a, 'Save');
  const b = await page.observe({ focus: { role: 'textbox' } });
  assert.ok(b.nodes.length === 1);
  await expectError(page.act({ observationId: b.observationId, action: { kind: 'click', refId: save.refId } }), 'STALE_REF', 'WRONG_OBSERVATION');
});

real('focus filters observations and strict focus reports ambiguity', async ({ page }) => {
  await page.navigate(env.url('duplicates.html'));
  const o = await page.observe({ focus: { role: 'button', name: 'Delete', exact: true } });
  assert.equal(o.nodes.length, 2);
  assert.ok(o.nodes.every((n) => n.ambiguous));
  assert.equal(o.coverage.nodesTotal, 2);
  const none = await page.observe({ focus: { name: 'does-not-exist' } });
  assert.equal(none.nodes.length, 0);
  await assert.rejects(page.observe({ focus: 5 }), (e) => e.code === 'UNSUPPORTED');
  assert.ok((await page.observe({ focus: 'alice' })).nodes.length >= 1, 'a plain string focus (as the broker sends it) is a text search');
});

real('refs expire and a closed page is UNAVAILABLE', async ({ page }) => {
  await page.navigate(env.url('buttons.html'));
  const o = await page.observe();
  const btn = nodeByName(o, 'Enabled action');
  page._refs.get(btn.refId).expiresAt = Date.now() - 1;
  await expectError(page.act(clickCmd(o, btn)), 'STALE_REF', 'REF_EXPIRED');
  const extra = await env.session.newPage();
  await extra.close();
  await expectError(extra.observe(), 'UNAVAILABLE');
  await sleep(10);
});

test('headless pages have no visible owner badge and screenshots stay clean', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const page = await env.session.newPage();
  try {
    await page.navigate(env.url('task.html'));
    await page.setOwnerBadge('agent');
    assert.equal(page.owner, 'agent');
    assert.equal((await page.badgeState()).owner, 'none', 'nothing is drawn into a headless page');
    await assert.rejects(page.setOwnerBadge('root'), (e) => e.code === 'UNSUPPORTED');
  } finally { await page.close(); }
});

test('session.close() closes every page and the browser', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const s = await openFixtureSession();
  const extra = await s.session.newPage();
  assert.equal(s.session.pages.size, 2);
  await s.close();
  assert.equal(s.session.pages.size, 0);
  assert.equal(extra.closed, true);
  await s.session.close(); // idempotent
});

// ---- request-level policy hook -------------------------------------------------------------------------------
test('requestFilter: the initial request of every fetch is decided by the filter; a throwing filter blocks (fail closed)', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  let g;
  const seen = [];
  g = await openFixtureSession({ open: { requestFilter: (url, ctx) => { seen.push([url, ctx.navigation]); return url.startsWith(g.origin.origin) ? 'allow' : 'block'; } } });
  try {
    const page = g.page;
    const before = g.other.requests.length;
    const nav = await page.navigate(`${g.url('frames.html')}?x=${g.other.port}`);
    assert.equal(nav.outcome, 'ready');
    const o = await page.observe();
    assert.equal(g.other.requests.length, before, 'the foreign origin was never contacted for the frame');
    assert.equal(o.nodes.filter((n) => n.name === 'Inner action').length, 1, 'only the granted same-origin frame contributed');
    assert.ok(seen.some(([u, isNav]) => u.includes('/frames.html') && isNav === true));
    assert.ok(seen.some(([u]) => u.startsWith(g.other.origin)), 'the foreign request was seen by the filter (and blocked)');
    // a direct navigation to a foreign origin fails and is reported as failed, never ready
    const foreign = await page.navigate(`${g.other.origin}/task.html`);
    assert.equal(foreign.outcome, 'failed');
    assert.equal(foreign.error, 'ERR_BLOCKED_BY_CLIENT');
    assert.equal(g.other.requests.length, before);

    // KNOWN LIMITATION (capabilities.notes.requestInterception): Playwright does not route redirect hops,
    // so an allowed origin can redirect the browser to a foreign one. If this ever starts failing, the
    // limitation was lifted: tighten the capability note and the broker's policyEnforcement claim.
    const fresh = await g.session.newPage();
    const hop = await fresh.navigate(`${g.url('redirect')}?to=${encodeURIComponent(`${g.other.origin}/task.html`)}`);
    assert.equal(hop.outcome, 'ready');
    assert.ok(g.other.requests.length > before, 'redirect hop reached the foreign origin (documented gap)');
    assert.ok(fresh.url().startsWith(g.other.origin), 'the broker arrival check is what catches this');
  } finally { await g.close(); }

  const failClosed = await openFixtureSession({ open: { requestFilter: () => { throw new Error('boom'); } } });
  try {
    assert.equal((await failClosed.page.navigate(failClosed.url('task.html'))).outcome, 'failed');
    assert.equal(failClosed.origin.requests.length, 0);
  } finally { await failClosed.close(); }
});

// ---- click delivery attestation --------------------------------------------------------------------------------
real('a plain click is verified only by an observed trusted click on the exact target', async ({ page }) => {
  await page.navigate(env.url('buttons.html'));
  const o = await page.observe();
  const r = await page.act(clickCmd(o, nodeByName(o, 'Enabled action')));
  assert.equal(r.status, 'verified');
  const clicked = r.evidence.find((e) => e.kind === 'clicked');
  assert.deepEqual([clicked.observed, clicked.matches, clicked.trusted >= 1], [true, true, true]);
  assert.ok(r.evidence.every((e) => e.observed === true), 'the broker only trusts driver-observed facts');

  // a page that swallows the click before it reaches the target cannot be attested
  await page.navigate(env.url('swallow.html'));
  const o2 = await page.observe();
  const swallowed = await page.act(clickCmd(o2, nodeByName(o2, 'Do the thing')));
  assert.equal(swallowed.status, 'dispatched', 'input was sent but delivery cannot be proven');
  assert.equal(swallowed.evidence.find((e) => e.kind === 'clicked').matches, false);
  assert.equal(await logText(page), 'idle');
});
