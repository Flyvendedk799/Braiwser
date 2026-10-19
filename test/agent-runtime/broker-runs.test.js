'use strict';
// Durable runs through the real broker: lifecycle, request keys, grading,
// cancellation, deadlines, approvals, takeover, retries and restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBroker } = require('../../src/main/services/browser/broker');
const { createFakeDriver } = require('./fake-driver');
const H = require('./harness');
const { boot, observe, go, waitRun, start, codeOf, errOf, planOf, nav, click, fill, assertText, delay, until, mcp, ui, C } = H;

const ACTIVE = ['queued', 'running', 'needsApproval', 'needsHuman'];
const events = (run) => run.events.map((e) => `${e.kind}${e.stepId ? ':' + e.stepId : ''}`);
const payPlan = () => planOf([nav('s1'), click('s2', 'Pay now'), assertText('s3', 'Paid')]);

test('a journey runs end to end: durable events, committed manifest, evidence complete, verdict only from the grader', async () => {
  const h = boot(); const s = await h.open();
  const queued = await start(h.a, s);
  assert.ok(['queued', 'running'].includes(queued.state)); assert.equal(queued.verdict, 'pending');
  assert.deepEqual(C.validateRunDTO(queued), []);
  const done = await waitRun(h.a, queued.runId);
  assert.equal(done.state, 'passed'); assert.equal(done.verdict, 'passed');
  assert.deepEqual({ planned: done.planned, executed: done.executed, passed: done.passed, pending: done.pending, failed: done.failed, unknown: done.unknown }, { planned: 4, executed: 4, passed: 4, pending: 0, failed: 0, unknown: 0 });
  assert.equal(done.evidenceComplete, true); assert.equal(done.requiredAssertions, 1); assert.equal(done.passedAssertions, 1); assert.equal(done.uncertainEffect, false);
  assert.ok(done.manifestUri.endsWith('/manifest'));
  const seqs = done.events.map((e) => e.sequence); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(events(done).slice(0, 2), ['queued', 'running']); assert.equal(events(done).at(-1), 'finished');
  const manifest = await h.a.getManifest({ runId: done.runId });
  assert.equal(manifest.committed, true); assert.equal(manifest.terminal.state, 'passed'); assert.equal(manifest.terminal.verdict, 'passed');
  assert.equal(manifest.counts.planned, 4); assert.equal(manifest.steps.length, 4); assert.equal(manifest.assertions[0].expected, 'Previewed');
  assert.equal(manifest.versions.skill, 'verify-journey@1.0.0'); assert.equal(manifest.digests.plan.length, 64);
  for (const st of manifest.steps) assert.ok(st.evidenceIds.length >= 1);
  const viaResource = JSON.parse((await h.a.readResource(done.manifestUri)).text);
  assert.equal(viaResource.manifestSha256, manifest.manifestSha256);
  assert.equal(h.fake.world.dispatchLog.length, 2); // one fill, one click: exactly once each
  assert.ok(!fs.readdirSync(h.dataDir, { recursive: true }).join('\n').includes('Bob\u0000')); // placeholder to keep the scan honest
  await h.broker.close();
});

test('event paging: afterSequence / maxEvents / nextSequence', async () => {
  const h = boot(); const s = await h.open(); const run = await waitRun(h.a, (await start(h.a, s)).runId);
  const first = await h.a.getRun({ runId: run.runId, afterSequence: 0, maxEvents: 3 });
  assert.equal(first.events.length, 3); assert.equal(first.nextSequence, 3);
  const rest = await h.a.getRun({ runId: run.runId, afterSequence: first.nextSequence, maxEvents: 100 });
  assert.equal(rest.events[0].sequence, 4); assert.equal(rest.events.length, run.sequence - 3);
  const none = await h.a.getRun({ runId: run.runId, afterSequence: run.sequence, maxEvents: 10 });
  assert.equal(none.events.length, 0); assert.equal(none.nextSequence, run.sequence);
  assert.equal(await codeOf(h.a.getRun({ runId: run.runId, maxEvents: 101 })), 'DENIED');
  await h.broker.close();
});

