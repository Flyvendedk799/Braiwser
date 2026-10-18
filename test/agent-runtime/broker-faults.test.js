'use strict';
// Popups, device settings, storage faults, hostile input and restart idempotency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createBroker } = require('../../src/main/services/browser/broker');
const { createFakeDriver } = require('./fake-driver');
const H = require('./harness');
const { boot, observe, nodeNamed, act, go, codeOf, until, tmp, mcp } = H;

test('popup opened and closed quickly leaves no orphan page, ref or lane; the opener is untouched', async () => {
  const h = boot(); const s = await h.open(); const o = await go(h.a, s);
  const session = h.broker._internals.sessions.get(s.sessionId);
  const p = h.fake.firstPage.openPopup('https://app.test/two');
  assert.equal(session.pages.size, 2);
  p.closePage();
  assert.equal(session.pages.size, 1);
  assert.equal(session.lease.pages.size, 1);
  assert.equal((await act(h.a, s, o, { kind: 'click', ref: nodeNamed(o, 'Preview').ref })).status, 'verified'); // opener refs survive
  for (let i = 0; i < 20; i++) h.fake.firstPage.openPopup('https://app.test/two').closePage();
  assert.equal(session.pages.size, 1);
  await h.broker.close();
});

test('a popup that opens on a forbidden destination is quarantined on arrival, the opener keeps working', async () => {
  const h = boot(); const s = await h.open(); const o = await go(h.a, s);
  const session = h.broker._internals.sessions.get(s.sessionId);
  h.fake.firstPage.openPopup('https://evil.test/');
  const pop = [...session.pages.values()].find((p) => p.opener);
  assert.equal(pop.owned.owner, 'quarantined');
  assert.equal(session.page(s.pageId).owned.owner, 'agent');
  assert.equal((await act(h.a, s, o, { kind: 'click', ref: nodeNamed(o, 'Preview').ref })).status, 'verified');
  await h.broker.close();
});

test('popups beyond the page cap are disposed, not registered', async () => {
  const h = boot({ limits: { maxPagesPerSession: 2 } }); const s = await h.open(); await go(h.a, s);
  const session = h.broker._internals.sessions.get(s.sessionId);
  h.fake.firstPage.openPopup('https://app.test/two'); const third = h.fake.firstPage.openPopup('https://app.test/two');
  assert.equal(session.pages.size, 2); assert.equal(third.closed, true);
  await h.broker.close();
});

test('device settings reach the driver unchanged and bad ones are rejected', async () => {
  const h = boot();
  await h.open(h.a, { viewport: { width: 390, height: 844, deviceScaleFactor: 3 }, locale: 'da-DK', timezoneId: 'Europe/Copenhagen' });
  const opts = h.fake.lastSession.state.opts;
  assert.deepEqual(opts.viewport, { width: 390, height: 844, deviceScaleFactor: 3 });
  assert.equal(opts.locale, 'da-DK'); assert.equal(opts.timezoneId, 'Europe/Copenhagen'); assert.equal(opts.mode, 'headless');
  assert.equal(await codeOf(h.open(h.a, { viewport: { width: 5, height: 5 } })), 'DENIED');
  assert.equal(await codeOf(h.open(h.a, { locale: '../x' })), 'DENIED');
  await h.broker.close();
});

test('reference expiry: refs die after their TTL even in an unchanged document', async () => {
  let now = Date.now();
  const h = boot({ clock: { now: () => now }, limits: { refTtlMs: 1000 } }); const s = await h.open(); const o = await go(h.a, s);
  now += 1500;
  assert.equal(await codeOf(act(h.a, s, o, { kind: 'click', ref: nodeNamed(o, 'Preview').ref })), 'STALE_REF');
  const o2 = await observe(h.a, s);
  assert.equal((await act(h.a, s, o2, { kind: 'click', ref: nodeNamed(o2, 'Preview').ref })).status, 'verified');
  await h.broker.close();
});

