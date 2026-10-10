'use strict';
// Ownership kernel regression tests: the audit's sixteen reference tests (ported
// to node:test, fake drivers only) plus the session lease, journal hooks and
// ownership recheck helpers added in the repo version.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnedPage, SessionLease } = require('../../src/main/services/browser/owned-page');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cmd = (operationId, extra = {}) => ({ operationId, sessionId: 's1', pageId: 'p1', documentEpoch: 0, action: { kind: 'click' }, ...extra });
const verified = () => ({ status: 'verified', evidence: [{ kind: 'visible', observed: true }] });
const options = { sessionId: 's1', pageId: 'p1', validateEvidence: (_, result) => result.evidence?.every((e) => e.kind === 'visible' && e.observed === true) };

// ---- audit reference tests ---------------------------------------------------
test('serializes actions and deduplicates the same command', async () => {
  let running = 0; let peak = 0; let calls = 0;
  const page = new OwnedPage({ ...options, execute: async (_, c) => {
    calls++; running++; peak = Math.max(peak, running);
    await delay(5); c.beforeDispatch(); running--; return verified();
  } });
  const a = page.act(cmd('1'));
  assert.equal(a, page.act(cmd('1')));
  const results = await Promise.all([a, page.act(cmd('2'))]);
  assert.equal(peak, 1); assert.equal(calls, 2);
  assert.deepEqual(results.map((x) => x.status), ['verified', 'verified']);
  assert.throws(() => page.act(cmd('1', { action: { kind: 'fill' } })), /IDEMPOTENCY_CONFLICT/);
});

test('rejects wrong page and stale document before dispatch', async () => {
  let calls = 0;
  const page = new OwnedPage({ ...options, execute: async (_, c) => { calls++; c.beforeDispatch(); return verified(); } });
  assert.throws(() => page.act(cmd('wrong', { pageId: 'p2' })), /WRONG_SCOPE/);
  page.navigated();
  assert.equal((await page.act(cmd('stale'))).code, 'STALE_DOCUMENT');
  assert.equal(calls, 0);
});

test('rechecks document after asynchronous resolution', async () => {
  let clicked = false;
  const page = new OwnedPage({ ...options, execute: async (_, c) => { await delay(5); page.navigated(); c.beforeDispatch(); clicked = true; return verified(); } });
  assert.equal((await page.act(cmd('1'))).status, 'not_attempted');
  assert.equal(clicked, false);
});

test('timeout retains real driver barrier and reports external effect uncertainty', async () => {
  let release; let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const page = new OwnedPage({ ...options, execute: async (_, c) => { calls++; c.beforeDispatch(); await pending; return verified(); } });
  const first = await page.act(cmd('1'), { timeoutMs: 10 });
  assert.equal(first.status, 'uncertain'); assert.equal(page.owner, 'quarantined');
  const second = page.act(cmd('2'), { timeoutMs: 100 });
  await delay(5); assert.equal(calls, 1);
  release();
  assert.equal((await second).status, 'not_attempted');
  assert.equal(calls, 1);
  assert.deepEqual(await page.act(cmd('1')), first);
});

test('dispatch acknowledgment without evidence is never verified', async () => {
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); return { status: 'verified', evidence: [] }; } });
  assert.equal((await page.act(cmd('1'))).status, 'dispatched');
});

test('human ownership invalidates old refs and requires fresh observation on resume', async () => {
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); return verified(); } });
  assert.equal((await page.handoff()).owner, 'human');
  assert.equal((await page.act(cmd('1'))).code, 'OWNERSHIP_LOST');
  const resumed = page.resume();
  assert.equal(resumed.requireFreshObservation, true);
  assert.equal((await page.act(cmd('2'))).code, 'STALE_DOCUMENT');
  assert.equal((await page.act(cmd('3', { documentEpoch: resumed.documentEpoch }))).status, 'verified');
});

test('cancelled queued work does not execute or poison an idle page', async () => {
  let calls = 0;
  const page = new OwnedPage({ ...options, execute: async (_, c) => { calls++; c.beforeDispatch(); return verified(); } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await page.act(cmd('1'), { signal: controller.signal })).status, 'not_attempted');
  assert.equal(calls, 0); assert.equal(page.owner, 'agent');
});

test('late navigation cannot turn unrelated evidence into a verified result', async () => {
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); await delay(1); page.navigated(); return verified(); } });
  const receipt = await page.act(cmd('1'));
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.code, 'COMPLETION_SCOPE_CHANGED');
});