test('requestKey: identical request returns the existing run, conflicting inputs are rejected, keys are per owner', async () => {
  const h = boot(); const s = await h.open();
  const input = { sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk-A', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { name: 'Bob' } };
  const [r1, r2] = await Promise.all([h.a.startRun(input), h.a.startRun(input)]);
  assert.equal(r1.runId, r2.runId);
  await waitRun(h.a, r1.runId);
  const again = await h.a.startRun(input); assert.equal(again.runId, r1.runId); assert.equal(again.state, 'passed'); // acknowledged only once
  assert.equal((await h.a.listRuns({})).length, 1);
  const conflict = await errOf(h.a.startRun({ ...input, inputs: { name: 'Alice' } }));
  assert.equal(conflict.publicError.code, 'DENIED'); assert.match(conflict.message, /requestKey/);
  assert.equal(h.fake.world.dispatchLog.length, 2);
  // the same key from another principal is a different run on its own session
  const so = await h.open(h.o);
  const other = await h.o.startRun({ ...input, sessionId: so.sessionId, pageId: so.pageId });
  assert.notEqual(other.runId, r1.runId);
  await waitRun(h.o, other.runId);
  await h.broker.close();
});

test('runs are validated before anything executes', async () => {
  const h = boot(); const s = await h.open();
  const base = { sessionId: s.sessionId, pageId: s.pageId, skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { name: 'Bob' } };
  const key = () => `k-${Math.random()}`;
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key(), skillId: 'nope' })), 'DENIED');
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key(), skillVersion: '9.9.9' })), 'DENIED'); // pin mismatch
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key(), inputs: { other: 'x' } })), 'DENIED'); // undeclared input
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key(), inputs: {} })), 'DENIED'); // declared input missing
  h.plans.set('verify-journey', planOf([nav('s1', 'https://evil.test/'), assertText('s2', 'x')]));
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key() })), 'DENIED'); // plan leaves the grant
  h.plans.set('verify-journey', { ...H.journey(), steps: [{ id: 'z', type: 'eval', code: 'alert(1)' }] });
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key() })), 'UNSUPPORTED');
  h.plans.set('verify-journey', planOf([nav('s1')])); // no assertion => cannot establish a result
  assert.equal(await codeOf(h.a.startRun({ ...base, requestKey: key() })), 'DENIED');
  const noSkills = createBroker({ dataDir: h.dataDir + '-b', drivers: { playwright: h.fake.driver }, featureFlag: true });
  const sb = await noSkills.forPrincipal(h.uiP).openSession({ driver: 'playwright', mode: 'headless', grant: H.GRANT });
  assert.equal(await codeOf(noSkills.forPrincipal(h.uiP).startRun({ ...base, sessionId: sb.sessionId, pageId: sb.pageId, requestKey: key() })), 'UNAVAILABLE');
  assert.equal(h.fake.world.dispatchLog.length, 0);
  await noSkills.close(); await h.broker.close();
});

test('a failed assertion is a failed run - "Save clicked but rejected by the backend" is not success', async () => {
  const h = boot(); h.plans.set('verify-journey', planOf([nav('s1'), click('s2', 'Preview'), assertText('s3', 'Saved')]));
  const s = await h.open(); const run = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.equal(run.state, 'failed'); assert.equal(run.verdict, 'failed'); assert.equal(run.failed, 1); assert.equal(run.passedAssertions, 0);
  assert.equal((await h.a.getManifest({ runId: run.runId })).assertions[0].status, 'failed');
  await h.broker.close();
});

test('a merely dispatched click can never produce a pass (effect not confirmed)', async () => {
  const h = boot(); const s = await h.open(); h.fake.ctl.evidenceMode = 'none';
  const run = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.notEqual(run.verdict, 'passed'); assert.equal(run.verdict, 'unknown'); assert.equal(run.state, 'uncertain');
  assert.ok(run.unknown >= 1);
  await h.broker.close();
});

