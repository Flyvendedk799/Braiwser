// Agent Runs controller against the FakeBrokerBridge: rehydrate from the journal,
// never invent success, drop stale replies, unsubscribe on destroy, takeover and
// resume semantics, approval digests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tick, flush } from './agent-dom-env.mjs';
import { FakeBrokerBridge, ev, approvalPayload, ownerPayload } from './fake-broker-bridge.mjs';

const { createAgentRunsController } = await load('controllers/agent-runs.js');
const { createAgentBridge, CH } = await load('lib/agent-bridge.js');

function boot(fake, opts = {}) {
  const bridge = createAgentBridge(fake.facade);
  const ctl = createAgentRunsController({ bridge, schedule: (fn) => setTimeout(fn, 0), ...opts });
  return ctl;
}
const journal = (n) => Array.from({ length: n }, (_, i) => ev(i + 1, i === 0 ? 'run.started' : 'step.planned', i ? { stepId: `s${i}` } : {}));

test('flag off: init reports disabled, subscribes to nothing, lists nothing', async () => {
  const fake = new FakeBrokerBridge({ enabled: false });
  const ctl = boot(fake);
  assert.equal(await ctl.init(), false);
  assert.equal(ctl.state.enabled, false);
  assert.equal(fake.listenerCount(), 0);
  assert.deepEqual(fake.calls.map((c) => c.channel), [CH.status]);
});

test('runtime facade absent: disabled, no throw', async () => {
  const ctl = createAgentRunsController({ bridge: createAgentBridge(undefined) });
  assert.equal(await ctl.init(), false);
});

test('opening a run rehydrates the whole journal from the broker, paging', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', planned: 230 }, journal(230));
  const ctl = boot(fake);
  await ctl.init();
  await ctl.openRun('r1');
  const view = ctl.getView('r1');
  assert.equal(view.events.length, 230);
  assert.equal(view.lastSequence, 230);
  assert.equal(view.sync, 'ok');
  assert.equal(ctl.completeness('r1').complete, true);
  const gets = fake.callsTo(CH.runGet);
  assert.ok(gets.length >= 3, 'paged');
  assert.equal(gets[0].payload.afterSequence, 0);
  assert.ok(gets.every((c) => c.payload.maxEvents <= 100));
});

test('a missing reply is an error: the run is "unavailable", never a pass', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', state: 'passed', verdict: 'passed' }, journal(3));
  fake.noReply.add(CH.runGet);
  const ctl = boot(fake);
  await ctl.init();
  await ctl.openRun('r1');
  const view = ctl.getView('r1');
  assert.equal(view.sync, 'unavailable');
  assert.ok(view.syncError);
  assert.equal(view.events.length, 0);
  // The list reply earlier may have carried a snapshot; the open view must say it is stale/unavailable.
  assert.equal(ctl.completeness('r1').complete, false);
});

test('a transport failure is an error with effect unknown', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1' }, journal(2));
  const ctl = boot(fake);
  await ctl.init();
  fake.throwTransport.add(CH.runCancel);
  const res = await ctl.cancelRun('r1');
  assert.equal(res.ok, false);
  assert.equal(res.error.replyMissing, true);
  assert.equal(res.error.effectUnknown, true);
  assert.equal(ctl.getView('r1').dto.cancelRequested, false, 'no cancellation is claimed without a reply');
});

test('cancel only changes what is shown via the returned report', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1' }, journal(2));
  const ctl = boot(fake);
  await ctl.init();
  const res = await ctl.cancelRun('r1');
  assert.equal(res.ok, true);
  assert.equal(ctl.getView('r1').dto.cancelRequested, true);
  assert.equal(ctl.getView('r1').dto.state, 'running', 'cancel request is not a cancelled run');
});

test('pushed events: a gap triggers one journal re-read; a hole the journal cannot fill stays visible', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', sequence: 2 }, journal(2));
  const ctl = boot(fake);
  await ctl.init();
  await ctl.openRun('r1');
  // journal in the broker never gets 3..5, but a push for 6 arrives
  fake.emit(CH.evRun, { runId: 'r1', event: ev(6, 'step.result', { stepId: 's1', detail: { status: 'passed', effect: 'confirmed' } }) });
  assert.deepEqual(ctl.completeness('r1').openGap, { from: 3, to: 5 });
  await tick(20);
  const c = ctl.completeness('r1');
  assert.equal(c.openGap, null);
  assert.deepEqual(c.holes.map((h) => [h.from, h.to]), [[3, 5]], 'unfillable range is disclosed');
  assert.equal(c.complete, false);
  assert.equal(ctl.getView('r1').lastSequence, 6);
});

test('pushed events: a gap that the journal CAN fill closes cleanly', async () => {
  const fake = new FakeBrokerBridge();
  const run = fake.addRun({ runId: 'r1', sequence: 2 }, journal(2));
  const ctl = boot(fake);
  await ctl.init();
  await ctl.openRun('r1');
  run.journal.push(ev(3, 'step.planned', { stepId: 's2' }), ev(4, 'step.planned', { stepId: 's3' }));
  run.dto.sequence = 4;
  fake.emit(CH.evRun, { runId: 'r1', event: ev(4, 'step.planned', { stepId: 's3' }) });
  await tick(20);
  const view = ctl.getView('r1');
  assert.equal(view.lastSequence, 4);
  assert.equal(ctl.completeness('r1').holes.length, 0);
});

