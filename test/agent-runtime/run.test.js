'use strict';
// Run store (durable state machine), grading helpers and the standalone
// CommonJS executePlan against a bare DriverPage (FakeDriver).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const C = require('../../src/shared/browser-contracts');
const R = require('../../src/main/services/browser/run');
const { createFakeDriver } = require('./fake-driver');
const { planOf, nav, click, fill, assertText, journey } = require('./harness');
const { tmp, delay } = require('./helpers');

async function pageOf(fake = createFakeDriver()) {
  const session = await fake.driver.open({});
  return { fake, page: [...session.pages.values()][0] };
}

// ---- executePlan -----------------------------------------------------------------------------
test('executePlan: verify-journey runs end to end against a DriverPage and is graded by the canonical grader', async () => {
  const { fake, page } = await pageOf();
  const r = await R.executePlan(journey(), page, { inputs: { name: 'Bob' } });
  assert.equal(r.terminal, 'completed');
  assert.equal(r.verdict.status, 'passed');
  assert.deepEqual([r.verdict.planned, r.verdict.passed, r.verdict.requiredAssertions, r.verdict.passedAssertions, r.verdict.evidenceComplete], [4, 4, 1, 1, true]);
  assert.deepEqual(fake.world.dispatchLog.map((e) => e.kind), ['fill', 'click']);
  assert.equal(r.results.length, 4); assert.ok(r.evidence.size >= 4);
});

test('executePlan: a failed assertion fails the run', async () => {
  const { page } = await pageOf();
  const r = await R.executePlan(planOf([nav('a'), click('b', 'Preview'), assertText('c', 'Saved')]), page);
  assert.equal(r.verdict.status, 'failed'); assert.equal(r.verdict.failed, 1);
});

test('executePlan: dispatch without a confirmed effect never passes', async () => {
  const { fake, page } = await pageOf(); fake.ctl.evidenceMode = 'none';
  const r = await R.executePlan(journey(), page, { inputs: { name: 'Bob' } });
  assert.notEqual(r.verdict.status, 'passed'); assert.equal(r.verdict.status, 'unknown'); assert.ok(r.verdict.unknown >= 1);
});

test('executePlan: cancellation yields cancelled with the remaining steps pending, even if the prefix is green', async () => {
  const { fake, page } = await pageOf(); fake.ctl.delays.act = 80;
  const ac = new AbortController();
  const p = R.executePlan(journey(), page, { inputs: { name: 'Bob' }, signal: ac.signal });
  await delay(40); ac.abort();
  const r = await p;
  assert.equal(r.verdict.status, 'cancelled'); assert.ok(r.verdict.pending >= 1); assert.notEqual(r.verdict.status, 'passed');
  const before = fake.world.dispatchLog.length;
  await delay(150);
  assert.equal(fake.world.dispatchLog.length, before);
});

test('executePlan: the deadline stops future dispatch and reports timedOut', async () => {
  const { fake, page } = await pageOf(); fake.ctl.delays.navigate = 150;
  const r = await R.executePlan(journey(), page, { inputs: { name: 'Bob' }, maxDurationMs: 30 });
  assert.equal(r.terminal, 'timedOut'); assert.equal(r.verdict.status, 'timedOut'); assert.equal(fake.world.dispatchLog.length, 0);
});

test('executePlan: secret fields, missing inputs and destination policy fail without input', async () => {
  let ctx = await pageOf();
  let r = await R.executePlan(planOf([nav('a'), fill('b', 'Password'), assertText('c', 'x')]), ctx.page, { inputs: { name: 'hunter2' } });
  assert.equal(r.verdict.status, 'failed'); assert.equal(ctx.fake.world.dispatchLog.length, 0);
  ctx = await pageOf();
  r = await R.executePlan(journey(), ctx.page, { inputs: {} });
  assert.equal(r.verdict.status, 'failed'); assert.equal(r.results.find((x) => x.stepId === 's2').code, 'MISSING_INPUT');
  ctx = await pageOf();
  r = await R.executePlan(planOf([nav('a', 'https://evil.test/'), assertText('b', 'x')]), ctx.page, { policy: (url) => url.startsWith('https://app.test') });
  assert.equal(r.verdict.status, 'failed'); assert.equal(r.results[0].code, 'DESTINATION_DENIED');
});

test('executePlan: browser crash after dispatch leaves the effect unknown', async () => {
  const { fake, page } = await pageOf(); fake.ctl.crashNextAct = 'afterDispatch';
  const r = await R.executePlan(journey(), page, { inputs: { name: 'Bob' } });
  assert.equal(r.terminal, 'unknown'); assert.equal(r.verdict.uncertainEffect, true); assert.notEqual(r.verdict.status, 'passed');
});

test('executePlan: invalid plans never execute', async () => {
  const { fake, page } = await pageOf();
  await assert.rejects(R.executePlan({ ...journey(), steps: [{ id: 'x', type: 'eval', code: '1' }] }, page));
  await assert.rejects(R.executePlan(planOf([nav('a')]), page)); // no assertion
  assert.equal(fake.world.inputLog.length, 0);
});

