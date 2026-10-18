'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot } = require('./harness');
const { createViewerGateway } = require('../../src/main/services/browser/viewer-gateway');
const { createHandoffCoordinator } = require('../../src/main/services/browser/handoff-coordinator');
const { doctorReport } = require('../../src/main/services/automation/doctor');

function httpJson(base, method, pathname, { body, headers } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { 'content-type': 'application/json', host: url.host, ...(headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function jarFrom(headers) {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const jar = {};
  for (const line of list) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

test('requestHandoff pauses without acquiring, hides the invitation from a replay, and fences observe', async () => {
  const h = boot();
  const s = await h.open();
  const first = await h.u.requestHandoff({
    sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_pause_1', reasonCode: 'needsHuman',
  });
  assert.equal(first.state, 'paused');
  assert.equal(first.controlOwner, 'paused');
  assert.equal(typeof first.invitationCode, 'string');
  assert.ok(first.invitationCode.length > 16);
  const again = await h.u.requestHandoff({
    sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_pause_1', reasonCode: 'needsHuman',
  });
  assert.equal(again.handoffId, first.handoffId);
  assert.equal(again.invitationCode, undefined);
  await assert.rejects(
    () => h.a.observe({ sessionId: s.sessionId, pageId: s.pageId }),
    (err) => err.publicError && err.publicError.code === 'DENIED',
  );
  await h.broker.close();
});

test('a restarted broker closes a persisted handoff and drops the invitation', async () => {
  const h = boot();
  const s = await h.open();
  const first = await h.u.requestHandoff({
    sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_restart', reasonCode: 'needsHuman',
  });
  const reloaded = createHandoffCoordinator({ dataDir: h.dataDir });
  const status = reloaded.status(first.handoffId, {});
  assert.equal(status.state, 'closed');
  assert.equal(status.blocker, 'BROKER_RESTART');
  assert.throws(() => reloaded.redeem(first.handoffId, first.invitationCode), (err) => err.v2Code === 'ACCESS_REVOKED' || err.v2Code === 'ACCESS_EXPIRED');
  await h.broker.close();
});

test('viewer redeem is one-use, a second acquire is busy, stale input is frozen, and resume returns the same session', async () => {
  const h = boot({ driverOptions: { humanHandoff: 'unsupported' } });
  const gateway = createViewerGateway({ broker: h.broker, host: '127.0.0.1', port: 0 });
  const base = await gateway.listen();
  const s = await h.open();
  const opened = await h.u.requestHandoff({
    sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_view', reasonCode: 'needsHuman',
  });
  assert.equal(opened.method, 'remote-view');
  assert.match(opened.viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/handoff\//);
  assert.equal(opened.invitationCode.includes(base) , false);

  const redeemed = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/redeem`, { body: { code: opened.invitationCode } });
  assert.equal(redeemed.status, 200);
  const jar = jarFrom(redeemed.headers);
  assert.ok(jar.braiwser_session);
  assert.ok(jar.braiwser_csrf);
  const again = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/redeem`, { body: { code: opened.invitationCode } });
  assert.equal(again.status, 401);

  const headers = {
    cookie: cookieHeader(jar),
    origin: base,
    'x-braiwser-csrf': jar.braiwser_csrf,
  };
  const frame = await httpJson(base, 'GET', `/v1/handoffs/${opened.handoffId}/frame`, { headers: { cookie: headers.cookie } });
  assert.equal(frame.status, 200);
  assert.equal(frame.json.value.fresh, true);
  const acquired = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/acquire`, {
    headers, body: { expectedControlEpoch: opened.controlEpoch },
  });
  assert.equal(acquired.status, 200, JSON.stringify(acquired.json));
  assert.equal(acquired.json.value.controlOwner, 'human');
  const busy = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/acquire`, {
    headers, body: { expectedControlEpoch: acquired.json.value.controlEpoch },
  });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, 'CONTROL_BUSY');

  const fresh = await httpJson(base, 'GET', `/v1/handoffs/${opened.handoffId}/frame`, { headers: { cookie: headers.cookie } });
  const stale = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/input`, {
    headers, body: { controlEpoch: acquired.json.value.controlEpoch, frameSequence: fresh.json.value.sequence + 9, kind: 'click', x: 1, y: 1 },
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.json.error.code, 'STALE_CONTROL_EPOCH');

  const resumed = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/resume`, {
    headers, body: { requestKey: 'vw_resume_1' },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  assert.equal(resumed.json.value.controlOwner, 'agent');
  assert.equal(resumed.json.value.resumed, true);
  const obs = await h.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  assert.equal(obs.sessionId || s.sessionId, s.sessionId);
  await gateway.close();
  await h.broker.close();
});

test('private input suspends broker observations', async () => {
  const h = boot();
  const gateway = createViewerGateway({ broker: h.broker, host: '127.0.0.1', port: 0 });
  const base = await gateway.listen();
  const s = await h.open();
  const opened = await h.u.requestHandoff({
    sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_private', reasonCode: 'privateInput',
  });
  const redeemed = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/redeem`, { body: { code: opened.invitationCode } });
  const jar = jarFrom(redeemed.headers);
  const headers = { cookie: cookieHeader(jar), origin: base, 'x-braiwser-csrf': jar.braiwser_csrf };
  const acquired = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/acquire`, {
    headers, body: { expectedControlEpoch: opened.controlEpoch },
  });
  assert.equal(acquired.status, 200, JSON.stringify(acquired.json));
  const priv = await httpJson(base, 'POST', `/v1/handoffs/${opened.handoffId}/private`, { headers, body: { enabled: true } });
  assert.equal(priv.status, 200, JSON.stringify(priv.json));
  await assert.rejects(
    () => h.a.observe({ sessionId: s.sessionId, pageId: s.pageId }),
    (err) => err.publicError && /PRIVATE_INPUT_ACTIVE/.test(err.publicError.message),
  );
  await gateway.close();
  await h.broker.close();
});

test('a remote deployment must not advertise a loopback viewer', async () => {
  const h = boot({ driverOptions: { humanHandoff: 'unsupported' } });
  h.broker.attachViewer({ enabled: true, baseUrl: 'http://127.0.0.1:9', deployment: 'remote' });
  const s = await h.open();
  await assert.rejects(
    () => h.u.requestHandoff({ sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk_remote', reasonCode: 'needsHuman' }),
    (err) => err.v2Code === 'VIEWER_UNREACHABLE' || (err.publicError && /VIEWER_UNREACHABLE/.test(err.publicError.message)),
  );
  const report = doctorReport({ env: { BRAIWSER_DEPLOYMENT: 'remote', BRAIWSER_VIEWER_ORIGIN: 'http://127.0.0.1:9' } });
  assert.equal(report.viewer, 'VIEWER_UNREACHABLE');
  assert.equal(report.viewerBaseUrl, null);
  await h.broker.close();
});
