'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonCollection, JsonDocument, StoreError, transact, cleanupStaleTmp } = require('../../src/main/store/db');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-db-')); }
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// A fs wrapper whose named methods can be made to fail on demand.
function faultyFs(rules = {}) {
  const wrapped = Object.create(fs);
  const state = { rules };
  for (const name of ['readFileSync', 'writeFileSync', 'renameSync', 'openSync', 'statSync', 'fsyncSync']) {
    wrapped[name] = (...args) => {
      const rule = state.rules[name];
      if (rule && rule(args)) {
        const err = new Error(`injected ${name} failure`);
        err.code = 'EIO';
        throw err;
      }
      return fs[name](...args);
    };
  }
  wrapped.state = state;
  return wrapped;
}

test('missing file is a new empty store (ENOENT only)', () => {
  const dir = tmp();
  const c = new JsonCollection(dir, 'things');
  assert.deepEqual(c.all(), []);
  assert.equal(c.status().ok, true);
  c.insert({ id: 'a' });
  assert.deepEqual(read(c.file), [{ id: 'a' }]);
});

test('MB-04: a failed write leaves disk and visible state unchanged and is never resurrected', () => {
  const dir = tmp();
  const fx = faultyFs();
  const c = new JsonCollection(dir, 'things', { fs: fx });
  c.insert({ id: 'a' });
  fx.state.rules.renameSync = () => true;
  assert.throws(() => c.insert({ id: 'rejected' }), /Failed to persist/);
  assert.deepEqual(c.all().map((x) => x.id), ['a'], 'visible state unchanged');
  assert.deepEqual(read(c.file).map((x) => x.id), ['a'], 'disk unchanged');
  assert.throws(() => c.update('a', { v: 1 }), StoreError);
  assert.equal(c.get('a').v, undefined);
  fx.state.rules.renameSync = null;
  c.insert({ id: 'b' });
  assert.deepEqual(read(c.file).map((x) => x.id), ['a', 'b'], 'rejected record did not come back');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no stray temp files');
});

test('MB-04: write (open/fsync) failures are rolled back the same way', () => {
  for (const op of ['openSync', 'fsyncSync', 'writeFileSync']) {
    const dir = tmp();
    const fx = faultyFs();
    const c = new JsonCollection(dir, 'things', { fs: fx });
    c.insert({ id: 'a' });
    fx.state.rules[op] = (args) => op !== 'openSync' || String(args[0]).endsWith('.tmp');
    assert.throws(() => c.remove('a'), StoreError, op);
    assert.deepEqual(c.all().map((x) => x.id), ['a'], op);
  }
});

test('MB-04: transact rolls back files already written when a later one fails', () => {
  const dir = tmp();
  const fx = faultyFs();
  const a = new JsonCollection(dir, 'a', { fs: fx });
  const b = new JsonCollection(dir, 'b', { fs: fx });
  a.insert({ id: 'a1' });
  b.insert({ id: 'b1' });
  fx.state.rules.renameSync = (args) => String(args[1]).endsWith('b.json');
  assert.throws(() => transact([a, b], (tx) => {
    tx(a).insert({ id: 'a2' });
    tx(b).remove('b1');
  }), StoreError);
  fx.state.rules.renameSync = null;
  assert.deepEqual(read(a.file).map((x) => x.id), ['a1'], 'first file restored');
  assert.deepEqual(a.all().map((x) => x.id), ['a1']);
  assert.deepEqual(b.all().map((x) => x.id), ['b1']);
  // and the store still works afterwards
  a.insert({ id: 'a3' });
  assert.deepEqual(read(a.file).map((x) => x.id), ['a1', 'a3']);
});

test('MB-05: a transient read error never erases data on the next write', () => {
  const dir = tmp();
  const seed = new JsonCollection(dir, 'things');
  seed.insert({ id: 'keep' });
  const fx = faultyFs({ readFileSync: (args) => String(args[0]).endsWith('things.json') });
  const c = new JsonCollection(dir, 'things', { fs: fx });
  assert.deepEqual(c.all(), [], 'reads degrade to empty while unreadable');
  assert.equal(c.status().state, 'unreadable');
  assert.throws(() => c.insert({ id: 'x' }), /STORE_READ_ONLY/);
  assert.deepEqual(read(c.file).map((x) => x.id), ['keep'], 'file untouched');
  // the error was transient: once reads work again the store recovers by itself
  fx.state.rules.readFileSync = null;
  assert.deepEqual(c.all().map((x) => x.id), ['keep']);
  assert.equal(c.status().ok, true);
  c.insert({ id: 'y' });
  assert.deepEqual(read(c.file).map((x) => x.id), ['keep', 'y']);
});

test('MB-05: invalid JSON and wrong shapes are kept, read-only, and use the backup', () => {
  for (const bad of ['{ not json', '{"id":"obj"}', '[1,2,3]', '"str"']) {
    const dir = tmp();
    const c = new JsonCollection(dir, 'things');
    c.insert({ id: 'one' });
    c.insert({ id: 'two' }); // makes .bak = [one]
    fs.writeFileSync(c.file, bad);
    const fresh = new JsonCollection(dir, 'things');
    assert.deepEqual(fresh.all().map((x) => x.id), ['one'], `serves last-good backup for ${bad}`);
    const st = fresh.status();
    assert.equal(st.state, 'corrupt');
    assert.equal(st.readOnly, true);
    assert.equal(st.backupAvailable, true);
    assert.throws(() => fresh.insert({ id: 'x' }), /STORE_READ_ONLY/);
    assert.equal(fs.readFileSync(c.file, 'utf8'), bad, 'damaged file untouched');
  }
});