test('pushed run for an unknown id refreshes the list instead of inventing a row', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  const before = fake.callsTo(CH.runsList).length;
  fake.addRun({ runId: 'r9' }, journal(1));
  fake.emit(CH.evRun, { runId: 'r9', event: ev(1, 'run.started') });
  await tick(120);
  assert.ok(fake.callsTo(CH.runsList).length > before);
  assert.ok(ctl.runSummaries().some((r) => r.runId === 'r9'));
});

test('a stale reply that arrives after a newer one does not roll the run back', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', state: 'running', sequence: 5 }, journal(5));
  const ctl = boot(fake);
  await ctl.init();
  const release = fake.holdChannel(CH.runGet);
  const slow = ctl.hydrate('r1', { fromStart: true }); // reply held
  await tick(5);
  // meanwhile a newer snapshot arrives by push
  fake.emit(CH.evRun, { runId: 'r1', run: { runId: 'r1', state: 'failed', verdict: 'failed', sequence: 9, events: [] } });
  assert.equal(ctl.getView('r1').dto.state, 'failed');
  release();
  await slow;
  assert.equal(ctl.getView('r1').dto.state, 'failed', 'older held reply must not win');
});

test('destroy unsubscribes every listener and ignores in-flight replies', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1' }, journal(3));
  const ctl = boot(fake);
  await ctl.init();
  assert.equal(fake.listenerCount(), 4);
  const release = fake.holdChannel(CH.runGet);
  const p = ctl.hydrate('r1', { fromStart: true });
  await tick(5);
  ctl.destroy();
  assert.equal(fake.listenerCount(), 0);
  release();
  await p;
  assert.equal(ctl.getView('r1').events.length, 0, 'late reply after destroy changes nothing');
  fake.emit(CH.evRun, { runId: 'r1', event: ev(9, 'x') });
});

// ---- ownership -------------------------------------------------------------------
test('takeover: the human controls only after the runtime says so; agent controls are disabled meanwhile', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evOwner, ownerPayload());
  assert.equal(ctl.agentControlsEnabled('s1'), true);
  const release = fake.holdChannel(CH.handoff);
  const pending = ctl.takeControl({ sessionId: 's1', pageId: 'p1', runId: 'r1' });
  await tick(5);
  assert.equal(ctl.getOwner('s1').controller, 'agent', 'not flipped on click');
  assert.equal(ctl.agentControlsEnabled('s1'), false, 'busy => agent controls off immediately');
  release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(ctl.getOwner('s1').controller, 'human');
  assert.equal(ctl.agentControlsEnabled('s1'), false);
});

test('takeover failure leaves the owner unchanged and says why', async () => {
  const fake = new FakeBrokerBridge();
  fake.fail.set(CH.handoff, { code: 'UNSUPPORTED', message: 'Headless takeover needs a remote viewer', dispatched: false, effectUnknown: false, retry: 'never' });
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evOwner, ownerPayload());
  const res = await ctl.takeControl({ sessionId: 's1', pageId: 'p1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNSUPPORTED');
  assert.equal(ctl.getOwner('s1').controller, 'agent');
  assert.equal(ctl.agentControlsEnabled('s1'), true);
});

test('resume is only for a human-controlled session and does not assume agent control without the runtime', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evOwner, ownerPayload());
  assert.equal((await ctl.resume({ sessionId: 's1', pageId: 'p1' })).ok, false, 'agent already in control');
  await ctl.takeControl({ sessionId: 's1', pageId: 'p1' });
  // runtime reply that does NOT confirm agent control
  fake.handlers[CH.resume] = () => ({ owner: 'human' });
  const res = await ctl.resume({ sessionId: 's1', pageId: 'p1' });
  assert.equal(res.ok, true);
  assert.equal(ctl.getOwner('s1').controller, 'human');
  fake.handlers[CH.resume] = () => ({ owner: 'agent', observationId: 'ob_f' });
  await ctl.resume({ sessionId: 's1', pageId: 'p1' });
  assert.equal(ctl.getOwner('s1').controller, 'agent');
});

test('resume transport failure leaves the human in control', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evOwner, ownerPayload({ owner: 'human' }));
  fake.throwTransport.add(CH.resume);
  const res = await ctl.resume({ sessionId: 's1', pageId: 'p1' });
  assert.equal(res.ok, false);
  assert.equal(ctl.getOwner('s1').controller, 'human');
});

test('stale owner message (older fence) is ignored', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evOwner, ownerPayload({ owner: 'human', ownerEpoch: 9 }));
  fake.emit(CH.evOwner, ownerPayload({ owner: 'agent', ownerEpoch: 8 }));
  assert.equal(ctl.getOwner('s1').controller, 'human');
});

