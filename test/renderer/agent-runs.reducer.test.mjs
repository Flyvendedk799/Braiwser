// Agent Runs: reducer ordering / gaps / truncation, and the verdict the UI is
// allowed to display. Pure modules — no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './agent-dom-env.mjs';

const R = await load('lib/agent-run-reducer.js');
const U = await load('lib/agent-ui.js');
const ev = (sequence, kind, extra = {}) => ({ sequence, kind, summary: kind, ...extra });
const hydrated = () => { const v = R.createRunView('r1'); R.applyEvents(v, [ev(1, 'run.started')], { fromStart: true }); return v; };

test('events apply strictly in sequence; out-of-order arrival is buffered, not reordered into place', () => {
  const v = hydrated();
  R.applyEvents(v, [ev(3, 'step.planned', { stepId: 'b' })]);
  assert.equal(v.lastSequence, 1, 'seq 3 must wait for seq 2');
  assert.deepEqual(R.openGap(v), { from: 2, to: 2 });
  R.applyEvents(v, [ev(2, 'step.planned', { stepId: 'a' })]);
  assert.equal(v.lastSequence, 3);
  assert.equal(R.openGap(v), null);
  assert.deepEqual(v.events.map((e) => e.sequence), [1, 2, 3]);
  assert.deepEqual(R.stepsOf(v).map((s) => s.stepId), ['a', 'b']);
});

test('duplicates are ignored and counted', () => {
  const v = hydrated();
  R.applyEvents(v, [ev(2, 'x'), ev(2, 'x'), ev(1, 'run.started')]);
  assert.equal(v.events.length, 2);
  assert.equal(v.duplicates, 2);
});

test('a missing range is an OPEN gap; when the journal cannot fill it, it becomes a visible unfilled hole', () => {
  const v = hydrated();
  R.applyEvents(v, [ev(6, 'step.result', { stepId: 's', detail: { status: 'passed' } })]);
  assert.deepEqual(R.openGap(v), { from: 2, to: 5 });
  assert.equal(R.completeness(v).complete, false);
  const gap = R.markGapUnfilled(v, 'journal rolled over');
  assert.deepEqual(gap, { from: 2, to: 5 });
  assert.equal(v.lastSequence, 6, 'continues after the hole');
  const c = R.completeness(v);
  assert.equal(c.complete, false, 'a timeline with a hole is never reported complete');
  assert.deepEqual(c.holes.map((h) => [h.from, h.to]), [[2, 5]]);
});

test('a journal that does not start at the beginning discloses the missing head', () => {
  const v = R.createRunView('r1');
  R.applyEvents(v, [ev(40, 'a'), ev(41, 'b')], { fromStart: true });
  assert.deepEqual(v.holes.map((h) => [h.from, h.to]), [[1, 39]]);
  assert.equal(R.completeness(v).complete, false);
});

test('events pushed before any journal read are buffered and flag a hydrate; nothing is applied blindly', () => {
  const v = R.createRunView('r1');
  R.applyEvents(v, [ev(7, 'step.result', { stepId: 's', detail: { status: 'passed' } })]);
  assert.equal(v.needsHydrate, true);
  assert.equal(v.events.length, 0);
  assert.equal(v.steps.size, 0);
});

test('explicit gap / truncated events from the journal are surfaced as notices', () => {
  const v = hydrated();
  R.applyEvents(v, [ev(2, 'stream.truncated', { summary: 'Output backpressure: events dropped', detail: { from: 3, to: 9, dropped: 7 } })]);
  const c = R.completeness(v);
  assert.equal(c.notices.length, 1);
  assert.equal(c.notices[0].dropped, 7);
  assert.equal(c.complete, false);
});

test('local event cap discloses trimmed events', () => {
  const v = hydrated();
  const many = [];
  for (let i = 2; i < 2300; i++) many.push(ev(i, 'tick'));
  R.applyEvents(v, many);
  assert.ok(v.events.length <= 2000);
  assert.ok(v.droppedLocal > 0);
  assert.equal(R.completeness(v).droppedLocal, v.droppedLocal);
});

test('a step is "passed" only when an explicit status says so; a result without status is unknown', () => {
  const v = hydrated();
  R.applyEvents(v, [
    ev(2, 'step.started', { stepId: 'a', detail: { intent: 'Click Save' } }),
    ev(3, 'step.result', { stepId: 'a' }),
    ev(4, 'step.started', { stepId: 'b' }),
    ev(5, 'step.result', { stepId: 'b', detail: { status: 'passed', effect: 'confirmed', outcome: 'Saved toast shown' } }),
  ]);
  assert.equal(v.steps.get('a').status, 'unknown');
  assert.equal(v.steps.get('b').status, 'passed');
  assert.equal(v.steps.get('a').intent, 'Click Save');
  assert.equal(R.lastProvenStep(v).stepId, 'b');
});

