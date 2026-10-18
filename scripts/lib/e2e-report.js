// Parsing and judging the e2e report. Pure functions, unit-tested in
// test/release/e2e-launcher.test.js.
//
// The app announces its result two ways and the launcher accepts either:
//   * a JSON file at $BRAIWSER_E2E_REPORT_FILE (preferred: it survives a crash that
//     truncates stdout), and
//   * a stdout line `BRAIWSER_E2E_REPORT {json}` (legacy alias `CAOS_E2E_REPORT`).
//
// "Exit code 0" alone is never enough. A run counts as PASSED only if the report is
// present, complete and says ok: a crashed or hung renderer that still lets Electron
// exit 0 must not read as green.
const fs = require('fs');

const MARKERS = ['BRAIWSER_E2E_REPORT ', 'CAOS_E2E_REPORT '];

// Last report line wins (a crash handler may print a partial one before the final).
function reportFromStdout(text) {
  let found = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = MARKERS.find((m) => line.startsWith(m));
    if (!marker) continue;
    try {
      found = JSON.parse(line.slice(marker.length));
    } catch (_e) {
      found = { unparsable: true };
    }
  }
  return found;
}

function reportFromFile(file) {
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { unparsable: true, error: err.message };
  }
  if (!text.trim()) return { unparsable: true, error: 'report file is empty' };
  try {
    return JSON.parse(text);
  } catch (err) {
    return { unparsable: true, error: err.message };
  }
}

// Everything that makes a report NOT a clean pass. Empty array = passed.
function reportProblems(report, { minChecks = 1 } = {}) {
  const problems = [];
  if (!report) return ['no E2E report was produced (the app exited or was killed before finishing)'];
  if (typeof report !== 'object' || Array.isArray(report)) return ['the E2E report is not an object'];
  if (report.unparsable) return [`the E2E report could not be parsed${report.error ? ` (${report.error})` : ''}`];

  if (report.crashed) problems.push('the renderer crashed during the run');
  if (report.timedOut || report.timeout) problems.push('the run timed out');
  if (report.fatal) problems.push(`fatal error: ${report.fatal}`);
  if (report.ok !== true) problems.push('report.ok is not true');

  const checks = Array.isArray(report.checks) ? report.checks : null;
  if (!checks) {
    problems.push('the report has no checks array');
    return problems;
  }
  if (checks.length < minChecks) problems.push(`only ${checks.length} checks were reported (expected at least ${minChecks})`);
  const failed = checks.filter((c) => !c || c.pass !== true);
  for (const c of failed.slice(0, 20)) problems.push(`check failed: ${(c && c.name) || '(unnamed)'}${c && c.detail ? ` :: ${c.detail}` : ''}`);
  if (failed.length > 20) problems.push(`... and ${failed.length - 20} more failed checks`);
  if (Number.isFinite(report.total) && report.total !== checks.length) {
    problems.push(`report.total (${report.total}) does not match the number of checks (${checks.length}): the run is incomplete`);
  }
  if (Number.isFinite(report.passed) && report.passed !== checks.length - failed.length) {
    problems.push(`report.passed (${report.passed}) does not match the passing checks (${checks.length - failed.length})`);
  }
  return problems;
}

// Combine process outcome and report into the launcher's verdict.
//   exit codes: 0 passed, 1 failed (tests, crash, missing/incomplete report),
//               2 timed out, 3 harness error (could not run what was asked)
function verdict({ code, signal, timedOut, report, minChecks }) {
  const reasons = [];
  if (timedOut) reasons.push('the app did not finish before the launcher deadline and was killed');
  if (signal) reasons.push(`the app was terminated by signal ${signal}`);
  else if (code !== 0 && !timedOut) reasons.push(`the app exited with code ${code}`);
  reasons.push(...reportProblems(report, { minChecks }));
  const passed = !timedOut && !signal && code === 0 && reasons.length === 0;
  return { passed, exitCode: passed ? 0 : timedOut ? 2 : 1, reasons };
}

module.exports = { reportFromStdout, reportFromFile, reportProblems, verdict, MARKERS };
