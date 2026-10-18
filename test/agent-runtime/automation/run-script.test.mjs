import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(here, '../../../.agents/skills/braiwser-verify/scripts/run.mjs');
const FIXTURE = path.join(here, 'fixtures', 'stdio-run-server.mjs');

const dto = (over = {}) => ({
  runId: 'run_1', state: 'passed', verdict: 'passed', sequence: 3, cancelRequested: false,
  planned: 3, executed: 3, passed: 3, skipped: 0, cancelled: 0, timedOut: 0, evidenceComplete: true, uncertainEffect: false,
  requiredAssertions: 1, passedAssertions: 1, deadlineAt: '2026-10-09T12:00:00.000Z', pending: 0, failed: 0, unknown: 0,
  events: [], nextSequence: 3, manifestUri: 'braiwser://runs/run_1/manifest', ...over });
const running = (over = {}) => dto({ state: 'running', verdict: 'pending', executed: 1, passed: 1, pending: 2, passedAssertions: 0, ...over });

// Spawns `node run.mjs` (no shell) against the stdio fixture server.
function exec(scenario, { args = ['bs_1', 'pg_1', 'rec_1', 'rk_1'], env = {}, entry = FIXTURE, signalAfterMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-run-'));
  const log = path.join(dir, 'calls.jsonl');
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario, log }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN, ...args], {
      env: { ...process.env, BRAIWSER_MCP_ENTRY: entry, BRAIWSER_BRIDGE_INFO: scenarioFile,
        BRAIWSER_POLL_MS: '20', BRAIWSER_WAIT_MS: '4000', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (signalAfterMs) setTimeout(() => child.kill('SIGINT'), signalAfterMs);
    child.on('close', (code) => {
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      resolve({ code, stdout, stderr, calls, scenarioFile, lines: stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } }) });
    });
  });
}
const names = (r) => r.calls.map((c) => c.tool);

