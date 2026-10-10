// REL-03: the launcher judges the report, not just the exit status.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { reportFromStdout, reportProblems, verdict } = require('../../scripts/lib/e2e-report');
const { pickShellTarget } = require('../../scripts/lib/cdp-crash');
const { hermeticEnv } = require('../../scripts/e2e');

const LAUNCHER = path.join(__dirname, '..', '..', 'scripts', 'e2e.js');
const FAKE = path.join(__dirname, 'fake-e2e-app.js');

function launch(mode, env = {}) {
  const res = spawnSync(process.execPath, [LAUNCHER, '--runner', process.execPath, '--app', FAKE], {
    env: { ...process.env, FAKE_MODE: mode, BRAIWSER_E2E_MIN_CHECKS: '50', BRAIWSER_E2E_TIMEOUT_MS: '20000', BRAIWSER_E2E_GRACE_MS: '200', ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

test('a complete ok:true report passes (file transport)', () => {
  const r = launch('pass');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASSED \(60 checks\)/);
});

test('a complete ok:true report passes (stdout transport, legacy alias parsing)', () => {
  assert.equal(launch('pass-stdout-only').code, 0);
  assert.deepEqual(reportFromStdout('noise\nCAOS_E2E_REPORT {"ok":true,"checks":[]}\n'), { ok: true, checks: [] });
});

test('exit 0 with NO report fails', () => {
  const r = launch('no-report');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no E2E report/);
});

test('a crash report fails even when the app exits 0 (the old app.quit() behaviour)', () => {
  const r = launch('crash-exit0');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /renderer crashed/);
});

test('a failed check, an incomplete report, too few checks, a truncated file and a non-zero exit all fail', () => {
  for (const mode of ['failed-check', 'incomplete', 'too-few', 'truncated', 'exit1']) {
    const r = launch(mode);
    assert.equal(r.code, 1, `${mode}\n${r.out}`);
  }
  assert.match(launch('failed-check').out, /check failed: check 7 :: boom/);
  assert.match(launch('incomplete').out, /incomplete/);
  assert.match(launch('truncated').out, /could not be parsed/);
});

test('a hung app is killed at the deadline with exit code 2', () => {
  const r = launch('hang', { BRAIWSER_E2E_TIMEOUT_MS: '1500' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /did not finish before the launcher deadline/);
});

test('the app never sees real credentials, and its credential files point nowhere', () => {
  const r = launch('pass', { ANTHROPIC_API_KEY: 'sk-ant-leak', OPENAI_API_KEY: 'sk-leak' });
  assert.equal(r.code, 0, r.out);
  const env = hermeticEnv({ ANTHROPIC_API_KEY: 'x', ELECTRON_RUN_AS_NODE: '1', PATH: 'p' }, 'r.json');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.BRAIWSER_E2E, '1');
  assert.equal(env.BRAIWSER_E2E_REPORT_FILE, 'r.json');
  assert.match(env.CLAUDE_CREDENTIALS_FILE, /no-credentials/);
});

test('a missing packaged app is a harness error (3), not a test failure', () => {
  const res = spawnSync(process.execPath, [LAUNCHER, '--app', path.join(__dirname, 'does-not-exist')], { encoding: 'utf8' });
  assert.equal(res.status, 3);
});

test('crash mode that cannot reach the app is a harness error (3), never a vacuous "failure"', () => {
  const r = launch('hang', { BRAIWSER_E2E_CRASH: '1', BRAIWSER_E2E_CRASH_WAIT_MS: '800', BRAIWSER_E2E_TIMEOUT_MS: '15000' });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /could not be injected/);
});

test('verdict combines process outcome and report', () => {
  const good = { ok: true, passed: 2, total: 2, checks: [{ name: 'a', pass: true }, { name: 'b', pass: true }] };
  assert.equal(verdict({ code: 0, signal: null, report: good, minChecks: 1 }).passed, true);
  assert.equal(verdict({ code: 0, signal: 'SIGKILL', report: good, minChecks: 1 }).passed, false);
  assert.equal(verdict({ code: 1, signal: null, report: good, minChecks: 1 }).exitCode, 1);
  assert.equal(verdict({ code: null, signal: null, timedOut: true, report: null, minChecks: 1 }).exitCode, 2);
  assert.ok(reportProblems({ ok: true, fatal: 'x', checks: good.checks }).some((p) => /fatal/.test(p)));
});

test('crash injection targets the shell page, not a guest page', () => {
  const targets = [
    { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://guest' },
    { type: 'page', url: 'file:///C:/app/src/renderer/index.html', webSocketDebuggerUrl: 'ws://shell' },
    { type: 'other', url: 'x' },
  ];
  assert.equal(pickShellTarget(targets).webSocketDebuggerUrl, 'ws://shell');
});