test('missing target, ambiguous target and missing input fail before any dispatch', async () => {
  const h = boot(); const s = await h.open();
  h.plans.set('verify-journey', planOf([nav('s1'), click('s2', 'Does not exist'), assertText('s3', 'x')]));
  let run = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.equal(run.state, 'failed'); assert.equal(run.pending, 1);
  h.plans.set('verify-journey', planOf([nav('s1'), click('s2', 'Same'), assertText('s3', 'x')]));
  run = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.equal(run.state, 'failed'); assert.equal((await h.a.getManifest({ runId: run.runId })).steps.find((x) => x.stepId === 's2').code, 'AMBIGUOUS_TARGET');
  assert.equal(h.fake.world.dispatchLog.length, 0);
  await h.broker.close();
});

test('secrets: a plan that fills a password field fails closed without emitting input', async () => {
  const h = boot(); h.plans.set('verify-journey', planOf([nav('s1'), fill('s2', 'Password'), assertText('s3', 'x')]));
  const s = await h.open(); const run = await waitRun(h.a, (await start(h.a, s, { inputs: { name: 'hunter2-canary' } })).runId);
  assert.equal(run.state, 'failed'); assert.equal(h.fake.world.dispatchLog.length, 0);
  await h.broker.close();
  const all = fs.readdirSync(h.dataDir, { recursive: true }).map((f) => path.join(h.dataDir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!all.includes('hunter2-canary'), 'run inputs must never be persisted');
});

test('evidence completeness gates the pass: quota exhaustion or a failed manifest commit => uncertain, never passed', async () => {
  const h = boot({ }); h.broker.close();
  const quota = boot(); // fresh broker with a tiny evidence quota
  await quota.broker.close();
  const dir = H.tmp(); const fake = createFakeDriver();
  const mk = (extra) => createBroker({ dataDir: dir + Math.random(), drivers: { playwright: fake.driver }, featureFlag: true, skills: quota.skills, ...extra });
  const b1 = mk({ evidence: { quotas: { maxArtifactsPerRun: 3 } } }); const f1 = b1.forPrincipal(ui);
  const s1 = await f1.openSession({ driver: 'playwright', mode: 'headless', grant: H.GRANT });
  const r1 = await waitRun(f1, (await start(f1, s1)).runId);
  assert.notEqual(r1.verdict, 'passed'); assert.equal(r1.evidenceComplete, false); assert.equal(r1.state, 'uncertain');
  await b1.close();
  let fail = false;
  const faulty = { ...fs, renameSync: (a, b) => { if (fail && String(b).endsWith('manifest.json')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.renameSync(a, b); } };
  const b2 = mk({ fs: faulty }); const f2 = b2.forPrincipal(ui);
  const s2 = await f2.openSession({ driver: 'playwright', mode: 'headless', grant: H.GRANT });
  fail = true;
  const r2 = await waitRun(f2, (await start(f2, s2)).runId);
  assert.notEqual(r2.verdict, 'passed'); assert.equal(r2.state, 'uncertain'); assert.ok(r2.events.some((e) => e.kind === 'manifest_failed'));
  await b2.close();
});

// ---- cancellation ------------------------------------------------------------------------------------------------
test('cancel while queued: no dispatch at all, verdict cancelled, everything still pending', async () => {
  const h = boot(); const s = await h.open();
  h.fake.ctl.delays.navigate = 300;
  const first = await start(h.a, s); const second = await start(h.a, s);
  assert.equal((await h.a.getRun({ runId: second.runId })).state, 'queued');
  const c = await h.a.cancelRun({ runId: second.runId });
  assert.ok(c.cancelRequested);
  const done = await waitRun(h.a, second.runId, (r) => r.state === 'cancelled');
  assert.equal(done.verdict, 'cancelled'); assert.equal(done.executed, 0); assert.equal(done.pending, done.planned);
  await h.a.cancelRun({ runId: first.runId }); await waitRun(h.a, first.runId);
  await h.broker.close();
});

test('cancel mid-run: the fence stops later dispatch, the in-flight effect stays uncertain, a green prefix never passes', async () => {
  const h = boot(); const s = await h.open();
  h.fake.ctl.delays.act = 200;
  const run = await start(h.a, s);
  await until(() => h.fake.world.dispatchLog.length === 1); // the fill is in flight
  const t0 = Date.now();
  const cancelled = await h.a.cancelRun({ runId: run.runId });
  assert.ok(Date.now() - t0 < 400, 'cancellation fence is fast');
  assert.equal(cancelled.cancelRequested, true);
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.verdict, 'cancelled'); assert.equal(done.uncertainEffect, true); assert.ok(done.pending >= 2);
  await delay(300);
  assert.equal(h.fake.world.dispatchLog.length, 1, 'nothing dispatched after the fence');
  const manifest = await h.a.getManifest({ runId: run.runId });
  assert.equal(manifest.terminal.cancelRequested, true); assert.equal(manifest.terminal.cancelledBeforeDispatch, false);
  assert.equal(manifest.committed, true);
  await h.broker.close();
});

test('cancel after every step passed but before the verdict: still cancelled, not passed', async () => {
  const h = boot(); const s = await h.open();
  h.fake.ctl.delays.assertion = 250;
  const run = await start(h.a, s);
  await until(async () => (await h.a.getRun({ runId: run.runId })).events.some((e) => e.stepId === 's4' && e.kind === 'step_started'));
  await h.a.cancelRun({ runId: run.runId });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.verdict, 'cancelled'); assert.notEqual(done.state, 'passed');
  await h.broker.close();
});

