#!/usr/bin/env node
// Cross-platform e2e launcher. Runs the app in self-test mode (BRAIWSER_E2E) and
// decides pass/fail itself instead of trusting the app's exit status:
//
//   dev tree      node scripts/e2e.js
//   packaged app  node scripts/e2e.js --app dist/linux-unpacked/braiwser
//                 (or BRAIWSER_E2E_APP=...); extra app arguments after `--`
//
// A run passes only if the app exits 0 AND a report is present, complete and
// ok:true (see scripts/lib/e2e-report.js). A crash, a hang, a missing report or a
// partial one all fail.
//
// Exit codes: 0 passed | 1 failed | 2 timed out | 3 harness error (the launcher
// could not do what was asked, e.g. crash injection failed). CI relies on the
// distinction: the crash gate expects exactly 1.
//
// Environment
//   BRAIWSER_E2E_TIMEOUT_MS   the app's own watchdog (src/main/e2e-finalizer.js), default
//                             600000 (10 min); the app reports a 'timeout' and exits 1
//   BRAIWSER_E2E_GRACE_MS     extra time the launcher allows beyond that before it kills
//                             the app itself (exit 2), default 60000
//   BRAIWSER_E2E_MIN_CHECKS   a report with fewer checks fails, default 50
//   BRAIWSER_E2E_REPORT_FILE  optional JSON-file transport for the report (the launcher
//                             picks the path); the stdout line is always accepted too
//   BRAIWSER_E2E_CRASH=1      crash the renderer mid-suite (over CDP); the run is
//                             then EXPECTED to fail with exit code 1
//   BRAIWSER_E2E_CRASH_DELAY_MS  delay before the crash, default 5000
//   BRAIWSER_E2E_CRASH_WAIT_MS   how long to wait for the app's DevTools endpoint, default 90000
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reportFromFile, reportFromStdout, verdict, reportProblems } = require('./lib/e2e-report');

const root = path.join(__dirname, '..');

function parseArgs(argv, env) {
  const out = { app: env.BRAIWSER_E2E_APP || '', runner: '', appArgs: [] };
  const dashes = argv.indexOf('--');
  const own = dashes >= 0 ? argv.slice(0, dashes) : argv;
  if (dashes >= 0) out.appArgs = argv.slice(dashes + 1);
  const i = own.indexOf('--app');
  if (i >= 0) out.app = own[i + 1] || '';
  const r = own.indexOf('--runner');
  if (r >= 0) out.runner = own[r + 1] || '';
  return out;
}

// Never let the harness see or spend a real credential: AI tasks must take the
// credential-free path in CI exactly as they would on a clean machine.
function hermeticEnv(base, reportFile) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  const nowhere = path.join(os.tmpdir(), 'braiwser-e2e-no-credentials');
  env.CLAUDE_CREDENTIALS_FILE = path.join(nowhere, 'claude.json');
  env.CODEX_AUTH_FILE = path.join(nowhere, 'codex.json');
  env.BRAIWSER_E2E = '1';
  env.CAOS_E2E = '1';
  env.BRAIWSER_E2E_REPORT_FILE = reportFile;
  return env;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid == null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch (_e) { /* already gone */ }
}

async function main() {
  const { app, runner, appArgs } = parseArgs(process.argv.slice(2), process.env);
  const appTimeoutMs = Number(process.env.BRAIWSER_E2E_TIMEOUT_MS) || 10 * 60 * 1000;
  const graceMs = process.env.BRAIWSER_E2E_GRACE_MS != null ? Number(process.env.BRAIWSER_E2E_GRACE_MS) : 60 * 1000;
  const timeoutMs = appTimeoutMs + (Number.isFinite(graceMs) ? graceMs : 60 * 1000);
  const minChecks = Number(process.env.BRAIWSER_E2E_MIN_CHECKS) || 50;
  const crashMode = process.env.BRAIWSER_E2E_CRASH === '1';

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-e2e-'));
  const reportFile = process.env.BRAIWSER_E2E_REPORT_FILE || path.join(reportDir, 'report.json');
  try { fs.rmSync(reportFile, { force: true }); } catch (_e) { /* fresh path */ }

  let command;
  let args;
  if (app) {
    const target = path.resolve(app);
    if (!fs.existsSync(target)) {
      console.error(`E2E launcher: packaged app not found: ${target}`);
      return 3;
    }
    // --runner wraps the target (used by this repo's launcher tests to run a stand-in app).
    command = runner || target;
    args = [...(runner ? [target] : []), '--no-sandbox', ...appArgs];
  } else {
    command = require('electron');
    args = [root, '--no-sandbox', ...appArgs];
  }

  let debugPort = null;
  if (crashMode) {
    try {
      debugPort = (await require('./lib/cdp-crash').freePort()).port;
    } catch (err) {
      console.error(`E2E launcher: no free port for crash injection: ${err.message}`);
      return 3;
    }
    args.push(`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*');
  }

  console.log(`E2E launcher: ${app ? 'packaged app' : 'dev tree'}${crashMode ? ' (intentional renderer crash)' : ''}`);
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...hermeticEnv(process.env, reportFile), BRAIWSER_E2E_TIMEOUT_MS: String(appTimeoutMs) },
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    stdout += chunk.toString('utf8');
    if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
  });

  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.on('error', (err) => { spawnError = err; resolve({ code: 1, signal: null }); });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let crashInjected = !crashMode;
  let crashError = null;
  if (crashMode) {
    require('./lib/cdp-crash')
      .crashRenderer({
        port: debugPort,
        delayMs: Number(process.env.BRAIWSER_E2E_CRASH_DELAY_MS) || 5000,
        waitMs: Number(process.env.BRAIWSER_E2E_CRASH_WAIT_MS) || 90000,
        log: (m) => console.log(`E2E launcher: ${m}`),
      })
      .then(() => { crashInjected = true; })
      .catch((err) => { crashError = err; killTree(child); });
  }

  const { code, signal } = await exited;
  clearTimeout(deadline);
  // Give the app's final stdout a tick to arrive after the process closes.
  await new Promise((r) => setImmediate(r));

  if (spawnError) {
    console.error(`E2E launcher: could not start the app: ${spawnError.message}`);
    return 3;
  }
  if (crashMode && !crashInjected) {
    console.error(`E2E launcher: the intentional crash could not be injected: ${crashError ? crashError.message : 'the app exited first'}`);
    return 3;
  }

  const report = reportFromFile(reportFile) || reportFromStdout(stdout);
  const result = verdict({ code, signal, timedOut, report, minChecks });

  if (result.passed) {
    console.log(`E2E launcher: PASSED (${report.checks.length} checks)`);
    return 0;
  }
  console.error('E2E launcher: FAILED');
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  return result.exitCode;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`E2E launcher: harness error: ${(err && err.stack) || err}`);
      process.exit(3);
    },
  );
}

module.exports = { parseArgs, hermeticEnv, reportProblems };