// ---- helpers ---------------------------------------------------------------------------------------
test('state/terminal mapping', () => {
  assert.deepEqual(['cancelled', 'timedOut', 'unknown', 'failed'].map((t) => R.stateFor(t, 'passed')), ['cancelled', 'timedOut', 'uncertain', 'failed']);
  assert.deepEqual(['passed', 'failed', 'timedOut', 'cancelled', 'unknown', 'skipped'].map((s) => R.stateFor('completed', s)), ['passed', 'failed', 'timedOut', 'cancelled', 'uncertain', 'uncertain']);
  const sig = (reason) => { const c = new AbortController(); if (reason) c.abort(reason); return c.signal; };
  assert.equal(R.decideTerminal({ signal: sig('DEADLINE'), results: new Map() }), 'timedOut');
  assert.equal(R.decideTerminal({ signal: sig('CANCELLED'), results: new Map() }), 'cancelled');
  assert.equal(R.decideTerminal({ signal: sig('SESSION_CLOSED'), results: new Map() }), 'cancelled');
  assert.equal(R.decideTerminal({ signal: sig(), results: new Map([['a', { status: 'unknown', effect: 'unknown' }]]) }), 'unknown');
  assert.equal(R.decideTerminal({ signal: sig(), results: new Map([['a', { status: 'failed', effect: 'notDispatched' }]]) }), 'completed');
  assert.deepEqual(['verified', 'dispatched'].map((s) => R.fromReceipt({ status: s }).effect), ['confirmed', 'dispatched']);
  assert.equal(R.fromReceipt({ status: 'uncertain', code: 'DEADLINE_EXCEEDED' }).status, 'timedOut');
  assert.equal(R.fromReceipt({ status: 'not_attempted', code: 'CANCELLED' }).status, 'cancelled');
  assert.equal(R.fromReceipt({ status: 'dispatched', code: 'DESTINATION_DENIED' }).status, 'failed');
});

test('waitForEvent resolves on event, abort and timeout', async () => {
  const em = new EventEmitter();
  const p1 = R.waitForEvent(em, 'x', (e) => e.ok, { timeoutMs: 500 }); em.emit('x', { ok: false }); em.emit('x', { ok: true });
  assert.equal(await p1, 'event');
  const ac = new AbortController(); const p2 = R.waitForEvent(em, 'x', null, { signal: ac.signal, timeoutMs: 500 }); ac.abort();
  assert.equal(await p2, 'aborted');
  assert.equal(await R.waitForEvent(em, 'x', null, { timeoutMs: 20 }), 'timeout');
  assert.equal(em.listenerCount('x'), 0);
});

// ---- run store -----------------------------------------------------------------------------------------
const meta = (over = {}) => ({ runId: C.newId('run'), evidenceRunId: null, ownerId: 'o1', sessionId: 's1', pageId: 'p1', requestKey: 'k1', requestHash: 'h1', skillId: 'verify-journey', skillVersion: '1.0.0',
  plan: journey(), inputKeys: ['name'], inputsDigest: 'd', maxDurationMs: 1000, deadlineAt: Date.now() + 1000, parentRunId: null, attempt: 1, ...over });

test('store: (owner, requestKey) is unique; identical returns the existing run; conflicts throw', () => {
  const store = R.createRunStore({ dir: tmp() });
  const a = store.create(meta());
  assert.equal(a.existing, false);
  const dup = store.create(meta({ runId: C.newId('run') }));
  assert.equal(dup.existing, true); assert.equal(dup.run.runId, a.run.runId);
  assert.throws(() => store.create(meta({ requestHash: 'different' })), (e) => e.publicError.code === 'DENIED');
  assert.equal(store.create(meta({ ownerId: 'o2', runId: C.newId('run') })).existing, false);
  assert.equal(store.list({ ownerId: 'o1' }).length, 1);
  store.close();
});

test('store: only legal transitions, terminal states are immutable, step results are immutable', () => {
  const store = R.createRunStore({ dir: tmp() });
  const { run } = store.create(meta());
  assert.throws(() => store.transition(run.runId, 'passed'), /ILLEGAL_TRANSITION|queued -> passed/);
  store.transition(run.runId, 'running'); store.transition(run.runId, 'needsApproval'); store.transition(run.runId, 'running');
  store.stepResult(run.runId, { stepId: 's1', status: 'failed', effect: 'notDispatched', evidenceIds: [] });
  store.stepResult(run.runId, { stepId: 's1', status: 'passed', effect: 'confirmed', evidenceIds: ['x'] });
  assert.equal(store.get(run.runId).results.get('s1').status, 'failed');
  store.transition(run.runId, 'failed', { terminal: 'completed' });
  for (const to of ['running', 'passed', 'cancelled', 'queued']) assert.throws(() => store.transition(run.runId, to), /ILLEGAL_TRANSITION|failed ->/, to);
  assert.equal(store.get(run.runId).state, 'failed');
  store.close();
});

