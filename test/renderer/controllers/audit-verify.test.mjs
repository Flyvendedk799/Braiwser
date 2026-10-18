import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditRunner, sameAuditedPage } from '../../../src/renderer/controllers/audit-controller.js';
import { createVerifyRunner } from '../../../src/renderer/controllers/verify-controller.js';
import { auditOutcome } from '../../../src/renderer/controllers/run-report.js';
import { createTabDerived, dropStaleAudit, resetForNewDocument } from '../../../src/renderer/controllers/tab-state.js';
import { manualTimers, tick, deferred } from './fakes.mjs';

const ctxA = { runId: 'r1', tabId: 'A', docGen: 1, url: 'http://a/', title: 'A page' };

function runner(extra = {}) {
  const timers = manualTimers();
  const sent = [];
  const r = createAuditRunner({ send: (c) => sent.push(c.runId), staleReason: () => null, getViewport: () => ({ w: 1, h: 2 }), timers, now: () => 'T', ...extra });
  return { r, timers, sent };
}

test('RF-04: audit timeout is an explicit timedOut outcome, never a clean zero', async () => {
  const { r, timers } = runner();
  const p = r.run(ctxA);
  timers.runAll();
  const res = await p;
  assert.equal(res.outcome.status, 'timedOut');
  assert.equal(res.outcome.total, null);
  assert.equal(res.timedOut, true);
});

test('RF-04: a second audit while one runs is "skipped", not a zero report', async () => {
  const { r } = runner();
  const p1 = r.run(ctxA);
  const second = await r.run({ ...ctxA, runId: 'r2' });
  assert.equal(second.outcome.status, 'skipped');
  assert.equal(second.report, null);
  r.deliver('A', { total: 2, counts: {}, findings: [] });
  assert.equal((await p1).outcome.status, 'findings');
});

test('RF-06: report carries the identity of the audited page', async () => {
  const { r } = runner();
  const p = r.run(ctxA);
  r.deliver('A', { total: 1, counts: { minor: 1 }, findings: [] });
  const res = await p;
  assert.deepEqual(res.source, { runId: 'r1', tabId: 'A', docGen: 1, url: 'http://a/', title: 'A page', viewport: { w: 1, h: 2 }, at: 'T' });
});

test('RF-06: replies from another tab, with another runId, or after the run are dropped', async () => {
  const { r, timers } = runner();
  const p = r.run(ctxA);
  assert.equal(r.deliver('B', { total: 0 }), false, 'other tab');
  assert.equal(r.deliver('A', { total: 0, runId: 'zzz' }), false, 'other run');
  timers.runAll();
  await p;
  assert.equal(r.deliver('A', { total: 0 }), false, 'late reply after timeout');
});

test('RF-06: a page that navigated mid-audit discards the result', async () => {
  let stale = null;
  const { r } = runner({ staleReason: () => stale });
  const p = r.run(ctxA);
  stale = 'the page navigated';
  r.deliver('A', { total: 3, counts: {}, findings: [] });
  const res = await p;
  assert.equal(res.outcome.status, 'cancelled');
  assert.equal(res.report, null);
});

test('abandon (tab closed) settles the waiter instead of hanging', async () => {
  const { r } = runner();
  const p = r.run(ctxA);
  assert.equal(r.abandon('A', 'The tab was closed'), true);
  assert.equal((await p).outcome.status, 'cancelled');
});

test('RF-06: stale audit for another page is dropped from the tab; same page (hash change) is kept', () => {
  const d = createTabDerived();
  d.audit = { report: { total: 1 }, source: { tabId: 'A', url: 'http://a/' }, promoted: new Set() };
  assert.equal(dropStaleAudit(d, { tabId: 'A', url: 'http://a/#section' }), false);
  assert.equal(dropStaleAudit(d, { tabId: 'A', url: 'http://b/' }), true);
  assert.equal(d.audit, null);
  assert.equal(sameAuditedPage({ tabId: 'A', url: 'x' }, { tabId: 'B', url: 'x' }), false);
});

test('new document resets selection/layers/edit stacks but not the audit', () => {
  const d = createTabDerived();
  Object.assign(d, { styleInfo: { a: 1 }, styleTarget: '#x', layout: {}, tree: {}, editStacks: { undo: 2, redo: 1 }, audit: { report: {} } });
  resetForNewDocument(d);
  assert.equal(d.styleTarget, null);
  assert.equal(d.layout, null);
  assert.deepEqual(d.editStacks, { undo: 0, redo: 0 });
  assert.ok(d.audit);
});

