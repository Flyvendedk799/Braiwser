'use strict';
// The registry must not drag Playwright or Electron into processes that do not use them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'browser', 'drivers', 'index.js');
const probeLoaded = (code) => JSON.parse(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, INDEX } }).stdout);

test('requiring the registry and creating drivers loads neither playwright-core nor electron', () => {
  const r = probeLoaded(`
    const { createDrivers } = require(process.env.INDEX);
    const d = createDrivers();
    const names = Object.keys(require.cache);
    console.log(JSON.stringify({ keys: Object.keys(d), pw: names.some(n => /playwright-core/.test(n)), el: names.some(n => /[\\/]electron[\\/]/.test(n)) }));
  `);
  assert.deepEqual(r.keys, ['playwright', 'electron-embedded']);
  assert.equal(r.pw, false);
  assert.equal(r.el, false);
});

test('drivers are created lazily and cached; playwright-core loads only on open()', () => {
  const r = probeLoaded(`
    const { createDrivers } = require(process.env.INDEX);
    const d = createDrivers();
    const p1 = d.playwright; const p2 = d.playwright;
    const caps = p1.capabilities();
    const names = Object.keys(require.cache);
    console.log(JSON.stringify({ same: p1 === p2, name: p1.name, ename: d['electron-embedded'].name, driver: caps.driver, pw: names.some(n => /playwright-core/.test(n)) }));
  `);
  assert.deepEqual([r.same, r.name, r.ename, r.driver, r.pw], [true, 'playwright', 'electron-embedded', 'playwright', false]);
});

test('the registry can be restricted and rejects unknown drivers', () => {
  const { createDrivers, driverNames } = require(INDEX);
  assert.deepEqual(Object.keys(createDrivers({ only: 'playwright' })), ['playwright']);
  assert.throws(() => createDrivers({ only: ['chrome-extension'] }), /UNKNOWN_DRIVER/);
  assert.deepEqual(driverNames(), ['playwright', 'electron-embedded']);
});
