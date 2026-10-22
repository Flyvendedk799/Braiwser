'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright');

// A launch that records its options and then stops; nothing past launch matters here.
function recordingPlaywright(seen) {
  return { chromium: { launch: async (options) => { seen.push(options); throw new Error('stop after launch'); } } };
}
const open = (driver) => driver.open({ mode: 'headless', grant: null }).catch(() => {});

test('the browser sandbox stays on by default', async () => {
  const seen = [];
  await open(createPlaywrightDriver({ playwright: recordingPlaywright(seen), executablePath: '/x/chrome' }));
  assert.equal(seen[0].chromiumSandbox, true);
  assert.ok(!seen[0].args.includes('--disable-dev-shm-usage'));
});

test('a supervisor in a locked-down container can turn the browser sandbox off', async () => {
  const seen = [];
  await open(createPlaywrightDriver({ playwright: recordingPlaywright(seen), executablePath: '/x/chrome', chromiumSandbox: false }));
  assert.equal(seen[0].chromiumSandbox, false);
  assert.ok(seen[0].args.includes('--disable-dev-shm-usage'));
});

test('only an explicit false disables it', async () => {
  for (const value of [undefined, null, 0, '', 'false', true]) {
    const seen = [];
    await open(createPlaywrightDriver({ playwright: recordingPlaywright(seen), executablePath: '/x/chrome', chromiumSandbox: value }));
    assert.equal(seen[0].chromiumSandbox, true, String(value));
  }
});

function recordingContext(seen) {
  return { chromium: { launch: async () => ({ version: () => '156.0.7390.12', newContext: async (options) => { seen.push(options); throw new Error('stop after context'); }, close: async () => {} }) } };
}

test('a supervisor can make the browser report the Chrome it is instead of HeadlessChrome', async () => {
  const seen = [];
  await open(createPlaywrightDriver({ playwright: recordingContext(seen), executablePath: '/x/chrome', standardUserAgent: true }));
  assert.match(seen[0].userAgent, /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/156\.0\.0\.0 Safari\/537\.36$/);
  assert.ok(!seen[0].userAgent.includes('Headless'));
});

test('by default the browser keeps its own user agent', async () => {
  const seen = [];
  await open(createPlaywrightDriver({ playwright: recordingContext(seen), executablePath: '/x/chrome' }));
  assert.equal(seen[0].userAgent, undefined);
});
