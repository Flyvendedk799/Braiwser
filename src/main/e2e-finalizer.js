// Single finalizer for every terminal E2E state (audit REL-03).
//
// Normal completion (renderer posts caos:e2e-done), a renderer crash, an
// unresponsive/failed-to-load window, an uncaught main-process exception and the
// overall watchdog timeout ALL funnel through `finalize()`. It is idempotent
// (the first terminal state wins), always prints the report, and calls
// `app.exit(code)` — never `app.quit()`, which exits 0.
//
// Success requires a COMPLETE report: terminal === 'completed', a report object
// with ok !== false, no `fatal`, at least one check, every check passing, and
// `total` equal to the number of checks it lists. Anything else exits 1.
//
// REPORT FORMAT (stable; scripts/e2e.js parses it). Two identical stdout lines:
//   BRAIWSER_E2E_REPORT <json>
//   CAOS_E2E_REPORT <json>          (legacy alias)
// where <json> is a single-line object:
//   {
//     ok:        boolean,           // true only for a complete, fully passing run
//     passed:    number,            // checks with pass === true
//     total:     number,            // checks listed
//     checks:    [{ name, pass, detail }],
//     terminal:  'completed' | 'render-process-gone' | 'timeout' | 'unresponsive'
//                | 'load-failed' | 'main-exception' | 'incomplete-report',
//     exitCode:  0 | 1,             // what the main process is about to exit with
//     reason?:   string,            // why a non-completed/incomplete state failed
//     crashed?:  true,              // renderer/main died before finishing
//     fatal?:    string             // renderer-reported fatal error
//   }
// A human line `E2E PASSED|FAILED — p/t checks` precedes it. Exactly one report
// is printed per process.
'use strict';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function createE2EFinalizer({ app, log = console.log, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout, exitDelayMs = 100 } = {}) {
  const streamed = []; // checks as they arrive, so a crash still reports progress
  let finalized = null;
  let watchdog = null;

  function recordCheck(c) {
    if (c && typeof c === 'object') streamed.push(c);
    return true;
  }

  function partial() { return streamed; }

  function finalize(terminal, { report, reason } = {}) {
    if (finalized) return finalized;
    if (watchdog) { clearTimer(watchdog); watchdog = null; }

    const reported = report && typeof report === 'object' ? report : null;
    const checks = reported && Array.isArray(reported.checks) ? reported.checks : streamed.slice();
    const failures = checks.filter((c) => !c || !c.pass);
    const passed = checks.length - failures.length;
    let why = reason || '';

    let ok = terminal === 'completed';
    let structural = false; // report itself unusable (vs. tests that merely failed)
    if (ok && !reported) { ok = false; structural = true; why = why || 'no report was posted'; }
    if (ok && reported.ok === false) { ok = false; why = why || 'report.ok is false'; }
    if (ok && reported.fatal) { ok = false; why = why || 'renderer reported a fatal error'; }
    if (ok && checks.length === 0) { ok = false; structural = true; why = why || 'report contains no checks'; }
    if (ok && failures.length) { ok = false; why = why || `${failures.length} check(s) failed`; }
    if (ok && reported.total !== checks.length) { ok = false; structural = true; why = why || `report.total (${reported.total}) does not match its checks (${checks.length})`; }
    if (ok && streamed.length > checks.length) { ok = false; structural = true; why = why || `report lists ${checks.length} checks but ${streamed.length} were streamed`; }
    if (terminal === 'completed' && structural) terminal = 'incomplete-report';

    const out = {
      ...(reported || {}),
      ok,
      passed,
      total: checks.length,
      checks,
      terminal,
      exitCode: ok ? 0 : 1,
    };
    if (!ok && why) out.reason = why;
    if (terminal !== 'completed' && terminal !== 'incomplete-report') out.crashed = true;

    if (out.fatal) log('E2E FATAL: ' + out.fatal);
    if (!ok && why) log('E2E REASON: ' + why);
    for (const f of failures) log(`E2E FAIL: ${(f && f.name) || '(unnamed)'}${f && f.detail ? ' :: ' + f.detail : ''}`);
    log(`E2E ${ok ? 'PASSED' : 'FAILED'} — ${passed}/${checks.length} checks`);
    const line = JSON.stringify(out);
    log('BRAIWSER_E2E_REPORT ' + line);
    log('CAOS_E2E_REPORT ' + line);

    finalized = out;
    // Exit non-zero on any failure so CI actually goes red.
    setTimer(() => app.exit(ok ? 0 : 1), exitDelayMs);
    return out;
  }

  function arm(ms) {
    const t = ms || timeoutMs || Number(process.env.BRAIWSER_E2E_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    if (watchdog) clearTimer(watchdog);
    watchdog = setTimer(() => finalize('timeout', { reason: `suite did not finish within ${t} ms` }), t);
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
  }

  return { recordCheck, partial, finalize, arm, isFinalized: () => !!finalized };
}

// Process-wide instance used by main.js and ipc/index.js.
let shared = null;
function getE2EFinalizer(app) {
  if (!shared) shared = createE2EFinalizer({ app });
  return shared;
}

module.exports = { createE2EFinalizer, getE2EFinalizer, DEFAULT_TIMEOUT_MS };
