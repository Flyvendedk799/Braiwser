'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgentRuntime } = require('../../src/main/services/browser/bootstrap');

test('disabled runtime builds a broker that refuses every call and touches no disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-boot-'));
  const rt = startAgentRuntime({ repos: {}, userDataDir: dir, enabled: false });
  assert.equal(rt.enabled, false);
  assert.equal(rt.broker.enabled, false);
  await assert.rejects(rt.broker.openSession({}, { principal: { id: 'x', kind: 'ui', scopes: [] } }), (e) => e.code === 'UNAVAILABLE' || /disabled/.test(e.message));
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enabled runtime wires drivers, skills and a bridge that grants nothing by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-boot-'));
  const messages = [];
  const rt = startAgentRuntime({
    repos: { recordings: { get: () => null } }, userDataDir: dir, enabled: true, log: (m) => messages.push(m),
  });
  try {
    assert.equal(rt.enabled, true);
    assert.equal(rt.broker.enabled, true);
    await rt.ready;
    assert.ok(rt.bridge, 'bridge should start outside e2e: ' + messages.join('; '));
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'browser', 'agent-bridge.json'), 'utf8'));
    assert.equal(info.principalId, 'mcp-default');
    assert.equal(typeof rt.attachHost, 'function');
  } finally {
    await rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('under e2e the broker exists but no bridge socket is opened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-boot-'));
  const rt = startAgentRuntime({ repos: {}, userDataDir: dir, enabled: true, isE2E: true });
  try {
    await rt.ready;
    assert.equal(rt.bridge, null);
  } finally {
    await rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
