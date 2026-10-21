'use strict';
// Owner-initiated watch and takeover through the trusted-proxy gateway mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./harness');
const { createViewerGateway } = require('../../src/main/services/browser/viewer-gateway');

const TOKEN = 'proxy-secret-'.padEnd(48, 'x');
const VIEWER = 'viewer-instance-0123456789';

async function world(t, { proxy = { allowedHosts: [] } } = {}) {
  const h = boot();
  const gateway = createViewerGateway({ broker: h.broker, host: '127.0.0.1', port: 0, proxy,
    owner: { token: TOKEN, id: 'human-owner', principalId: h.agentP.id } });
  const origin = await gateway.listen();
  t.after(async () => { await gateway.close(); await h.broker.close(); });
  const call = async (method, path, body, token = TOKEN) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json()) };
  };
  return { h, gateway, origin, call };
}

test('proxy mode is only available with a strong owner secret and an explicit proxy option', async () => {
  const { boot: rawBoot } = require('./harness');
  const h = rawBoot();
  assert.throws(() => createViewerGateway({ broker: h.broker, host: '0.0.0.0' }), /loopback host required/);
  assert.throws(() => createViewerGateway({ broker: h.broker, host: '127.0.0.1', proxy: {}, owner: { token: 'short', id: 'o', principalId: 'agent' } }), /strong owner token/);
  await h.broker.close();
});

test('proxy routes need the bearer secret and are absent without proxy mode', async (t) => {
  const { h, call, gateway, origin } = await world(t);
  const s = await h.open();
  assert.equal((await call('GET', `/proxy/v1/sessions/${s.sessionId}`, undefined, null)).status, 401);
  assert.equal((await call('GET', `/proxy/v1/sessions/${s.sessionId}`, undefined, 'wrong'.padEnd(48, 'y'))).status, 401);
  assert.equal((await call('GET', `/proxy/v1/sessions/${s.sessionId}`)).status, 200);
  const plain = createViewerGateway({ broker: h.broker, port: 0 });
  const base = await plain.listen();
  t.after(() => plain.close());
  const res = await fetch(`${base}/proxy/v1/sessions/${s.sessionId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.notEqual(res.status, 200);
  assert.ok(origin && gateway);
});

test('watching is read-only and available without any handoff; another principal is invisible', async (t) => {
  const { h, call } = await world(t);
  const mine = await h.open();
  const foreign = await h.open(h.o);
  const status = await call('GET', `/proxy/v1/sessions/${mine.sessionId}`);
  assert.equal(status.value.controlOwner, 'agent');
  assert.equal(status.value.handoff, null);
  const frame = await call('GET', `/proxy/v1/sessions/${mine.sessionId}/frame?pageId=${mine.pageId}`);
  assert.equal(frame.value.fresh, true);
  assert.equal(frame.value.controlOwner, 'agent');
  // The agent keeps control while a person only watches.
  await h.a.observe({ sessionId: mine.sessionId, pageId: mine.pageId });
  assert.equal((await call('GET', `/proxy/v1/sessions/${foreign.sessionId}`)).status, 401);
  assert.equal((await call('GET', `/proxy/v1/sessions/${mine.sessionId}/frame?pageId=nope`)).status, 401);
});

test('private input withholds the watch frame', async (t) => {
  const { h, call } = await world(t);
  const s = await h.open();
  h.broker._internals.sessions.get(s.sessionId).privateInput = true;
  const frame = await call('GET', `/proxy/v1/sessions/${s.sessionId}/frame?pageId=${s.pageId}`);
  assert.equal(frame.value.withheld, true);
  assert.equal(frame.value.image, null);
  assert.equal(frame.value.fresh, false);
});

test('owner takeover pauses the agent, relays input, then returns the same session to the agent', async (t) => {
  const { h, call } = await world(t);
  const s = await h.open();
  const session = h.broker._internals.sessions.get(s.sessionId);
  const dispatched = [];
  session.page(s.pageId).driverPage.humanInput = async (input) => { dispatched.push(input); return { dispatched: true }; };

  const taken = await call('POST', `/proxy/v1/sessions/${s.sessionId}/takeover`, { pageId: s.pageId, viewerInstanceId: VIEWER, requestKey: 'take-1' });
  assert.equal(taken.status, 200, JSON.stringify(taken));
  assert.equal(taken.value.controlOwner, 'human');
  assert.equal(taken.value.reasonCode, 'userRequested');
  const handoffId = taken.value.handoffId;

  // A repeated takeover from the same viewer reuses the live episode.
  const again = await call('POST', `/proxy/v1/sessions/${s.sessionId}/takeover`, { pageId: s.pageId, viewerInstanceId: VIEWER, requestKey: 'take-2' });
  assert.equal(again.value.handoffId, handoffId);
  // The agent is fenced out while the person is in control.
  await assert.rejects(() => h.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: 1, operationId: 'blocked',
    action: { kind: 'navigate', url: 'https://app.test/' } }));

  const frame = await call('GET', `/proxy/v1/handoffs/${handoffId}/frame`);
  assert.equal(frame.value.fresh, true);
  const input = await call('POST', `/proxy/v1/handoffs/${handoffId}/input`, { viewerInstanceId: VIEWER,
    requestKey: 'in-1', expectedControlEpoch: frame.value.controlEpoch, controlEpoch: frame.value.controlEpoch,
    frameSequence: frame.value.sequence, documentEpoch: frame.value.documentEpoch, kind: 'click', x: 1, y: 1 });
  assert.equal(input.status, 200, JSON.stringify(input));
  assert.equal(dispatched.length, 1);

  const epoch = (await call('GET', `/proxy/v1/handoffs/${handoffId}`)).value.controlEpoch;
  const resumed = await call('POST', `/proxy/v1/handoffs/${handoffId}/resume`, { viewerInstanceId: VIEWER,
    requestKey: 'back-1', expectedControlEpoch: epoch });
  assert.equal(resumed.status, 200, JSON.stringify(resumed));
  assert.equal(resumed.value.controlOwner, 'agent');
  const obs = await h.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  assert.ok(obs.observationId, 'the agent continues on the same session after a fresh observation');
});

test('the heartbeat releases human control when the relay stops polling', async (t) => {
  const h = boot();
  const gateway = createViewerGateway({ broker: h.broker, host: '127.0.0.1', port: 0, heartbeatMs: 60, proxy: { allowedHosts: [] },
    owner: { token: TOKEN, id: 'human-owner', principalId: h.agentP.id } });
  const origin = await gateway.listen();
  t.after(async () => { await gateway.close(); await h.broker.close(); });
  const s = await h.open();
  const res = await fetch(`${origin}/proxy/v1/sessions/${s.sessionId}/takeover`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ pageId: s.pageId, viewerInstanceId: VIEWER, requestKey: 'hb' }) });
  assert.equal((await res.json()).value.controlOwner, 'human');
  await new Promise((r) => setTimeout(r, 400));
  const session = h.broker._internals.sessions.get(s.sessionId);
  assert.equal(session.lease.owner, 'paused', 'idle relay leaves the browser paused, never silently agent-controlled');
});
