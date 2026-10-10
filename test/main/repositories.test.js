'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRepositories } = require('../../src/main/store/repositories');

const PW = 'Synthetic-Passw0rd-123';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-repo-')); }
const storeDir = (u) => path.join(u, 'braiwser');
const readJson = (u, n) => JSON.parse(fs.readFileSync(path.join(storeDir(u), n + '.json'), 'utf8'));

test('CE-01: recordings never persist a secret step value (create + update)', () => {
  const u = tmp();
  const repos = createRepositories(u);
  const rec = repos.recordings.create({
    name: 'Login', startUrl: 'http://x',
    steps: [{ type: 'input', selector: '#pw', value: PW, secret: true }, { type: 'input', selector: '#u', value: 'ada' }],
  });
  repos.recordings.update(rec.id, { steps: [{ type: 'input', selector: '#pw', value: PW + '!', inputType: 'password' }] });
  const raw = fs.readFileSync(path.join(storeDir(u), 'recordings.json'), 'utf8');
  assert.ok(!raw.includes(PW), 'plaintext absent from disk');
  const back = repos.recordings.get(rec.id);
  assert.equal(back.steps[0].placeholder, '{{secret}}');
  assert.equal('value' in back.steps[0], false);
  for (const f of fs.readdirSync(storeDir(u))) {
    assert.ok(!fs.readFileSync(path.join(storeDir(u), f), 'utf8').includes(PW), f);
  }
});

test('CE-01: existing stored recordings are scrubbed once on load, other data preserved, no secret-bearing backup', () => {
  const u = tmp();
  fs.mkdirSync(storeDir(u), { recursive: true });
  const legacy = [
    { id: 'r1', projectId: 'p', name: 'Old', startUrl: 'http://x', createdAt: 'c', updatedAt: 'u', lastRun: { passed: 1 },
      steps: [{ type: 'click', selector: '#a' }, { type: 'input', selector: '#pw', value: PW, secret: true, tag: 'input' }] },
    { id: 'r2', projectId: 'p', name: 'Clean', steps: [{ type: 'input', selector: '#n', value: 'ada' }] },
  ];
  fs.writeFileSync(path.join(storeDir(u), 'recordings.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(storeDir(u), 'recordings.json.bak'), JSON.stringify(legacy));
  const repos = createRepositories(u);
  assert.equal(repos.health().maintenance.recordingsScrubbed, 1);
  const raw = fs.readFileSync(path.join(storeDir(u), 'recordings.json'), 'utf8');
  assert.ok(!raw.includes(PW));
  assert.ok(!fs.existsSync(path.join(storeDir(u), 'recordings.json.bak')), 'stale backup with plaintext removed');
  const r1 = repos.recordings.get('r1');
  assert.deepEqual(r1.lastRun, { passed: 1 });
  assert.equal(r1.steps[0].selector, '#a');
  assert.equal(r1.steps[1].tag, 'input');
  assert.equal(repos.recordings.get('r2').steps[0].value, 'ada');
  // second boot: nothing left to scrub
  assert.equal(createRepositories(u).health().maintenance.recordingsScrubbed, 0);
});

test('MB-01: Open File project stores the directory in path and the file in entry', () => {
  const u = tmp();
  const proj = path.join(u, 'my proj', 'ünï');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'page.html');
  fs.writeFileSync(file, '<html></html>');
  const repos = createRepositories(u);
  const p = repos.projects.create({ name: 'page', path: file, kind: 'local' });
  assert.equal(p.path, proj);
  assert.equal(p.entry, file);
  const folder = repos.projects.create({ name: 'dir', path: proj, kind: 'local', entry: file });
  assert.equal(folder.path, proj);
  assert.equal(folder.entry, file);
  const updated = repos.projects.update(folder.id, { path: file });
  assert.equal(updated.path, proj);
});

test('MB-01: existing file-projects are migrated on load', () => {
  const u = tmp();
  const dir = path.join(u, 'site');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, 'x');
  fs.mkdirSync(storeDir(u), { recursive: true });
  fs.writeFileSync(path.join(storeDir(u), 'projects.json'), JSON.stringify([
    { id: 'f', name: 'f', path: file, kind: 'local' },
    { id: 'd', name: 'd', path: dir, kind: 'local' },
    { id: 'u', name: 'u', path: '', kind: 'url' },
    { id: 'gone', name: 'g', path: path.join(u, 'missing.html'), kind: 'local' },
  ]));
  const repos = createRepositories(u);
  assert.equal(repos.health().maintenance.projectsNormalized, 1);
  assert.deepEqual([repos.projects.get('f').path, repos.projects.get('f').entry], [dir, file]);
  assert.equal(repos.projects.get('d').path, dir);
  assert.equal(repos.projects.get('gone').path, path.join(u, 'missing.html'));
});

test('MB-02: imported projects stay imported until relocate() with a real directory', () => {
  const u = tmp();
  const repos = createRepositories(u);
  const p = repos.projects.create({ name: 'imp', path: '/some/other/machine', kind: 'local', imported: true });
  assert.equal(p.imported, true);
  assert.equal(repos.projects.update(p.id, { imported: false }).imported, true, 'update cannot clear imported');
  assert.throws(() => repos.projects.relocate(p.id, { path: path.join(u, 'nope') }), /existing folder/);
  const dir = path.join(u, 'mine');
  fs.mkdirSync(dir);
  const r = repos.projects.relocate(p.id, { path: dir });
  assert.equal(r.imported, false);
  assert.equal(r.path, dir);
});