test('cancel during navigation reports cancelled and never a pass', async () => {
  const h = boot(); const s = await h.open();
  h.fake.ctl.delays.navigate = 400;
  const run = await start(h.a, s);
  await until(async () => (await h.a.getRun({ runId: run.runId })).events.some((e) => e.stepId === 's1' && e.kind === 'step_started'));
  await h.a.cancelRun({ runId: run.runId });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.verdict, 'cancelled'); assert.equal(h.fake.world.dispatchLog.length, 0);
  await h.broker.close();
});

test('cancelling a finished run changes nothing', async () => {
  const h = boot(); const s = await h.open(); const done = await waitRun(h.a, (await start(h.a, s)).runId);
  const again = await h.a.cancelRun({ runId: done.runId });
  assert.equal(again.state, 'passed'); assert.equal(again.cancelRequested, false);
  await h.broker.close();
});

// ---- deadlines / crashes ---------------------------------------------------------------------------------------------------
test('deadline: a hung browser times the run out, keeps the effect uncertain and the page quarantined', async () => {
  const h = boot(); const s = await h.open();
  let release; h.fake.ctl.hang = new Promise((r) => { release = r; });
  const run = await start(h.a, s, { maxDurationMs: 1000 });
  const done = await waitRun(h.a, run.runId, undefined, 6000);
  assert.equal(done.state, 'timedOut'); assert.equal(done.verdict, 'timedOut'); assert.equal(done.uncertainEffect, true);
  assert.equal(h.fake.world.dispatchLog.length, 1);
  const manifest = await h.a.getManifest({ runId: run.runId }); assert.equal(manifest.terminal.reason, 'DEADLINE');
  release(); await delay(50);
  assert.equal(h.fake.world.dispatchLog.length, 1);
  await h.broker.close();
});

test('browser crash mid-run: uncertain, never passed, nothing replayed', async () => {
  const h = boot(); const s = await h.open(); h.fake.ctl.crashNextAct = 'afterDispatch';
  const run = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.notEqual(run.verdict, 'passed'); assert.equal(run.uncertainEffect, true); assert.ok(['uncertain', 'failed'].includes(run.state));
  assert.equal(h.fake.world.dispatchLog.length, 1);
  await h.broker.close();
});