test('MB-05: explicit recovery quarantines the damaged file and continues from backup', () => {
  const dir = tmp();
  const c = new JsonCollection(dir, 'things');
  c.insert({ id: 'one' });
  c.insert({ id: 'two' });
  fs.writeFileSync(c.file, '{{{');
  const fresh = new JsonCollection(dir, 'things');
  const r = fresh.recover();
  assert.equal(r.recovered, true);
  assert.equal(r.from, 'backup');
  assert.ok(fs.existsSync(r.quarantined));
  assert.equal(fs.readFileSync(r.quarantined, 'utf8'), '{{{');
  assert.deepEqual(read(fresh.file).map((x) => x.id), ['one']);
  fresh.insert({ id: 'three' });
  assert.deepEqual(fresh.all().map((x) => x.id), ['one', 'three']);
});

test('MB-05: collection entries must be objects', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'things.json'), JSON.stringify([{ id: 'a' }, 5]));
  const c = new JsonCollection(dir, 'things');
  assert.equal(c.status().state, 'corrupt');
});

test('rolling backup holds the previous generation after each successful write', () => {
  const dir = tmp();
  const c = new JsonCollection(dir, 'things');
  c.insert({ id: 'a' });
  c.insert({ id: 'b' });
  c.insert({ id: 'c' });
  assert.deepEqual(read(c.bakFile).map((x) => x.id), ['a', 'b']);
});

test('MB-03: two instances on the same file never lose each other\'s committed records', () => {
  const dir = tmp();
  const A = new JsonCollection(dir, 'things');
  const B = new JsonCollection(dir, 'things');
  assert.deepEqual(A.all(), []);
  assert.deepEqual(B.all(), []);
  A.insert({ id: 'A' });
  B.insert({ id: 'B' });
  assert.deepEqual(read(A.file).map((x) => x.id).sort(), ['A', 'B']);
  assert.deepEqual(A.all().map((x) => x.id).sort(), ['A', 'B'], 'first instance sees the other\'s record');
  A.update('B', { seen: true });
  B.remove('A');
  assert.deepEqual(read(A.file), [{ id: 'B', seen: true }]);
  assert.ok(A.externalChanges + B.externalChanges >= 2);
});

test('MB-03: interleaved transactions across two instances keep both writes', () => {
  const dir = tmp();
  const A = new JsonCollection(dir, 'x');
  const B = new JsonCollection(dir, 'x');
  for (let i = 0; i < 20; i += 1) {
    (i % 2 ? A : B).insert({ id: 'r' + i });
  }
  assert.equal(read(A.file).length, 20);
});

test('JsonDocument: copy-on-write merge, read-only on corruption', () => {
  const dir = tmp();
  const fx = faultyFs();
  const d = new JsonDocument(dir, 'settings', { theme: 'light' }, { fs: fx });
  assert.equal(d.data().theme, 'light');
  d.merge({ a: 1 });
  fx.state.rules.renameSync = () => true;
  assert.throws(() => d.merge({ a: 2 }), StoreError);
  assert.equal(d.data().a, 1);
  fx.state.rules.renameSync = null;
  fs.writeFileSync(d.file, '[]');
  const d2 = new JsonDocument(dir, 'settings', { theme: 'light' });
  assert.equal(d2.status().state, 'corrupt');
  assert.throws(() => d2.set('a', 3), /STORE_READ_ONLY/);
  assert.equal(fs.readFileSync(d.file, 'utf8'), '[]');
});

test('replaceAll without backup leaves no un-scrubbed predecessor behind', () => {
  const dir = tmp();
  const c = new JsonCollection(dir, 'things');
  c.insert({ id: 'a', secret: 'x' });
  c.insert({ id: 'b' });
  c.replaceAll([{ id: 'a' }, { id: 'b' }], { backup: false });
  assert.equal(fs.existsSync(c.bakFile), false);
});

test('bulk updateMany is a single write', () => {
  const dir = tmp();
  let writes = 0;
  const fx = faultyFs({});
  const realRename = fx.renameSync;
  fx.renameSync = (...a) => { writes += 1; return realRename(...a); };
  const c = new JsonCollection(dir, 'things', { fs: fx });
  c.insertMany(Array.from({ length: 50 }, (_, i) => ({ id: 'i' + i })));
  writes = 0;
  c.updateMany(Array.from({ length: 50 }, (_, i) => ({ id: 'i' + i, patch: { n: i } })));
  assert.equal(writes, 1);
  assert.equal(c.get('i49').n, 49);
});

test('cleanupStaleTmp removes old temp files only', () => {
  const dir = tmp();
  const old = path.join(dir, 'x.json.123.abcd.tmp');
  const fresh = path.join(dir, 'y.json.123.abcd.tmp');
  fs.writeFileSync(old, '');
  fs.writeFileSync(fresh, '');
  fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  assert.equal(cleanupStaleTmp(dir), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});
