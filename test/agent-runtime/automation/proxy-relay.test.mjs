import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startServer } from '../../../src/main/services/automation/server.mjs';

const principal = { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe'] };
const token = 'relay-secret-'.padEnd(48, 'q');

test('relay forwards bearer-authenticated requests to the loopback gateway and rejects other paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-relay-'));
  const service = await startServer({ dataDir: path.join(dir, 'store'), deployment: 'proxy', proxyToken: token, principal, ownerId: 'human', keepAlive: true });
  const relay = spawn(process.execPath, [path.join(import.meta.dirname, '../../../src/main/services/automation/proxy-relay.mjs')], {
    env: { ...process.env, BRAIWSER_RELAY_CONFIG: JSON.stringify({ ownerFile: service.ownerFile, token }) }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(async () => { relay.kill(); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const answers = new Map();
  readline.createInterface({ input: relay.stdout }).on('line', (line) => { const m = JSON.parse(line); answers.get(m.id)?.(m); });
  const ask = (request) => new Promise((resolve) => { answers.set(request.id, resolve); relay.stdin.write(`${JSON.stringify(request)}\n`); });

  const ok = await ask({ id: '1', method: 'GET', path: '/proxy/v1/sessions/bs_missing' });
  assert.equal(ok.status, 401, 'reached the gateway; an unknown session is refused');
  assert.equal(ok.body.ok, false);
  assert.equal(JSON.stringify(ok).includes(token), false);
  assert.equal((await ask({ id: '2', method: 'GET', path: '/v1/handoffs/x' })).status, 400);
  assert.equal((await ask({ id: '3', method: 'DELETE', path: '/proxy/v1/sessions/bs_missing' })).status, 400);
  assert.equal((await ask({ id: '4', method: 'GET', path: '/proxy/v1/sessions/../x' })).status, 400);
});

test('relay refuses to start without a strong secret', async () => {
  const relay = spawn(process.execPath, [path.join(import.meta.dirname, '../../../src/main/services/automation/proxy-relay.mjs')], {
    env: { ...process.env, BRAIWSER_RELAY_CONFIG: JSON.stringify({ ownerFile: 'x', token: 'short' }) }, stdio: 'ignore' });
  const code = await new Promise((resolve) => relay.on('exit', resolve));
  assert.equal(code, 2);
});