test('exit 0 only for a proven pass; start uses the pinned skill and stable request key', async () => {
  const r = await exec({ start: dto() });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(names(r), ['browser_run']);
  assert.deepEqual(r.calls[0].args, { sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_1', skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'rec_1' } });
  assert.equal(r.lines.at(-1).state, 'passed');
});

test('polls to a terminal state and prints each event once', async () => {
  const ev = (sequence) => ({ sequence, kind: 'step', summary: `s${sequence}` });
  const r = await exec({
    start: running({ events: [ev(0)], nextSequence: 1 }),
    statuses: [running({ events: [ev(0), ev(1)], nextSequence: 2 }), dto({ events: [ev(1), ev(2)], nextSequence: 3 })],
  });
  assert.equal(r.code, 0, r.stderr);
  const printed = r.lines.filter((l) => l && l.kind === 'step').map((l) => l.sequence);
  assert.deepEqual(printed, [0, 1, 2], 'no duplicated events');
  assert.deepEqual(r.calls.filter((c) => c.tool === 'browser_run_status').map((c) => c.args.afterSequence), [1, 2]);
  assert.equal(names(r).filter((n) => n === 'browser_run').length, 1, 'never starts a replacement run');
});

test('failed, cancelled, timedOut, uncertain and interrupted runs exit 2 and are reported as-is', async () => {
  for (const [state, verdict] of [['failed', 'failed'], ['cancelled', 'cancelled'], ['timedOut', 'timedOut'], ['uncertain', 'unknown'], ['interrupted', 'unknown']]) {
    const r = await exec({ start: dto({ state, verdict, executed: 1, passed: 1, pending: 2, passedAssertions: 0, uncertainEffect: state === 'uncertain' }) });
    assert.equal(r.code, 2, state);
    assert.equal(r.lines.at(-1).state, state);
  }
});

test('an inconsistent "passed" run is never reported as success (exit 2, no passed line)', async () => {
  const bad = {
    'evidence incomplete': { evidenceComplete: false },
    'uncertain effect': { uncertainEffect: true },
    'no required assertions': { requiredAssertions: 0, passedAssertions: 0 },
    'assertion short': { passedAssertions: 0 },
    'executed < planned': { executed: 2, pending: 1 },
    'passed < planned': { passed: 2, unknown: 1 },
    'failed step': { failed: 1 },
    'skipped step': { skipped: 1 },
    'cancelled step': { cancelled: 1 },
    'timed out step': { timedOut: 1 },
    'zero planned': { planned: 0, executed: 0, passed: 0 },
    'verdict mismatch': { verdict: 'unknown' },
  };
  for (const [why, over] of Object.entries(bad)) {
    const r = await exec({ start: dto(over) });
    assert.equal(r.code, 2, why);
    assert.match(r.stderr, /Inconsistent/, why);
    assert.ok(!r.lines.some((l) => l && l.state === 'passed' && l.runId && l.verdict), `${why}: must not print a passed status`);
  }
  // A non-passed lifecycle state that carries a passed verdict is also inconsistent.
  const r = await exec({ start: dto({ state: 'failed', verdict: 'passed' }) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Inconsistent/);
});

test('needsApproval / needsHuman exit 3 with the resumable runId and no new run', async () => {
  for (const state of ['needsApproval', 'needsHuman']) {
    const r = await exec({ start: dto({ state, verdict: 'pending', executed: 1, passed: 1, pending: 2, passedAssertions: 0 }) });
    assert.equal(r.code, 3, state);
    const hint = r.lines.find((l) => l && l.resume);
    assert.equal(hint.runId, 'run_1');
    assert.match(hint.manifestUri, /^braiwser:\/\//);
    assert.deepEqual(names(r), ['browser_run']);
  }
});

test('client wait budget exhausted -> exit 4 and the server-side run is not cancelled', async () => {
  const r = await exec({ start: running(), statuses: [running()] }, { env: { BRAIWSER_WAIT_MS: '300', BRAIWSER_POLL_MS: '30' } });
  assert.equal(r.code, 4);
  assert.ok(!names(r).includes('browser_run_cancel'));
  assert.match(r.stdout, /no cancellation was inferred/);
});

test('resume attaches to the existing run id and never starts another', async () => {
  const r = await exec({ statuses: [dto()] }, { args: ['bs_1', 'pg_1', '', '', 'run_1'] });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(names(r), ['browser_run_status']);
  assert.equal(r.calls[0].args.runId, 'run_1');
});

test('tool errors and invalid envelopes exit 2 without retrying the start', async () => {
  const err = await exec({ start: { ok: false, value: null, error: { code: 'DENIED', message: 'grant required', dispatched: false, effectUnknown: false, retry: 'never' } } });
  assert.equal(err.code, 2);
  assert.match(err.stderr, /grant required/);
  assert.match(err.stderr, /do not launch a replacement/);
  assert.equal(names(err).length, 1);
  const malformed = await exec({ start: dto({ planned: 'three' }) });
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /Invalid run/);
  const unknownState = await exec({ start: dto({ state: 'done' }) });
  assert.equal(unknownState.code, 2);
});

test('configuration is validated: relative or missing entrypoints and missing arguments are refused', async () => {
  const noEntry = await exec({}, { env: { BRAIWSER_MCP_ENTRY: '' } });
  assert.equal(noEntry.code, 2);
  assert.match(noEntry.stderr, /BRAIWSER_MCP_ENTRY/);
  assert.equal((await exec({}, { entry: 'relative/sidecar.mjs' })).code, 2);
  assert.equal((await exec({}, { entry: path.join(here, 'fixtures', 'does-not-exist.mjs') })).code, 2);
  assert.equal((await exec({}, { entry: path.join(here, 'fixtures') })).code, 2, 'a directory is not an entrypoint');
  assert.equal((await exec({}, { entry: path.join(here, '_harness.mjs').replace(/\.mjs$/, '.txt') })).code, 2);
  const noArgs = await exec({ start: dto() }, { args: ['bs_1', 'pg_1'] });
  assert.equal(noArgs.code, 2);
  assert.deepEqual(noArgs.calls, [], 'nothing runs with incomplete arguments');
});

test('only the bridge variables reach the sidecar; the parent environment does not leak into it', async () => {
  const r = await exec({ start: dto() }, { env: { LEAK_CANARY: 'should-not-pass' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].env.info, r.scenarioFile);
  assert.equal(r.calls[0].env.leak, undefined);
});

test('SIGINT sends exactly one cancel request and reports the resulting state', { skip: process.platform === 'win32' && 'child.kill(SIGINT) terminates the process on Windows' }, async () => {
  const r = await exec({ start: running(), statuses: [running()],
    cancel: dto({ state: 'cancelled', verdict: 'cancelled', cancelRequested: true, executed: 1, passed: 1, pending: 2, passedAssertions: 0 }) },
  { signalAfterMs: 400, env: { BRAIWSER_POLL_MS: '100', BRAIWSER_WAIT_MS: '10000' } });
  assert.equal(r.code, 2);
  assert.equal(names(r).filter((n) => n === 'browser_run_cancel').length, 1);
  assert.equal(r.lines.at(-1).state, 'cancelled');
});
