'use strict';
// REAL headless Chromium against LOCAL fixtures: bounded table / list observation, pagination hints, setViewport and
// capture on the Playwright driver. Skips (with the reason) when Chromium is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserAvailable, openFixtureSession, noopControl } = require('./_env');
const obs = require('../../../src/main/services/browser/drivers/observe');

let avail = { ok: false, reason: 'not probed' };
let env = null;

test.before(async () => {
  avail = await browserAvailable('headless');
  if (avail.ok) env = await openFixtureSession();
});
test.after(async () => { if (env) await env.close(); });

function real(name, fn) {
  test(name, async (t) => {
    if (!avail.ok) { t.skip(avail.reason); return; }
    const page = await env.session.newPage();
    try { await fn({ page, t }); } finally { await page.close(); }
  });
}
const byName = (o, name, role) => o.nodes.find((n) => n.name === name && (!role || n.role === role));
const png = (bytes) => ({ sig: bytes.subarray(0, 8).toString('hex'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
const PNG_SIG = '89504e470d0a1a0a';

// ---- tables and lists --------------------------------------------------------------------------------------------
real('tables: bounded matrix with header names, row/column counts, merged flag and withheld secrets', async ({ page }) => {
  await page.navigate(env.url('tables.html'));
  const o = await page.observe({ maxNodes: 200 });
  const accounts = byName(o, 'Accounts', 'table');
  assert.ok(accounts && accounts.table, 'a captioned <table> is a table node with its payload');
  assert.deepEqual(accounts.table.headers, ['User', 'Password', 'Notes']);
  assert.equal(accounts.table.rowCount, 3); assert.equal(accounts.table.columnCount, 3); assert.equal(accounts.table.hasHeader, true);
  assert.deepEqual(accounts.table.withheld, [1], 'a column whose header looks like a secret is withheld');
  assert.deepEqual(accounts.table.cells.map((r) => r[0]), ['ada', 'grace', 'alan']);
  assert.ok(accounts.table.cells.every((r) => r[1] === null), 'withheld cells are null, never text');
  assert.equal(accounts.table.cells[1][2], null, 'a cell holding a password control is withheld on its own');
  assert.equal(accounts.table.cells[0][2], 'first');
  assert.ok(accounts.table.cells[2][2].length <= 80 && accounts.table.truncated.cells >= 1, 'per-cell cap with a counted marker');
  const json = JSON.stringify(o);
  for (const canary of ['CANARY-hunter2', 'CANARY-swordfish', 'CANARY-in-input']) assert.ok(!json.includes(canary), `${canary} must never reach an observation`);

  const merged = byName(o, 'Merged', 'table');
  assert.equal(merged.table.merged, true, 'colspan makes positions unreliable and says so');
  const grid = byName(o, 'Grid', 'grid');
  assert.deepEqual(grid.table.headers, ['Key', 'Value']);
  assert.deepEqual(grid.table.cells, [['alpha', '1'], ['beta', '2']]);
  assert.equal(grid.kind, 'table');
});

real('tables: 50 rows x 12 columns x 80 characters, with explicit truncation markers, inside the 64 KiB / 200 node caps', async ({ page }) => {
  await page.navigate(env.url('tables.html'));
  const o = await page.observe({ maxNodes: 200 });
  const big = byName(o, 'Big', 'table');
  const t = big.table;
  assert.equal(t.rowCount, 80); assert.equal(t.rowsExact, true);
  assert.equal(t.cells.length, 50); assert.equal(t.truncated.rows, true);
  assert.equal(t.columnCount, 15); assert.equal(t.headers.length, 12); assert.equal(t.truncated.columns, true);
  assert.ok(t.cells.every((r) => r.length === 12));
  assert.ok(t.cells[0][1].length <= 80 && t.cells[0][1].endsWith('…') && t.truncated.cells >= 1, 'a clipped cell ends with the ellipsis marker');
  assert.ok(Buffer.byteLength(JSON.stringify(o)) <= 64 * 1024);
  assert.ok(o.nodes.length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= obs.LIMITS.structBytes + 512);

  // the driver tightens the matrix until the payload fits its byte budget, and says so
  const wide = obs.boundTable({ rowCount: 50, rowsExact: true, columnCount: 12, hasHeader: true, headers: Array.from({ length: 12 }, (_, i) => `H${i}`),
    cells: Array.from({ length: 50 }, () => Array.from({ length: 12 }, () => 'é'.repeat(80))), truncated: { rows: false, columns: false, cells: 0 }, merged: false, withheld: [] });
  assert.ok(wide.cells.length < 50 && wide.truncated.rows === true);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= obs.LIMITS.structBytes);
});

real('lists: bounded items; navigation menus, single-item and link-only lists are not noise', async ({ page }) => {
  await page.navigate(env.url('tables.html'));
  const o = await page.observe({ maxNodes: 200 });
  const lists = o.nodes.filter((n) => n.role === 'list');
  assert.deepEqual(lists.map((l) => l.name).sort(), ['', 'Steps'].sort());
  const plain = lists.find((l) => l.name === '');
  assert.deepEqual(plain.list.items, ['apples', 'pears', 'plums']); assert.equal(plain.list.ordered, false); assert.equal(plain.list.itemCount, 3);
  const steps = lists.find((l) => l.name === 'Steps');
  assert.equal(steps.list.ordered, true);
  assert.ok(o.nodes.some((n) => n.role === 'link' && n.name === 'Alpha'), 'the menu links are still ordinary nodes');
});

real('table content is part of the delta signature: a changed cell is re-sent, an unchanged table is not', async ({ page }) => {
  await page.navigate(env.url('orders.html'));
  const first = await page.observe({ maxNodes: 200 });
  const same = await page.observe({ maxNodes: 200, baseObservationId: first.observationId });
  assert.equal(same.delta.available, true);
  assert.ok(!same.nodes.some((n) => n.role === 'table' && n.table.cells.length), 'unchanged => not resent');
  await page._raw.evaluate(() => { document.querySelector('td').textContent = 'CHANGED'; });
  const after = await page.observe({ maxNodes: 200, baseObservationId: same.observationId });
  const table = after.nodes.find((n) => n.role === 'table');
  assert.ok(table, 'a table whose cell changed is part of the delta');
  assert.equal(table.table.cells[0][0], 'CHANGED');
});

// ---- pagination hints --------------------------------------------------------------------------------------------
real('pagination hints are refs to next / previous controls found by accessible name only', async ({ page }) => {
  await page.navigate(env.url('orders.html?page=2'));
  const o = await page.observe({});
  const next = byName(o, 'Next', 'link'); const prev = byName(o, 'Previous', 'link');
  assert.deepEqual(o.pagination, { next: { refId: next.refId, name: 'Next', enabled: true }, prev: { refId: prev.refId, name: 'Previous', enabled: true } });
  await page.navigate(env.url('orders.html?page=3'));
  const last = await page.observe({});
  assert.equal(last.pagination.next.enabled, false, 'the last page\'s Next is present and disabled');
  await page.navigate(env.url('orders.html?page=1'));
  assert.equal((await page.observe({})).pagination.prev.enabled, false);
  await page.navigate(env.url('orders.html?mode=nopager'));
  assert.equal((await page.observe({})).pagination, undefined, 'no hint when there is nothing to find');
  // two candidates for one direction: no ref is offered, the ambiguity is reported
  await page.navigate(env.url('orders.html?page=2'));
  await page._raw.evaluate(() => { const a = document.createElement('a'); a.href = '#'; a.textContent = 'Next page'; document.body.appendChild(a); });
  const dup = await page.observe({});
  assert.deepEqual(dup.pagination.ambiguous, ['next']);
  assert.equal(dup.pagination.next, undefined);
  assert.ok(dup.pagination.prev);
  // hints use the accessible name, never markup: a button labelled "Next" counts, a link whose class says next does not
  await page._raw.evaluate(() => { document.body.innerHTML = '<a class="next" href="#a">Go on</a><button>Older</button>'; });
  const named = await page.observe({});
  assert.equal(named.pagination.next.name, 'Older');
});

// ---- setViewport -----------------------------------------------------------------------------------------------
real('setViewport: resizes for real, reads the size back, bumps the epoch and kills every ref', async ({ page }) => {
  await page.navigate(env.url('responsive-buggy.html'));
  const o = await page.observe({});
  const link = byName(o, 'Home', 'link');
  const epoch = page.documentEpoch;
  const events = [];
  page.events.on('navigated', (e) => events.push(e));
  const calls = { check: 0, beforeDispatch: 0 };
  const r = await page.setViewport({ width: 375, height: 812 }, noopControl(calls));
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.evidence.map((e) => [e.kind, e.change, e.width, e.height, e.matches]), [['state-change', 'viewport', 375, 812, true]]);
  assert.equal(calls.beforeDispatch, 1, 'the ledger point is committed once, immediately before the resize');
  assert.ok(page.documentEpoch > epoch);
  assert.ok(events.some((e) => e.kind === 'viewport' && e.documentEpoch === page.documentEpoch), 'the broker is told through the page event');
  assert.deepEqual(await page._raw.evaluate(() => [window.innerWidth, window.innerHeight]), [375, 812]);
  assert.throws(() => page.resolve(link.refId), (e) => e.code === 'STALE_REF', 'refs from before the resize are dead');
  // layout really changed: the media query hides the Primary navigation below 600px and shows it again at 1280px
  const visible = () => page.evaluateAssertion({ kind: 'visible', target: { by: 'role', role: 'navigation', name: 'Primary' } }).then((a) => a.status);
  assert.equal(await visible(), 'failed');
  assert.equal((await page.setViewport({ width: 1280, height: 800 }, noopControl())).status, 'verified');
  assert.equal(await visible(), 'passed');
  // same size again is still a (verified) state change, not a silent no-op
  const again = await page.setViewport({ width: 1280, height: 800 }, noopControl());
  assert.equal(again.status, 'verified');
});

real('setViewport: out-of-range sizes are refused before anything is dispatched', async ({ page }) => {
  for (const [width, height] of [[239, 800], [800, 239], [4097, 800], [800, 4097], [800.5, 800], ['800', 800], [undefined, 800]]) {
    const calls = { check: 0, beforeDispatch: 0 };
    const err = await page.setViewport({ width, height }, noopControl(calls)).then(() => null, (e) => e);
    assert.ok(err, `${width}x${height}`);
    assert.equal(err.code, 'UNSUPPORTED'); assert.equal(err.detail, 'INVALID_VIEWPORT'); assert.equal(err.dispatched, false);
    assert.equal(calls.beforeDispatch, 0);
  }
  assert.equal((await page.setViewport({ width: 240, height: 240 }, noopControl())).status, 'verified');
  assert.equal((await page.setViewport({ width: 4096, height: 4096 }, noopControl())).status, 'verified');
  const closed = await env.session.newPage();
  await closed.close();
  assert.equal(await closed.setViewport({ width: 500, height: 500 }, noopControl()).then(() => null, (e) => e.code), 'UNAVAILABLE');
});

// ---- capture -----------------------------------------------------------------------------------------------------
real('capture: an unmodified viewport PNG with url / viewport / scale / scroll / capturedAt and transformed:false', async ({ page }) => {
  await page.navigate(env.url('responsive.html'));
  assert.equal((await page.setViewport({ width: 375, height: 600 }, noopControl())).status, 'verified');
  const before = await page._raw.evaluate(() => document.documentElement.outerHTML);
  const shot = await page.capture({});
  assert.equal(png(shot.bytes).sig, PNG_SIG);
  assert.deepEqual({ w: png(shot.bytes).width, h: png(shot.bytes).height }, { w: 375, h: 600 }, 'pixels are not resized');
  const m = shot.meta;
  assert.equal(m.transformed, false);
  assert.deepEqual(m.viewport, { width: 375, height: 600 });
  assert.equal(m.scale, 1);
  assert.deepEqual(m.scroll, { x: 0, y: 0 });
  assert.equal(m.clip, null);
  assert.equal(m.url, env.url('responsive.html'));
  assert.ok(Math.abs(Date.now() - Date.parse(m.capturedAt)) < 60000);
  assert.equal(m.documentEpoch, page.documentEpoch);
  assert.equal(await page._raw.evaluate(() => document.documentElement.outerHTML), before, 'capturing does not touch the page');
  await page._raw.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 120); });
  assert.deepEqual((await page.capture({})).meta.scroll, { x: 0, y: 120 });
});

