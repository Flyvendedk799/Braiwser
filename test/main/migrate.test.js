'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacyUserData, MARKER, STAGING_SUFFIX } = require('../../src/main/migrate');
const { migrateStore, CURRENT_SCHEMA_VERSION } = require('../../src/main/store/schema');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-mig-')); }

function legacyWorld() {
  const root = tmp();
  const appData = path.join(root, 'appData');
  const userData = path.join(appData, 'Braiwser');
  const src = path.join(appData, 'Chrome AI OS', 'caos');
  fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(src, 'projects.json'), '[{"id":"p"}]');
  fs.writeFileSync(path.join(src, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(src, 'recordings.json'), '[]');
  fs.writeFileSync(path.join(src, 'nested', 'x.json'), '{}');
  fs.mkdirSync(userData, { recursive: true });
  return { appData, userData, src, target: path.join(userData, 'braiwser') };
}

// fs wrapper that throws on the Nth call to `method`.
function failingFs(method, nth) {
  let n = 0;
  const f = Object.create(fs);
  f[method] = (...a) => {
    n += 1;
    if (n === nth) { const e = new Error(`injected ${method} #${nth}`); e.code = 'EIO'; throw e; }
    return fs[method](...a);
  };
  return f;
}

test('MB-06: clean migration promotes a complete store with a completion marker, source untouched', () => {
  const w = legacyWorld();
  const r = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData });
  assert.equal(r.migrated, true);
  assert.equal(r.kind, 'app-rename');
  assert.ok(fs.existsSync(path.join(w.target, MARKER)));
  assert.equal(fs.readFileSync(path.join(w.target, 'nested', 'x.json'), 'utf8'), '{}');
  assert.ok(fs.existsSync(path.join(w.src, 'projects.json')));
  assert.equal(fs.existsSync(w.target + STAGING_SUFFIX), false);
  assert.equal(migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData }).migrated, false, 'idempotent');
});

for (const [method, count] of [['mkdirSync', 2], ['copyFileSync', 1], ['copyFileSync', 3], ['renameSync', 1], ['renameSync', 4], ['writeFileSync', 1], ['statSync', 2]]) {
  test(`MB-06: interruption at ${method} #${count} leaves no half-built target and the next launch completes`, () => {
    const w = legacyWorld();
    const bad = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData, fs: failingFs(method, count) });
    assert.equal(bad.migrated, false);
    assert.ok(bad.error, 'failure is reported, not thrown');
    assert.equal(fs.existsSync(w.target), false, 'target is absent, so a retry is not skipped');
    assert.ok(fs.existsSync(path.join(w.src, 'projects.json')), 'source intact');
    const ok = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData });
    assert.equal(ok.migrated, true);
    assert.equal(fs.readFileSync(path.join(w.target, 'projects.json'), 'utf8'), '[{"id":"p"}]');
    assert.equal(fs.existsSync(w.target + STAGING_SUFFIX), false);
  });
}

test('MB-06: a stale staging dir from a crash is discarded and redone', () => {
  const w = legacyWorld();
  fs.mkdirSync(w.target + STAGING_SUFFIX, { recursive: true });
  fs.writeFileSync(path.join(w.target + STAGING_SUFFIX, 'garbage.json'), 'half');
  const r = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData });
  assert.equal(r.migrated, true);
  assert.equal(fs.existsSync(path.join(w.target, 'garbage.json')), false);
});

test('MB-06: a destination left half-filled by the old migration is completed without overwriting', () => {
  const w = legacyWorld();
  fs.mkdirSync(w.target, { recursive: true });
  fs.writeFileSync(path.join(w.target, 'meta.json'), '{"schemaVersion":2}'); // no user-data file yet
  const r = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData });
  assert.equal(r.migrated, true);
  assert.equal(r.resumed, true);
  assert.equal(fs.readFileSync(path.join(w.target, 'projects.json'), 'utf8'), '[{"id":"p"}]');
  assert.equal(fs.readFileSync(path.join(w.target, 'meta.json'), 'utf8'), '{"schemaVersion":2}');
});

test('MB-06: an established store is never touched', () => {
  const w = legacyWorld();
  fs.mkdirSync(w.target, { recursive: true });
  fs.writeFileSync(path.join(w.target, 'projects.json'), '[{"id":"mine"}]');
  const r = migrateLegacyUserData({ appDataDir: w.appData, userDataDir: w.userData });
  assert.equal(r.migrated, false);
  assert.equal(fs.readFileSync(path.join(w.target, 'projects.json'), 'utf8'), '[{"id":"mine"}]');
  assert.equal(fs.existsSync(path.join(w.target, 'recordings.json')), false);
});

test('MB-06: userData/caos is promoted to userData/braiwser', () => {
  const root = tmp();
  const userData = path.join(root, 'ud');
  fs.mkdirSync(path.join(userData, 'caos'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'caos', 'projects.json'), '[]');
  const r = migrateLegacyUserData({ appDataDir: path.join(root, 'ad'), userDataDir: userData });
  assert.equal(r.kind, 'store-rename');
  assert.ok(fs.existsSync(path.join(userData, 'braiwser', 'projects.json')));
});

// ---- schema migration (MB-05/MB-06 share the "never overwrite what you can't read" rule)
test('schema: v1 settings are upgraded and meta written once', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"dark"}');
  const meta = migrateStore(dir);
  assert.equal(meta.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(meta.applied, ['1->2']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).persona, 'agent');
  const stamp = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  migrateStore(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), stamp, 'no rewrite when already current');
});

test('schema: unreadable/corrupt settings are NOT replaced by defaults and the migration is retried later', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{oops');
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"schemaVersion":1}');
  const meta = migrateStore(dir);
  assert.equal(meta.schemaVersion, 1, 'version does not advance past a failed step');
  assert.equal(meta.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{oops');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"dark"}');
  assert.equal(migrateStore(dir).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('schema: a store from a newer build is not downgraded', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"schemaVersion":99}');
  const meta = migrateStore(dir);
  assert.equal(meta.newerThanApp, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).schemaVersion, 99);
});

test('schema: a damaged meta.json is preserved before being replaced', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'meta.json'), 'garbage');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  migrateStore(dir);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('meta.json.corrupt-')));
});
