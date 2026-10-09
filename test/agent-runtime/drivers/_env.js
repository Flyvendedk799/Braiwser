'use strict';
// Shared helpers for the real-browser driver tests. Not a test file (no .test.js).
//
//   * Browser availability is probed ONCE per process per mode. When Chromium is not
//     installed the real-browser tests SKIP (t.skip) with the reason; they never
//     silently pass.
//   * Pages are LOCAL fixtures only (127.0.0.1 ephemeral ports). Nothing here
//     navigates to an external site.

const path = require('node:path');
const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright');
const { startFixtureServer } = require('../../fixtures/agent-sites/server');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'agent-sites');
const OFFSCREEN = Object.freeze({ x: -2400, y: -2400 });

const probes = new Map();

function displayAvailable() {
  if (process.env.BRAIWSER_SKIP_VISIBLE === '1') return false;
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// -> { ok: boolean, reason?: string }
function browserAvailable(mode) {
  if (probes.has(mode)) return probes.get(mode);
  const p = (async () => {
    if (mode === 'visible' && !displayAvailable()) return { ok: false, reason: 'no display available for visible mode' };
    const driver = createPlaywrightDriver();
    try {
      const session = await driver.open({ mode, window: OFFSCREEN });
      await session.close();
      return { ok: true };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/Executable doesn't exist|playwright install|browserType\.launch.*(not found|install)|Failed to launch|ENOENT/i.test(msg)) {
        return { ok: false, reason: `Chromium unavailable: ${msg.split('\n')[0]}` };
      }
      // A launch failure that is NOT "binary missing" is a real failure: surface it.
      throw err;
    }
  })();
  probes.set(mode, p);
  return p;
}

async function openFixtureSession({ mode = 'headless', open = {} } = {}) {
  const origin = await startFixtureServer({ dir: FIXTURE_DIR });
  const other = await startFixtureServer({ dir: FIXTURE_DIR });
  const events = [];
  const driver = createPlaywrightDriver();
  const session = await driver.open({ mode, window: OFFSCREEN, onPageEvent: (e) => events.push(e), ...open });
  const page = session.pages.values().next().value;
  return {
    driver, session, page, events, origin, other,
    url: (file) => `${origin.origin}/${file}`,
    otherUrl: (file) => `${other.origin}/${file}`,
    async close() {
      await session.close().catch(() => {});
      await origin.close();
      await other.close();
    },
  };
}

const noopControl = (calls) => ({
  signal: null,
  check() { if (calls) calls.check += 1; },
  beforeDispatch() { if (calls) calls.beforeDispatch += 1; },
});

function nodeByName(obsv, name, role) {
  return obsv.nodes.find((n) => n.name === name && (!role || n.role === role));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

module.exports = { FIXTURE_DIR, OFFSCREEN, browserAvailable, displayAvailable, openFixtureSession, noopControl, nodeByName, sleep, waitFor };