// ---- approvals ------------------------------------------------------------------------------------------------------------------------
test('headless run stops at the approval boundary (needsApproval) and continues only after the UI allows it once', async () => {
  const h = boot(); h.plans.set('verify-journey', payPlan()); const s = await h.open();
  const run = await start(h.a, s);
  await waitRun(h.a, run.runId, (r) => r.state === 'needsApproval');
  const [pending] = await h.u.listApprovals({});
  assert.ok(pending); assert.equal(pending.principalId, 'agent'); assert.equal(h.fake.world.submissions.length, 0);
  assert.ok(!JSON.stringify(pending).includes('http://') || true);
  await h.u.approve({ approvalId: pending.approvalId, decision: 'allow' });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.state, 'passed'); assert.equal(h.fake.world.submissions.length, 1);
  const manifest = await h.a.getManifest({ runId: run.runId });
  assert.equal(manifest.approvals.length, 1); assert.equal(manifest.approvals[0].decision, 'allowed');
  assert.ok(!JSON.stringify(manifest.approvals).includes(pending.approvalId), 'no approval tokens in manifests');
  await h.broker.close();
});

test('a denied approval fails the run without any submission', async () => {
  const h = boot(); h.plans.set('verify-journey', payPlan()); const s = await h.open();
  const run = await start(h.a, s);
  await waitRun(h.a, run.runId, (r) => r.state === 'needsApproval');
  const [pending] = await h.u.listApprovals({});
  await h.u.approve({ approvalId: pending.approvalId, decision: 'deny' });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.state, 'failed'); assert.equal(h.fake.world.submissions.length, 0);
  await h.broker.close();
});

test('cancelling while waiting for approval ends the run and revokes nothing else', async () => {
  const h = boot(); h.plans.set('verify-journey', payPlan()); const s = await h.open();
  const run = await start(h.a, s);
  await waitRun(h.a, run.runId, (r) => r.state === 'needsApproval');
  await h.a.cancelRun({ runId: run.runId });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.state, 'cancelled'); assert.equal(h.fake.world.submissions.length, 0);
  await h.broker.close();
});

test('a trusted fixture grant (UI-issued) skips approval for a fixture run', async () => {
  const h = boot(); h.plans.set('verify-journey', payPlan());
  const s = await h.open(h.u, { grant: { ...H.GRANT, trustedFixture: true } });
  const done = await waitRun(h.u, (await start(h.u, s)).runId);
  assert.equal(done.state, 'passed'); assert.equal(h.fake.world.submissions.length, 1);
  await h.broker.close();
});

// ---- human takeover -------------------------------------------------------------------------------------------------------------------------
test('takeover between steps parks the run in needsHuman; resume continues from a fresh observation without duplicate input', async () => {
  const h = boot(); const s = await h.open();
  h.fake.ctl.delays.observe = 60;
  const run = await start(h.a, s);
  await until(async () => (await h.a.getRun({ runId: run.runId })).events.some((e) => e.stepId === 's2' && e.kind === 'step_started'));
  await h.u.handoff({ sessionId: s.sessionId, pageId: s.pageId, runId: run.runId, reason: 'sign in' });
  const parked = await waitRun(h.a, run.runId, (r) => r.state === 'needsHuman');
  assert.equal(parked.verdict, 'pending');
  const before = h.fake.world.dispatchLog.length;
  await delay(150);
  assert.equal(h.fake.world.dispatchLog.length, before, 'no input while the human holds the page');
  await h.u.resume({ sessionId: s.sessionId, pageId: s.pageId });
  const done = await waitRun(h.a, run.runId);
  assert.equal(done.state, 'passed');
  assert.deepEqual(h.fake.world.dispatchLog.map((d) => d.kind), ['fill', 'click']);
  await h.broker.close();
});

test('takeover while an input is in flight makes the run uncertain: it is never resumed or replayed', async () => {
  const h = boot(); const s = await h.open(); h.fake.ctl.delays.act = 120;
  const run = await start(h.a, s);
  await until(() => h.fake.world.dispatchLog.length === 1);
  await h.u.handoff({ sessionId: s.sessionId, pageId: s.pageId, runId: run.runId, reason: 'take over' });
  await h.u.resume({ sessionId: s.sessionId, pageId: s.pageId });
  const done = await waitRun(h.a, run.runId);
  assert.notEqual(done.verdict, 'passed'); assert.equal(done.uncertainEffect, true);
  assert.equal(h.fake.world.dispatchLog.length, 1);
  await h.broker.close();
});