test('cached receipt and evidence cannot be mutated through aliases', async () => {
  const result = verified();
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); return result; } });
  const receipt = await page.act(cmd('1'));
  result.evidence[0].observed = false;
  assert.equal(receipt.evidence[0].observed, true);
  assert.throws(() => { receipt.evidence[0].observed = false; }, TypeError);
  assert.equal((await page.act(cmd('1'))).evidence[0].observed, true);
});

test('evidence is unverified unless a trusted validator accepts it', async () => {
  const page = new OwnedPage({ sessionId: 's1', pageId: 'p1', execute: async (_, c) => { c.beforeDispatch(); return verified(); } });
  assert.equal((await page.act(cmd('1'))).status, 'dispatched');
});

test('unserializable driver evidence yields uncertainty instead of hanging', async () => {
  const result = verified(); result.evidence[0].self = result.evidence[0];
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); return result; } });
  assert.equal((await page.act(cmd('1'))).status, 'uncertain');
});

test('transition authorization must be a synchronous explicit true', async () => {
  const page = new OwnedPage({ ...options, acceptTransition: () => Promise.resolve(true), execute: async (_, c) => { c.beforeDispatch(); page.navigated(); return verified(); } });
  const receipt = await page.act(cmd('1'));
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.code, 'COMPLETION_SCOPE_CHANGED');
});

// ---- additional kernel guarantees --------------------------------------------------
test('a trusted synchronous transition validator may accept a navigation', async () => {
  const page = new OwnedPage({ ...options, acceptTransition: () => true, execute: async (_, c) => { c.beforeDispatch(); page.navigated(); return verified(); } });
  assert.equal((await page.act(cmd('1'))).status, 'verified');
});

test('an action that never calls beforeDispatch is not_attempted, never verified', async () => {
  const page = new OwnedPage({ ...options, execute: async () => verified() });
  const r = await page.act(cmd('1'));
  assert.equal(r.status, 'not_attempted'); assert.equal(r.code, 'DRIVER_DID_NOT_DISPATCH');
});

test('abort while waiting for a target (before dispatch) is not_attempted', async () => {
  const controller = new AbortController();
  const page = new OwnedPage({ ...options, execute: async (_, c) => { await delay(30); c.beforeDispatch(); return verified(); } });
  const p = page.act(cmd('1'), { signal: controller.signal });
  await delay(5); controller.abort();
  const r = await p;
  assert.equal(r.status, 'not_attempted'); assert.equal(r.code, 'CANCELLED'); assert.equal(r.dispatched, false);
});

test('receipts carry dispatched / effectUnknown flags', async () => {
  const page = new OwnedPage({ ...options, execute: async (_, c) => { c.beforeDispatch(); throw Object.assign(new Error('x'), { code: 'BOOM' }); } });
  const r = await page.act(cmd('1'));
  assert.equal(r.status, 'uncertain'); assert.equal(r.dispatched, true); assert.equal(r.effectUnknown, true); assert.equal(r.code, 'BOOM');
});

test('operation capacity is explicit, never silent eviction', async () => {
  const page = new OwnedPage({ ...options, maxOperations: 2, execute: async (_, c) => { c.beforeDispatch(); return verified(); } });
  await page.act(cmd('1')); await page.act(cmd('2'));
  assert.throws(() => page.act(cmd('3')), /OPERATION_CAPACITY/);
  assert.equal((await page.act(cmd('1'))).status, 'verified'); // old ids are still deduplicated
});

test('invalid timeout is rejected', () => {
  const page = new OwnedPage({ ...options, execute: async () => verified() });
  assert.throws(() => page.act(cmd('1'), { timeoutMs: 0 }), /INVALID_TIMEOUT/);
});

test('ownership recheck helpers report the failing condition', async () => {
  const lease = new SessionLease({ sessionId: 's1' });
  const page = new OwnedPage({ ...options, lease, execute: async (_, c) => { c.beforeDispatch(); return verified(); } });
  assert.equal(page.ownershipProblem(), null);
  await lease.takeOver();
  assert.equal(page.ownershipProblem(), 'OWNERSHIP_LOST');
  assert.throws(() => page.assertOwnership(), /OWNERSHIP_LOST/);
});

// ---- session lease -----------------------------------------------------------------
function twoPageSession(executeFor = {}) {
  const lease = new SessionLease({ sessionId: 's1' });
  const mk = (pageId) => new OwnedPage({ ...options, pageId, lease, execute: executeFor[pageId] || (async (_, c) => { c.beforeDispatch(); return verified(); }) });
  return { lease, a: mk('p1'), b: mk('p2') };
}
const cmdFor = (pageId, operationId, extra = {}) => cmd(operationId, { pageId, ...extra });

