import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFakeBroker, P } from './_fake-broker.mjs';
import { startServer } from '../../../src/main/services/automation/server.mjs';

const require = createRequire(import.meta.url);
const { createBridgeServer } = require('../../../src/main/services/automation/bridge-server.js');
const bridge = require('../../../src/main/services/automation/bridge.js');
const HOUR = 60 * 60 * 1000;

test('an extended credential keeps working past its original expiry; a lapsed one cannot be revived', async (t) => {
  let clock = Date.now();
  const server = createBridgeServer({ broker: createFakeBroker(), now: () => clock, authFailureDelayMs: 5 });
  await server.listen();
  t.after(() => server.close());
  const kept = server.issueToken(P('mcp:kept'), { ttlMs: 8 * HOUR });
  const lapsed = server.issueToken(P('mcp:lapsed'), { ttlMs: 8 * HOUR });
  clock += 7 * HOUR;
  assert.equal(server.extend(kept, { ttlMs: 8 * HOUR }), true);
  clock += 2 * HOUR; // 9h after issue: past the original expiry of both
  const facade = await bridge.connectBridge({ endpoint: server.endpoint, token: kept });
  await facade.close();
  await assert.rejects(() => bridge.connectBridge({ endpoint: server.endpoint, token: lapsed }));
  assert.equal(server.extend(lapsed, { ttlMs: 8 * HOUR }), false, 'an expired token is never brought back');
  assert.equal(server.extend('never-issued', { ttlMs: HOUR }), false);
});

test('a kept-alive owner renews its client file in place: same token, later expiry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-renew-'));
  const service = await startServer({ dataDir: path.join(dir, 'store'), keepAlive: true, renewMs: 150,
    principal: { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe'] } });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = JSON.parse(fs.readFileSync(service.bridgeFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 600));
  const after = JSON.parse(fs.readFileSync(service.bridgeFile, 'utf8'));
  assert.equal(after.token, before.token);
  assert.equal(after.endpoint, before.endpoint);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.expiresAt), `${after.expiresAt} > ${before.expiresAt}`);
  const facade = await bridge.connectBridge(bridge.readConnectionInfo(service.bridgeFile));
  await facade.close();
});

test('an owner that is not kept alive does not renew', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-norenew-'));
  const service = await startServer({ dataDir: path.join(dir, 'store'), renewMs: 100,
    principal: { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe'] } });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = fs.readFileSync(service.bridgeFile, 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(service.bridgeFile, 'utf8'), before);
});
