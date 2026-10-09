'use strict';
// The headless worker as a SPAWNED process: no Electron, honest exit codes, JSON-lines protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { browserAvailable } = require('./_env');
const { EXIT } = require('../../../src/main/services/browser/cli');

const CLI = path.join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'browser', 'cli.js');
let avail = { ok: false, reason: 'not probed' };
test.before(async () => { avail = await browserAvailable('headless'); });

const run = (args, opts) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 90000, ...(opts || {}) });
const needsBrowser = (name, fn) => test(name, async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  await fn(t);
});

test('usage errors exit 2 and print nothing on stdout', () => {
  for (const args of [['bogus'], ['run-fixture'], ['run-fixture', '../etc/passwd'], ['run-fixture', 'nope'], ['run-fixture', 'preview', '--mode', 'hybrid'],
    ['run-fixture', 'preview', '--input', 'novalue'], ['serve', '--classes', 'root'], ['--nonsense']]) {
    const r = run(args);
    assert.equal(r.status, EXIT.USAGE, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', 'stdout is reserved for receipts / protocol');
  }
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /run-fixture/);
});

test('a missing Chromium is EXIT.UNAVAILABLE (3), not a failure of the run', () => {
  const r = run(['run-fixture', 'preview'], { env: { ...process.env, BRAIWSER_CHROMIUM_PATH: path.join(__dirname, 'definitely-not-a-browser.exe') } });
  assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
  assert.match(r.stderr, /Chromium is not available/);
  assert.equal(r.stdout, '');
});

test('capabilities prints both mode documents without a browser', () => {
  const r = run(['capabilities']);
  assert.equal(r.status, 0, r.stderr);
  const caps = JSON.parse(r.stdout);
  assert.deepEqual(caps.headless.modes, ['headless']);
  assert.deepEqual(caps.visible.modes, ['visible']);
  assert.equal(caps.headless.liveModeSwitch, false);
});

needsBrowser('run-fixture: open -> observe -> act -> verify, receipt JSON, exit 0 only when the verdict is passed', () => {
  const r = run(['run-fixture', 'preview']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.schema, 'braiwser.cli.receipt/1');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.state, 'passed');
  assert.equal(receipt.electron, false, 'runs without Electron');
  assert.equal(receipt.driver, 'playwright');
  assert.equal(receipt.mode, 'headless');
  assert.deepEqual([receipt.run.passed, receipt.run.planned, receipt.run.passedAssertions, receipt.run.requiredAssertions], [4, 4, 1, 1]);
  assert.equal(receipt.run.evidenceComplete, true);
  assert.equal(receipt.run.uncertainEffect, false);
  assert.ok(receipt.observation.nodes >= 3 && receipt.observation.coverage.framesSeen === 1);
  assert.equal(receipt.manifest.present, true);
  assert.equal(receipt.capabilities.canvas, false);
  assert.ok(!/127\.0\.0\.1:\d+.*password/i.test(r.stdout));
});

needsBrowser('run-fixture: a wrong expectation is an honest FAILED (exit 1), never rounded up to a pass', () => {
  const r = run(['run-fixture', 'preview', '--input', 'name=Bob']);
  assert.equal(r.status, EXIT.FAILED, r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.verdict, 'failed');
  assert.equal(receipt.run.failed, 1);
  assert.equal(receipt.run.passedAssertions, 0);
});

// ---- JSON-lines mode ---------------------------------------------------------------------------------------------
function worker(args) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; const waiters = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const obj = JSON.parse(line); // every stdout line MUST be JSON
      lines.push(obj);
      for (const w of waiters.splice(0)) w();
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const next = async (pred) => {
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      await new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error(`timeout waiting for a line; stderr=${stderr}`)), 60000).unref(); });
    }
  };
  let id = 0;
  const call = async (method, params) => {
    const myId = ++id;
    child.stdin.write(`${JSON.stringify({ id: myId, method, params })}\n`);
    return next((l) => l.id === myId);
  };
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, call, next, exited, write: (s) => child.stdin.write(s), end: () => child.stdin.end(), stderr: () => stderr };
}