real('capture of one element: bound to an observed ref, cropped to its box, refused when the ref is stale', async ({ page }) => {
  await page.navigate(env.url('responsive.html'));
  await page.setViewport({ width: 1280, height: 800 }, noopControl());
  const o = await page.observe({});
  const nav = byName(o, 'Primary', 'navigation');
  const shot = await page.capture({ refId: nav.refId });
  const dims = png(shot.bytes);
  assert.equal(dims.sig, PNG_SIG);
  assert.ok(shot.meta.clip && shot.meta.clip.width > 100 && shot.meta.clip.height > 10, 'the crop region is recorded');
  assert.ok(Math.abs(dims.width - shot.meta.clip.width) <= 2 && Math.abs(dims.height - shot.meta.clip.height) <= 2, `${dims.width}x${dims.height} vs ${JSON.stringify(shot.meta.clip)}`);
  assert.equal(shot.meta.transformed, false);
  await page.setViewport({ width: 800, height: 800 }, noopControl());
  const err = await page.capture({ refId: nav.refId }).then(() => null, (e) => e);
  assert.equal(err.code, 'STALE_REF');
  assert.equal(await page.capture({ refId: 'r_nope' }).then(() => null, (e) => e.code), 'STALE_REF');
});

real('capture of a hidden element fails honestly instead of returning an empty image', async ({ page }) => {
  await page.navigate(env.url('responsive-buggy.html'));
  await page.setViewport({ width: 500, height: 700 }, noopControl());
  const o = await page.observe({});
  assert.equal(byName(o, 'Primary', 'navigation'), undefined, 'a hidden landmark is not observed, so it cannot be captured');
  assert.ok(byName(o, 'Content', 'main'));
});