test('storage fault: if dispatch_started cannot be made durable, no input is emitted and the ledger refuses further writes', async () => {
  let fail = false;
  const faulty = { ...fs, writeSync: (fd, data, ...rest) => { if (fail && typeof data === 'string' && data.includes('"dispatch_started"')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return fs.writeSync(fd, data, ...rest); } };
  const fake = createFakeDriver();
  const broker = createBroker({ dataDir: tmp(), drivers: { playwright: fake.driver }, featureFlag: true, fs: faulty });
  const a = broker.forPrincipal(mcp('agent', H.AGENT_SCOPES));
  const s = await a.openSession({ driver: 'playwright', mode: 'headless', grant: H.GRANT }); const o = await go(a, s);
  fail = true;
  const r = await act(a, s, o, { kind: 'click', ref: nodeNamed(o, 'Preview').ref });
  assert.equal(r.status, 'not_attempted'); assert.equal(r.code, 'LEDGER_WRITE_FAILED'); assert.equal(r.dispatched, false);
  assert.equal(fake.world.dispatchLog.length, 0);
  fail = false;
  const o2 = await observe(a, s);
  const again = await act(a, s, o2, { kind: 'click', ref: nodeNamed(o2, 'Preview').ref }).catch((e) => e);
  assert.ok((again.publicError && again.publicError.code === 'UNAVAILABLE') || again.status === 'not_attempted'); // poisoned: never silently continues
  assert.equal(fake.world.dispatchLog.length, 0);
  await broker.close();
});

test('hostile ids and paths are rejected before any mutation', async () => {
  const h = boot(); const s = await h.open(); const o = await go(h.a, s);
  const before = h.broker._internals.ledger.stats().operations;
  for (const operationId of ['../../etc/passwd', 'a/b', '', 'x'.repeat(200), 'a b', 'a\u0000b']) {
    assert.equal(await codeOf(h.a.act({ sessionId: s.sessionId, pageId: s.pageId, observationId: o.observationId, documentEpoch: o.documentEpoch, operationId, action: { kind: 'click', ref: nodeNamed(o, 'Preview').ref } })), 'DENIED', JSON.stringify(operationId));
  }
  for (const bad of ['../x', 'C:\\Windows', '/etc/passwd']) {
    assert.equal(await codeOf(h.a.observe({ sessionId: bad, pageId: s.pageId })), 'DENIED');
    assert.equal(await codeOf(h.a.getRun({ runId: bad })), 'DENIED');
    assert.equal(await codeOf(h.a.getManifest({ runId: bad })), 'DENIED');
  }
  assert.equal(await codeOf(h.a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: '../k', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: {} })), 'DENIED');
  assert.equal(h.broker._internals.ledger.stats().operations, before);
  assert.equal(h.fake.world.dispatchLog.length, 0);
  await h.broker.close();
});

test('an operation in flight at a crash is recorded as uncertain after restart and never re-executed', async () => {
  const h = boot(); const s = await h.open(); const o = await go(h.a, s);
  let release; h.fake.ctl.hang = new Promise((r) => { release = r; });
  const input = { sessionId: s.sessionId, pageId: s.pageId, observationId: o.observationId, documentEpoch: o.documentEpoch, operationId: 'crashy', action: { kind: 'click', ref: nodeNamed(o, 'Preview').ref }, timeoutMs: 5000 };
  h.a.act(input).catch(() => {});
  await until(() => h.fake.world.dispatchLog.length === 1);
  const { ledger, runStore } = h.broker._internals; ledger._crash(); runStore._crash();
  const fake2 = createFakeDriver();
  const second = createBroker({ dataDir: h.dataDir, drivers: { playwright: fake2.driver }, featureFlag: true });
  const op = second._internals.ledger.get(s.sessionId, 'crashy');
  assert.equal(op.receipt.status, 'uncertain'); assert.equal(op.receipt.code, 'INTERRUPTED_EFFECT_UNKNOWN');
  assert.equal(second._internals.ledger.unresolved().length, 0);
  assert.equal(fake2.world.dispatchLog.length, 0); // nothing replayed
  release(); await second.close();
});
