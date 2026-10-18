'use strict';
// The real guest sources, bundled: shared modules resolved, loads in jsdom.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildBundle, collectModules } = require('../../scripts/bundle-guest');

const SRC = path.join(__dirname, '..', '..', 'src');
const REQ = /\brequire\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g;

test('real guest sources bundle deterministically and include the shared modules they require', () => {
  const text = buildBundle();
  assert.equal(text, buildBundle(), 'two builds are byte-identical');
  assert.doesNotThrow(() => new vm.Script(text));
  const modules = collectModules(SRC);
  const ids = modules.map((m) => m.id);
  assert.ok(ids.includes('webview/inspector') && ids.includes('webview/anchor'));
  assert.ok(ids.includes('shared/assertions') && ids.includes('shared/redact'), ids.join(','));
  assert.ok(!ids.some((id) => id.includes('dist/')), 'previous bundle output is never re-bundled');
  assert.ok(!ids.some((id) => /\.test$/.test(id)), 'tests are not bundled');
  // every relative require in every bundled module resolves to a bundled module
  for (const m of modules) {
    for (const r of m.source.matchAll(REQ)) {
      const parts = m.id.split('/'); parts.pop();
      for (const seg of r[2].split('/')) {
        if (seg === '..') parts.pop(); else if (seg !== '.' && seg) parts.push(seg);
      }
      const target = parts.join('/').replace(/\.js$/, '');
      assert.ok(ids.includes(target), `${m.id} requires ${r[2]} -> ${target}, missing from bundle`);
    }
  }
});

test('the real bundle loads in jsdom with webview AND shared modules resolved inside it', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><button id="b">go</button></body></html>', {
    url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  // Record every module the bundle's loader instantiates.
  const text = buildBundle().replace(
    'function __load(id) {',
    'function __load(id) { (globalThis.__bundleLoaded = globalThis.__bundleLoaded || []).push(id);',
  );
  assert.ok(text.includes('__bundleLoaded'), 'instrumentation applied');
  const electronCalls = [];
  const fakeElectron = {
    ipcRenderer: { on: (ch) => electronCalls.push(ch), send() {}, sendToHost() {}, invoke: async () => ({}), removeListener() {} },
  };
  const realRequires = [];
  const ctx = dom.getInternalVMContext();
  const fn = new vm.Script(`(function (require) {\n${text}\n})`, { filename: 'guest-preload.bundle.js' }).runInContext(ctx);
  fn((name) => {
    realRequires.push(name);
    if (name === 'electron') return fakeElectron;
    throw new Error('unexpected external require ' + name);
  });
  const loaded = vm.runInContext('globalThis.__bundleLoaded', ctx);
  for (const id of ['webview/inspector', 'webview/anchor', 'webview/recorder', 'webview/replay', 'shared/redact', 'shared/assertions']) {
    assert.ok(loaded.includes(id), `${id} was not loaded; loaded: ${loaded.join(',')}`);
  }
  assert.deepEqual(Array.from(new Set(realRequires)), ['electron'], 'only electron escapes to the preload require');
  assert.ok(electronCalls.length > 0, 'inspector registered its ipc listeners');
});
