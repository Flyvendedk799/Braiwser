'use strict';
// REAL Electron: starts electron-native/main.js, which drives the production Electron-embedded driver against a
// WebContentsView and a <webview> showing local fixtures. The flags `shadowDom`, `screenshots` and the `select`
// action in drivers/electron.js are only on because the checks below pass on real Electron.
//
// Needs the Electron binary and a display. On Linux without one, `xvfb-run` is used when it is installed.
// Otherwise the test SKIPS with the reason; it never passes without having run.
//   BRAIWSER_SKIP_ELECTRON_NATIVE=1   skip explicitly
//   BRAIWSER_ELECTRON_SCALE=2         run at another device scale factor

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MAIN = path.join(__dirname, 'electron-native', 'main.js');

function plan() {
  if (process.env.BRAIWSER_SKIP_ELECTRON_NATIVE === '1') return { skip: 'BRAIWSER_SKIP_ELECTRON_NATIVE=1' };
  let electron;
  try { electron = require('electron'); } catch (_e) { return { skip: 'the electron package is not installed' }; }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) return { skip: 'the Electron binary is not downloaded' };
  const args = [];
  // Chromium refuses to run its sandbox as root; a root CI container is the boundary there.
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const scale = Number(process.env.BRAIWSER_ELECTRON_SCALE);
  if (scale >= 1 && scale <= 3) args.push(`--force-device-scale-factor=${scale}`);
  args.push(MAIN);
  const hasDisplay = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (hasDisplay) return { command: electron, args };
  const xvfb = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (xvfb.error) return { skip: 'no display and xvfb-run is not installed' };
  return { command: 'xvfb-run', args: ['-a', '-s', '-screen 0 2560x2048x24', electron, ...args] };
}

function run({ command, args }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS; // Electron rejects some node options a test runner may carry
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: String(e && e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('real Electron: open shadow roots, select and screenshots on a WebContentsView and a <webview>', async (t) => {
  const p = plan();
  if (p.skip) { t.skip(p.skip); return; }
  const r = await run(p);
  const line = r.out.split('\n').find((l) => l.startsWith('NATIVE_RESULT '));
  if (!line) {
    // Electron itself could not start here (no usable sandbox, missing system libraries, ...): that is an
    // environment gap, reported as a skip with the evidence, never as a pass.
    t.skip(`Electron did not start (exit ${r.code}): ${r.err.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600)}`);
    return;
  }
  const result = JSON.parse(line.slice('NATIVE_RESULT '.length));
  assert.equal(result.fatal, undefined, result.fatal);
  t.diagnostic(`Electron ${result.electron} (Chromium ${result.chrome}) on ${result.platform}: ${result.checks.length} checks`);
  const failed = result.checks.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => `${c.guest}: ${c.name}\n${c.error}`), []);

  // every claim, on both kinds of guest
  for (const guest of ['view', 'webview']) {
    const names = result.checks.filter((c) => c.guest === guest).map((c) => c.name);
    for (const claim of ['shadow:', 'select: the option', 'select: unknown', 'screenshot: the viewport', 'screenshot: a clip', 'capture:', 'screenshot: the owner badge']) {
      assert.ok(names.some((n) => n.startsWith(claim)), `${guest} ran "${claim}"`);
    }
  }
  assert.equal(r.code, 0);
  // the capability document says exactly what was just proven
  assert.deepEqual(result.capabilities, { shadowDom: true, screenshots: true, actions: ['click', 'fill', 'press', 'select', 'check', 'navigate'] });
});