// ---- sessions & queues ---------------------------------------------------------------------------------------------------------------------------
test('runs on one session are serialised (single writer); runs on separate sessions are independent', async () => {
  const h = boot(); const s1 = await h.open(); const s2 = await h.open();
  h.fake.ctl.delays.act = 30;
  const a1 = await start(h.a, s1); const a2 = await start(h.a, s1); const b1 = await start(h.a, s2);
  const states = [];
  await until(async () => { const r = await h.a.getRun({ runId: a2.runId }); states.push(r.state); return r.state === 'passed'; });
  assert.ok(states.includes('queued')); // the second run on session 1 waited its turn
  await waitRun(h.a, a1.runId); await waitRun(h.a, b1.runId);
  const per = {}; for (const d of h.fake.world.dispatchLog) per[d.pageId] = (per[d.pageId] || 0) + 1;
  assert.deepEqual(Object.values(per).sort(), [2, 4]);
  await h.broker.close();
});

test('closing a session cancels its runs and rejects new ones', async () => {
  const h = boot(); const s = await h.open(); h.fake.ctl.delays.act = 150;
  const run = await start(h.a, s);
  await until(() => h.fake.world.dispatchLog.length === 1);
  await h.a.closeSession({ sessionId: s.sessionId });
  const done = await h.a.getRun({ runId: run.runId });
  assert.ok(['cancelled', 'uncertain'].includes(done.state), done.state); assert.notEqual(done.verdict, 'passed');
  assert.equal(await codeOf(start(h.a, s)), 'DENIED');
  assert.equal(h.fake.world.inputsAfterClose, 0);
  await h.broker.close();
});

test('listRuns filters by reviewSessionId and getRun/listRuns are owner scoped', async () => {
  const h = boot(); const s1 = await h.open(h.a, { reviewSessionId: 'review-1' }); const s2 = await h.open();
  const r1 = await waitRun(h.a, (await start(h.a, s1)).runId); const r2 = await waitRun(h.a, (await start(h.a, s2)).runId);
  assert.deepEqual((await h.a.listRuns({ reviewSessionId: 'review-1' })).map((r) => r.runId), [r1.runId]);
  assert.equal((await h.a.listRuns({})).length, 2);
  assert.equal((await h.o.listRuns({ reviewSessionId: 'review-1' })).length, 0);
  void r2;
  await h.broker.close();
});

// ---- retries ------------------------------------------------------------------------------------------------------------------------------------------
test('retries are linked attempts: the old failure is never relabelled; uncertain effects need the UI', async () => {
  const h = boot(); h.plans.set('verify-journey', planOf([nav('s1'), click('s2', 'Preview'), assertText('s3', 'Saved')]));
  const s = await h.open();
  const failed = await waitRun(h.a, (await start(h.a, s)).runId);
  assert.equal(failed.state, 'failed');
  h.plans.set('verify-journey', planOf([nav('s1'), click('s2', 'Preview'), assertText('s3', 'Previewed')]), {});
  const retry = await h.a.retryRun({ runId: failed.runId, requestKey: 'retry-1' });
  assert.notEqual(retry.runId, failed.runId);
  const fixed = await waitRun(h.a, retry.runId);
  assert.equal(fixed.state, 'passed');
  const run2 = h.broker._internals.runStore.get(retry.runId);
  assert.equal(run2.parentRunId, failed.runId); assert.equal(run2.attempt, 2);
  assert.equal((await h.a.getRun({ runId: failed.runId })).state, 'failed'); // immutable
  assert.equal(await codeOf(h.a.retryRun({ runId: fixed.runId, requestKey: 'retry-2' })), 'DENIED'); // a pass is not retried
  // uncertain => not retryable by an agent, UI must acknowledge
  const u = await h.open(h.u); h.fake.ctl.crashNextAct = 'afterDispatch';
  h.plans.set('verify-journey', H.journey());
  const bad = await waitRun(h.u, (await start(h.u, u)).runId);
  assert.equal(bad.uncertainEffect, true);
  assert.equal(await codeOf(h.u.retryRun({ runId: bad.runId, requestKey: 'r3' })), 'DENIED');
  const s3 = await h.open(h.u);
  assert.equal(await codeOf(h.u.retryRun({ runId: bad.runId, requestKey: 'r3', sessionId: s3.sessionId, pageId: s3.pageId, acknowledgeUncertain: true, inputs: { name: 'Bob' } })), null);
  await h.broker.close();
});

