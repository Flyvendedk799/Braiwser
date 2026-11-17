// Dialogs that used to live inline in app.js: the storage-health recovery
// dialog, the shortcut sheet / About, and the import / Playwright export reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click, settle, tick } from './dom-env.mjs';

const { document } = setupDom();
const { createStorageHealthCheck } = await load('components/storage-health-modal.js');
const { showShortcuts, showAbout, keyLabel } = await load('components/help-modals.js');
const { showImportReport, showPlaywrightExportNotes } = await load('components/export-reports.js');

const dialogs = () => Array.from(document.querySelectorAll('.modal-backdrop'));
const top = () => dialogs().pop() || null;
const button = (root, label) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === label) || null;
async function closeAll() {
  for (const d of dialogs()) { const x = d.querySelector('.modal-x'); if (x) click(x); }
  await tick(260);
}

const CORRUPT = { problems: [{ name: 'annotations', file: '/data/annotations.json', state: 'corrupt', error: { message: 'bad json' }, backupAvailable: true }] };

test('storage health: a healthy store opens nothing', async () => {
  const health = createStorageHealthCheck({ api: { store: { status: async () => ({ ok: true, problems: [] }) } }, reload: async () => {} });
  await health.check();
  assert.equal(dialogs().length, 0);
  // A status call that fails must not take the app down with it.
  const broken = createStorageHealthCheck({ api: { store: { status: async () => { throw new Error('ipc down'); } } }, reload: async () => {} });
  await broken.check();
  assert.equal(dialogs().length, 0);
});

test('storage health: a damaged file is explained and can be restored from its backup', async () => {
  const calls = [];
  let status = CORRUPT;
  const health = createStorageHealthCheck({
    api: { store: {
      status: async () => status,
      recover: async (name, mode) => { calls.push(['recover', name, mode]); status = { ok: true, problems: [] }; return { recovered: true, from: 'backup' }; },
    } },
    reload: async () => { calls.push(['reload']); },
  });
  await health.check();
  await settle();
  const dlg = top();
  assert.ok(dlg, 'the dialog is shown');
  assert.match(dlg.textContent, /Saved data needs attention/);
  assert.match(dlg.textContent, /annotations\.json/);
  assert.match(dlg.textContent, /bad json/);
  assert.ok(button(dlg, 'Start fresh'), 'starting fresh is offered');
  click(button(dlg, 'Restore from backup'));
  await tick(40);
  assert.deepEqual(calls, [['recover', 'annotations', 'backup'], ['reload']], 'recovers, then the shell re-reads its data');
  await tick(260);
  assert.equal(dialogs().length, 0, 'nothing left to fix: the dialog closes itself');
});

test('storage health: starting fresh asks first, and a file still damaged keeps the dialog up', async () => {
  const calls = [];
  const health = createStorageHealthCheck({
    api: { store: { status: async () => CORRUPT, recover: async (name, mode) => { calls.push([name, mode]); return { recovered: false, reason: 'no-backup' }; } } },
    reload: async () => {},
  });
  await health.check();
  await settle();
  click(button(top(), 'Start fresh'));
  await settle();
  assert.match(top().textContent, /Start with an empty file\?/);
  click(button(top(), 'Cancel'));
  await tick(260);
  assert.deepEqual(calls, [], 'declining the confirmation recovers nothing');
  click(button(top(), 'Start fresh'));
  await settle();
  click(button(top(), 'Start fresh')); // the confirmation's own button
  await tick(300);
  assert.deepEqual(calls, [['annotations', 'empty']]);
  assert.equal(dialogs().length, 1, 'still damaged: one dialog, re-opened rather than stacked');
  assert.match(top().textContent, /Saved data needs attention/);
  await closeAll();
});

test('shortcut sheet renders every group with platform key names', async () => {
  const config = { platform: 'darwin', shortcuts: [{ group: 'Tools', items: [['Inspect', 'Mod+Shift+I'], ['Draw', 'Alt+D']] }, { group: 'Help', items: [['Shortcuts', '?']] }] };
  assert.deepEqual(keyLabel('Mod+Shift+I', config), ['⌘', '⇧', 'I']);
  assert.deepEqual(keyLabel('Mod+Shift+I', { platform: 'linux' }), ['Ctrl', 'Shift', 'I']);
  assert.deepEqual(keyLabel('Mod + K', null), ['Ctrl', 'K']);
  showShortcuts(config);
  await settle();
  const dlg = top();
  assert.deepEqual(Array.from(dlg.querySelectorAll('.shortcut-group h4')).map((n) => n.textContent), ['Tools', 'Help']);
  assert.equal(dlg.querySelectorAll('.shortcut-row').length, 3);
  assert.deepEqual(Array.from(dlg.querySelectorAll('.shortcut-row')[0].querySelectorAll('kbd')).map((k) => k.textContent), ['⌘', '⇧', 'I']);
  await closeAll();
  showShortcuts(null); // config not loaded yet: an empty sheet, not a throw
  await settle();
  assert.equal(top().querySelectorAll('.shortcut-row').length, 0);
  await closeAll();
});

test('About shows the version', async () => {
  showAbout({ appVersion: '9.8.7' });
  await settle();
  assert.match(top().textContent, /Braiwser/);
  assert.equal(top().querySelector('.about-version').textContent, 'v9.8.7');
  await closeAll();
});

test('import report lists what was dropped and what was changed', async () => {
  showImportReport({
    dropped: [{ type: 'annotation', index: 0, reason: 'no session' }, { type: 'recording', index: 4, reason: 'bad steps' }],
    droppedCount: 5,
    warnings: ['2 secret values were removed'],
  });
  await settle();
  const items = Array.from(top().querySelectorAll('li')).map((n) => n.textContent);
  assert.deepEqual(items, ['annotation #1: no session', 'recording #5: bad steps', '…and 3 more', '2 secret values were removed']);
  assert.deepEqual(Array.from(top().querySelectorAll('h4')).map((n) => n.textContent), ['Not imported', 'Changed on import']);
  await closeAll();
});

test('Playwright export notes: silent when clean, explicit about skipped steps and secrets', async () => {
  showPlaywrightExportNotes({ skipped: [], secrets: [] });
  showPlaywrightExportNotes(null);
  await settle();
  assert.equal(dialogs().length, 0);
  showPlaywrightExportNotes({ skipped: [{ index: -1, reason: 'no start URL' }, { index: 2, type: 'drag', reason: 'unsupported' }], secrets: ['BRAIWSER_SECRET_1'] });
  await settle();
  const text = top().textContent;
  assert.match(text, /2 steps not exported/);
  assert.match(text, /Start URL: no start URL/);
  assert.match(text, /Step 3 \(drag\): unsupported/);
  assert.match(text, /BRAIWSER_SECRET_1/);
  await closeAll();
});
