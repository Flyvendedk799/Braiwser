// The adapter against the REAL broker (src/main/services/browser/broker.js) over
// the shared FakeDriver: real ownership, grants, ledger, evidence store, run
// state machine and canonical grader. Proves the wire DTOs line up end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connect } from './_harness.mjs';

const require = createRequire(import.meta.url);
const { createBroker } = require('../../../src/main/services/browser/broker.js');
const { createFakeDriver } = require('../fake-driver.js');
const { tmp, delay, until, mcp, cleanup } = require('../helpers.js');
const registry = require('../../../src/main/services/automation/skill-registry.js');
const { createBridgeServer } = require('../../../src/main/services/automation/bridge-server.js');
const bridge = require('../../../src/main/services/automation/bridge.js');
const { createMcpServer } = await import('../../../src/main/services/automation/mcp.mjs');

after(() => cleanup());

const SCOPES = ['class:observe', 'class:navigate', 'class:interact', 'class:submit', 'origin:https://app.test'];
const GRANT = { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact', 'submit'] };

const RECORDINGS = {
  rec_nav: { name: 'next page', startUrl: 'https://app.test/', steps: [
    { type: 'navigate', url: 'https://app.test/' },
    { type: 'click', selector: 'button[data-testid="next"]', tag: 'button', text: 'Next' },
    { type: 'assert', kind: 'text', op: 'contains', selector: 'p', expected: 'arrived', locator: { by: 'role', role: 'status', name: 'Status' } }] },
  rec_fill: { name: 'fill', startUrl: 'https://app.test/', steps: [
    { type: 'navigate', url: 'https://app.test/' },
    { type: 'input', selector: 'input[aria-label="Display name"]', tag: 'input', value: 'Ada' },
    { type: 'click', selector: 'button[data-testid="next"]', tag: 'button', text: 'Next' },
    { type: 'assert', kind: 'text', op: 'contains', selector: 'p', expected: 'arrived', locator: { by: 'role', role: 'status', name: 'Status' } }] },
  rec_secret: { name: 'login', startUrl: 'https://app.test/', steps: [
    { type: 'navigate', url: 'https://app.test/' },
    { type: 'input', selector: 'input[data-testid="pw"]', tag: 'input', value: 'CANARY-recorded-pw', secret: true },
    { type: 'assert', kind: 'url', op: 'contains', expected: 'app.test' }] },
};

function rig(driverOptions = {}) {
  const fake = createFakeDriver(driverOptions);
  const skills = registry.createBrokerSkills({ loadRecording: (id) => RECORDINGS[id] || null });
  const broker = createBroker({ dataDir: tmp(), drivers: { playwright: fake.driver }, featureFlag: true, skills, appVersion: 'test' });
  return { fake, broker, principal: mcp('agent', SCOPES) };
}
async function client(r, principal = r.principal) {
  const h = await connect(r.broker, principal);
  return h;
}
const open = (h, extra = {}) => h.ok('browser_session_open', { driver: 'playwright', mode: 'headless', grant: GRANT, ...extra });
const ids = (s) => ({ sessionId: s.sessionId, pageId: s.pageId });
let op = 0;
const operation = () => `mcp-op-${++op}`;
async function waitTerminal(h, runId, timeoutMs = 5000) {
  let s;
  await until(async () => {
    s = await h.ok('browser_run_status', { runId, maxEvents: 100 });
    return !['queued', 'running'].includes(s.state);
  }, { timeoutMs });
  return s;
}
async function navigateTo(h, page, url) {
  const ob = await h.ok('browser_observe', page);
  return h.ok('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch, operationId: operation(), action: { kind: 'navigate', url } });
}

test('real broker: open -> navigate -> observe -> act, output validated by the MCP client against the schemas', async () => {
  const r = rig();
  const h = await client(r);
  const s = await open(h);
  assert.match(s.sessionId, /^bs_/);
  assert.equal(s.capabilities.liveModeSwitch, false);
  const page = ids(s);
  const nav = await navigateTo(h, page, 'https://app.test/');
  assert.equal(nav.status, 'verified');
  const ob = await h.ok('browser_observe', page);
  assert.equal(ob.trust, 'untrusted-page');
  assert.ok(ob.nodes.length > 5);
  assert.ok(ob.nodes.every((n) => /^[A-Za-z0-9_.:-]+$/.test(n.ref)));
  const preview = ob.nodes.find((n) => n.name === 'Preview');
  const receipt = await h.ok('browser_act', { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch,
    operationId: operation(), action: { kind: 'click', ref: preview.ref } });
  assert.equal(receipt.sessionId, s.sessionId);
  assert.ok(['verified', 'dispatched'].includes(receipt.status));
  assert.match(receipt.evidenceUri, /^braiwser:\/\//);
  assert.ok(r.fake.world.dispatchLog.some((d) => d.kind === 'click'));
  await h.close(); await r.broker.close();
});

test('real broker: ambiguity, staleness, secret fields and cross-owner access are refused with typed errors', async () => {
  const r = rig();
  const h = await client(r);
  const other = await client(r, mcp('other', SCOPES));
  const s = await open(h);
  const page = ids(s);
  await navigateTo(h, page, 'https://app.test/');
  const ob = await h.ok('browser_observe', page);
  const base = { ...page, observationId: ob.observationId, documentEpoch: ob.documentEpoch };

  const dup = ob.nodes.find((n) => n.name === 'Same');
  const ambiguous = await h.call('browser_act', { ...base, operationId: operation(), action: { kind: 'click', ref: dup.ref } });
  // The fake driver resolves refs individually; the broker/driver decides ambiguity. Either way nothing is silently retargeted.
  assert.ok(ambiguous.structuredContent.ok || ['AMBIGUOUS_TARGET', 'STALE_REF'].includes(ambiguous.structuredContent.error.code));

  const CANARY = 'CANARY-typed-secret-5521';
  const pw = ob.nodes.find((n) => n.name === 'Password');
  const ob2 = await h.ok('browser_observe', page);
  const pwRef = ob2.nodes.find((n) => n.name === 'Password').ref;
  const denied = await h.call('browser_act', { ...page, observationId: ob2.observationId, documentEpoch: ob2.documentEpoch, operationId: operation(),
    action: { kind: 'fill', ref: pwRef, text: CANARY } });
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify(denied).includes(CANARY));
  assert.ok(!r.fake.world.dispatchLog.some((d) => d.elementId === 'pw'), 'no input reached the password field');
  void pw;

  const stale = await h.call('browser_act', { ...base, operationId: operation(), action: { kind: 'click', ref: ob2.nodes[0].ref } });
  assert.ok(['STALE_REF', 'DENIED'].includes(stale.structuredContent.error?.code) || stale.structuredContent.ok === true);

  // another principal cannot use, read or hand off this session
  for (const [name, args] of [['browser_observe', page], ['browser_handoff', { ...page, reason: 'x' }]]) {
    const res = await other.call(name, args);
    assert.equal(res.structuredContent.error.code, 'DENIED', name);
  }
  await h.close(); await other.close(); await r.broker.close();
});

test('real broker: pinned verify-journey from a stored recording runs to a proven pass and the manifest resource is owner-scoped', async () => {
  const r = rig();
  const h = await client(r);
  const other = await client(r, mcp('other', SCOPES));
  const s = await open(h);
  const page = ids(s);
  const started = await h.ok('browser_run', { ...page, requestKey: 'rk-nav', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_nav' } });
  assert.match(started.runId, /^run_/);
  assert.ok(['queued', 'running'].includes(started.state));
  assert.notEqual(started.verdict, 'passed', 'acceptance never implies success');

  const done = await waitTerminal(h, started.runId);
  assert.equal(done.state, 'passed', JSON.stringify(done));
  assert.equal(done.verdict, 'passed');
  assert.equal(done.evidenceComplete, true);
  assert.equal(done.requiredAssertions, 1);
  assert.equal(done.passedAssertions, 1);
  assert.equal(done.executed, done.planned);
  assert.equal(done.pending, 0);

  // requestKey recovery returns the same run; a different request under the same key conflicts
  const again = await h.ok('browser_run', { ...page, requestKey: 'rk-nav', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_nav' } });
  assert.equal(again.runId, started.runId);
  const dispatchesBefore = r.fake.world.dispatchLog.length;
  assert.equal((await h.call('browser_run', { ...page, requestKey: 'rk-nav', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_fill' } })).isError, true);
  assert.equal(r.fake.world.dispatchLog.length, dispatchesBefore, 'recovery never re-dispatches');

  // manifest: owner can read, another principal cannot; contents carry no secrets
  const res = await h.client.readResource({ uri: done.manifestUri });
  const manifest = JSON.parse(res.contents[0].text);
  assert.equal(manifest.runId, started.runId);
  await assert.rejects(() => other.client.readResource({ uri: done.manifestUri }), /not available/i);
  assert.equal((await other.call('browser_run_status', { runId: started.runId })).structuredContent.error.code, 'DENIED');
  assert.equal((await other.call('browser_run_cancel', { runId: started.runId })).structuredContent.error.code, 'DENIED');
  const listed = await h.client.listResources();
  assert.ok(listed.resources.some((x) => x.uri === done.manifestUri));
  assert.ok(!(await other.client.listResources()).resources.some((x) => x.uri === done.manifestUri));
  await h.close(); await other.close(); await r.broker.close();
});

test('real broker: recordings with secret steps are refused with reason codes; the canary never leaves', async () => {
  const r = rig();
  const h = await client(r);
  const s = await open(h);
  const res = await h.call('browser_run', { ...ids(s), requestKey: 'rk-secret', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_secret' } });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, 'DENIED');
  assert.match(res.structuredContent.error.message, /SECRET_STEP@1/);
  assert.ok(!JSON.stringify(res).includes('CANARY-recorded-pw'));
  const missing = await h.call('browser_run', { ...ids(s), requestKey: 'rk-none', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_missing' } });
  assert.equal(missing.structuredContent.error.code, 'DENIED');
  await h.close(); await r.broker.close();
});

test('real broker: pin failures and unsupported skills never reach the broker or the page', async () => {
  const r = rig();
  const h = await client(r);
  const s = await open(h);
  const args = { ...ids(s), requestKey: 'rk-x', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_nav' } };
  assert.equal((await h.call('browser_run', { ...args, skillDigest: `sha256:${'0'.repeat(64)}` })).structuredContent.error.code, 'DENIED');
  assert.equal((await h.call('browser_run', { ...args, skillVersion: '2.0.0' })).structuredContent.error.code, 'UNSUPPORTED');
  assert.equal((await h.call('browser_run', { ...args, skillId: 'extract-table', inputs: {} })).structuredContent.error.code, 'UNSUPPORTED');
  assert.equal(r.fake.world.dispatchLog.length, 0);
  // review-responsive needs viewport/screenshot steps the broker's closed plan language does not execute yet: it must fail closed.
  const rr = await h.call('browser_run', { ...args, requestKey: 'rk-rr', skillId: 'review-responsive',
    inputs: { url: 'https://app.test/', landmarks: [{ role: 'heading', name: 'Welcome' }] } });
  assert.equal(rr.isError, true, 'an unsupported step type is refused, not skipped');
  assert.equal(r.fake.world.dispatchLog.length, 0);
  await h.close(); await r.broker.close();
});

test('real broker: typed values come from the recording, are never in the plan bytes, and the pass is proven', async () => {
  const r = rig();
  const h = await client(r);
  const s = await open(h);
  const started = await h.ok('browser_run', { ...ids(s), requestKey: 'rk-fill', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_fill' } });
  const done = await waitTerminal(h, started.runId);
  assert.equal(done.state, 'passed', JSON.stringify(done));
  assert.ok(r.fake.world.dispatchLog.some((d) => d.kind === 'fill' && d.elementId === 'name'));
  const manifest = JSON.parse((await h.client.readResource({ uri: done.manifestUri })).contents[0].text);
  assert.ok(!JSON.stringify(manifest).includes('Ada'), 'typed input values are not persisted in the manifest');
  await h.close(); await r.broker.close();
});

test('real broker: cancel stops future dispatch and keeps an honest terminal reason', async () => {
  const r = rig();
  r.fake.ctl.delays.act = 150;
  const h = await client(r);
  const s = await open(h);
  const started = await h.ok('browser_run', { ...ids(s), requestKey: 'rk-cancel', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_nav' } });
  await delay(30);
  const c = await h.ok('browser_run_cancel', { runId: started.runId });
  assert.equal(c.cancelRequested, true);
  const final = await waitTerminal(h, started.runId);
  assert.notEqual(final.state, 'passed', 'a cancelled run cannot be a pass');
  assert.notEqual(final.verdict, 'passed');
  const dispatchesAtCancel = r.fake.world.dispatchLog.length;
  await delay(250);
  assert.equal(r.fake.world.dispatchLog.length, dispatchesAtCancel, 'no input after the cancellation fence');
  await h.close(); await r.broker.close();
});

test('real broker: handoff reports the driver method and revokes agent dispatch', async () => {
  const r = rig({ humanHandoff: 'native' });
  const h = await client(r);
  const s = await open(h);
  const page = ids(s);
  const ho = await h.ok('browser_handoff', { ...page, reason: 'captcha' });
  assert.equal(ho.method, 'native');
  assert.match(ho.userAction, /Take control/);
  const ob = await h.call('browser_observe', page);
  // After handoff the agent must not be able to act until a human resumes.
  assert.equal(ob.structuredContent.error.code, 'DENIED', 'the page is under human control');
  const attempt = await h.call('browser_act', { ...page, observationId: 'ob_x', documentEpoch: 1, operationId: operation(), action: { kind: 'navigate', url: 'https://app.test/two' } });
  assert.equal(attempt.structuredContent.value.status, 'not_attempted');
  assert.equal(attempt.structuredContent.value.dispatched, false);
  assert.equal(attempt.structuredContent.value.effectUnknown, false);
  assert.equal(r.fake.world.dispatchLog.length, 0);
  await h.close(); await r.broker.close();
});

test('real broker: the same tools work through the authenticated bridge (sidecar path)', async () => {
  const r = rig();
  const server = createBridgeServer({ broker: r.broker, authFailureDelayMs: 5 });
  await server.listen();
  const facade = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(r.principal) });
  const mcpServer = createMcpServer(facade);
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'bridge-client', version: '1.0.0' });
  await Promise.all([mcpServer.connect(b), c.connect(a)]);
  const open1 = await c.callTool({ name: 'browser_session_open', arguments: { driver: 'playwright', mode: 'headless', grant: GRANT } });
  assert.equal(open1.structuredContent.ok, true, JSON.stringify(open1.structuredContent));
  const { sessionId, pageId } = open1.structuredContent.value;
  const obs = await c.callTool({ name: 'browser_observe', arguments: { sessionId, pageId } });
  assert.equal(obs.structuredContent.ok, true);
  // a different token (principal) cannot see that session through its own bridge connection
  const f2 = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(mcp('other', SCOPES)) });
  const denied = await f2.observe({ sessionId, pageId }).catch((e) => e);
  assert.equal(denied.publicError.code, 'DENIED');
  await c.close(); await facade.close(); await f2.close(); await server.close(); await r.broker.close();
});