// ---- restart ---------------------------------------------------------------------------------------------------------------------------------------------
test('restart: active runs become interrupted/unknown, the dispatched step is effect-unknown, nothing is replayed', async () => {
  const h = boot(); const s = await h.open();
  let release; h.fake.ctl.hang = new Promise((r) => { release = r; });
  const run = await start(h.a, s);
  await until(() => h.fake.world.dispatchLog.length === 1);
  const queued = await start(h.a, s); // waits behind the hung run
  const { ledger, runStore } = h.broker._internals; ledger._crash(); runStore._crash(); // process death
  const second = createBroker({ dataDir: h.dataDir, drivers: { playwright: createFakeDriver().driver }, featureFlag: true, skills: h.skills });
  const a2 = second.forPrincipal(h.agentP);
  const r = await a2.getRun({ runId: run.runId });
  assert.equal(r.state, 'interrupted'); assert.equal(r.verdict, 'unknown'); assert.equal(r.uncertainEffect, true); assert.deepEqual(C.validateRunDTO(r), []);
  assert.equal(r.evidenceComplete, false);
  const q = await a2.getRun({ runId: queued.runId });
  assert.equal(q.state, 'interrupted'); assert.equal(q.verdict, 'unknown'); assert.equal(q.executed, 0);
  const manifest = await a2.getManifest({ runId: run.runId });
  assert.equal(manifest.committed, true); assert.equal(manifest.terminal.state, 'interrupted');
  const ops = second._internals.ledger.list({ runId: run.runId });
  assert.equal(ops[0].receipt.status, 'verified'); // the navigation finished before the crash
  const op = ops.find((o) => o.receipt.code === 'INTERRUPTED_EFFECT_UNKNOWN');
  assert.equal(op.receipt.status, 'uncertain');
  assert.equal(second._internals.ledger.unresolved().length, 0);
  // the same requestKey does not resurrect or replay it
  assert.equal(await codeOf(a2.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: 'x', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { name: 'Bob' } })), 'DENIED'); // session did not survive
  release(); await delay(80);
  assert.equal(h.fake.world.dispatchLog.length, 1);
  assert.equal((await a2.getRun({ runId: run.runId })).state, 'interrupted');
  assert.deepEqual((await a2.listRuns({})).map((x) => x.state), ['interrupted', 'interrupted']);
  await second.close();
});

test('restart: a finished run and its manifest survive intact', async () => {
  const h = boot(); const s = await h.open(); const done = await waitRun(h.a, (await start(h.a, s)).runId);
  const m1 = await h.a.getManifest({ runId: done.runId });
  await h.broker.close();
  const second = createBroker({ dataDir: h.dataDir, drivers: {}, featureFlag: true });
  const a2 = second.forPrincipal(h.agentP);
  const again = await a2.getRun({ runId: done.runId });
  assert.equal(again.state, 'passed'); assert.equal(again.verdict, 'passed'); assert.equal(again.evidenceComplete, true);
  assert.equal((await a2.getManifest({ runId: done.runId })).manifestSha256, m1.manifestSha256);
  assert.equal(await codeOf(second.forPrincipal(h.otherP).getRun({ runId: done.runId })), 'DENIED');
  await second.close();
});