test('human takeover revokes agent dispatch on EVERY page of the session', async () => {
  const { lease, a, b } = twoPageSession();
  const r = await lease.takeOver();
  assert.equal(r.owner, 'human');
  assert.equal(a.owner, 'human'); assert.equal(b.owner, 'human');
  assert.equal((await a.act(cmdFor('p1', '1', { documentEpoch: a.documentEpoch }))).code, 'OWNERSHIP_LOST');
  assert.equal((await b.act(cmdFor('p2', '2', { documentEpoch: b.documentEpoch }))).code, 'OWNERSHIP_LOST');
});

test('takeover aborts in-flight work on a sibling page and never emits input afterwards', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const emitted = [];
  const { lease, a, b } = twoPageSession({
    p1: async (_, c) => { await gate; c.beforeDispatch(); emitted.push('p1'); return verified(); },
    p2: async (_, c) => { c.beforeDispatch(); emitted.push('p2'); return verified(); },
  });
  const inflight = a.act(cmdFor('p1', '1'), { timeoutMs: 1000 });
  const queued = b.act(cmdFor('p2', '2'), { timeoutMs: 1000 });
  await delay(2);
  const takeover = lease.takeOver({ acknowledgeUncertain: true });
  release();
  await takeover;
  assert.equal((await inflight).status, 'not_attempted');
  assert.deepEqual(emitted.filter((x) => x === 'p1'), []);
  const later = await queued; // queued behind nothing on b, ran before or after: it must never emit once revoked
  assert.ok(['verified', 'not_attempted', 'uncertain'].includes(later.status));
  assert.equal(emitted.includes('p1'), false);
  // after the takeover nothing can emit
  const n = emitted.length;
  await b.act(cmdFor('p2', '3', { documentEpoch: b.documentEpoch }));
  assert.equal(emitted.length, n);
});

test('takeover of a session with an uncertain action needs trusted acknowledgement', async () => {
  const { lease, a } = twoPageSession({ p1: async (_, c) => { c.beforeDispatch(); await delay(40); return verified(); } });
  const p = a.act(cmdFor('p1', '1'), { timeoutMs: 5 });
  assert.equal((await p).status, 'uncertain');
  await assert.rejects(lease.takeOver(), /RECONCILE_BEFORE_HANDOFF/);
  assert.equal(lease.owner, 'agent'); // refused: nothing changed hands
  assert.equal(a.owner, 'quarantined');
  await delay(60); // real barrier settles
  const r = await lease.takeOver({ acknowledgeUncertain: true });
  assert.equal(r.uncertain, true);
  assert.equal(a.owner, 'human');
  lease.resume();
  assert.equal(a.owner, 'agent');
});

test('a hung driver cannot be drained: takeover is refused, page stays quarantined', async () => {
  const never = new Promise(() => {});
  const { lease, a, b } = twoPageSession({ p1: async (_, c) => { c.beforeDispatch(); await never; return verified(); } });
  a.act(cmdFor('p1', '1'), { timeoutMs: 1000 });
  await delay(5);
  await assert.rejects(lease.takeOver({ acknowledgeUncertain: true, drainTimeoutMs: 20 }), /DRAIN_TIMEOUT/);
  assert.equal(a.owner, 'quarantined');
  assert.equal(b.owner, 'agent'); // idle sibling is restored
  assert.notEqual(lease.owner, 'human');
});

test('fencing epoch: work accepted before takeover+resume cannot run after it', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let ran = 0;
  const { lease, a } = twoPageSession({ p1: async (_, c) => { if (++ran === 1) await gate; c.beforeDispatch(); return verified(); } });
  const first = a.act(cmdFor('p1', '1'), { timeoutMs: 1000 });
  const second = a.act(cmdFor('p1', '2'), { timeoutMs: 1000 });
  await delay(2);
  const t = lease.takeOver({ acknowledgeUncertain: true });
  release();
  await t;
  lease.resume();
  const r2 = await second;
  assert.equal(r2.status, 'not_attempted');
  assert.ok(['OWNERSHIP_LOST', 'CANCELLED'].includes(r2.code), r2.code);
  await first;
});

