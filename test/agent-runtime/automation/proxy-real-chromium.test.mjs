import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../../src/main/services/automation/server.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const candidates = [process.env.BRAIWSER_TEST_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
const token = 'real-browser-proxy-secret-'.padEnd(48, 'k');

test('an owner watches, takes over, types and clicks, then returns the same live page to the agent', { skip: !executablePath && 'no Chromium-family browser available', timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-proxy-real-'));
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><style>body{margin:0}input{position:absolute;left:10px;top:10px;width:200px;height:30px}button{position:absolute;left:10px;top:70px;width:100px;height:30px}</style><label for="name">Name</label><input id="name"><button id="go">Go</button><script>window.identity=crypto.randomUUID();document.querySelector("button").onclick=()=>{document.querySelector("button").textContent="Submitted "+document.querySelector("input").value}</script>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const service = await startServer({ dataDir: path.join(dir, 'store'), deployment: 'proxy', proxyToken: token, keepAlive: true, ownerId: 'human',
    driverOptions: { executablePath }, principal: { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe', 'class:navigate', 'class:interact', `origin:${origin}`] } });
  const relay = spawn(process.execPath, [path.join(root, 'src/main/services/automation/proxy-relay.mjs')], {
    env: { ...process.env, BRAIWSER_RELAY_CONFIG: JSON.stringify({ ownerFile: service.ownerFile, token }) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let client;
  t.after(async () => { await client?.close(); relay.kill(); await service.close(); await new Promise((r) => site.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const answers = new Map(); let n = 0;
  readline.createInterface({ input: relay.stdout }).on('line', (line) => { const m = JSON.parse(line); answers.get(m.id)?.(m); });
  const ask = (method, p, body) => new Promise((resolve) => { const id = `r${++n}`; answers.set(id, resolve); relay.stdin.write(`${JSON.stringify({ id, method, path: p, ...(body ? { body } : {}) })}\n`); });
  client = new Client({ name: 'agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/main/services/automation/sidecar.mjs')],
    env: { ...getDefaultEnvironment(), BRAIWSER_BRIDGE_INFO: service.bridgeFile }, stderr: 'pipe' }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const must = async (name, args) => { const r = await call(name, args); assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };

  const opened = await must('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: [origin], toolClasses: ['observe', 'navigate', 'interact'] } });
  const ids = { sessionId: opened.sessionId, pageId: opened.pageId };
  const first = await must('browser_observe', ids);
  await must('browser_act', { ...ids, observationId: first.observationId, documentEpoch: first.documentEpoch, operationId: 'go-site', action: { kind: 'navigate', url: origin } });

  // Watching needs no handoff and gives the agent no reason to pause.
  const watched = await ask('GET', `/proxy/v1/sessions/${ids.sessionId}/frame?pageId=${ids.pageId}`);
  assert.equal(watched.status, 200, JSON.stringify(watched.body));
  assert.equal(watched.body.value.fresh, true);
  assert.equal(Buffer.from(watched.body.value.image, 'base64').subarray(1, 4).toString(), 'PNG', 'a real screenshot');
  assert.ok(watched.body.value.width > 0 && watched.body.value.height > 0);
  assert.equal((await call('browser_observe', ids)).ok, true, 'the agent is still in control while watched');

  // Taking over pauses the agent on the same session.
  const viewerInstanceId = 'owner-tab-0123456789abcdef';
  const taken = await ask('POST', `/proxy/v1/sessions/${ids.sessionId}/takeover`, { pageId: ids.pageId, viewerInstanceId, requestKey: 'real-takeover' });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.value.controlOwner, 'human');
  const blocked = await call('browser_observe', ids);
  assert.equal(blocked.ok, false, 'the agent cannot act while the owner is in control');

  const handoffId = taken.body.value.handoffId;
  const input = async (event) => {
    const frame = (await ask('GET', `/proxy/v1/handoffs/${handoffId}/frame`)).body.value;
    assert.equal(frame.fresh, true);
    const result = await ask('POST', `/proxy/v1/handoffs/${handoffId}/input`, { ...event, viewerInstanceId, requestKey: `k${++n}`,
      expectedControlEpoch: frame.controlEpoch, controlEpoch: frame.controlEpoch, frameSequence: frame.sequence, documentEpoch: frame.documentEpoch });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await input({ kind: 'click', x: 50, y: 25 });
  await input({ kind: 'text', text: 'Typed by owner' });
  await input({ kind: 'click', x: 50, y: 85 });

  const state = (await ask('GET', `/proxy/v1/handoffs/${handoffId}`)).body.value;
  const returned = await ask('POST', `/proxy/v1/handoffs/${handoffId}/resume`, { viewerInstanceId, requestKey: 'real-return', expectedControlEpoch: state.controlEpoch });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.value.controlOwner, 'agent');

  // The same page, with the owner's work on it, is back with the agent.
  const after = await must('browser_observe', ids);
  assert.ok(JSON.stringify(after.nodes).includes('Submitted Typed by owner'), JSON.stringify(after.nodes));
  assert.equal(after.pageId, ids.pageId);
});
