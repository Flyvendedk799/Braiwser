// The built-in workflows against the REAL broker, the REAL Playwright driver (headless Chromium) and LOCAL fixtures:
//   review-responsive  - setViewport / capture / visible assertions over three viewports, run end to end through
//                        browser_run, with the evidence read back from the artifact store;
//   extract-table      - typed, paginated, bounded extraction with source refs and explicit incomplete results.
// Skips (with the reason) when Chromium is not installed. Nothing here touches an external site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connect } from './_harness.mjs';

const require = createRequire(import.meta.url);
const { createBroker } = require('../../../src/main/services/browser/broker.js');
const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright.js');
const registry = require('../../../src/main/services/automation/skill-registry.js');
const reviewResponsive = require('../../../src/main/services/automation/workflows/review-responsive.js');
const extractTable = require('../../../src/main/services/automation/workflows/extract-table.js');
const { startFixtureServer } = require('../../fixtures/agent-sites/server.js');
const { browserAvailable, FIXTURE_DIR } = require('../drivers/_env.js');
const { tmp, until, mcp, cleanup } = require('../helpers.js');

let avail = { ok: false, reason: 'not probed' };
let site; let broker; let origin; let principal; let agent;

before(async () => {
  avail = await browserAvailable('headless');
  if (!avail.ok) return;
  site = await startFixtureServer({ dir: FIXTURE_DIR });
  origin = site.origin;
  principal = mcp('agent', ['class:observe', 'class:navigate', 'class:interact', `origin:${origin}`]);
  broker = createBroker({ dataDir: tmp(), drivers: { playwright: createPlaywrightDriver() }, featureFlag: true,
    skills: registry.createBrokerSkills({}), appVersion: 'test' });
  agent = broker.forPrincipal(principal);
});
after(async () => {
  if (broker) await broker.close();
  if (site) await site.close();
  cleanup();
});

function real(name, fn) {
  test(name, async (t) => {
    if (!avail.ok) { t.skip(avail.reason); return; }
    await fn(t);
  });
}

