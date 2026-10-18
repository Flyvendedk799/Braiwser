'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { renderBundle, writeBundle, bundleStatus } = require('../../scripts/bundle-guest');

function run(code, fakeRequire) {
  const sandbox = { result: null, console };
  vm.createContext(sandbox);
  vm.runInContext(`(function (require) {\n${code}\n})`, sandbox)(fakeRequire);
  return sandbox;
}

test('bundle resolves relative requires inside itself and everything else via the preload require', () => {
  const log = [];
  const code = renderBundle([
    { id: 'entry', source: "const a = require('./a'); const { b } = require('./lib/b.js'); const e = require('electron'); globalThis.result = [a.v, b, e.name, require('./a') === a];" },
    { id: 'a', source: "module.exports = { v: 'A' };" },
    { id: 'lib/b', source: "const a = require('../a'); exports.b = a.v + 'B';" },
  ], 'entry');
  const sandbox = run(code, (name) => { log.push(name); return { name }; });
  assert.deepEqual(Array.from(sandbox.result), ['A', 'AB', 'electron', true]);
  assert.deepEqual(log, ['electron'], 'only non-relative requires reach the real require');
});

test('circular requires get the in-progress exports, like Node', () => {
  const code = renderBundle([
    { id: 'main', source: "const x = require('./x'); globalThis.result = x.seenY;" },
    { id: 'x', source: "exports.early = 1; const y = require('./y'); exports.seenY = y.sawEarly;" },
    { id: 'y', source: "const x = require('./x'); exports.sawEarly = x.early;" },
  ], 'main');
  assert.equal(run(code, () => ({})).result, 1);
});

test('a missing bundled module is a loud error, not a silent undefined', () => {
  const code = renderBundle([{ id: 'main', source: "require('./nope');" }], 'main');
  assert.throws(() => run(code, () => ({})), /Cannot find module nope/);
  assert.throws(() => renderBundle([{ id: 'a', source: '' }], 'main'), /entry "main" not found/);
});

test('output is deterministic, order-independent, LF-normalised, timestamp-free', () => {
  const mods = [
    { id: 'b', source: "exports.b = 1;\r\n" },
    { id: 'main', source: "require('./b');\r\n" },
  ];
  const one = renderBundle(mods, 'main');
  const two = renderBundle(mods.slice().reverse(), 'main');
  const three = renderBundle(mods.map((m) => ({ ...m, source: m.source.replace(/\r\n/g, '\n') })), 'main');
  assert.equal(one, two);
  assert.equal(one, three);
  assert.ok(!/\r/.test(one));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(one.split('\n').slice(0, 3).join('\n')), 'no date in header');
  const changed = renderBundle([{ id: 'b', source: 'exports.b = 2;' }, mods[1]], 'main');
  assert.notEqual(one.match(/bundle-hash: (\w+)/)[1], changed.match(/bundle-hash: (\w+)/)[1]);
});

test('writeBundle / bundleStatus detect missing and stale output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-bundle-'));
  try {
    const src = path.join(dir, 'webview');
    fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.writeFileSync(path.join(src, 'inspector.js'), "module.exports = require('./dep') + require('../shared/s');");
    fs.writeFileSync(path.join(dir, 'shared', 's.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(src, 'dep.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(src, 'unused.js'), 'throw new Error("never bundled: unreachable")');
    const out = path.join(src, 'dist', 'guest-preload.bundle.js');
    const opts = { root: dir, out, entry: 'webview/inspector' };
    assert.equal(bundleStatus(opts), 'missing');
    const r = writeBundle(opts);
    assert.ok(r.bytes > 0);
    assert.equal(bundleStatus(opts), 'fresh');
    fs.writeFileSync(path.join(dir, 'shared', 's.js'), 'module.exports = 2;');
    assert.equal(bundleStatus(opts), 'stale', 'a shared-module change makes the bundle stale');
    writeBundle(opts);
    assert.equal(bundleStatus(opts), 'fresh', 'dist output does not feed back into the bundle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