test('store: events are sequenced, redacted and capped without losing the sequence', () => {
  const store = R.createRunStore({ dir: tmp() });
  const { run } = store.create(meta());
  for (let i = 0; i < R.MAX_EVENTS + 50; i++) store.event(run.runId, { kind: 'tick', summary: i === 3 ? 'token=abcdef1234567890 Bearer abcdefghijklmnop' : `n${i}` });
  const r = store.get(run.runId);
  assert.equal(r.events.length, R.MAX_EVENTS); assert.equal(r.sequence, R.MAX_EVENTS + 51); assert.equal(r.droppedEvents, 51);
  assert.ok(!JSON.stringify(r.events).includes('abcdef1234567890'));
  store.close();
});

test('store: restart interrupts active runs, marks dispatched steps effect-unknown, keeps finished runs', () => {
  const dir = tmp();
  const s1 = R.createRunStore({ dir });
  const active = s1.create(meta({ requestKey: 'a', requestHash: 'a' })).run;
  s1.transition(active.runId, 'running');
  s1.stepStarted(active.runId, 's1', 'op-notdispatched'); s1.stepResult(active.runId, { stepId: 's1', status: 'passed', effect: 'confirmed', evidenceIds: ['e1'] });
  s1.stepStarted(active.runId, 's2', 'op-dispatched');
  s1.stepStarted(active.runId, 's3', 'op-accepted-only');
  const done = s1.create(meta({ requestKey: 'b', requestHash: 'b' })).run;
  s1.transition(done.runId, 'running'); s1.transition(done.runId, 'passed', { terminal: 'completed', evidenceComplete: true });
  const queued = s1.create(meta({ requestKey: 'c', requestHash: 'c' })).run;
  s1._crash();
  const lookup = (sessionId, opId) => ({ 'op-dispatched': { state: 'dispatch_started' }, 'op-accepted-only': { state: 'accepted' } }[opId] || null);
  const s2 = R.createRunStore({ dir, ledgerLookup: lookup });
  assert.deepEqual(s2.recovered.sort(), [active.runId, queued.runId].sort());
  const a = s2.get(active.runId);
  assert.equal(a.state, 'interrupted'); assert.equal(a.terminal, 'unknown'); assert.equal(a.evidenceComplete, false);
  assert.equal(a.results.get('s1').status, 'passed');
  assert.deepEqual([a.results.get('s2').status, a.results.get('s2').effect], ['unknown', 'unknown']);
  assert.equal(a.results.has('s3'), false); // provably never dispatched: stays pending, not "unknown"
  const g = R.gradeRun(a);
  assert.equal(g.uncertainEffect, true); assert.notEqual(g.status, 'passed');
  assert.equal(R.runToDTO(a).verdict, 'unknown');
  assert.equal(s2.get(queued.runId).state, 'interrupted');
  assert.equal(s2.get(done.runId).state, 'passed'); assert.equal(s2.get(done.runId).evidenceComplete, true);
  assert.equal(s2.create(meta({ requestKey: 'a', requestHash: 'a', runId: C.newId('run') })).existing, true); // key still bound to the interrupted run
  s2.close();
  const s3 = R.createRunStore({ dir }); assert.deepEqual(s3.recovered, []); assert.equal(s3.recovery, null); s3.close();
});

test('store: a torn tail is recovered like the ledger (valid prefix kept)', () => {
  const dir = tmp();
  const s1 = R.createRunStore({ dir }); const r = s1.create(meta()).run; s1.transition(r.runId, 'running'); s1.close();
  require('node:fs').appendFileSync(path.join(dir, 'runs.jsonl'), '{"seq":99,"ts":1,"type":"run_st');
  const s2 = R.createRunStore({ dir });
  assert.equal(s2.recovery.reason, 'torn_tail'); assert.equal(s2.get(r.runId).state, 'interrupted');
  s2.close();
});

test('store: retention compacts finished runs, keeps active ones and a verifiable chain', () => {
  const dir = tmp(); let now = 1_000_000;
  const store = R.createRunStore({ dir, clock: { now: () => now }, retentionMs: 1000 });
  const old = store.create(meta({ requestKey: 'old', requestHash: 'o' })).run; store.transition(old.runId, 'running'); store.transition(old.runId, 'failed', { terminal: 'completed' });
  const live = store.create(meta({ requestKey: 'live', requestHash: 'l' })).run; store.transition(live.runId, 'running');
  store.event(live.runId, { kind: 'keep', summary: 'x' });
  now += 5000;
  store.compact();
  assert.equal(store.get(old.runId), null); assert.equal(store.get(live.runId).state, 'running');
  store.close();
  const again = R.createRunStore({ dir, clock: { now: () => now } });
  assert.equal(again.recovery, null); assert.equal(again.get(live.runId).events.some((e) => e.kind === 'keep'), true);
  again.close();
});