const GRANT = () => ({ allowedOrigins: [origin], toolClasses: ['observe', 'navigate', 'interact'] });
async function withSession(fn, grant = GRANT()) {
  const s = await agent.openSession({ driver: 'playwright', mode: 'headless', grant });
  try { return await fn(s); } finally { await agent.closeSession({ sessionId: s.sessionId }); }
}
const ids = (s) => ({ sessionId: s.sessionId, pageId: s.pageId });
let counter = 0;
async function navigateTo(s, url) {
  const o = await agent.observe(ids(s));
  const r = await agent.act({ ...ids(s), documentEpoch: o.documentEpoch, operationId: `rc-nav-${++counter}`, action: { kind: 'navigate', url } });
  assert.equal(r.status, 'verified', JSON.stringify(r));
}
const waitDone = async (h, runId, timeoutMs = 60000) => {
  let s;
  await until(async () => { s = await h.ok('browser_run_status', { runId, maxEvents: 100 }); return !['queued', 'running', 'needsApproval', 'needsHuman'].includes(s.state); }, { timeoutMs, stepMs: 50 });
  return s;
};
const pngSize = (b64) => { const b = Buffer.from(b64, 'base64'); return { sig: b.subarray(0, 8).toString('hex'), width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

// ------------------------------------------------------------------------------------------ review-responsive

const VIEWPORTS = [{ name: 'mobile', width: 375, height: 812 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'laptop', width: 1280, height: 800 }];
const LANDMARKS = [{ role: 'navigation', name: 'Primary' }, { role: 'main', name: 'Content' }];

real('review-responsive: three viewports on a local page pass end to end, every capture is stored as evidence', async () => {
  const h = await connect(broker, principal);
  try {
    await withSession(async (s) => {
      const started = await h.ok('browser_run', { ...ids(s), requestKey: 'rr-pass', skillId: 'review-responsive', skillVersion: '1.0.0',
        inputs: { url: `${origin}/responsive.html`, landmarks: LANDMARKS, viewports: VIEWPORTS } });
      const done = await waitDone(h, started.runId);
      assert.equal(done.state, 'passed', JSON.stringify(done.events.slice(-4)));
      assert.equal(done.verdict, 'passed');
      assert.equal(done.evidenceComplete, true);
      assert.equal(done.planned, 21, '3 x (viewport + navigate + 2 assertions + page capture + 2 crops)');
      assert.equal(done.requiredAssertions, 6);
      assert.equal(done.passedAssertions, 6, 'captures are evidence only: the six landmark assertions are what passed');
      assert.equal(done.executed, 21);

      const manifest = await agent.getManifest({ runId: started.runId });
      assert.equal(manifest.committed, true);
      assert.equal(manifest.steps.filter((x) => x.type === 'setViewport').length, 3);
      const shots = manifest.artifacts.filter((a) => a.kind === 'screenshot');
      const metas = manifest.artifacts.filter((a) => a.kind === 'capture');
      assert.equal(shots.length, 9); assert.equal(metas.length, 9);
      assert.ok(shots.every((a) => a.mime === 'image/png' && a.visibility === 'internal' && a.bytes > 200));

      // page captures are the unmodified viewport: the PNG is exactly the requested size, and the metadata says so
      const records = [];
      for (const m of metas) records.push(JSON.parse((await agent.readResource(m.uri)).text));
      const pages = records.filter((r) => !r.clip);
      assert.deepEqual(pages.map((r) => [r.viewport.width, r.viewport.height]), VIEWPORTS.map((v) => [v.width, v.height]));
      assert.ok(records.every((r) => r.transformed === false && r.url === `${origin}/responsive.html` && r.scale === 1 && Number.isFinite(Date.parse(r.capturedAt))));
      for (const r of pages) {
        const art = shots.find((a) => a.artifactId === r.screenshot.artifactId);
        const read = await agent.readResource(art.uri);
        assert.equal(read.encoding, 'base64');
        assert.ok(read.returnedBytes <= 48 * 1024 && Buffer.byteLength(JSON.stringify(read)) <= 64 * 1024, 'never returned inline beyond the cap');
        if (read.truncated === false) assert.deepEqual(pngSize(read.data), { sig: '89504e470d0a1a0a', width: r.viewport.width, height: r.viewport.height });
        else assert.equal(pngSize(read.data).sig, '89504e470d0a1a0a');
      }
      const crops = records.filter((r) => r.clip);
      assert.equal(crops.length, 6);
      assert.ok(crops.every((r) => r.clip.width > 0 && r.clip.height > 0 && /navigation|main/.test(r.target)));
      // the run DTO and its events never carry pixels
      assert.ok(JSON.stringify(done).length < 12000);
      assert.ok(!JSON.stringify(done).includes('iVBOR'));
    });
  } finally { await h.close(); }
});

real('review-responsive: a viewport-specific defect fails the run and maps back to target + viewport + URL', async () => {
  const h = await connect(broker, principal);
  try {
    await withSession(async (s) => {
      const inputs = { url: `${origin}/responsive-buggy.html`, landmarks: LANDMARKS, viewports: VIEWPORTS };
      const started = await h.ok('browser_run', { ...ids(s), requestKey: 'rr-bug', skillId: 'review-responsive', skillVersion: '1.0.0', inputs });
      const done = await waitDone(h, started.runId);
      assert.equal(done.state, 'failed'); assert.equal(done.verdict, 'failed');
      assert.equal(done.failed, 1);
      assert.ok(done.pending > 0, 'fail-fast: the later viewports were not run, and the run says so');
      const manifest = await agent.getManifest({ runId: started.runId });
      const prepared = registry.createRegistry().resolveForRun({ skillId: 'review-responsive', skillVersion: '1.0.0', inputs });
      const plan = prepared.def.compile(prepared.inputs, {}).plan;
      const defects = reviewResponsive.defects(plan, manifest.steps);
      assert.equal(defects.length, 1);
      assert.deepEqual(defects[0].target, { by: 'role', role: 'navigation', name: 'Primary' });
      assert.deepEqual(defects[0].viewport, { width: 375, height: 812 });
      assert.equal(defects[0].url, `${origin}/responsive-buggy.html`);
      assert.deepEqual(defects[0].reproduce, ['mobile-viewport', 'mobile-navigate', 'mobile-landmark-1']);
      // the failing viewport was a real 375px layout: the page itself, read back, agrees
      const o = await agent.observe(ids(s));
      assert.equal(o.nodes.some((n) => n.role === 'navigation' && n.name === 'Primary'), false, 'the nav is hidden at 375px');
    });
  } finally { await h.close(); }
});

real('review-responsive: a grant without the interact class cannot resize, nothing is captured, the run fails', async () => {
  const h = await connect(broker, principal);
  try {
    await withSession(async (s) => {
      const started = await h.ok('browser_run', { ...ids(s), requestKey: 'rr-denied', skillId: 'review-responsive', skillVersion: '1.0.0',
        inputs: { url: `${origin}/responsive.html`, landmarks: LANDMARKS, viewports: [VIEWPORTS[0]] } });
      const done = await waitDone(h, started.runId);
      assert.equal(done.state, 'failed');
      const manifest = await agent.getManifest({ runId: started.runId });
      assert.equal(manifest.steps[0].type, 'setViewport');
      assert.equal(manifest.steps[0].status, 'failed');
      assert.equal(manifest.artifacts.filter((a) => a.kind === 'screenshot').length, 0);
    }, { allowedOrigins: [origin], toolClasses: ['observe', 'navigate'] });
  } finally { await h.close(); }
});

real('review-responsive: a url outside the grant is refused before the page is touched', async () => {
  const h = await connect(broker, principal);
  try {
    await withSession(async (s) => {
      const r = await h.call('browser_run', { ...ids(s), requestKey: 'rr-out', skillId: 'review-responsive', skillVersion: '1.0.0',
        inputs: { url: 'http://127.0.0.1:9/elsewhere', landmarks: LANDMARKS } });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent.error.code, 'DENIED');
    });
  } finally { await h.close(); }
});

// ----------------------------------------------------------------------------------------------- extract-table

const COLUMNS = [{ name: 'order', header: 'Order' }, { name: 'customer', header: 'Customer' }, { name: 'total', header: 'Total', type: 'number' }, { name: 'status', header: 'Status' }];
async function extract(file, input, { start = file } = {}) {
  return withSession(async (s) => {
    await navigateTo(s, `${origin}/${start}`);
    return extractTable.run(agent, { columns: COLUMNS, tableName: 'Orders', ...input }, { ...ids(s), operationPrefix: `et-${++counter}` });
  });
}

real('extract-table: three pages become 12 typed records with source refs, missing markers and a positively observed end', async () => {
  const r = await extract('orders.html', { nextPage: { role: 'link', name: 'Next' } });
  assert.equal(r.complete, true, JSON.stringify({ reason: r.incompleteReason, problems: r.problems }));
  assert.equal(r.incompleteReason, null);
  assert.equal(r.pages, 3);
  assert.equal(r.rows.length, 12);
  assert.deepEqual(r.rows.map((x) => x.record.order), Array.from({ length: 12 }, (_, i) => `ORD-${1001 + i}`));
  assert.deepEqual(r.rows[0].record, { order: 'ORD-1001', customer: 'Ada', total: 12.5, status: 'Paid' }, 'totals are numbers, not strings');
  assert.equal(r.rows[2].record.status, 'Shipped');
  // explicit missing-value markers, never a guess
  assert.deepEqual(r.rows[5].missing, ['total']); assert.equal(r.rows[5].record.total, null);
  assert.deepEqual({ missing: r.rows[5].cells.total.missing, reason: r.rows[5].cells.total.reason }, { missing: true, reason: 'EMPTY_CELL' });
  assert.deepEqual(r.rows[6].missing, ['status']);
  assert.deepEqual(r.missing, { count: 2, reasons: { EMPTY_CELL: 2 } });
  // every value points at the observed table node and its position
  const c = r.rows[4].cells.customer;
  assert.equal(c.value, 'Barbara');
  assert.deepEqual({ row: c.source.row, col: c.source.col, page: c.source.page }, { row: 0, col: 1, page: 2 });
  assert.ok(c.source.ref && r.observationIds.includes(c.source.observationId));
  assert.equal(r.trust, 'untrusted-page');
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 64 * 1024);
});

