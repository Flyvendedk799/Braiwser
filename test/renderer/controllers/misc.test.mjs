import test from 'node:test';
import assert from 'node:assert/strict';
import { runBulk, describeBulk } from '../../../src/renderer/controllers/bulk.js';
import { mergeFilteredOrder } from '../../../src/renderer/lib/note-order.js';
import { createOperationContexts, createGeneration, createSingleFlight, createOwnerCache } from '../../../src/renderer/controllers/operation-context.js';
import { createAwakeHolder } from '../../../src/renderer/controllers/keep-awake.js';
import { requestFromGuest } from '../../../src/renderer/controllers/guest-request.js';
import { FakeWv, manualTimers, tick } from './fakes.mjs';

test('bulk: failures are counted, kept, and never announced as successes', async () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const res = await runBulk(items, async (a) => { if (a.id === 2) throw new Error('disk full'); return a.id * 10; });
  assert.deepEqual(res.ok.map((r) => r.result), [10, 30]);
  assert.deepEqual(res.failed.map((f) => [f.item.id, f.error]), [[2, 'disk full']]);
  assert.deepEqual(describeBulk('Updated', 'note', res), { tone: 'warn', text: 'Updated 2 notes; 1 failed' });
  const allBad = await runBulk(items, async () => { throw new Error('x'); });
  assert.equal(describeBulk('Deleted', 'note', allBad).tone, 'error');
  const clean = await runBulk([1], async () => 1);
  assert.deepEqual(describeBulk('Updated', 'note', clean), { tone: 'success', text: 'Updated 1 note' });
});

test('note reorder: a filtered view submits the FULL order; hidden notes keep their slots', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];
  // only b, d, e are visible and the user drags e to the top of the visible list
  assert.deepEqual(mergeFilteredOrder(full, ['e', 'b', 'd']), ['a', 'e', 'c', 'b', 'd']);
  assert.deepEqual(mergeFilteredOrder(full, full), full);
  assert.deepEqual(mergeFilteredOrder(full, ['d', 'zzz', 'd']), full.map((x) => x).map((x) => (x === 'd' ? 'd' : x)));
  assert.equal(new Set(mergeFilteredOrder(full, ['e', 'a'])).size, 5, 'no duplicates, nothing lost');
});

function ctxWorld() {
  const tabs = new Map([['A', { id: 'A', wv: {}, docGen: 0, documentId: '' }], ['B', { id: 'B', wv: {}, docGen: 0, documentId: '' }]]);
  const w = { tabs, active: 'A', session: { id: 'S1' }, epoch: 0 };
  w.ops = createOperationContexts({ getTab: (id) => tabs.get(id) || null, getActiveTabId: () => w.active, getSession: () => w.session, getSessionEpoch: () => w.epoch });
  return w;
}

test('operation context: captures tab/session identity and detects every kind of drift', () => {
  const w = ctxWorld();
  const ctx = w.ops.capture('x');
  assert.equal(ctx.tabId, 'A');
  assert.equal(w.ops.staleReason(ctx, { doc: true, session: true, active: true }), null);
  w.active = 'B';
  assert.match(w.ops.staleReason(ctx, { active: true }), /front/);
  assert.equal(w.ops.staleReason(ctx), null, 'plain tab check survives a tab switch');
  w.tabs.get('A').docGen = 1;
  assert.match(w.ops.staleReason(ctx, { doc: true }), /navigated/);
  w.session = { id: 'S2' };
  assert.match(w.ops.staleReason(ctx, { session: true }), /session/);
  w.session = { id: 'S1' }; w.epoch = 1;
  assert.match(w.ops.staleReason(ctx, { session: true }), /reopened/);
  w.tabs.get('A').closed = true;
  assert.match(w.ops.staleReason(ctx), /closed/);
});

test('operation context: guest documentId is the document identity once known', () => {
  const w = ctxWorld();
  w.tabs.get('A').documentId = 'd1';
  const ctx = w.ops.capture('x');
  assert.equal(ctx.documentId, 'd1');
  w.tabs.get('A').documentId = 'd2';
  assert.match(w.ops.staleReason(ctx, { doc: true }), /navigated/);
  // a context taken before the id was known never goes stale on the id alone
  w.tabs.get('B').documentId = '';
  const early = w.ops.capture('x', { tabId: 'B' });
  w.tabs.get('B').documentId = 'dB';
  assert.equal(w.ops.staleReason(early, { doc: true }), null);
});

test('generation / single-flight / owner cache helpers', async () => {
  const g = createGeneration();
  const t1 = g.begin(); const t2 = g.begin();
  assert.equal(g.valid(t1), false);
  assert.equal(g.valid(t2), true);
  g.invalidate();
  assert.equal(g.valid(t2), false);
  const sf = createSingleFlight();
  let n = 0;
  const [a, b] = [sf.run('k', async () => ++n), sf.run('k', async () => ++n)];
  assert.equal(a, b);
  await a;
  assert.equal(n, 1);
  const c = createOwnerCache();
  c.set('S1', [1]);
  assert.equal(c.get('S2'), undefined);
});

test('keep-awake: holds the guest for the duration, releases on every path, refcounts overlap', async () => {
  const calls = [];
  const power = { keepAwake: async (id) => { calls.push(id); } };
  const h = createAwakeHolder(power);
  const r1 = h.acquire(() => 7);
  await h.settled();
  const r2 = h.acquire(() => 9);
  await h.settled();
  assert.deepEqual(calls, [7, 9]);
  await r2(); // the later hold ends: fall back to the first
  assert.deepEqual(calls, [7, 9, 7]);
  await r1(); await r1(); // idempotent
  assert.deepEqual(calls, [7, 9, 7, null]);
  assert.equal(h.size(), 0);
  // a webview that cannot report its id never throws
  const r3 = h.acquire(() => { throw new Error('not ready'); });
  await r3();
  assert.deepEqual(calls, [7, 9, 7, null]);
  // missing power API (older preload) is tolerated
  const none = createAwakeHolder(undefined);
  await none.acquire(() => 1)();
});

test('keep-awake: a replay that throws still releases (finally pattern)', async () => {
  const calls = [];
  const h = createAwakeHolder({ keepAwake: async (id) => { calls.push(id); } });
  const release = h.acquire(() => 5);
  await h.settled();
  try { throw new Error('boom'); } catch (_e) { /* replay failed */ } finally { release(); }
  await h.settled();
  assert.deepEqual(calls, [5, null]);
});

test('guest request: reply is matched on the element it was sent to; listener always removed', async () => {
  const A = new FakeWv('A'); const B = new FakeWv('B');
  const p = requestFromGuest(A, { channel: 'q', payload: { x: 1 }, replyChannel: 'r', timeoutMs: 1000, fallback: 'none' });
  B.ipc('r', 'from-B'); // another tab answering is irrelevant
  A.ipc('r', 'from-A');
  assert.equal(await p, 'from-A');
  assert.equal(A.listenerCount(), 0);
  assert.deepEqual(A.sent[0], ['q', { x: 1 }]);
});

test('guest request: accept() filters stale replies; timeout yields the fallback', async () => {
  const A = new FakeWv('A');
  const timers = manualTimers();
  const p = requestFromGuest(A, { channel: 'q', replyChannel: 'r', accept: (r) => r.id === 2, timeoutMs: 5, fallback: null, timers });
  A.ipc('r', { id: 1 });
  await tick();
  timers.runAll();
  assert.equal(await p, null);
  assert.equal(A.listenerCount(), 0);
  assert.equal(await requestFromGuest(null, { channel: 'q', replyChannel: 'r', fallback: 'x' }), 'x');
});