// ---- approvals ---------------------------------------------------------------------
test('approval: allow is refused when the shown digest is not the current digest', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evApproval, approvalPayload());
  const shown = ctl.getApproval('ap_1').actionDigest;
  // page navigated: the runtime re-announces the SAME id with a different action
  fake.emit(CH.evApproval, approvalPayload({ actionDigest: 'dig_bbbb2222', action: { kind: 'click', label: 'Delete account' } }));
  const res = await ctl.decide('ap_1', 'allow', shown);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'digest-mismatch');
  assert.equal(fake.callsTo(CH.approvalDecide).length, 0, 'nothing is sent to the runtime');
  // reviewing the NEW request and allowing it works
  const ok = await ctl.decide('ap_1', 'allow', 'dig_bbbb2222');
  assert.equal(ok.ok, true);
  assert.equal(fake.callsTo(CH.approvalDecide)[0].payload.actionDigest, 'dig_bbbb2222');
});

test('approval: expired, withdrawn (takeover) and digest-less requests cannot be allowed', async () => {
  let clock = 1_000_000;
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake, { now: () => clock });
  await ctl.init();
  fake.emit(CH.evApproval, approvalPayload({ approvalId: 'a_exp', expiresAt: clock + 1000 }));
  clock += 5000;
  assert.equal((await ctl.decide('a_exp', 'allow', 'dig_aaaa1111')).reason, 'expired');

  fake.emit(CH.evApproval, approvalPayload({ approvalId: 'a_nd', actionDigest: '', expiresAt: clock + 60000 }));
  assert.equal((await ctl.decide('a_nd', 'allow', '')).reason, 'no-digest');

  fake.emit(CH.evApproval, approvalPayload({ approvalId: 'a_w', expiresAt: clock + 60000 }));
  fake.emit(CH.evOwner, ownerPayload({ owner: 'human' }));
  assert.equal((await ctl.decide('a_w', 'allow', 'dig_aaaa1111')).reason, 'invalid');
  assert.equal((await ctl.decide('nope', 'allow', 'x')).reason, 'unknown');
  assert.equal(fake.callsTo(CH.approvalDecide).length, 0);
});

test('approval: page navigation (new document epoch) withdraws the pending request', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evApproval, approvalPayload());
  fake.emit(CH.evOwner, ownerPayload({ documentEpoch: 4 }));
  assert.equal((await ctl.decide('ap_1', 'allow', 'dig_aaaa1111')).reason, 'invalid');
});

test('approval: a runtime error leaves it pending; an unconfirmed reply is not treated as a decision', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  fake.emit(CH.evApproval, approvalPayload());
  fake.throwTransport.add(CH.approvalDecide);
  const r1 = await ctl.decide('ap_1', 'allow', 'dig_aaaa1111');
  assert.equal(r1.ok, false);
  assert.equal(ctl.getApproval('ap_1').status, 'pending');
  fake.throwTransport.clear();
  fake.handlers[CH.approvalDecide] = () => ({});
  const r2 = await ctl.decide('ap_1', 'allow', 'dig_aaaa1111');
  assert.equal(r2.ok, false);
  assert.equal(ctl.getApproval('ap_1').status, 'pending');
  fake.handlers[CH.approvalDecide] = (p) => ({ decision: p.decision });
  assert.equal((await ctl.decide('ap_1', 'allow', 'dig_aaaa1111')).ok, true);
  assert.equal(ctl.getApproval('ap_1').status, 'allowed');
  // an answered approval can never be reopened by a replay of the push
  fake.emit(CH.evApproval, approvalPayload());
  assert.equal(ctl.getApproval('ap_1').status, 'allowed');
});

test('connections: unsupported registry is reported as such, not as an empty list', async () => {
  const fake = new FakeBrokerBridge();
  fake.connections = { supported: false, connections: [] };
  const ctl = boot(fake);
  await ctl.init();
  await ctl.loadConnections();
  assert.equal(ctl.state.connections.supported, false);
});

test('evidence reads only accept run evidence links', async () => {
  const fake = new FakeBrokerBridge();
  const ctl = boot(fake);
  await ctl.init();
  for (const bad of ['file:///etc/passwd', 'https://x.test', 'braiwser://runs/../../x', 'braiwser://capabilities', '']) {
    assert.equal((await ctl.readEvidence(bad)).ok, false, bad);
  }
  assert.equal((await ctl.readEvidence('braiwser://runs/r1/observations/ob_1')).ok, true);
});

test('filter counts follow run state groups', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'a', state: 'running' });
  fake.addRun({ runId: 'b', state: 'needsApproval' });
  fake.addRun({ runId: 'c', state: 'uncertain', verdict: 'unknown' });
  fake.addRun({ runId: 'd', state: 'failed', verdict: 'failed' });
  const ctl = boot(fake);
  await ctl.init();
  assert.deepEqual(ctl.counts(), { all: 4, active: 1, needsInput: 2, completed: 1 });
  ctl.setFilter('needsInput');
  assert.deepEqual(ctl.filteredRuns().map((r) => r.runId).sort(), ['b', 'c']);
  await flush();
});