real('extract-table: with no configured control the observation\'s pagination hint finds Next and the disabled Next ends the data', async () => {
  const r = await extract('orders.html', {});
  assert.equal(r.complete, true, JSON.stringify({ reason: r.incompleteReason, problems: r.problems }));
  assert.equal(r.rows.length, 12);
  const none = await extract('orders.html?mode=nopager', {});
  assert.equal(none.complete, false); assert.equal(none.incompleteReason, 'PAGINATION_NOT_CONFIGURED'); assert.equal(none.rows.length, 4);
  assert.equal((await extract('orders.html?mode=nopager', { singlePage: true })).complete, true, 'a single page is complete only when the caller says so');
});

real('extract-table: every pagination failure is an explicit incomplete result with the rows read so far', async () => {
  const next = { nextPage: { role: 'link', name: 'Next' } };
  const stuck = await extract('orders.html?mode=stuck', next);
  assert.equal(stuck.complete, false); assert.equal(stuck.incompleteReason, 'PAGINATION_NO_PROGRESS'); assert.equal(stuck.rows.length, 4);
  assert.ok(stuck.problems.includes('PAGINATION_NO_PROGRESS'));
  const vanish = await extract('orders.html?mode=vanish', next);
  assert.equal(vanish.complete, false, 'a missing Next on the last page is not proof that the data ended');
  assert.equal(vanish.incompleteReason, 'NEXT_CONTROL_NOT_FOUND'); assert.equal(vanish.rows.length, 12);
  const capped = await extract('orders.html', { ...next, maxPages: 2 });
  assert.equal(capped.incompleteReason, 'MAX_PAGES_REACHED'); assert.equal(capped.rows.length, 8); assert.equal(capped.complete, false);
  const rowCap = await extract('orders.html', { ...next, maxRows: 6 });
  assert.equal(rowCap.incompleteReason, 'MAX_ROWS_REACHED'); assert.equal(rowCap.rows.length, 6);
  const wrongName = await extract('orders.html', { nextPage: { role: 'link', name: 'Forward' } });
  assert.equal(wrongName.incompleteReason, 'NEXT_CONTROL_NOT_FOUND'); assert.equal(wrongName.rows.length, 4);
  const wrongTable = await extract('orders.html', { tableName: 'Invoices', ...next });
  assert.equal(wrongTable.incompleteReason, 'TABLE_NOT_FOUND'); assert.equal(wrongTable.rows.length, 0);
});

