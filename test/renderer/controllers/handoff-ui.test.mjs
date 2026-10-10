import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffWhere } from '../../../src/renderer/controllers/handoff-ui.js';

// Windows-style path from a forward-slash spelling.
const win = (p) => p.split('/').join(String.fromCharCode(92));

test('local project: cwd shown, nothing blocked', () => {
  const dir = win('C:/code/site');
  const entry = win('C:/code/site/index.html');
  const w = handoffWhere({ cwd: dir, file: 'x' }, { kind: 'local', path: dir, entry });
  assert.equal(w.needsLocalDirectory, false);
  assert.equal(w.cwd, dir);
  assert.equal(w.entry, entry);
  assert.deepEqual(w.notices, []);
});

test('imported project needs a directory and hides the untrusted cwd', () => {
  const w = handoffWhere({ cwd: win('C:/app/requests'), imported: true }, { kind: 'local', path: win('C:/x'), imported: true });
  assert.equal(w.needsLocalDirectory, true);
  assert.equal(w.cwd, '');
  assert.deepEqual(w.notices, []);
});

test('url project and missing project both need a directory', () => {
  assert.equal(handoffWhere({ cwd: '/d' }, { kind: 'url', path: '' }).needsLocalDirectory, true);
  assert.equal(handoffWhere({ cwd: '/d' }, null).needsLocalDirectory, true);
});

test('fell back to app data although the project is local: notice but runnable', () => {
  const w = handoffWhere({ cwd: '/app/requests' }, { kind: 'local', path: '/home/me/site' });
  assert.equal(w.needsLocalDirectory, false);
  assert.match(w.notices[0], /could not write/);
});

test('file-path project whose cwd is its folder is not a fallback; sibling folder is', () => {
  assert.deepEqual(handoffWhere({ cwd: '/home/me/site' }, { kind: 'local', path: '/home/me/site/index.html' }).notices, []);
  assert.equal(handoffWhere({ cwd: '/home/me/site2' }, { kind: 'local', path: '/home/me/site' }).notices.length, 1);
});
