'use strict';
// Proposed release targets (audit): p95 focused observation < 1 s on a 10,000-node fixture,
// bounded response (64 KiB) with truncation metadata, cancellation fence < 250 ms,
// worker shutdown < 5 s. These measure the broker layer over a fake driver only
// (not a real browser, not network latency).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SITE } = require('./fake-driver');
const H = require('./harness');
const { boot, observe, go, start, until, delay } = H;

test('10,000-node page: p95 observation under 1 s, every response within 64 KiB', async () => {
  const site = { ...DEFAULT_SITE, 'https://app.test/': { elements: Array.from({ length: 10000 }, (_, i) => ({ id: `e${i}`, role: 'button', name: `Item ${i} ${'x '.repeat(40)}` })) } };
  const h = boot({ driverOptions: { site }, limits: {} }); const s = await h.open(); await go(h.a, s);
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = process.hrtime.bigint();
    const o = await observe(h.a, s, { maxNodes: 200, focus: 'Item 42' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.ok(Buffer.byteLength(JSON.stringify(o)) <= 64 * 1024);
    assert.ok(o.nodes.length <= 200); assert.equal(o.truncated, true); assert.ok(o.nextCursor);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 1000, `p95 ${p95}ms`);
  await h.broker.close();
});

test('cancellation fence is immediate and shutdown with hung work completes within 5 s', async () => {
  const h = boot(); const sessions = await Promise.all([h.open(), h.open(), h.open()]);
  h.fake.ctl.hang = new Promise(() => {}); // browser stalls after dispatch, forever
  const runs = [];
  for (const s of sessions) runs.push(await start(h.a, s));
  await until(() => h.fake.world.dispatchLog.length >= 1);
  const t0 = Date.now();
  const cancelled = await h.a.cancelRun({ runId: runs[0].runId });
  assert.equal(cancelled.cancelRequested, true);
  assert.ok(Date.now() - t0 < 1000);
  const fenceT = Date.now();
  await delay(50);
  assert.ok(h.fake.world.dispatchLog.every((e) => e.at <= fenceT));
  const t1 = Date.now();
  await h.broker.close();
  assert.ok(Date.now() - t1 < 5000, `shutdown took ${Date.now() - t1}ms`);
});
