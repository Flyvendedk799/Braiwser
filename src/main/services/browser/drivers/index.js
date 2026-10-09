'use strict';
// Driver registry. Drivers are created lazily so that requiring this module never
// loads playwright-core or Electron (the headless CLI must run without Electron,
// and the Electron main process must not pay for Playwright).
//
//   const { createDrivers } = require('./drivers');
//   const drivers = createDrivers({ electron: { debuggerBroker } });
//   drivers.playwright.open({ mode: 'headless' })        // DriverSession
//   drivers['electron-embedded'].registerGuest(wc)       // main-owned guest registry

const NAMES = Object.freeze(['playwright', 'electron-embedded']);

function createDrivers(options) {
  const o = options || {};
  const cache = new Map();
  const factories = {
    playwright: () => require('./playwright').createPlaywrightDriver(o.playwright),
    'electron-embedded': () => require('./electron').createElectronDriver(o.electron),
  };
  const wanted = o.only ? [].concat(o.only) : NAMES.slice();
  const out = {};
  for (const name of wanted) {
    if (!factories[name]) throw new Error(`UNKNOWN_DRIVER:${name}`);
    Object.defineProperty(out, name, {
      enumerable: true,
      get() {
        if (!cache.has(name)) cache.set(name, factories[name]());
        return cache.get(name);
      },
    });
  }
  return out;
}

function driverNames() { return NAMES.slice(); }

module.exports = { createDrivers, driverNames, get driverError() { return require('./observe').driverError; } };