real('extract-table: unknown columns, type mismatches, merged cells, withheld secrets and oversized pages are all explicit', async () => {
  const single = { singlePage: true };
  const unknown = await extract('orders.html', { ...single, columns: [{ name: 'price', header: 'Price' }] });
  assert.equal(unknown.complete, false); assert.equal(unknown.incompleteReason, 'COLUMN_NOT_FOUND'); assert.equal(unknown.rows[0].cells.price.reason, 'COLUMN_NOT_FOUND');
  const mismatch = await extract('orders.html', { ...single, columns: [{ name: 'customer', header: 'Customer', type: 'number' }, { name: 'order', header: 'Order' }] });
  assert.equal(mismatch.complete, true, 'a typed mismatch is a marker on that value, the table itself parsed');
  assert.ok(mismatch.rows.every((x) => x.cells.customer.missing && x.cells.customer.reason === 'TYPE_MISMATCH' && x.record.customer === null && x.cells.customer.raw));
  assert.equal(mismatch.missing.reasons.TYPE_MISMATCH, 4);

  const accounts = await extract('tables.html', { ...single, tableName: 'Accounts', columns: [{ name: 'user', header: 'User' }, { name: 'password', header: 'Password' }] });
  assert.deepEqual(accounts.rows.map((x) => x.record.user), ['ada', 'grace', 'alan']);
  assert.ok(accounts.rows.every((x) => x.cells.password.missing && x.cells.password.reason === 'WITHHELD' && x.record.password === null));
  assert.ok(!JSON.stringify(accounts).includes('CANARY'), 'secret-looking columns never reach the result');
  const merged = await extract('tables.html', { ...single, tableName: 'Merged', columns: [{ name: 'region', header: 'Region' }] });
  assert.equal(merged.incompleteReason, 'MERGED_CELLS'); assert.equal(merged.rows.length, 0);
  const big = await extract('tables.html', { ...single, tableName: 'Big', columns: [{ name: 'c0', header: 'C0' }, { name: 'c13', header: 'C13' }] });
  assert.equal(big.complete, false); assert.equal(big.incompleteReason, 'COLUMNS_TRUNCATED', 'a column beyond the 12 an observation carries is reported, not invented');
  const bigRows = await extract('tables.html', { ...single, tableName: 'Big', columns: [{ name: 'c0', header: 'C0' }] });
  assert.equal(bigRows.complete, false); assert.equal(bigRows.incompleteReason, 'PAGE_ROWS_TRUNCATED');
  assert.equal(bigRows.rows.length, 50, 'the rows that were observed are kept');
  const ambiguous = await extract('tables.html', { ...single, tableName: undefined, columns: [{ name: 'c0', header: 'C0' }] });
  assert.equal(ambiguous.incompleteReason, 'AMBIGUOUS_TABLE');
});

real('browser_observe relays table, list and pagination payloads through the strict MCP schemas', async () => {
  const h = await connect(broker, principal);
  try {
    await withSession(async (s) => {
      await navigateTo(s, `${origin}/orders.html?page=2`);
      const o = await h.ok('browser_observe', { ...ids(s) });
      const table = o.nodes.find((n) => n.role === 'table');
      assert.deepEqual(table.table.headers, ['Order', 'Customer', 'Total', 'Status']);
      assert.equal(table.table.cells.length, 4);
      const next = o.nodes.find((n) => n.role === 'link' && n.name === 'Next');
      assert.equal(o.pagination.next.ref, next.ref, 'the hint is an ordinary ref from this observation');
      assert.equal(o.pagination.prev.enabled, true);
      assert.ok(JSON.stringify(o).length < 64 * 1024);
      await navigateTo(s, `${origin}/tables.html`);
      const t = await h.ok('browser_observe', { ...ids(s) });
      assert.ok(t.nodes.some((n) => n.role === 'list' && n.list.items.includes('apples')));
      assert.ok(!JSON.stringify(t).includes('CANARY'));
      // a ref from the hint is actable like any other
      const o2 = await h.ok('browser_observe', { ...ids(s) });
      assert.ok(o2.pagination.next.ref);
    });
  } finally { await h.close(); }
});