// ---------------------------------------------------------------- verify
function verifyWorld(over = {}) {
  const w = {
    session: { id: 'S1' },
    saved: [],
    toasts: [],
    busy: [],
    shown: [],
    annotations: [{ status: 'open' }, { status: 'resolved' }, { status: 'open' }],
    rec: null,
  };
  const deps = {
    getSession: () => w.session,
    captureContext: () => ({ runId: 'v1', tabId: 'A', url: 'http://a/', docGen: 1 }),
    getAnnotations: () => w.annotations,
    getSelectedRecording: () => w.rec,
    getBaselineAudit: () => auditOutcome({ total: 12, counts: {} }),
    setBusy: (on) => w.busy.push(on),
    captureShot: async () => 'shot',
    runAudit: async () => auditOutcome({ total: 3, counts: {} }),
    replay: async () => null,
    save: async (id, payload) => { w.saved.push([id, payload]); return { ok: true, run: { status: 'verified' } }; },
    showRun: (run) => w.shown.push(run),
    currentUrlOf: () => 'http://a/',
    toast: (m, k) => w.toasts.push([m, k]),
    ...over,
  };
  return { w, deps };
}

test('RF-04: a failed/timed-out/skipped after-audit is saved as such with total:null', async () => {
  for (const [label, outcome, status] of [
    ['timeout', auditOutcome({ error: 'slow', total: 0 }, { timedOut: true }), 'timedOut'],
    ['skipped', auditOutcome(null, { skipped: true }), 'skipped'],
    ['error', auditOutcome({ error: 'boom', total: 0 }), 'error'],
  ]) {
    const { w, deps } = verifyWorld({ runAudit: async () => outcome });
    await createVerifyRunner(deps).run();
    const payload = w.saved[0][1];
    assert.equal(payload.after.audit.status, status, label);
    assert.equal(payload.after.audit.total, null, label);
    assert.equal(payload.before.audit.total, 12, label);
  }
});

test('RF-04: a null audit result (never ran) is skipped, not zero', async () => {
  const { w, deps } = verifyWorld({ runAudit: async () => null });
  await createVerifyRunner(deps).run();
  assert.equal(w.saved[0][1].after.audit.status, 'skipped');
  assert.equal(w.saved[0][1].after.audit.total, null);
});

test('RF-05: saves only to the CAPTURED session even if another is opened mid-run', async () => {
  const gate = deferred();
  const { w, deps } = verifyWorld({ runAudit: async () => { await gate.promise; return auditOutcome({ total: 1, counts: {} }); } });
  const v = createVerifyRunner(deps);
  const p = v.run();
  await tick();
  w.session = { id: 'S2' }; // user opens another session while Verify waits
  w.annotations = [];       // ...whose notes are different
  gate.resolve();
  await p;
  assert.equal(w.saved[0][0], 'S1');
  assert.deepEqual(w.saved[0][1].notes, { open: 2, total: 3 }, 'note counts are the start-of-run snapshot');
  assert.equal(w.shown.length, 0, 'the panel is not repainted for a session that is no longer on screen');
});

test('RF-05: single-run guard + busy state is always released (even on failure)', async () => {
  const gate = deferred();
  const { w, deps } = verifyWorld({ runAudit: async () => { await gate.promise; throw new Error('x'); } });
  const v = createVerifyRunner(deps);
  const p1 = v.run();
  const p2 = v.run();
  assert.equal(p1, p2, 'second click joins the run in flight');
  gate.resolve();
  await p1;
  assert.deepEqual(w.busy, [true, false]);
  assert.equal(v.isRunning(), false);
  assert.equal(w.saved.length, 1);
});

test('RF-05: save failure releases busy and reports the error', async () => {
  const { w, deps } = verifyWorld({ save: async () => { throw new Error('disk full'); } });
  const r = await createVerifyRunner(deps).run();
  assert.equal(r, null);
  assert.deepEqual(w.busy, [true, false]);
  assert.match(w.toasts.at(-1)[0], /disk full/);
});

test('RF-05: deleted session -> save returns an error and no panel claims success', async () => {
  const { w, deps } = verifyWorld({ save: async () => ({ ok: false, error: 'Session not found' }) });
  await createVerifyRunner(deps).run();
  assert.equal(w.shown.length, 0);
  assert.match(w.toasts.at(-1)[0], /Session not found/);
});

test('verify: the replay of the selected recording is bound to the captured context and never reuses the old result', async () => {
  const seen = [];
  const { w, deps } = verifyWorld({
    replay: async (ctx, rec) => { seen.push([ctx.tabId, rec.id]); return null; }, // replay did not run
  });
  w.rec = { id: 'R1', name: 'J', lastRun: { total: 3, passed: 3, failed: 0, at: 't', status: 'passed' } };
  await createVerifyRunner(deps).run();
  assert.deepEqual(seen, [['A', 'R1']]);
  assert.equal(w.saved[0][1].after.journey, null, 'a replay that did not run is not "the same as before"');
  assert.equal(w.saved[0][1].before.journey.passed, 3);
});

test('verify: headline toast is only green when the main process says verified', async () => {
  const { w, deps } = verifyWorld({ save: async () => ({ ok: true, run: { status: 'inconclusive', reason: 'after:timedOut' } }) });
  await createVerifyRunner(deps).run();
  assert.equal(w.toasts.at(-1)[1], 'warn');
  assert.match(w.toasts.at(-1)[0], /inconclusive/);
});
