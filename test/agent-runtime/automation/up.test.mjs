// `braiwser mcp`: one command gives an MCP client a supervised browser and the review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildConfig, UsageError, main } from '../../../src/main/services/automation/up.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const UP = path.join(root, 'src/main/services/automation/up.mjs');
const candidates = [process.env.BRAIWSER_TEST_BROWSER, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium', '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
const opts = { env: {}, cwd: '/work', home: '/home/me' };

test('flags become the smallest grant that was asked for; nothing is granted by default', () => {
  const { config } = buildConfig(['mcp', '--origin', 'http://localhost:3000/', '--origin', 'http://localhost:3000'], opts);
  assert.deepEqual(config, { dataDir: path.join('/home/me', '.braiwser', 'runtime'), ownerId: 'local-owner',
    principal: { id: 'local-agent', kind: 'mcp', scopes: ['class:observe', 'class:navigate', 'class:interact', 'origin:http://localhost:3000'] } });
  const withReview = buildConfig(['mcp', '--origin', 'https://app.test', '--review', 'r', '--classes', 'observe', '--data', 'd', '--chromium', '/usr/bin/chromium', '--no-browser-sandbox'], opts).config;
  assert.deepEqual(withReview.principal.scopes, ['class:observe', 'origin:https://app.test', 'review:read', 'review:write']);
  assert.equal(withReview.reviewDir, path.resolve('/work', 'r'));
  assert.equal(withReview.dataDir, path.resolve('/work', 'd'));
  assert.deepEqual(withReview.driverOptions, { executablePath: '/usr/bin/chromium', chromiumSandbox: false });
  assert.deepEqual(buildConfig(['mcp', '--origin', 'https://app.test', '--review', 'r', '--review-read-only'], opts).config.principal.scopes.slice(-1), ['review:read']);
  assert.equal(buildConfig(['mcp', '--origin', 'https://a.test'], { ...opts, env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/x/chrome' } }).config.driverOptions.executablePath, '/x/chrome');
});

test('unsafe or meaningless flags are refused with a message for the person', async () => {
  for (const argv of [['mcp'], ['mcp', '--origin', 'ftp://x'], ['mcp', '--origin', 'https://u:p@x.test'], ['mcp', '--origin', 'https://x.test/admin'],
    ['mcp', '--origin', 'https://x.test', '--classes', 'observe,credentials'], ['mcp', '--origin', 'https://x.test', '--review-read-only'],
    ['serve', '--origin', 'https://x.test'], ['mcp', '--origin', 'https://x.test', '--unknown'], []]) {
    assert.throws(() => buildConfig(argv, opts), UsageError, argv.join(' '));
  }
  let err = '';
  assert.equal(await main(['mcp'], { ...opts, stderr: (t) => { err += t; }, stdout: () => {} }), 1);
  assert.match(err, /granted no site by default/);
  let out = '';
  assert.equal(await main(['mcp', '--origin', 'https://x.test', '--print-config'], { ...opts, stdout: (t) => { out += t; } }), 0);
  assert.equal(JSON.parse(out).principal.id, 'local-agent');
});

test('one command: a real MCP client lists tools, reads the review and visits the granted site', { skip: !executablePath && 'no Chromium-family browser available', timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-up-'));
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Up</title><h1>It works</h1><button data-testid="go">Go</button>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const review = path.join(dir, 'review'); fs.mkdirSync(review);
  fs.writeFileSync(path.join(review, 'p.braiwser.json'), JSON.stringify({ format: 'braiwser-bundle', kind: 'braiwser.project-bundle', version: 1, project: { name: 'P', kind: 'url' },
    sessions: [{ id: 's', name: 'S', url: `${origin}/` }],
    annotations: [{ sessionId: 's', kind: 'edit', action: 'change', note: 'make it bold', target: { locator: { by: 'testId', value: 'go' } }, edit: { type: 'style', css: 'font-weight: 700;', details: { props: { 'font-weight': '700' } } } }], recordings: [] }));
  const data = path.join(dir, 'data');
  const client = new Client({ name: 'up-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    try { process.kill(JSON.parse(fs.readFileSync(path.join(data, 'owner.lock'), 'utf8')).pid, 'SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => site.close(r));
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [UP, 'mcp', '--origin', origin, '--review', review, '--data', data, '--chromium', executablePath], env: getDefaultEnvironment(), stderr: 'pipe' }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === 'review_notes') && tools.some((x) => x.name === 'browser_pages'));
  const notes = await call('review_notes', {});
  assert.equal(notes.ok, true, JSON.stringify(notes));
  assert.equal(notes.value.notes[0].verifiable, true);
  const opened = await call('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: [origin], toolClasses: ['observe', 'navigate'] } });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const visited = await call('browser_visit', { sessionId: opened.value.sessionId, pageId: opened.value.pageId, url: `${origin}/`, operationId: 'v1' });
  assert.equal(visited.ok, true, JSON.stringify(visited));
  assert.ok(visited.value.page.text.includes('It works'));
  // A site that was not named on the command line stays out of reach, whatever the session asks for.
  const outside = await call('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://example.com'], toolClasses: ['observe', 'navigate'] } });
  const target = outside.ok ? outside.value : opened.value;
  const denied = await call('browser_visit', { sessionId: target.sessionId, pageId: target.pageId, url: 'https://example.com/', operationId: 'v2' });
  const refused = denied.ok === false ? denied.error.code === 'DENIED' : denied.value.page === null && !['verified', 'dispatched'].includes(denied.value.receipt.status);
  assert.ok(refused, JSON.stringify(denied).slice(0, 600));
});