needsBrowser('serve: JSON-lines command mode drives a session through the broker; stdout is protocol only', async () => {
  const w = worker(['--fixtures', '--classes', 'observe,navigate,interact']);
  try {
    const ready = await w.next((l) => l.event === 'ready');
    assert.equal(ready.protocol, 'braiwser.cli.jsonl/1');
    assert.equal(ready.runtime.electron, false);
    assert.ok(ready.fixtureOrigin.startsWith('http://127.0.0.1:'));
    assert.ok(!ready.methods.includes('approve') && !ready.methods.includes('resume'));

    const opened = await w.call('openSession', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: [ready.fixtureOrigin], toolClasses: ['observe', 'navigate', 'interact'] } });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const { sessionId, pageId } = opened.result;
    const o0 = (await w.call('observe', { sessionId, pageId })).result;
    const nav = await w.call('act', { sessionId, pageId, documentEpoch: o0.documentEpoch, operationId: 'op-nav-1', action: { kind: 'navigate', url: `${ready.fixtureOrigin}/preview.html` } });
    assert.equal(nav.result.status, 'verified', JSON.stringify(nav));
    const o1 = (await w.call('observe', { sessionId, pageId })).result;
    assert.equal(o1.trust, 'untrusted-page');
    const field = o1.nodes.find((n) => n.name === 'Display name');
    const fill = await w.call('act', { sessionId, pageId, observationId: o1.observationId, documentEpoch: o1.documentEpoch, operationId: 'op-fill-1', action: { kind: 'fill', ref: field.ref, text: 'Zed' } });
    assert.equal(fill.result.status, 'verified', JSON.stringify(fill));
    const click = await w.call('act', { sessionId, pageId, observationId: o1.observationId, documentEpoch: o1.documentEpoch, operationId: 'op-click-1', action: { kind: 'click', ref: o1.nodes.find((n) => n.name === 'Preview').ref } });
    assert.equal(click.result.status, 'verified');
    const o2 = (await w.call('observe', { sessionId, pageId })).result;
    assert.ok(o2.nodes.some((n) => n.role === 'status' && n.name === 'Status'));

    // protocol hygiene
    const bad = await w.call('nope', {});
    assert.deepEqual([bad.ok, bad.error.code], [false, 'UNSUPPORTED']);
    const approve = await w.call('approve', { approvalId: 'x', decision: 'allow' });
    assert.equal(approve.error.code, 'DENIED');
    const resume = await w.call('resume', {});
    assert.equal(resume.error.code, 'DENIED');
    const stale = await w.call('act', { sessionId, pageId, observationId: o1.observationId, documentEpoch: o1.documentEpoch - 1, operationId: 'op-stale', action: { kind: 'click', ref: field.ref } });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.dispatched, false);
    w.write('this is not json\n');
    const invalid = await w.next((l) => l.id === null);
    assert.equal(invalid.error.code, 'INVALID');
    const caps = await w.call('capabilities');
    assert.equal(caps.ok, true);

    // a whole run through the same facade
    const run = await w.call('startRun', { sessionId, pageId, requestKey: 'req-1', skillId: 'fixture-preview', skillVersion: '1.0.0', maxDurationMs: 30000, inputs: { name: 'Ada' } });
    assert.equal(run.ok, true, JSON.stringify(run));
    let dto = run.result;
    for (let i = 0; i < 200 && !['passed', 'failed', 'uncertain', 'cancelled', 'timedOut', 'interrupted'].includes(dto.state); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      dto = (await w.call('getRun', { runId: dto.runId })).result;
    }
    assert.equal(dto.verdict, 'passed', JSON.stringify(dto));

    const closed = await w.call('closeSession', { sessionId });
    assert.equal(closed.ok, true);
    w.end();
    assert.equal(await w.exited, EXIT.OK);
  } finally { if (!w.child.killed) w.child.kill(); }
});

needsBrowser('serve: without --origin no destination is granted (no ambient authority)', async () => {
  const w = worker([]);
  try {
    await w.next((l) => l.event === 'ready');
    const opened = await w.call('openSession', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['http://127.0.0.1:1'], toolClasses: ['observe', 'navigate'] } });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const { sessionId, pageId } = opened.result;
    const o = (await w.call('observe', { sessionId, pageId })).result;
    const nav = await w.call('act', { sessionId, pageId, documentEpoch: o.documentEpoch, operationId: 'op-n', action: { kind: 'navigate', url: 'http://127.0.0.1:1/' } });
    assert.equal(nav.ok, false);
    assert.equal(nav.error.code, 'DENIED');
    const noSkills = await w.call('startRun', { sessionId, pageId, requestKey: 'k1', skillId: 's', skillVersion: '1.0.0', maxDurationMs: 1000, inputs: {} });
    assert.equal(noSkills.ok, false);
    await w.call('closeSession', { sessionId });
    w.end();
    assert.equal(await w.exited, EXIT.OK);
  } finally { if (!w.child.killed) w.child.kill(); }
});
