import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { main } from '../../../src/main/services/automation/cli.mjs';
import { createFakeBroker, P } from './_fake-broker.mjs';

const require = createRequire(import.meta.url);
const { createBridgeServer } = require('../../../src/main/services/automation/bridge-server.js');
const bridge = require('../../../src/main/services/automation/bridge.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../../src/main/services/automation/cli.mjs');

async function rig() {
  const broker = createFakeBroker();
  const server = createBridgeServer({ broker, authFailureDelayMs: 5 });
  await server.listen();
  const token = server.issueToken(P('cli:t', 'cli'));
  const connect = () => bridge.connectBridge({ endpoint: server.endpoint, token });
  const cli = async (...argv) => {
    let out = '', err = '';
    const code = await main(argv, { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, connect });
    return { code, out, err, json: out.trim() ? JSON.parse(out.trim().split('\n')[0]) : null };
  };
  return { broker, server, cli };
}

test('open -> observe -> act -> run -> status -> cancel -> handoff -> close over the same broker bridge', async () => {
  const { broker, server, cli } = await rig();
  const open = await cli('open', '--driver', 'playwright', '--mode', 'headless', '--origin', 'https://app.test', '--classes', 'observe,interact');
  assert.equal(open.code, 0);
  assert.equal(open.json.ok, true);
  const { sessionId, pageId } = open.json.value;

  const obs = await cli('observe', '--session', sessionId, '--page', pageId, '--max-nodes', '10');
  assert.equal(obs.json.value.trust, 'untrusted-page');

  const act = await cli('act', '--session', sessionId, '--page', pageId, '--observation', obs.json.value.observationId,
    '--epoch', String(obs.json.value.documentEpoch), '--operation', 'op_cli_1', '--action', '{"kind":"click","ref":"r_save"}');
  assert.equal(act.code, 0);
  assert.equal(act.json.value.status, 'verified');

  const run = await cli('run', '--session', sessionId, '--page', pageId, '--request-key', 'rk_cli', '--skill', 'verify-journey',
    '--skill-version', '1.0.0', '--inputs', '{"recordingId":"rec_1"}');
  assert.equal(run.code, 0);
  assert.equal(run.json.value.state, 'queued');
  const status = await cli('status', '--run', run.json.value.runId, '--max-events', '5');
  assert.equal(status.json.value.runId, run.json.value.runId);
  const cancel = await cli('cancel', '--run', run.json.value.runId);
  assert.equal(cancel.json.value.state, 'cancelled');
  const handoff = await cli('handoff', '--session', sessionId, '--page', pageId, '--reason', 'needs captcha');
  assert.equal(handoff.json.value.method, 'native');
  const closed = await cli('close', '--session', sessionId);
  assert.deepEqual(closed.json.value, { closed: true });
  const after = await cli('observe', '--session', sessionId, '--page', pageId);
  assert.equal(after.code, 2);
  assert.equal(after.json.error.code, 'DENIED');
  void broker;
  await server.close();
});

test('tool errors exit 2 with the typed error; usage errors exit 1 and never connect', async () => {
  const { broker, server, cli } = await rig();
  const denied = await cli('open', '--driver', 'playwright', '--mode', 'headless');
  assert.equal(denied.code, 2);
  assert.equal(denied.json.error.code, 'DENIED');

  const before = broker.state.calls.length;
  for (const argv of [
    [], ['frobnicate'], ['open', '--driver'], ['observe', '--session', 's', '--page', 'p', '--max-nodes', 'many'],
    ['act', '--action', '{not json'], ['open', '--bogus', '1'], ['observe', 'extra-positional'],
  ]) {
    const r = await cli(...argv);
    assert.ok([0, 1].includes(r.code), JSON.stringify(argv));
  }
  assert.equal((await cli('frobnicate')).code, 1);
  assert.equal((await cli('act', '--action', '{not json')).code, 1);
  assert.equal((await cli('observe', '--session', 's', '--page', 'p', '--max-nodes', 'many')).code, 1);
  assert.equal(broker.state.calls.length, before, 'usage errors never reach the broker');

  // schema-level rejection (valid flags, invalid values) is a typed tool error, still no broker call
  const bad = await cli('act', '--session', 's', '--page', 'p', '--observation', 'o', '--epoch', '1', '--operation', 'op',
    '--action', '{"kind":"evaluate","script":"1"}');
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error.code, 'UNSUPPORTED');
  assert.equal(broker.state.calls.length, before);
  await server.close();
});

test('doctor reports readiness without connecting to a broker', async () => {
  let out = '';
  const code = await main(['doctor'], {
    env: { BRAIWSER_DEPLOYMENT: 'local' },
    stdout: (t) => { out += t; },
    stderr: () => {},
    connect: () => { throw new Error('must not connect'); },
  });
  assert.equal(code, 0);
  const json = JSON.parse(out);
  assert.equal(json.ok, true);
  assert.equal(json.value.protocol, 2);
  assert.equal(json.value.deployment, 'local');
});

test('skills lists the pinned catalog without needing a broker', async () => {
  let out = '';
  const code = await main(['skills'], { stdout: (t) => { out += t; }, stderr: () => {}, connect: () => { throw new Error('must not connect'); } });
  assert.equal(code, 0);
  const json = JSON.parse(out);
  assert.equal(json.ok, true);
  assert.ok(json.value.skills.some((s) => s.id === 'verify-journey' && /^sha256:/.test(s.digest)));
});

test('an unreachable Braiwser is a typed UNAVAILABLE result, not a stack trace', async () => {
  let out = '', err = '';
  const code = await main(['status', '--run', 'run_1'], { env: { BRAIWSER_BRIDGE_INFO: path.join(os.tmpdir(), 'nope-braiwser.json') },
    stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  assert.equal(code, 2);
  assert.equal(JSON.parse(out).error.code, 'UNAVAILABLE');
  assert.equal(err, '');
});

test('the real executable: JSON on stdout, no shell, exit code mirrors the result', async () => {
  const { server } = await rig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-cli-'));
  const { file } = server.writeClientFile(path.join(dir, 'info.json'), P('cli:exe', 'cli'), { ttlMs: 60_000 });
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, BRAIWSER_BRIDGE_INFO: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const open = await run(['open', '--driver', 'playwright', '--mode', 'headless', '--origin', 'https://app.test', '--classes', 'observe,interact']);
  assert.equal(open.code, 0, open.err);
  assert.equal(JSON.parse(open.out).ok, true);
  const bad = await run(['status', '--run', 'run_missing']);
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.out).error.code, 'DENIED');
  assert.equal((await run(['bogus'])).code, 1);
  // shell metacharacters in values are just data
  const meta = await run(['handoff', '--session', 'bs_1', '--page', 'pg_1', '--reason', '$(touch /tmp/pwned); & calc.exe']);
  assert.equal(meta.code, 2);
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