test('CE-02 support: legacy / unknown visibility is normalized to internal; client is kept', () => {
  const u = tmp();
  fs.mkdirSync(storeDir(u), { recursive: true });
  fs.writeFileSync(path.join(storeDir(u), 'annotations.json'), JSON.stringify([
    { id: 'a', sessionId: 's' }, { id: 'b', sessionId: 's', visibility: 'client' },
    { id: 'c', sessionId: 's', visibility: 'public' }, { id: 'd', sessionId: 's', visibility: 'internal' },
  ]));
  const repos = createRepositories(u);
  const vis = Object.fromEntries(repos.annotations.bySession('s').map((a) => [a.id, a.visibility]));
  assert.deepEqual(vis, { a: 'internal', b: 'client', c: 'internal', d: 'internal' });
  assert.equal(readJson(u, 'annotations').find((a) => a.id === 'c').legacyVisibility, 'public');
  assert.equal(repos.annotations.update('b', { visibility: 'weird' }).visibility, 'internal');
});

test('performance: reorder is one write however many notes', () => {
  const u = tmp();
  let renames = 0;
  const fx = Object.create(fs);
  fx.renameSync = (...a) => { renames += 1; return fs.renameSync(...a); };
  const repos = createRepositories(u, { fs: fx });
  const s = repos.sessions.create({ name: 's' });
  const ids = [];
  for (let i = 0; i < 30; i += 1) ids.push(repos.annotations.create({ sessionId: s.id, note: 'n' + i }).id);
  renames = 0;
  const out = repos.annotations.reorder(s.id, ids.slice().reverse());
  assert.equal(renames, 1);
  assert.deepEqual(out.map((a) => a.id), ids.slice().reverse());
});

test('performance + atomicity: bulk.importProject writes each file once and marks the project imported', () => {
  const u = tmp();
  let renames = 0;
  const fx = Object.create(fs);
  fx.renameSync = (...a) => { renames += 1; return fs.renameSync(...a); };
  const repos = createRepositories(u, { fs: fx });
  renames = 0;
  const res = repos.bulk.importProject({
    project: { name: 'P', path: '/elsewhere', kind: 'local' },
    sessions: [{ sourceId: 's1', name: 'S' }],
    annotations: Array.from({ length: 40 }, (_, i) => ({ sessionSourceId: 's1', note: 'n' + i, visibility: i % 2 ? 'client' : undefined })).concat([{ sessionSourceId: 'orphan', note: 'x' }]),
    recordings: [{ name: 'R', steps: [{ type: 'input', selector: '#p', value: PW, secret: true }] }],
  });
  assert.equal(renames, 4);
  assert.equal(res.project.imported, true);
  assert.deepEqual(res.counts, { sessions: 1, annotations: 40, recordings: 1 });
  assert.ok(!fs.readFileSync(path.join(storeDir(u), 'recordings.json'), 'utf8').includes(PW));
  assert.equal(repos.annotations.bySession(res.sessionIdMap.s1).length, 40);
});

test('MB-04: compound operations are all-or-nothing (project removal, annotation create)', () => {
  const u = tmp();
  const fx = Object.create(fs);
  let failOn = null;
  fx.renameSync = (from, to) => {
    if (failOn && String(to).endsWith(failOn)) { const e = new Error('injected'); e.code = 'EIO'; throw e; }
    return fs.renameSync(from, to);
  };
  const repos = createRepositories(u, { fs: fx });
  const p = repos.projects.create({ name: 'P', kind: 'url' });
  const s = repos.sessions.create({ projectId: p.id, name: 'S' });
  repos.annotations.create({ sessionId: s.id, note: 'keep' });
  repos.recordings.create({ projectId: p.id, name: 'R', steps: [] });

  failOn = 'projects.json';
  assert.throws(() => repos.projects.remove(p.id));
  assert.equal(repos.sessions.list(p.id).length, 1);
  assert.equal(repos.annotations.bySession(s.id).length, 1);
  assert.equal(repos.recordings.list(p.id).length, 1);
  assert.equal(readJson(u, 'annotations').length, 1, 'earlier files were restored on disk');

  failOn = 'sessions.json';
  const before = repos.sessions.get(s.id).updatedAt;
  assert.throws(() => repos.annotations.create({ sessionId: s.id, note: 'new' }));
  assert.equal(repos.annotations.bySession(s.id).length, 1, 'annotation insert rolled back with the session bump');
  assert.equal(repos.sessions.get(s.id).updatedAt, before);

  failOn = null;
  assert.equal(repos.projects.remove(p.id), true);
  assert.equal(repos.annotations.bySession(s.id).length, 0);
});

test('MB-05 via repositories: a corrupt collection is reported by health() and never overwritten', () => {
  const u = tmp();
  fs.mkdirSync(storeDir(u), { recursive: true });
  fs.writeFileSync(path.join(storeDir(u), 'projects.json'), '{broken');
  const repos = createRepositories(u);
  const h = repos.health();
  assert.equal(h.ok, false);
  assert.equal(h.problems[0].name, 'projects');
  assert.throws(() => repos.projects.create({ name: 'x', kind: 'url' }), /STORE_READ_ONLY/);
  assert.equal(fs.readFileSync(path.join(storeDir(u), 'projects.json'), 'utf8'), '{broken');
  repos.recover('projects', 'empty');
  assert.equal(repos.health().ok, true);
  repos.projects.create({ name: 'x', kind: 'url' });
});

test('MB-03 via repositories: two repository instances on one store do not clobber each other', () => {
  const u = tmp();
  const r1 = createRepositories(u);
  const r2 = createRepositories(u);
  r1.projects.create({ name: 'A', kind: 'url' });
  r2.projects.create({ name: 'B', kind: 'url' });
  assert.deepEqual(r1.projects.list().map((p) => p.name).sort(), ['A', 'B']);
  assert.deepEqual(readJson(u, 'projects').map((p) => p.name).sort(), ['A', 'B']);
});
