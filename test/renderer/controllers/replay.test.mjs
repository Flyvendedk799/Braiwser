import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDriver } from '../../../src/renderer/controllers/replay-driver.js';
import { runReplay } from '../../../src/renderer/controllers/replay-engine.js';
import { createOperationContexts } from '../../../src/renderer/controllers/operation-context.js';
import { FakeWv, manualTimers, tick } from './fakes.mjs';

const noSleep = async () => {};

// A fake page: answers navigations with the given outcome and replay-steps with acks.
function wirePage(wv, { nav = 'ready', ack } = {}) {
  wv.onSrc = () => {
    setImmediate(() => {
      if (nav === 'ready') { wv.emit('did-start-loading'); wv.emit('did-navigate', { url: wv.url }); wv.emit('dom-ready'); }
      else if (nav === 'fail') { wv.emit('did-start-loading'); wv.emit('did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true }); }
      // nav === 'hang': nothing happens
    });
  };
  wv.onSend = (channel, payload) => {
    if (channel !== 'caos:replay-step') return;
    setImmediate(() => {
      const reply = ack ? ack(payload) : { ok: true, status: 'passed', effect: 'confirmed' };
      if (reply) wv.ipc('caos:replay-ack', { index: payload.index, runId: payload.runId, ...reply });
    });
  };
}

function ctxFor(wv, tabId = 'tab1') {
  return { runId: 'run-1', tabId, wv, docGen: 0, url: '' };
}

const steps = [
  { type: 'navigate', url: 'http://site/a', ts: 1 },
  { type: 'click', selector: '#go', ts: 2 },
  { type: 'assert', kind: 'url', op: 'contains', expected: 'site/a', ts: 3 },
  { type: 'click', selector: '#next', ts: 4 },
];

test('happy path: navigation ready + acks + url assertion -> passed 4/4', async () => {
  const wv = new FakeWv();
  wirePage(wv);
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const report = await runReplay({ steps, driver, sleep: noSleep });
  assert.equal(report.status, 'passed');
  assert.equal(report.total, 4);
  assert.equal(report.passed, 4);
  assert.equal(wv.listenerCount(), 0, 'all listeners removed');
});

test('RF-03: DNS/file failure is a failed navigation; later steps are skipped, not passed', async () => {
  const wv = new FakeWv();
  wirePage(wv, { nav: 'fail' });
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const report = await runReplay({ steps, driver, sleep: noSleep });
  assert.equal(report.status, 'failed');
  assert.equal(report.steps[0].status, 'failed');
  assert.match(report.steps[0].error, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(report.skipped, 3);
  assert.equal(report.total, 4);
  assert.equal(wv.sent.filter(([c]) => c === 'caos:replay-step').length, 0, 'nothing was dispatched after the failed navigation');
});

test('RF-03: a navigation that never completes times out (not a green navigate)', async () => {
  const wv = new FakeWv();
  wirePage(wv, { nav: 'hang' });
  const timers = manualTimers();
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url, timers });
  const p = runReplay({ steps, driver, sleep: noSleep });
  await tick(); await tick();
  timers.runAll();
  const report = await p;
  assert.equal(report.status, 'timedOut');
  assert.equal(report.steps[0].status, 'timedOut');
  assert.equal(report.failed, 1);
});

test('RF-03: an unrelated dom-ready before the requested navigation started is not "ready"', async () => {
  const wv = new FakeWv();
  const timers = manualTimers();
  wv.onSrc = () => { setImmediate(() => wv.emit('dom-ready')); }; // stray dom-ready, no navigation start
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url, timers });
  const p = driver.navigate('http://site/a');
  await tick(); await tick();
  timers.runAll();
  assert.equal((await p).outcome, 'timeout');
});

test('RF-03: cancel settles a pending navigation immediately and the run is cancelled', async () => {
  const wv = new FakeWv();
  wirePage(wv, { nav: 'hang' });
  const ac = new AbortController();
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const p = runReplay({ steps, driver, signal: ac.signal, sleep: noSleep });
  await tick();
  ac.abort();
  const report = await p;
  assert.equal(report.status, 'cancelled');
  assert.equal(report.total, 4);
  assert.equal(report.steps[0].status, 'cancelled');
  assert.equal(report.passed, 0);
  assert.equal(wv.listenerCount(), 0);
});

test('RF-03: cancel after the first interaction keeps the required later assertion as skipped', async () => {
  const wv = new FakeWv();
  wirePage(wv);
  const ac = new AbortController();
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const p = runReplay({ steps, driver, signal: ac.signal, sleep: async () => { ac.abort(); } });
  const report = await p;
  assert.equal(report.status, 'cancelled');
  assert.equal(report.executed, 1);
  assert.equal(report.steps[2].status, 'skipped');
  assert.notEqual(report.status, 'passed');
});

test('cancel while a step awaits its ack settles at once', async () => {
  const wv = new FakeWv();
  wirePage(wv, { ack: () => null }); // guest never answers
  const ac = new AbortController();
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const p = runReplay({ steps: steps.slice(1, 2), driver, signal: ac.signal, sleep: noSleep });
  await tick(); await tick();
  ac.abort();
  const report = await p;
  assert.equal(report.status, 'cancelled');
});