test('resume bumps every page epoch and demands a fresh observation', async () => {
  const { lease, a, b } = twoPageSession();
  await lease.takeOver();
  const before = [a.documentEpoch, b.documentEpoch];
  const r = lease.resume();
  assert.equal(r.requireFreshObservation, true);
  assert.equal(a.documentEpoch, before[0] + 1); assert.equal(b.documentEpoch, before[1] + 1);
  assert.equal((await a.act(cmdFor('p1', '1', { documentEpoch: before[0] }))).code, 'STALE_DOCUMENT');
  assert.throws(() => lease.resume(), /NOT_HUMAN_OWNED/);
});

test('a page registered while a human holds the session is human-owned', async () => {
  const { lease } = twoPageSession();
  await lease.takeOver();
  const late = new OwnedPage({ ...options, pageId: 'p3', lease, execute: async () => verified() });
  assert.equal(late.owner, 'human');
});

test('concurrent takeovers: only one wins', async () => {
  const { lease } = twoPageSession();
  const results = await Promise.allSettled([lease.takeOver(), lease.takeOver()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('independent sessions are unaffected by another session takeover', async () => {
  const s1 = twoPageSession(); const s2 = twoPageSession();
  await s1.lease.takeOver();
  assert.equal((await s2.a.act(cmdFor('p1', '1'))).status, 'verified');
});

test('read() refuses while a human owns the page and reports document changes', async () => {
  const { lease, a } = twoPageSession();
  assert.equal((await a.read(async ({ documentEpoch }) => documentEpoch)).value, 0);
  await assert.rejects(a.read(async () => { a.navigated(); return 1; }), /STALE_DOCUMENT/);
  await lease.takeOver();
  await assert.rejects(a.read(async () => 1), /OWNERSHIP_LOST/);
});

// ---- journal hooks ---------------------------------------------------------------------
function memoryJournal({ failDispatch = false, failResult = false } = {}) {
  const log = []; const ops = new Map();
  return {
    log,
    accept(c, digest) {
      const prior = ops.get(c.operationId);
      if (prior) { if (prior.digest !== digest) throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { code: 'IDEMPOTENCY_CONFLICT' }); return { receipt: prior.receipt }; }
      ops.set(c.operationId, { digest }); log.push(['accepted', c.operationId]); return null;
    },
    dispatchStarted(c) { if (failDispatch) throw Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' }); log.push(['dispatch_started', c.operationId]); },
    result(c, r) { if (failResult) throw Object.assign(new Error('disk'), { code: 'LEDGER_WRITE_FAILED' }); ops.get(c.operationId).receipt = r; log.push(['result', c.operationId, r.status]); },
  };
}

test('journal: dispatch_started is committed before the driver emits input', async () => {
  const journal = memoryJournal(); const order = [];
  const page = new OwnedPage({ ...options, journal, execute: async (_, c) => { c.beforeDispatch(); order.push([...journal.log.map((l) => l[0])]); return verified(); } });
  await page.act(cmd('1'));
  assert.deepEqual(order[0], ['accepted', 'dispatch_started']);
  assert.deepEqual(journal.log.map((l) => l[0]), ['accepted', 'dispatch_started', 'result']);
});

test('journal: if dispatch_started cannot be committed no input is emitted', async () => {
  const journal = memoryJournal({ failDispatch: true }); let emitted = false;
  const page = new OwnedPage({ ...options, journal, execute: async (_, c) => { c.beforeDispatch(); emitted = true; return verified(); } });
  const r = await page.act(cmd('1'));
  assert.equal(emitted, false);
  assert.equal(r.status, 'not_attempted'); assert.equal(r.code, 'LEDGER_WRITE_FAILED');
});

test('journal: an unrecordable result is never reported as verified', async () => {
  const journal = memoryJournal({ failResult: true });
  const page = new OwnedPage({ ...options, journal, execute: async (_, c) => { c.beforeDispatch(); return verified(); } });
  const r = await page.act(cmd('1'));
  assert.equal(r.status, 'uncertain'); assert.equal(page.owner, 'quarantined');
});

test('journal: a known operation returns its recorded receipt and never re-executes', async () => {
  const journal = memoryJournal(); let calls = 0;
  const mk = () => new OwnedPage({ ...options, journal, execute: async (_, c) => { calls++; c.beforeDispatch(); return verified(); } });
  const first = await mk().act(cmd('1'));
  const again = await mk().act(cmd('1')); // a fresh page object, same durable journal (restart)
  assert.equal(calls, 1);
  assert.equal(again.status, first.status);
  assert.throws(() => mk().act(cmd('1', { action: { kind: 'fill' } })), /IDEMPOTENCY_CONFLICT/);
});
