// Stand-in for the Electron app, driven by FAKE_MODE, used by e2e-launcher.test.js.
// Not a test file (no .test suffix): it is spawned as a child process.
const fs = require('node:fs');

const mode = process.env.FAKE_MODE || 'pass';
const file = process.env.BRAIWSER_E2E_REPORT_FILE;

function checks(n, failAt = -1) {
  return Array.from({ length: n }, (_, i) => ({ name: `check ${i}`, pass: i !== failAt, ...(i === failAt ? { detail: 'boom' } : {}) }));
}
function report(n, extra = {}, failAt = -1) {
  const c = checks(n, failAt);
  const passed = c.filter((x) => x.pass).length;
  return { ok: failAt < 0, passed, total: n, checks: c, ...extra };
}
function toFile(r) { fs.writeFileSync(file, JSON.stringify(r)); }
function toStdout(r) { console.log('BRAIWSER_E2E_REPORT ' + JSON.stringify(r)); }

// The harness must never see real credentials.
if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
  console.log('LEAK: credentials visible to the app');
  process.exit(9);
}

switch (mode) {
  case 'pass': toFile(report(60)); break;
  case 'pass-stdout-only': toStdout(report(60)); break;
  case 'no-report': break; // exits 0 without any report
  case 'crash-exit0': toStdout({ ok: false, crashed: true, passed: 12, total: 12, checks: checks(12) }); break; // old behaviour: app.quit() => exit 0
  case 'failed-check': toFile(report(60, {}, 7)); break;
  case 'incomplete': { const r = report(60); r.total = 80; toFile(r); break; }
  case 'too-few': toFile(report(3)); break;
  case 'truncated': fs.writeFileSync(file, '{"ok":true,"checks":['); break;
  case 'exit1': toFile(report(60)); process.exitCode = 1; break;
  case 'hang': setInterval(() => {}, 1000); break;
  default: throw new Error('unknown FAKE_MODE ' + mode);
}