test('unresponsive guest -> timedOut and the run stops', async () => {
  const wv = new FakeWv();
  wirePage(wv, { ack: () => null });
  const timers = manualTimers();
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url, timers });
  const p = runReplay({ steps: steps.slice(1), driver, sleep: noSleep });
  await tick(); await tick();
  timers.runAll();
  const report = await p;
  assert.equal(report.status, 'timedOut');
  assert.equal(report.steps[0].status, 'timedOut');
  assert.equal(report.skipped, 2);
});

test('failed step with reason (secret binding missing) fails but later asserts still run', async () => {
  const wv = new FakeWv();
  wirePage(wv, { ack: (p) => (p.step.selector === '#go' ? { ok: false, status: 'failed', effect: 'none', reason: 'secret-binding-missing', error: 'needs a secret' } : { ok: true, status: 'passed', effect: 'confirmed' }) });
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const report = await runReplay({ steps, driver, sleep: noSleep });
  assert.equal(report.status, 'failed');
  assert.equal(report.steps[1].reason, 'secret-binding-missing');
  assert.equal(report.steps[2].status, 'passed');
});

test('dispatchOnly acks are unproven; a later passed url assertion vouches for them', async () => {
  const wv = new FakeWv();
  wirePage(wv, { ack: () => ({ ok: true, status: 'dispatched', effect: 'dispatchOnly', needsPostcondition: true }) });
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  const noAssert = await runReplay({ steps: [steps[0], steps[1]], driver, sleep: noSleep });
  assert.equal(noAssert.status, 'unknown');
  assert.equal(noAssert.steps[1].unproven, true);
  const withAssert = await runReplay({ steps: [steps[0], steps[1], steps[2]], driver, sleep: noSleep });
  assert.equal(withAssert.status, 'passed');
});

test('guest options (secrets, actionTimeoutMs, allowSuggested) are forwarded in opts', async () => {
  const wv = new FakeWv();
  wirePage(wv);
  const driver = createReplayDriver({ ctx: ctxFor(wv), getUrl: () => wv.url });
  await driver.step(steps[1], 1, { fast: true, secrets: { '#pw': 'x' }, actionTimeoutMs: 900, allowSuggested: true });
  const [, payload] = wv.sent.find(([c]) => c === 'caos:replay-step');
  assert.deepEqual(payload.opts, { fast: true, forVideo: false, actionTimeoutMs: 900, allowSuggested: true, secrets: { '#pw': 'x' } });
  assert.equal(payload.runId, 'run-1');
});

// ---- RF-01: the replay is bound to its originating tab -----------------------
test('RF-01: switching/creating tabs at every await boundary never redirects commands or acks', async () => {
  const tabs = new Map();
  const A = new FakeWv('A'); const B = new FakeWv('B');
  tabs.set('tabA', { id: 'tabA', wv: A, url: 'http://a/', docGen: 0 });
  tabs.set('tabB', { id: 'tabB', wv: B, url: 'http://b/', docGen: 0 });
  let active = 'tabA';
  const ops = createOperationContexts({ getTab: (id) => tabs.get(id) || null, getActiveTabId: () => active, getSession: () => null });
  const ctx = ops.capture('replay');
  assert.equal(ctx.tabId, 'tabA');
  wirePage(A);
  wirePage(B, { ack: (p) => ({ ok: true, status: 'passed', effect: 'confirmed', actual: 'FROM-B' }) });
  const driver = createReplayDriver({ ctx, getUrl: () => tabs.get(ctx.tabId).url });
  A.addEventListener('did-navigate', (e) => { tabs.get('tabA').url = e.url || 'http://site/a'; });
  const report = await runReplay({
    steps, driver,
    sleep: async () => { active = active === 'tabA' ? 'tabB' : 'tabA'; }, // the user flips tabs at every pause
  });
  assert.equal(report.status, 'passed');
  assert.equal(B.sent.length, 0, 'nothing was ever sent to tab B');
  assert.equal(B.srcSet.length, 0, 'tab B never navigated');
  assert.deepEqual(A.srcSet, ['http://site/a']);
  assert.equal(A.sent.filter(([c]) => c === 'caos:replay-step').length, 2);
});

test('RF-01: an ack arriving on another tab, or for an older request, cannot satisfy a waiter', async () => {
  const A = new FakeWv('A'); const B = new FakeWv('B');
  const driver = createReplayDriver({ ctx: ctxFor(A), getUrl: () => '' });
  let wire;
  A.onSend = (c, p) => { wire = p.index; };
  const p = driver.step(steps[1], 1, { fast: true });
  await tick();
  B.ipc('caos:replay-ack', { index: wire, ok: true }); // other tab: ignored (different element)
  A.ipc('caos:replay-ack', { index: wire - 1, ok: true }); // earlier request: ignored
  A.ipc('caos:replay-ack', { index: wire, runId: 'other-run', ok: true }); // other run: ignored
  let settled = false; p.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  A.ipc('caos:replay-ack', { index: wire, runId: 'run-1', ok: true, status: 'passed', effect: 'confirmed' });
  assert.equal((await p).ok, true);
});

test('RF-01: URL assertions read the replay tab URL, not the active tab', async () => {
  const A = new FakeWv('A');
  wirePage(A);
  const driver = createReplayDriver({ ctx: ctxFor(A), getUrl: () => 'http://replay-tab/page' });
  const report = await runReplay({ steps: [{ type: 'assert', kind: 'url', op: 'contains', expected: 'replay-tab', ts: 1 }], driver, sleep: noSleep });
  assert.equal(report.steps[0].actual, 'http://replay-tab/page');
});
