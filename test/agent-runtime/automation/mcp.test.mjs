import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { createMcpServer, checkSchemaVersion } from '../../../src/main/services/automation/mcp.mjs';
import { createFakeBroker, P, PAGE_NODES } from './_fake-broker.mjs';
import { connect, openPage } from './_harness.mjs';

const require = createRequire(import.meta.url);
const registry = require('../../../src/main/services/automation/skill-registry.js');

const proof = (ids = ['s1', 's2', 's3']) => ids.map((stepId) => ({
  stepId, status: 'passed', effect: stepId === 's3' ? 'notDispatched' : 'confirmed', evidenceIds: [`ev_${stepId}`] }));

async function setup(options = {}, brokerOptions = {}) {
  const broker = createFakeBroker(brokerOptions);
  const h = await connect(broker, P('mcp:a'), options);
  const opened = await openPage(h);
  const page = { sessionId: opened.sessionId, pageId: opened.pageId };
  return { broker, h, page };
}
const startRun = (h, page, extra = {}) => h.ok('browser_run', {
  ...page && { sessionId: page.sessionId, pageId: page.pageId }, requestKey: 'rk1', skillId: 'verify-journey', skillVersion: '1.0.0',
  inputs: { recordingId: 'rec_1' }, ...extra });

test('registers the broker tools with strict inputs, typed outputs and honest annotations', async () => {
  const { h } = await setup();
  const { tools } = await h.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'browser_act', 'browser_extract', 'browser_handoff', 'browser_handoff_status', 'browser_observe', 'browser_run',
    'browser_run_cancel', 'browser_run_pause', 'browser_run_resume', 'browser_run_status', 'browser_session_close', 'browser_session_open'].sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} input must reject unknown keys`);
    assert.ok(t.outputSchema, `${t.name} has an output schema`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
    assert.equal(t.annotations.destructiveHint, !t.annotations.readOnlyHint && ['browser_act', 'browser_run'].includes(t.name));
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.browser_observe.annotations.readOnlyHint, true);
  assert.equal(byName.browser_run_status.annotations.readOnlyHint, true);
  assert.equal(byName.browser_extract.annotations.readOnlyHint, true);
  assert.equal(byName.browser_act.annotations.readOnlyHint, false);
  // No arbitrary-code surface exists anywhere in the advertised schemas.
  assert.ok(!/evaluate|script|selector|\bpath\b|\bcookie|shell|command/i.test(JSON.stringify(tools.map((t) => t.inputSchema))));
  await h.close();
});

test('open -> observe -> act: typed envelopes validated by the real client against the output schema', async () => {
  const { h, page } = await setup();
  assert.match(page.sessionId, /^bs_/);
  const ob = await h.ok('browser_observe', page);
  assert.equal(ob.trust, 'untrusted-page');
  assert.equal(ob.nodes[0].ref, 'r_save');
  assert.ok(ob.nodes.every((n) => !('refId' in n)));
  assert.match(ob.evidenceUri, /^braiwser:\/\//);
  const receipt = await h.ok('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: 'op_1', action: { kind: 'click', ref: 'r_save' } });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.dispatched, true);
  assert.equal(receipt.effectUnknown, false);
  assert.equal(receipt.operationId, 'op_1');
  await h.close();
});

test('malformed input is rejected before the broker is touched', async () => {
  const { broker, h, page } = await setup();
  const before = broker.state.calls.length;
  const cases = [
    ['browser_observe', { ...page, extra: 1 }],
    ['browser_observe', { sessionId: page.sessionId }],
    ['browser_observe', { ...page, maxNodes: 9999 }],
    ['browser_observe', { sessionId: '../etc/passwd', pageId: page.pageId }],
    ['browser_act', { ...page, observationId: 'o', documentEpoch: -1, operationId: 'op', action: { kind: 'click', ref: 'r' } }],
    ['browser_session_open', { driver: 'chrome', mode: 'headless' }],
    ['browser_run_status', { runId: 'run_1', maxEvents: 5000 }],
    ['browser_handoff', { ...page, reason: '' }],
  ];
  for (const [name, args] of cases) {
    const r = await h.fail(name, args);
    assert.match(r.content[0].text, /validation|Invalid/i, name);
  }
  assert.equal(broker.state.calls.length, before, 'no malformed call may reach the broker');
  await h.close();
});

test('unknown operation kinds and smuggled flags fail closed', async () => {
  const { broker, h, page } = await setup();
  const ob = await h.ok('browser_observe', page);
  const base = { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch };
  const before = broker.state.calls.length;
  for (const action of [
    { kind: 'evaluate', script: 'document.cookie' },
    { kind: 'click', ref: 'r_save', force: true },
    { kind: 'click', selector: '#save' },
    { kind: 'fill', ref: 'r_pw', text: 'x', secret: true },
    { kind: 'fill', ref: 'r_pw', secretRef: 'vault:1' },
    { kind: 'navigate', url: 'file:///etc/passwd' },
    { kind: 'navigate', url: 'javascript:alert(1)' },
    { kind: 'navigate', url: 'https://user:pass@example.test/' },
    { kind: 'press', ref: 'r_save', key: 'Control+A' },
    { kind: 'upload', ref: 'r_save', path: 'C:/secrets.txt' },
  ]) {
    await h.fail('browser_act', { ...base, operationId: 'op_x', action });
  }
  assert.equal(broker.state.calls.length, before);
  await h.close();
});

test('secret canaries never appear in tool output, errors or diagnostics', async () => {
  const CANARY = 'CANARY-p@ssw0rd-7731';
  const events = [];
  const { broker, h, page } = await setup({ log: (e) => events.push(e) });
  const ob = await h.ok('browser_observe', page);
  const r = await h.call('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: 'op_pw', action: { kind: 'fill', ref: 'r_pw', text: CANARY } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'DENIED');
  assert.equal(r.structuredContent.error.dispatched, false);
  assert.ok(!JSON.stringify(r).includes(CANARY));
  assert.ok(!JSON.stringify(events).includes(CANARY));
  // A successful non-secret fill does not echo the typed text back either.
  const ok = await h.ok('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: 'op_name', action: { kind: 'fill', ref: 'r_name', text: CANARY } });
  assert.ok(!JSON.stringify(ok).includes(CANARY));
  assert.ok(!JSON.stringify(events).includes(CANARY));
  void broker;
  await h.close();
});

test('stale document, stale ref and ambiguous targets surface typed retry guidance, never a silent retarget', async () => {
  const { h, page } = await setup();
  const ob = await h.ok('browser_observe', page);
  const act = (extra) => h.call('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: `op_${Math.random().toString(36).slice(2, 8)}`, action: { kind: 'click', ref: 'r_save' }, ...extra });
  const dup = await act({ action: { kind: 'click', ref: 'r_dup1' } });
  assert.equal(dup.structuredContent.error.code, 'AMBIGUOUS_TARGET');
  assert.equal(dup.structuredContent.error.retry, 'refresh');
  const unknown = await act({ action: { kind: 'click', ref: 'r_gone' } });
  assert.equal(unknown.structuredContent.error.code, 'STALE_REF');
  const first = await act({});                       // click bumps the epoch
  assert.equal(first.structuredContent.ok, true);
  const stale = await act({});
  assert.equal(stale.structuredContent.error.code, 'STALE_REF');
  assert.equal(stale.structuredContent.error.dispatched, false);
  assert.equal(stale.structuredContent.error.retry, 'refresh');
  await h.close();
});

test('dispatch-only and uncertain receipts keep effectUnknown true', async () => {
  const { h, page } = await setup();
  const ob = await h.ok('browser_observe', page);
  const base = { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch };
  const maybe = await h.ok('browser_act', { ...base, operationId: 'op_pay', action: { kind: 'click', ref: 'r_maybe' } });
  assert.equal(maybe.status, 'uncertain');
  assert.equal(maybe.effectUnknown, true);
  const ob2 = await h.ok('browser_observe', page);
  const plain = await h.ok('browser_act', { ...page, observationId: ob2.observationId, documentEpoch: ob2.documentEpoch,
    operationId: 'op_docs', action: { kind: 'click', ref: 'r_plain' } });
  assert.equal(plain.status, 'dispatched');
  assert.equal(plain.effectUnknown, true);
  await h.close();
});

test('a receipt that does not bind to the request scope is reported as an uncertain error, not a pass', async () => {
  const { broker, h, page } = await setup();
  const ob = await h.ok('browser_observe', page);
  const realFor = broker.forPrincipal;
  broker.forPrincipal = (p) => { const f = realFor(p); const act = f.act; f.act = async (a, c) => ({ ...(await act(a, c)), operationId: 'someone_elses' }); return f; };
  const h2 = await connect(broker, P('mcp:a'));
  const r = await h2.call('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: 'op_scope', action: { kind: 'click', ref: 'r_save' } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.dispatched, true);
  assert.equal(r.structuredContent.error.effectUnknown, true);
  assert.equal(r.structuredContent.error.retry, 'never');
  await h.close(); await h2.close();
});

test('cross-owner access is denied for sessions, runs, cancel and resources; unknown ids look identical', async () => {
  const broker = createFakeBroker();
  const a = await connect(broker, P('mcp:a'));
  const b = await connect(broker, P('mcp:b'));
  const opened = await openPage(a);
  const page = { sessionId: opened.sessionId, pageId: opened.pageId };
  const run = await startRun(a, page);

  const foreignObserve = await b.call('browser_observe', page);
  const missingObserve = await b.call('browser_observe', { sessionId: 'bs_999', pageId: 'pg_999' });
  assert.equal(foreignObserve.structuredContent.error.code, 'DENIED');
  assert.deepEqual(foreignObserve.structuredContent.error, missingObserve.structuredContent.error, 'no existence oracle');

  assert.equal((await b.call('browser_run_status', { runId: run.runId })).structuredContent.error.code, 'DENIED');
  assert.equal((await b.call('browser_run_cancel', { runId: run.runId })).structuredContent.error.code, 'DENIED');
  assert.equal((await b.call('browser_handoff', { ...page, reason: 'x' })).structuredContent.error.code, 'DENIED');
  assert.equal((await b.call('browser_run', { ...page, requestKey: 'k', skillId: 'verify-journey', skillVersion: '1.0.0',
    inputs: { recordingId: 'rec_1' } })).structuredContent.error.code, 'DENIED');

  await assert.rejects(() => b.client.readResource({ uri: run.manifestUri }), /not available/i);
  await assert.rejects(() => b.client.readResource({ uri: 'braiwser://runs/run_nope/manifest' }), /not available/i);
  const own = await a.client.readResource({ uri: run.manifestUri });
  assert.equal(JSON.parse(own.contents[0].text).runId, run.runId);
  // The owner's run is untouched by B's attempts.
  assert.equal((await a.ok('browser_run_status', { runId: run.runId })).state, 'queued');
  await a.close(); await b.close();
});

test('browser_run: pinned start, requestKey recovery and conflicts; pin failures never reach the broker', async () => {
  const { broker, h, page } = await setup();
  const first = await startRun(h, page);
  assert.equal(first.state, 'queued');
  assert.equal(first.verdict, 'pending');
  assert.equal(first.executed, 0);
  assert.equal(first.pending, 3);
  const again = await startRun(h, page);
  assert.equal(again.runId, first.runId, 'same requestKey + inputs recovers the run');
  const conflict = await h.call('browser_run', { ...page, requestKey: 'rk1', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_2' } });
  assert.equal(conflict.structuredContent.error.code, 'DENIED');

  const startRuns = () => broker.state.calls.filter((c) => c.name === 'startRun').length;
  const baseline = startRuns();
  const digest = registry.resolve({ skillId: 'verify-journey', skillVersion: '1.0.0' }).digest;
  const cases = [
    [{ skillVersion: '9.9.9' }, 'UNSUPPORTED'],
    [{ skillId: 'does-not-exist' }, 'UNSUPPORTED'],
    [{ skillDigest: `sha256:${'0'.repeat(64)}` }, 'DENIED'],
    [{ skillId: 'extract-table', skillVersion: '1.0.0', inputs: {} }, 'UNSUPPORTED'],
    [{ inputs: { recordingId: 'rec_1', evil: 'x' } }, 'UNSUPPORTED'],
    [{ inputs: { recordingId: '../../x' } }, 'UNSUPPORTED'],
  ];
  for (const [extra, code] of cases) {
    const r = await h.call('browser_run', { ...page, requestKey: 'rk-pin', skillId: 'verify-journey', skillVersion: '1.0.0',
      inputs: { recordingId: 'rec_1' }, ...extra });
    assert.equal(r.structuredContent.error.code, code, JSON.stringify(extra));
    assert.equal(r.structuredContent.error.dispatched, false);
  }
  assert.equal(startRuns(), baseline, 'blocked starts never reach the broker');
  // The correct digest is accepted.
  assert.equal((await startRun(h, page, { requestKey: 'rk-ok', skillDigest: digest })).state, 'queued');
  await h.close();
});

test('proof contract: only a fully proven run may be reported as passed', async () => {
  const { broker, h, page } = await setup();
  const fresh = async (key) => startRun(h, page, { requestKey: key });

  // 1. cancelled green prefix: cancel reason survives, steps stay pending, never a pass
  let run = await fresh('k-cancel');
  broker.finish(run.runId, { state: 'cancelled', results: proof(['s1', 's2']).slice(0, 2), evidenceComplete: true });
  let s = await h.ok('browser_run_status', { runId: run.runId });
  assert.equal(s.state, 'cancelled'); assert.equal(s.verdict, 'cancelled'); assert.equal(s.pending, 1);

  // 2. state=passed but evidence manifest incomplete -> refused, not relayed
  run = await fresh('k-noevidence');
  broker.finish(run.runId, { state: 'passed', results: proof(), evidenceComplete: false });
  let r = await h.call('browser_run_status', { runId: run.runId });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'INTERNAL');
  assert.equal(r.structuredContent.error.effectUnknown, true);

  // 3. uncertain effect -> unknown, never passed
  run = await fresh('k-uncertain');
  broker.finish(run.runId, { state: 'uncertain', results: [{ stepId: 's1', status: 'passed', effect: 'unknown', evidenceIds: ['e'] }] });
  s = await h.ok('browser_run_status', { runId: run.runId });
  assert.equal(s.verdict, 'unknown'); assert.equal(s.uncertainEffect, true);

  // 4. a failed step beats a green prefix
  run = await fresh('k-failed');
  broker.finish(run.runId, { state: 'failed', results: [proof()[0], { stepId: 's2', status: 'failed', effect: 'confirmed', evidenceIds: ['e'] }] });
  s = await h.ok('browser_run_status', { runId: run.runId });
  assert.equal(s.verdict, 'failed'); assert.equal(s.failed, 1);

  // 5. zero required assertions can never establish a pass
  run = await fresh('k-noassert');
  broker.run(run.runId).assertionIds = [];
  broker.finish(run.runId, { state: 'passed', results: proof(), evidenceComplete: true });
  r = await h.call('browser_run_status', { runId: run.runId });
  assert.equal(r.isError, true, 'passed with zero assertions is not relayed');

  // 6. full proof passes
  run = await fresh('k-good');
  broker.finish(run.runId, { state: 'passed', results: proof(), evidenceComplete: true });
  s = await h.ok('browser_run_status', { runId: run.runId });
  assert.equal(s.state, 'passed'); assert.equal(s.verdict, 'passed');
  assert.equal(s.requiredAssertions, 1); assert.equal(s.passedAssertions, 1);
  assert.equal(s.executed, s.planned); assert.equal(s.pending, 0);

  // 7. a broker that lies (passed without proof) is not believed
  broker.state.corrupt = 'passed-without-proof';
  r = await h.call('browser_run_status', { runId: run.runId });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'INTERNAL');
  broker.state.corrupt = null;
  await h.close();
});

test('unknown broker fields are projected away, not forwarded', async () => {
  const { broker, h, page } = await setup();
  const run = await startRun(h, page);
  broker.state.corrupt = 'extra-field';
  const s = await h.ok('browser_run_status', { runId: run.runId });
  assert.ok(!('internalDebug' in s));
  assert.ok(!JSON.stringify(s).includes('LEAK'));
  await h.close();
});

test('status paging: bounded events, monotonic nextSequence', async () => {
  const { broker, h, page } = await setup();
  const run = await startRun(h, page);
  const r = broker.run(run.runId);
  for (let i = 0; i < 12; i += 1) r.events.push({ sequence: r.events.length + 1, kind: 'step', summary: `step ${i}`, stepId: 's1' });
  const one = await h.ok('browser_run_status', { runId: run.runId, afterSequence: 0, maxEvents: 5 });
  assert.equal(one.events.length, 5);
  const two = await h.ok('browser_run_status', { runId: run.runId, afterSequence: one.nextSequence, maxEvents: 5 });
  assert.equal(two.events[0].sequence, one.nextSequence + 1);
  assert.ok(two.nextSequence > one.nextSequence);
  await h.close();
});

test('cancel before dispatch records the request and the terminal reason; it is not rollback', async () => {
  const { h, page } = await setup();
  const run = await startRun(h, page);
  const c = await h.ok('browser_run_cancel', { runId: run.runId });
  assert.equal(c.cancelRequested, true);
  assert.equal(c.state, 'cancelled');
  assert.equal(c.verdict, 'cancelled');
  assert.equal(c.executed, 0);
  assert.ok(c.pending > 0);
  const again = await h.ok('browser_run_cancel', { runId: run.runId });
  assert.equal(again.state, 'cancelled', 'cancel is idempotent');
  await h.close();
});

test('client cancellation of a tool call reaches the broker as an aborted signal', async () => {
  const { broker, h, page } = await setup();
  let sawAbort;
  const aborted = new Promise((resolve) => { sawAbort = resolve; });
  broker.state.hold = (ctx) => new Promise((_res, rej) => {
    ctx.signal.addEventListener('abort', () => { sawAbort(true); rej(Object.assign(new Error('x'), { name: 'AbortError' })); });
  });
  const controller = new AbortController();
  const pending = h.client.callTool({ name: 'browser_observe', arguments: page }, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);
  assert.equal(await Promise.race([aborted, new Promise((r) => setTimeout(() => r(false), 2000))]), true);
  await h.close();
});

test('handoff reports the supported method with fixed user guidance', async () => {
  for (const [method, expect] of [['native', /Take control/], ['remote-view', /remote view/], ['checkpoint-relaunch', /relaunch/], ['unsupported', /cannot be handed/]]) {
    const { h, page } = await setup({}, { handoff: method });
    const r = await h.ok('browser_handoff', { ...page, reason: 'captcha' });
    assert.equal(r.method, method);
    assert.match(r.userAction, expect);
    assert.equal(r.owner, 'paused');
    await h.close();
  }
  // An unrecognised method from a broker clamps to unsupported rather than inventing capability.
  const { h, page } = await setup({}, { handoff: 'teleport' });
  assert.equal((await h.ok('browser_handoff', { ...page, reason: 'x' })).method, 'unsupported');
  await h.close();
});

test('extract returns values with source refs and explicit missing / ambiguous markers', async () => {
  const { h, page } = await setup();
  const r = await h.ok('browser_extract', { ...page, fields: [
    { name: 'save', target: { by: 'role', role: 'button', name: 'Save' } },
    { name: 'dup', target: { by: 'role', role: 'button', name: 'Delete' } },
    { name: 'ghost', target: { by: 'role', role: 'heading', name: 'Nope' } },
    { name: 'byRef', target: { by: 'ref', ref: 'r_name' }, required: false },
  ] });
  const f = Object.fromEntries(r.fields.map((x) => [x.name, x]));
  assert.equal(f.save.status, 'found'); assert.equal(f.save.value, 'Save'); assert.equal(f.save.source.ref, 'r_save');
  assert.equal(f.dup.status, 'ambiguous'); assert.equal(f.dup.value, null);
  assert.equal(f.ghost.status, 'missing'); assert.equal(f.ghost.reason, 'NOT_FOUND');
  assert.equal(f.byRef.value, 'Display name'); assert.equal(f.byRef.required, false);
  assert.equal(r.complete, false);
  assert.equal(r.trust, 'untrusted-page');
  await h.close();
});

test('extract: truncated observations say so, and a stale epoch is refused', async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ refId: `r_${i}`, role: 'row', name: `Row ${i}` }));
  const { h, page } = await setup({}, { nodes: many, pageSize: 200 });
  const r = await h.ok('browser_extract', { ...page, fields: [{ name: 'late', target: { by: 'role', role: 'row', name: 'Row 449' } },
    { name: 'none', target: { by: 'role', role: 'row', name: 'Row 9999' } }] });
  const f = Object.fromEntries(r.fields.map((x) => [x.name, x]));
  assert.equal(f.late.status, 'found', 'three cursor hops cover 450 nodes');
  assert.equal(f.none.reason, 'NOT_FOUND', 'a fully read observation is a real absence');
  await h.close();
  const lots = Array.from({ length: 700 }, (_, i) => ({ refId: `r_${i}`, role: 'row', name: `Row ${i}` }));
  const s = await setup({}, { nodes: lots, pageSize: 100 });
  const t = await s.h.ok('browser_extract', { ...s.page, fields: [{ name: 'none', target: { by: 'role', role: 'row', name: 'Row 9999' } }] });
  assert.equal(t.truncated, true, '700 nodes at 100/page exceed the five-hop bound');
  assert.equal(t.fields[0].reason, 'NOT_FOUND_OBSERVATION_TRUNCATED');
  const stale = await s.h.call('browser_extract', { ...s.page, documentEpoch: 99, fields: [{ name: 'x', target: { by: 'ref', ref: 'r_1' } }] });
  assert.equal(stale.structuredContent.error.code, 'STALE_REF');
  await s.h.close();
});

test('response budget: observation nodes and run events are cut with explicit truncation, never silently', async () => {
  const wide = Array.from({ length: 200 }, (_, i) => ({ refId: `r_${i}`, role: 'link', name: `Link ${i} ${'x'.repeat(150)}` }));
  const { h, page } = await setup({ responseBudget: 8 * 1024 }, { nodes: wide });
  const ob = await h.ok('browser_observe', { ...page, maxNodes: 200 });
  assert.ok(ob.nodes.length < 200);
  assert.equal(ob.truncated, true);
  assert.ok(ob.coverage.nodesOmittedForBudget > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(ob)) <= 8 * 1024);
  await h.close();

  const s = await setup({ responseBudget: 3 * 1024 });
  const run = await startRun(s.h, s.page);
  const r = s.broker.run(run.runId);
  for (let i = 0; i < 40; i += 1) r.events.push({ sequence: r.events.length + 1, kind: 'step', summary: 'y'.repeat(250) });
  const status = await s.h.ok('browser_run_status', { runId: run.runId, maxEvents: 40 });
  assert.ok(status.events.length < 40);
  assert.equal(status.nextSequence, status.events[status.events.length - 1].sequence, 'cursor is the last consumed event');
  const following = await s.h.ok('browser_run_status', { runId: run.runId, afterSequence: status.nextSequence, maxEvents: 40 });
  assert.equal(following.events[0].sequence, status.nextSequence + 1, 'dropped events remain reachable without a gap');
  await s.h.close();
});

test('page-controlled fields are bounded and the URL carries no credentials or token values', async () => {
  const nodes = [{ refId: 'r_1', role: 'button', name: 'N'.repeat(5000) }];
  const { h, page } = await setup({}, { nodes });
  const ob = await h.ok('browser_observe', page);
  assert.equal(ob.nodes[0].name.length, 200);
  assert.equal(ob.coverage.labelsTruncated, 1);
  assert.ok(!ob.url.includes('PAGE_TOKEN'));
  assert.match(ob.url, /token=%5Bredacted%5D|token=\[redacted\]/);
  await h.close();
});

test('schema version: unsupported major is rejected, supported or absent is accepted', async () => {
  assert.deepEqual(checkSchemaVersion(undefined), { ok: true });
  assert.equal(checkSchemaVersion({ 'braiwser/schemaVersion': 1 }).ok, true);
  assert.equal(checkSchemaVersion({ 'braiwser/schemaVersion': '1.4' }).ok, true);
  assert.equal(checkSchemaVersion({ 'braiwser/schemaVersion': 2 }).ok, false);
  assert.equal(checkSchemaVersion({ 'braiwser/schemaVersion': 'latest' }).ok, false);
  const { broker, h, page } = await setup();
  const before = broker.state.calls.length;
  const r = await h.client.callTool({ name: 'browser_observe', arguments: page, _meta: { 'braiwser/schemaVersion': 2 } });
  assert.equal(r.structuredContent.error.code, 'UNSUPPORTED');
  assert.equal(broker.state.calls.length, before);
  const good = await h.client.callTool({ name: 'browser_observe', arguments: page, _meta: { 'braiwser/schemaVersion': 1 } });
  assert.equal(good.structuredContent.ok, true);
  await assert.rejects(() => h.client.readResource({ uri: 'braiwser://capabilities', _meta: { 'braiwser/schemaVersion': 3 } }), /Unsupported schema version/);
  await h.close();
});

test('resources: capabilities and catalog are readable; manifest redacts sensitive keys; reads never mutate', async () => {
  const { broker, h, page } = await setup();
  const run = await startRun(h, page);
  const caps = JSON.parse((await h.client.readResource({ uri: 'braiwser://capabilities' })).contents[0].text);
  assert.equal(caps.schemaVersion, 1);
  assert.equal(caps.tools.length, 12);
  assert.ok(caps.skills.some((s) => s.id === 'verify-journey' && /^sha256:/.test(s.digest)));
  assert.ok(caps.guarantees.length >= 3);
  const catalog = JSON.parse((await h.client.readResource({ uri: 'braiwser://skills/catalog' })).contents[0].text);
  assert.ok(catalog.skills.every((s) => typeof s.digest === 'string'));
  const callsBefore = broker.state.calls.filter((c) => c.name !== 'readResource').length;
  const manifest = JSON.parse((await h.client.readResource({ uri: run.manifestUri })).contents[0].text);
  assert.equal(manifest.password, '[redacted]');
  assert.ok(!JSON.stringify(manifest).includes('CANARY_PW'));
  assert.equal(broker.state.calls.filter((c) => c.name !== 'readResource').length, callsBefore, 'reading a resource triggers no other broker call');
  assert.equal(broker.run(run.runId).state, 'queued');
  const listed = await h.client.listResources();
  assert.ok(listed.resources.some((r) => r.uri === run.manifestUri), 'own run manifests are listed');
  await h.close();
});

test('resource URIs are re-validated; traversal and foreign shapes never reach the broker', async () => {
  const { broker, h } = await setup();
  const before = broker.state.calls.filter((c) => c.name === 'readResource').length;
  for (const uri of ['braiwser://runs/..%2F..%2Fsecrets/manifest', 'braiwser://runs/a b/manifest', 'braiwser://runs/x/manifest/extra',
    'braiwser://files/etc/passwd', 'file:///etc/passwd']) {
    await assert.rejects(() => h.client.readResource({ uri }), undefined, uri);
  }
  assert.equal(broker.state.calls.filter((c) => c.name === 'readResource').length, before);
  await h.close();
});

test('catalog change notifies clients only when it actually changed', async () => {
  const broker = createFakeBroker();
  const reg = registry.createRegistry();
  const h = await connect(broker, P('mcp:a'), { registry: reg });
  let notified = 0;
  h.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { notified += 1; });
  assert.equal(h.server.braiwser.refreshCatalog(), false);
  const files = { 'SKILL.md': '---\nname: extra-skill\ndescription: An imported helper.\nmetadata:\n  version: "1.0.0"\n---\nHello\n' };
  reg.registerImported(reg.inspectPackage(files), { id: 'ui:main', kind: 'ui', scopes: [] });
  assert.equal(h.server.braiwser.refreshCatalog(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notified, 1);
  assert.equal(h.server.braiwser.refreshCatalog(), false);
  await h.close();
});

test('the global broker cannot be served without a principal', () => {
  const broker = createFakeBroker();
  assert.throws(() => createMcpServer(broker), /principal-bound/);
  assert.doesNotThrow(() => createMcpServer(broker, { principal: P('mcp:a') }));
});

test('summary text mode keeps the full result in structuredContent', async () => {
  const { h, page } = await setup({ textMode: 'summary' });
  const r = await h.call('browser_observe', page);
  assert.match(r.content[0].text, /^browser_observe ok /);
  assert.ok(!r.content[0].text.includes('"nodes"'));
  assert.equal(r.structuredContent.ok, true);
  await h.close();
});

test('session open sends a grant REQUEST; self-granted privileges are not expressible', async () => {
  const broker = createFakeBroker();
  const h = await connect(broker, P('mcp:a'));
  const before = broker.state.calls.length;
  const base = { driver: 'playwright', mode: 'headless' };
  // a grant is mandatory, and the request vocabulary is closed
  await h.fail('browser_session_open', base);
  for (const grant of [
    { allowedOrigins: ['https://app.test'], trustedFixture: true },
    { allowedOrigins: ['https://app.test'], allowedRoots: ['C:/'] },
    { allowedOrigins: ['https://app.test'], toolClasses: ['credentials'] },
    { allowedOrigins: ['https://app.test'], toolClasses: ['upload'] },
    { allowedOrigins: ['file:///etc'] },
    { allowedOrigins: ['https://app.test/path'] },
    { all: true },
  ]) await h.fail('browser_session_open', { ...base, grant });
  await h.fail('browser_session_open', { ...base, grant: { allowedOrigins: ['https://app.test'] }, approved: true });
  assert.equal(broker.state.calls.length, before, 'invalid requests never reach the broker');
  // a request outside the client's scope is the broker's call: DENIED, nothing opened
  const denied = await h.call('browser_session_open', { ...base, grant: { allowedOrigins: ['https://other.test'] } });
  assert.equal(denied.structuredContent.error.code, 'DENIED');
  const ok = await h.call('browser_session_open', { ...base, profile: 'qa', grant: { allowedOrigins: ['https://app.test'], toolClasses: ['observe'] } });
  assert.equal(ok.structuredContent.ok, true);
  const sent = broker.state.calls.filter((c) => c.name === 'openSession').at(-1).args;
  assert.deepEqual(sent.grant, { allowedOrigins: ['https://app.test'], toolClasses: ['observe'], profile: 'qa' }, 'the profile travels inside the grant too');
  await h.close();
  void PAGE_NODES;
});