test('uncertain step: effect unknown, never reported as failed-and-safe-to-retry', () => {
  const v = hydrated();
  R.applyEvents(v, [
    ev(2, 'step.result', { stepId: 'a', detail: { status: 'passed', effect: 'confirmed' } }),
    ev(3, 'step.uncertain', { stepId: 'b', detail: { intent: 'Submit order', effect: 'dispatched' } }),
  ]);
  const unc = R.uncertainStep(v);
  assert.equal(unc.stepId, 'b');
  assert.equal(unc.status, 'unknown');
  assert.equal(unc.effect, 'unknown');
  assert.equal(R.lastProvenStep(v).stepId, 'a');
});

test('page-derived strings are length-bounded plain text', () => {
  const v = hydrated();
  R.applyEvents(v, [ev(2, 'step.started', { stepId: 'a', detail: { target: { role: 'button', name: '<img src=x onerror=1>'.repeat(100) } } })]);
  assert.ok(v.steps.get('a').target.name.length <= 200);
});

test('a late (stale) snapshot cannot roll the run back', () => {
  const v = R.createRunView('r1');
  const dto = (sequence, state) => ({ runId: 'r1', state, verdict: 'pending', sequence, events: [] });
  assert.equal(R.applySnapshot(v, dto(10, 'running')).accepted, true);
  const stale = R.applySnapshot(v, dto(4, 'queued'));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(v.dto.state, 'running');
  assert.equal(R.applySnapshot(v, { runId: 'other', state: 'running' }).accepted, false);
});

test('owner updates carry a fence: reordered older updates are refused', () => {
  const a = R.normalizeOwner({ sessionId: 's1', pageId: 'p1', owner: 'human', ownerEpoch: 5 });
  const stale = R.normalizeOwner({ sessionId: 's1', pageId: 'p1', owner: 'agent', ownerEpoch: 4 });
  let r = R.mergeOwner(null, a);
  assert.equal(r.owner.controller, 'human');
  r = R.mergeOwner(r.owner, stale);
  assert.equal(r.accepted, false);
  assert.equal(r.owner.controller, 'human');
  assert.equal(R.normalizeOwner({ owner: 'agent' }), null, 'no sessionId => rejected');
});

// ---- verdict display ------------------------------------------------------------
const passedDto = (over = {}) => ({
  runId: 'r1', state: 'passed', verdict: 'passed', planned: 3, executed: 3, passed: 3, failed: 0, skipped: 0,
  cancelled: 0, timedOut: 0, unknown: 0, pending: 0, requiredAssertions: 1, passedAssertions: 1,
  evidenceComplete: true, uncertainEffect: false, ...over,
});

test('displayVerdict shows passed only when the counters prove it', () => {
  assert.equal(U.displayVerdict(passedDto()).verdict, 'passed');
  for (const bad of [{ evidenceComplete: false }, { skipped: 1, passed: 2 }, { uncertainEffect: true }, { passedAssertions: 0 }, { requiredAssertions: 0, passedAssertions: 0 }, { planned: 0, passed: 0 }, { pending: 1 }]) {
    const d = U.displayVerdict(passedDto(bad));
    assert.equal(d.verdict, 'unknown', JSON.stringify(bad));
    assert.equal(d.inconsistent, true);
  }
});

test('displayVerdict: unfinished => pending; uncertain/interrupted => unknown; missing report => unknown', () => {
  for (const state of ['queued', 'running', 'needsApproval', 'needsHuman']) {
    assert.equal(U.displayVerdict({ state, verdict: 'passed' }).verdict, 'pending', state);
  }
  assert.equal(U.displayVerdict({ state: 'uncertain', verdict: 'passed' }).verdict, 'unknown');
  assert.equal(U.displayVerdict({ state: 'interrupted', verdict: 'failed' }).verdict, 'unknown');
  assert.equal(U.displayVerdict(null).verdict, 'unknown');
  assert.equal(U.displayVerdict({ state: 'failed', verdict: 'failed' }).verdict, 'failed');
  assert.equal(U.displayVerdict({ state: 'timedOut', verdict: 'timedOut' }).verdict, 'timedOut');
});

test('every outcome has a label AND an icon (not colour alone)', () => {
  for (const k of ['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown', 'pending']) {
    const m = U.outcomeMeta(k);
    assert.ok(m.label && m.icon, k);
    assert.match(U.agentIcon(m.icon), /<svg/);
  }
  for (const [state, m] of Object.entries(U.RUN_STATES)) assert.ok(m.label && m.icon && m.group, state);
});

test('safeImageSrc only admits inline raster data URLs', () => {
  assert.ok(U.safeImageSrc('data:image/png;base64,AAAA'));
  for (const bad of ['https://evil.test/x.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd', '']) {
    assert.equal(U.safeImageSrc(bad), '', bad);
  }
});
