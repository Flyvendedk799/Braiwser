import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../../src/main/services/automation/server.mjs';

const principal = { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe'] };
const proxyToken = 'proxy-deployment-secret-'.padEnd(48, 'z');

test('proxy deployment keeps the shared secret off disk and authenticates only the bearer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-proxy-'));
  const service = await startServer({ dataDir: path.join(dir, 'store'), deployment: 'proxy', bindHost: '127.0.0.1',
    allowedHosts: ['desk.internal:4100'], proxyToken, principal, ownerId: 'human-owner', keepAlive: true });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(service.readiness.deployment, 'proxy');
  assert.equal(service.readiness.watchVersion, 1);
  const owner = fs.readFileSync(service.ownerFile, 'utf8');
  assert.equal(owner.includes(proxyToken), false);
  assert.equal(JSON.parse(owner).token, undefined);
  const url = `${service.baseUrl}/proxy/v1/sessions/bs_missing`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${proxyToken}` } })).status, 401, 'authenticated but unknown session is still refused');
  // The proxy host must be listed; an unlisted host header is rejected before authentication.
  const res = await fetch(url, { headers: { authorization: `Bearer ${proxyToken}`, host: 'evil.example:4100' } }).catch(() => null);
  if (res) assert.equal(res.status, 401);
});

test('proxy deployment refuses weak secrets and public bind addresses by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-proxy-weak-'));
  await assert.rejects(() => startServer({ dataDir: path.join(dir, 'a'), deployment: 'proxy', proxyToken: 'short', principal }), /strong shared secret/);
  await assert.rejects(() => startServer({ dataDir: path.join(dir, 'b'), deployment: 'proxy', bindHost: 'example.com', proxyToken, principal }), /private bind address/);
  await assert.rejects(() => startServer({ dataDir: path.join(dir, 'c'), deployment: 'remote', principal }), /public viewer deployment/);
  fs.rmSync(dir, { recursive: true, force: true });
});
