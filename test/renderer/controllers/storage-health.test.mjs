import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStorageHealth, describeRecovery } from '../../../src/renderer/controllers/storage-health.js';

test('healthy or missing status is not damaged', () => {
  assert.equal(describeStorageHealth({ ok: true, problems: [] }).damaged, false);
  assert.equal(describeStorageHealth(null).damaged, false);
});

test('corrupt file with backup offers both choices', () => {
  const d = describeStorageHealth({ problems: [{ name: 'annotations', file: ['C:', 'u', 'annotations.json'].join(String.fromCharCode(92)), state: 'corrupt', error: { message: 'bad json' }, backupAvailable: true }] });
  assert.equal(d.damaged, true);
  const it = d.items[0];
  assert.equal(it.file, 'annotations.json');
  assert.equal(it.canRestoreBackup, true);
  assert.equal(it.canStartFresh, true);
  assert.equal(it.error, 'bad json');
});

test('unreadable file offers no destructive recovery', () => {
  const it = describeStorageHealth({ problems: [{ name: 'x', file: '/a/x.json', state: 'unreadable', backupAvailable: true }] }).items[0];
  assert.equal(it.canRestoreBackup, false);
  assert.equal(it.canStartFresh, false);
});

test('corrupt without backup can only start fresh; maintenance errors surface', () => {
  const d = describeStorageHealth({ problems: [{ name: 'x', file: 'x.json', state: 'corrupt', backupAvailable: false }], maintenance: { errors: [{ step: 'notes', message: 'boom' }] } });
  assert.equal(d.items[0].canRestoreBackup, false);
  assert.equal(d.items[0].canStartFresh, true);
  assert.deepEqual(d.maintenanceErrors, ['notes: boom']);
});

test('recovery outcomes read plainly', () => {
  assert.equal(describeRecovery({ file: 'a.json' }, 'backup', { recovered: true, from: 'backup' }).ok, true);
  assert.match(describeRecovery({ file: 'a.json' }, 'backup', { recovered: false, reason: 'no-backup' }).text, /no backup/);
});
