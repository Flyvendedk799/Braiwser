import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFakeBroker, P } from './_fake-broker.mjs';

const require = createRequire(import.meta.url);
const { createBridgeServer, startBridge } = require('../../../src/main/services/automation/bridge-server.js');
const bridge = require('../../../src/main/services/automation/bridge.js');

async function boot(brokerOptions, serverOptions = {}) {
  const broker = createFakeBroker(brokerOptions);
  const server = createBridgeServer({ broker, authFailureDelayMs: 5, helloTimeoutMs: 400, ...serverOptions });
  await server.listen();
  return { broker, server };
}
const rawHello = (endpoint, frame) => new Promise((resolve) => {
  const socket = net.connect(endpoint);
  const chunks = [];
  socket.on('connect', () => socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`));
  socket.on('data', (d) => chunks.push(d));
  socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  socket.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  setTimeout(() => socket.destroy(), 1500).unref();
});

test('a wrong token is rejected and nothing about why is disclosed', async () => {
  const { server } = await boot();
  const good = server.issueToken(P('mcp:a'));
  await assert.rejects(() => bridge.connectBridge({ endpoint: server.endpoint, token: 'wrong' }), (e) => e.publicError.code === 'DENIED');
  await assert.rejects(() => bridge.connectBridge({ endpoint: server.endpoint, token: good.slice(0, -1) }), (e) => e.publicError.code === 'DENIED');
  const reply = await rawHello(server.endpoint, { t: 'hello', v: 1, token: 'nope' });
  assert.deepEqual(JSON.parse(reply.trim()), { t: 'hello', ok: false });
  const wrongVersion = await rawHello(server.endpoint, { t: 'hello', v: 99, token: good });
  assert.deepEqual(JSON.parse(wrongVersion.trim()), { t: 'hello', ok: false });
  await server.close();
});

test('requests before authentication get no service; the connection is dropped', async () => {
  const { broker, server } = await boot();
  server.issueToken(P('mcp:a'));
  const reply = await rawHello(server.endpoint, { t: 'req', id: 1, method: 'openSession', params: { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } } });
  assert.ok(!reply.includes('"t":"res"'), 'no response to an unauthenticated request');
  assert.equal(broker.state.calls.length, 0);
  // garbage and oversize first frames are dropped as well
  assert.ok(!(await rawHello(server.endpoint, 'not json')).includes('res'));
  await server.close();
});

test('a silent connection is closed after the hello timeout', async () => {
  const { server } = await boot();
  const closed = await new Promise((resolve) => {
    const s = net.connect(server.endpoint);
    s.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000).unref();
  });
  assert.equal(closed, true);
  await server.close();
});

test('expired and revoked tokens stop working; revocation drops live connections', async () => {
  let t = 1_000;
  const { server } = await boot({}, { now: () => t });
  const short = server.issueToken(P('mcp:a'), { ttlMs: 1000 });
  const live = await bridge.connectBridge({ endpoint: server.endpoint, token: short });
  assert.ok(await live.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } }));
  t += 5_000;
  await assert.rejects(() => live.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } }), (e) => e.publicError.code === 'UNAVAILABLE');
  await assert.rejects(() => bridge.connectBridge({ endpoint: server.endpoint, token: short }), (e) => e.publicError.code === 'DENIED');

  const tok = server.issueToken(P('mcp:b'), { ttlMs: 60_000 });
  const c = await bridge.connectBridge({ endpoint: server.endpoint, token: tok });
  assert.equal(server.revoke(tok), true);
  await assert.rejects(() => c.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } }));
  await assert.rejects(() => bridge.connectBridge({ endpoint: server.endpoint, token: tok }), (e) => e.publicError.code === 'DENIED');
  await server.close();
});

test('tokens map to server-chosen principals: ownership holds across connections', async () => {
  const { broker, server } = await boot();
  const a = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(P('mcp:a')) });
  const b = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(P('cli:b', 'cli')) });
  const s = await a.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } });
  await assert.rejects(() => b.observe({ sessionId: s.sessionId, pageId: s.pageId }), (e) => e.publicError.code === 'DENIED');
  assert.ok((await a.observe({ sessionId: s.sessionId, pageId: s.pageId })).observationId);
  // The client cannot smuggle a principal: extra params are just params.
  await assert.rejects(() => b.observe({ sessionId: s.sessionId, pageId: s.pageId, principal: P('mcp:a'), ctx: { principal: P('mcp:a') } }));
  assert.ok(broker.state.calls.every((c) => ['mcp:a', 'cli:b'].includes(c.principal)));
  await a.close(); await b.close(); await server.close();
});

test('only the closed method list is reachable; UI-only operations are not', async () => {
  const { server } = await boot();
  const token = server.issueToken(P('mcp:a'));
  const socket = net.connect(server.endpoint);
  const frames = [];
  const waitFor = (n) => new Promise((resolve) => { const t = setInterval(() => { if (frames.length >= n) { clearInterval(t); resolve(); } }, 5); });
  let buf = '';
  socket.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { frames.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await new Promise((r) => socket.on('connect', r));
  socket.write(`${JSON.stringify({ t: 'hello', v: 1, token })}\n`);
  await waitFor(1);
  let n = 1;
  for (const method of ['approve', 'resume', 'forPrincipal', 'constructor', '__proto__', 'events', 'toString', 'evaluate']) {
    socket.write(`${JSON.stringify({ t: 'req', id: n, method, params: {} })}\n`);
    n += 1;
    await waitFor(n);
    const res = frames[n - 1];
    assert.equal(res.ok, false, method);
    assert.equal(res.error.code, 'UNSUPPORTED', method);
  }
  socket.write(`${JSON.stringify({ t: 'req', id: 100, method: 'observe', params: 'nope' })}\n`);
  await waitFor(n + 1);
  assert.equal(frames[n].error.code, 'UNSUPPORTED');
  socket.destroy();
  assert.deepEqual(bridge.METHODS.includes('approve'), false);
  assert.deepEqual(bridge.METHODS.includes('resume'), false);
  await server.close();
});

test('ui principals can never be issued a bridge token', async () => {
  const { server } = await boot();
  assert.throws(() => server.issueToken(P('ui:main', 'ui')), /mcp, cli or skill/);
  assert.throws(() => server.issueToken({ id: '', kind: 'mcp' }));
  assert.throws(() => server.issueToken(null));
  await server.close();
});

test('oversized frames drop the connection without reaching the broker', async () => {
  const { broker, server } = await boot();
  const token = server.issueToken(P('mcp:a'));
  const reply = await new Promise((resolve) => {
    const s = net.connect(server.endpoint);
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('connect', () => {
      s.write(`${JSON.stringify({ t: 'hello', v: 1, token })}\n`);
      s.write(`{"t":"req","id":1,"method":"observe","params":{"x":"${'a'.repeat(bridge.MAX_FRAME + 10)}"}}\n`);
    });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    setTimeout(() => { s.destroy(); resolve(got); }, 3000).unref();
  });
  assert.ok(!reply.includes('"t":"res"'));
  assert.equal(broker.state.calls.length, 0);
  await server.close();
});

test('errors cross the wire only as classified public errors', async () => {
  const { broker, server } = await boot();
  const c = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(P('mcp:a')) });
  const real = broker.forPrincipal;
  broker.forPrincipal = (p) => { const f = real(p); f.getRun = async () => { throw new Error('C:\\secret\\path\\stack at internal.js:1'); }; f.act = async () => { throw new Error('boom'); }; return f; };
  const server2 = createBridgeServer({ broker, authFailureDelayMs: 5 });
  await server2.listen();
  const c2 = await bridge.connectBridge({ endpoint: server2.endpoint, token: server2.issueToken(P('mcp:a')) });
  const err = await c2.getRun({ runId: 'r' }).catch((e) => e);
  assert.equal(err.publicError.code, 'INTERNAL');
  assert.ok(!JSON.stringify(err.publicError).includes('secret'));
  assert.equal(err.publicError.retry, 'safe-read');
  const act = await c2.act({}).catch((e) => e);
  assert.equal(act.publicError.effectUnknown, true, 'an unclassified mutation failure is uncertain');
  assert.equal(act.publicError.retry, 'never');
  await c.close(); await c2.close(); await server.close(); await server2.close();
});

test('client abort reaches the broker signal; the broker outcome is returned', async () => {
  const { broker, server } = await boot();
  const c = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(P('mcp:a')) });
  const s = await c.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } });
  let aborted = false;
  broker.state.hold = (ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => {
    aborted = true;
    rej(Object.assign(new Error('x'), { publicError: { code: 'CANCELLED', message: 'cancelled', dispatched: false, effectUnknown: false, retry: 'safe-read' } }));
  }));
  const ctl = new AbortController();
  const p = c.observe({ sessionId: s.sessionId, pageId: s.pageId }, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  const e = await p.catch((x) => x);
  assert.equal(aborted, true);
  assert.equal(e.publicError.code, 'CANCELLED');
  await c.close(); await server.close();
});

test('connection loss reports unavailable; mutations report effectUnknown', async () => {
  const { broker, server } = await boot();
  const c = await bridge.connectBridge({ endpoint: server.endpoint, token: server.issueToken(P('mcp:a')) });
  broker.state.hold = () => new Promise(() => {});
  const read = c.observe({ sessionId: 'x', pageId: 'y' });
  await new Promise((r) => setTimeout(r, 30));
  await server.close();
  const e = await read.catch((x) => x);
  assert.equal(e.publicError.code, 'UNAVAILABLE');
  assert.equal(e.publicError.retry, 'safe-read');
  await assert.rejects(() => c.openSession({}), (x) => x.publicError.code === 'UNAVAILABLE');
});

test('the endpoint is random and, on POSIX, lives in a private directory with a 0600 client file', async () => {
  const a = createBridgeServer({ broker: createFakeBroker() });
  const b = createBridgeServer({ broker: createFakeBroker() });
  await a.listen(); await b.listen();
  assert.notEqual(a.endpoint, b.endpoint);
  if (process.platform === 'win32') {
    assert.match(a.endpoint, /^\\\\\.\\pipe\\braiwser-agent-[0-9a-f]{24}$/);
  } else {
    assert.equal(fs.statSync(path.dirname(a.endpoint)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(a.endpoint).mode & 0o077, 0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-info-'));
  const { file, token } = a.writeClientFile(path.join(dir, 'client.json'), P('mcp:file'), { ttlMs: 60_000 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  const info = bridge.readConnectionInfo(file);
  assert.equal(info.token, token);
  assert.equal(info.endpoint, a.endpoint);
  const c = await bridge.connectBridge(info);
  assert.ok(await c.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } }));
  await c.close(); await a.close(); await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => bridge.readConnectionInfo(path.join(dir, 'missing.json')));
});

test('startBridge writes the default client file and serves it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-start-'));
  const started = await startBridge({ broker: createFakeBroker(), infoDir: dir, defaultClient: { principal: P('mcp:default'), ttlMs: 60_000 } });
  const info = bridge.loadConnectionInfo({ BRAIWSER_BRIDGE_INFO: path.join(dir, 'agent-bridge.json') });
  const c = await bridge.connectBridge(info);
  assert.ok(await c.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } }));
  await c.close(); await started.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => bridge.loadConnectionInfo({ BRAIWSER_BRIDGE_INFO: path.join(dir, 'gone.json') }), (e) => e.publicError.code === 'UNAVAILABLE');
});
