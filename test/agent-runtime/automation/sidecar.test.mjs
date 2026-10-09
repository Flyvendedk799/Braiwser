import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFakeBroker, P } from './_fake-broker.mjs';

const require = createRequire(import.meta.url);
const { createBridgeServer } = require('../../../src/main/services/automation/bridge-server.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(here, '../../../src/main/services/automation/sidecar.mjs');

test('a real stdio MCP client reaches the owning broker through the authenticated bridge', async () => {
  const broker = createFakeBroker();
  const server = createBridgeServer({ broker, authFailureDelayMs: 5 });
  await server.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-sidecar-'));
  const { file } = server.writeClientFile(path.join(dir, 'info.json'), P('mcp:stdio'), { ttlMs: 60_000 });

  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const stderrChunks = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SIDECAR], stderr: 'pipe',
    env: { ...getDefaultEnvironment(), BRAIWSER_BRIDGE_INFO: file } });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => stderrChunks.push(d));

  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  const open = await client.callTool({ name: 'browser_session_open', arguments: { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'] } } });
  assert.equal(open.structuredContent.ok, true);
  const { sessionId, pageId } = open.structuredContent.value;
  const obs = await client.callTool({ name: 'browser_observe', arguments: { sessionId, pageId } });
  assert.equal(obs.structuredContent.value.nodes[0].ref, 'r_save');
  // The broker saw the principal the SERVER assigned to the token, not anything the client said.
  assert.ok(broker.state.calls.every((c) => c.principal === 'mcp:stdio'));
  const caps = await client.readResource({ uri: 'braiwser://capabilities' });
  assert.equal(JSON.parse(caps.contents[0].text).tools.length, 8);

  await client.close();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(!Buffer.concat(stderrChunks).toString().includes('app.test'), 'diagnostics never include arguments');
});

test('without a reachable Braiwser the sidecar exits non-zero, keeps stdout clean and never prints the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-sidecar-'));
  const info = path.join(dir, 'info.json');
  fs.writeFileSync(info, JSON.stringify({ version: 1, endpoint: path.join(dir, 'missing.sock'), token: 'TOKEN-CANARY-123' }));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SIDECAR], { env: { ...process.env, BRAIWSER_BRIDGE_INFO: info }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, '', 'stdout is reserved for protocol messages');
  assert.match(result.err, /cannot connect to Braiwser/);
  assert.ok(!result.err.includes('TOKEN-CANARY-123'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a wrong token never yields a working MCP session', async () => {
  const server = createBridgeServer({ broker: createFakeBroker(), authFailureDelayMs: 5 });
  await server.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-sidecar-'));
  const info = path.join(dir, 'info.json');
  fs.writeFileSync(info, JSON.stringify({ version: 1, endpoint: server.endpoint, token: 'guess' }));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SIDECAR], { env: { ...process.env, BRAIWSER_BRIDGE_INFO: info }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
