'use strict';
// Loads the real shell preload against a fake `electron` module and inspects
// what it exposes to the renderer.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const PRELOAD = path.join(__dirname, '..', '..', 'src', 'main', 'preload.js');

function loadPreload({ env = {}, argv = [] } = {}) {
  const exposed = {};
  const sent = [];
  const listeners = new Map();
  const fake = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (channel, ...args) => { sent.push([channel, ...args]); return { ok: true }; },
      on: (channel, fn) => { listeners.set(channel, fn); },
      removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
    },
  };
  const saved = {
    env: { BRAIWSER_E2E: process.env.BRAIWSER_E2E, CAOS_E2E: process.env.CAOS_E2E, BRAIWSER_AGENT_RUNTIME: process.env.BRAIWSER_AGENT_RUNTIME },
    argv: process.argv,
  };
  for (const k of Object.keys(saved.env)) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = [...saved.argv, ...argv];
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? fake : origLoad.call(this, request, ...rest); };
  delete require.cache[PRELOAD];
  try {
    require(PRELOAD);
  } finally {
    Module._load = origLoad;
    delete require.cache[PRELOAD];
    process.argv = saved.argv;
    for (const [k, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { api: exposed.braiwser, alias: exposed.caos, sent, listeners };
}

test('exposes braiwser and the caos alias; existing names are intact', () => {
  const { api, alias } = loadPreload();
  assert.equal(api, alias);
  for (const group of ['fs', 'agent', 'projects', 'sessions', 'annotations', 'recordings', 'settings', 'secrets', 'ai', 'export', 'license']) {
    assert.equal(typeof api[group], 'object', group);
  }
  assert.equal(typeof api.fs.reveal, 'function');
  assert.equal(typeof api.fs.captureFullPage, 'function');
  assert.equal(typeof api.export.videoSource, 'function');
  assert.equal(typeof api.config, 'function');
});

test('self-test hooks exist only in an e2e run', () => {
  const normal = loadPreload().api;
  assert.equal(normal.e2e, false);
  assert.ok(!('e2eDone' in normal) && !('e2eCheck' in normal));
  const e2e = loadPreload({ env: { BRAIWSER_E2E: '1' } }).api;
  assert.equal(e2e.e2e, true);
  assert.equal(typeof e2e.e2eDone, 'function');
  assert.equal(typeof e2e.e2eCheck, 'function');
});

test('agentRuntime is absent unless the feature flag is on (env or main-supplied argv)', () => {
  assert.ok(!('agentRuntime' in loadPreload().api));
  assert.ok('agentRuntime' in loadPreload({ env: { BRAIWSER_AGENT_RUNTIME: '1' } }).api);
  assert.ok('agentRuntime' in loadPreload({ argv: ['--braiwser-agent-runtime=1'] }).api);
  assert.ok('agentRuntime' in loadPreload({ env: { BRAIWSER_E2E: '1' } }).api);
});

test('agentRuntime only talks over browser:* channels', async () => {
  const { api, sent, listeners } = loadPreload({ env: { BRAIWSER_AGENT_RUNTIME: '1' } });
  const rt = api.agentRuntime;
  assert.deepEqual(await rt.invoke('browser:status'), { ok: true });
  assert.deepEqual(sent.pop(), ['browser:status', {}]);
  await rt.invoke('browser:run-cancel', { runId: 'r1' });
  assert.deepEqual(sent.pop(), ['browser:run-cancel', { runId: 'r1' }]);

  for (const bad of ['caos:secrets.setKey', 'caos:agent.run', 'BROWSER:status', 'browser', 'browser:', 'xbrowser:a', 'browser:a b', 'browser:' + 'x'.repeat(80), undefined, 42]) {
    await assert.rejects(rt.invoke(bad, {}), /only browser:\* channels/, String(bad));
  }
  assert.equal(sent.length, 0, 'no refused call may reach ipcRenderer');

  const got = [];
  const off = rt.on('browser:run-event', (p) => got.push(p));
  listeners.get('browser:run-event')({ sender: 'secret-event-object' }, { id: 1 });
  assert.deepEqual(got, [{ id: 1 }], 'callback receives only the payload, never the IPC event');
  off();
  assert.equal(listeners.has('browser:run-event'), false);

  const noop = rt.on('caos:command', () => { throw new Error('must not subscribe'); });
  assert.equal(typeof noop, 'function');
  assert.equal(listeners.has('caos:command'), false);
});

test('path / id arguments are rejected before leaving the preload', async () => {
  const { api, sent } = loadPreload();
  await assert.rejects(api.fs.reveal('relative.txt'), /absolute path/);
  await assert.rejects(api.fs.reveal(null), /absolute path/);
  await assert.rejects(api.fs.captureFullPage('1'), /webContents id/);
  await assert.rejects(api.export.videoSource('x'), /webContents id or null/);
  assert.equal(sent.length, 0);
  await api.fs.reveal(path.resolve('/tmp/x.txt'));
  await api.fs.captureFullPage(4);
  await api.export.videoSource(null);
  assert.deepEqual(sent.map((s) => s[0]), ['caos:reveal', 'caos:capture-fullpage', 'caos:video.source']);
});
