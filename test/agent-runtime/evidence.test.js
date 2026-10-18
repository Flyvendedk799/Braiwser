'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/shared/browser-contracts');
const { createEvidenceStore } = require('../../src/main/services/browser/evidence');
const { createRedactor } = require('../../src/shared/browser-redact');
const { tmp, ui, mcp } = require('./helpers');

const owner = mcp('owner'); const other = mcp('other');
function setup(opts = {}) {
  const dir = tmp(); const store = createEvidenceStore({ dir, ...opts });
  const runId = C.newId('run');
  store.registerRun(runId, { ownerId: owner.id, sessionId: 's1', pageId: 'p1' });
  return { dir, store, runId };
}
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
const readAll = (dir) => allFiles(dir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('artifacts get opaque ids, hashes and are redacted before they touch disk', () => {
  const canary = 'CANARY-evidence-7781';
  const redactor = createRedactor({ secrets: [canary] });
  const { dir, store, runId } = setup({ redactor });
  const a = store.putArtifact(runId, { kind: 'console', data: { text: `saw ${canary} at https://x.test/cb?token=abcd1234&u=2`, password: 'hunter2', nested: { Authorization: 'Bearer zzzzzzzzzzzz' } } });
  assert.ok(C.isServerId(a.artifactId)); assert.equal(a.sha256.length, 64);
  const raw = readAll(dir);
  for (const leak of [canary, 'abcd1234', 'hunter2', 'zzzzzzzzzzzz']) assert.ok(!raw.includes(leak), leak);
  const read = store.read(a.uri, owner);
  assert.ok(!read.text.includes(canary)); assert.equal(JSON.parse(read.text).password, '[redacted]');
});

test('ids are validated before any path is built', () => {
  const { store, runId } = setup();
  assert.throws(() => store.putArtifact(runId, { id: '../../evil', kind: 'x', data: {} }), (e) => e.code === 'BAD_ID');
  assert.throws(() => store.registerRun('..', { ownerId: 'o' }), (e) => e.code === 'BAD_ID');
  assert.throws(() => store.read('braiwser://runs/../../x/manifest', owner));
  assert.throws(() => store.read(`braiwser://runs/${runId}/artifacts/art_nope000`, owner), (e) => e.code === 'NOT_FOUND');
});

test('quotas: oversize / too many / too large runs are rejected, recorded, and make evidence incomplete', () => {
  const { store, runId } = setup({ quotas: { maxArtifactsPerRun: 2, maxBytesPerRun: 400, maxArtifactBytes: 300 } });
  const ok = store.putArtifact(runId, { kind: 'a', data: { n: 1 } });
  assert.throws(() => store.putArtifact(runId, { kind: 'big', data: 'x'.repeat(1000) }), (e) => e.code === 'EVIDENCE_QUOTA_ARTIFACT');
  store.putArtifact(runId, { kind: 'a', data: { n: 2 } });
  assert.throws(() => store.putArtifact(runId, { kind: 'a', data: { n: 3 } }), (e) => e.code === 'EVIDENCE_QUOTA_COUNT');
  const v = store.verify(runId, [ok.artifactId]);
  assert.equal(v.complete, false); assert.ok(v.errors.length >= 2);
  const m = store.commitManifest(runId, {});
  assert.ok(m.artifactErrors.length >= 2);
  const t = createEvidenceStore({ dir: tmp(), quotas: { maxTotalBytes: 100 } }); const r = C.newId('run'); t.registerRun(r, { ownerId: 'o' });
  assert.throws(() => t.putArtifact(r, { kind: 'a', data: 'y'.repeat(200) }), (e) => e.code === 'EVIDENCE_QUOTA_TOTAL');
});

test('verify: complete only when every required artifact is present, intact and error-free', () => {
  const { dir, store, runId } = setup();
  const a = store.putArtifact(runId, { kind: 'a', data: { ok: 1 } });
  assert.equal(store.verify(runId, [a.artifactId]).complete, true);
  assert.deepEqual(store.verify(runId, [a.artifactId, 'art_missing1']).missing, ['art_missing1']);
  assert.equal(store.verify(runId, [a.artifactId, 'art_missing1']).complete, false);
  fs.writeFileSync(path.join(dir, runId, `${a.artifactId}.bin`), '{"ok":2}'); // bit-rot / tamper
  const v = store.verify(runId, [a.artifactId]);
  assert.deepEqual(v.corrupt, [a.artifactId]); assert.equal(v.complete, false);
  assert.throws(() => store.read(a.uri, owner), (e) => e.code === 'ARTIFACT_CORRUPT');
});

test('manifest: committed once, atomic, hash-checked, immutable afterwards', () => {
  const { dir, store, runId } = setup();
  const a = store.putArtifact(runId, { kind: 'a', data: { ok: 1 } });
  assert.equal(store.isCommitted(runId), false);
  assert.equal(store.getManifest(runId, owner).committed, false);
  const m = store.commitManifest(runId, { counts: { planned: 1 }, steps: [{ stepId: 's', evidenceIds: [a.artifactId] }], digests: { plan: 'a'.repeat(64) }, terminal: { state: 'passed' } });
  assert.equal(m.committed, true); assert.equal(m.digests.plan, 'a'.repeat(64));
  assert.equal(m.artifacts[0].artifactId, a.artifactId);
  assert.equal(store.isCommitted(runId), true);
  assert.throws(() => store.commitManifest(runId, {}), (e) => e.code === 'MANIFEST_COMMITTED');
  assert.throws(() => store.putArtifact(runId, { kind: 'late', data: {} }), (e) => e.code === 'MANIFEST_COMMITTED');
  // survives a restart and detects tampering
  const again = createEvidenceStore({ dir });
  assert.equal(again.isCommitted(runId), true);
  const file = path.join(dir, runId, 'manifest.json');
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.terminal.state = 'failed-to-passed'; fs.writeFileSync(file, JSON.stringify(tampered));
  assert.equal(createEvidenceStore({ dir }).isCommitted(runId), false);
});

test('a failed manifest write leaves no manifest behind (nothing half-committed)', () => {
  let fail = false;
  const faulty = { ...fs, renameSync: (a, b) => { if (fail && b.endsWith('manifest.json')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.renameSync(a, b); } };
  const { dir, store, runId } = setup({ fs: faulty });
  fail = true;
  assert.throws(() => store.commitManifest(runId, {}), (e) => e.code === 'EVIDENCE_WRITE_FAILED');
  assert.equal(fs.existsSync(path.join(dir, runId, 'manifest.json')), false);
  assert.equal(store.isCommitted(runId), false);
  fail = false;
  assert.equal(store.commitManifest(runId, {}).committed, true); // can be retried
});

test('resource reads are authorised by owner and run, not by possession of the URI', () => {
  const { store, runId } = setup();
  const a = store.putArtifact(runId, { kind: 'a', data: { secretish: 'v' } });
  store.putObservation(runId, C.newId('observation'), { nodes: [] });
  assert.ok(store.read(a.uri, owner)); assert.ok(store.read(a.uri, ui));
  assert.throws(() => store.read(a.uri, other), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.read(C.uris.manifest(runId), other), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.getManifest(runId, other), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.read(C.uris.manifest(C.newId('run')), owner), (e) => e.code === 'NOT_FOUND');
  // an artifact id is not an observation id
  assert.throws(() => store.read(C.uris.observation(runId, a.artifactId), owner), (e) => e.code === 'NOT_FOUND');
});

test('resource reads are bounded, resumable and base64 for binary', () => {
  const { store, runId } = setup();
  const big = store.putArtifact(runId, { kind: 'a', data: { items: Array.from({ length: 100 }, () => 'lorem ipsum dolor sit amet '.repeat(4)) } });
  const first = store.read(big.uri, owner, { maxBytes: 1000 });
  assert.equal(first.truncated, true); assert.equal(first.returnedBytes, 1000); assert.ok(first.nextCursor);
  let text = first.text; let cursor = first.nextCursor;
  while (cursor) { const p = store.read(big.uri, owner, { maxBytes: 1000, cursor }); text += p.text; cursor = p.nextCursor; }
  assert.equal(JSON.parse(text).items.length, 100);
  const shot = store.putArtifact(runId, { kind: 'screenshot', mime: 'image/png', data: Buffer.alloc(5000, 7) });
  const b = store.read(shot.uri, owner, { maxBytes: 4000 });
  assert.equal(b.encoding, 'base64'); assert.equal(b.truncated, true); assert.ok(b.data.length <= 4000);
});

test('public report only contains the permitted evidence set', () => {
  const { store, runId } = setup();
  const pub = store.putArtifact(runId, { kind: 'a', data: { v: 1 }, visibility: 'public' });
  store.putArtifact(runId, { kind: 'private', data: { v: 2 }, visibility: 'internal' });
  const png = store.putArtifact(runId, { kind: 'screenshot', mime: 'image/png', data: Buffer.from('png') }); // binary defaults to internal
  assert.throws(() => store.putArtifact(runId, { kind: 'screenshot', data: Buffer.from('x'), visibility: 'public' }), (e) => e.code === 'UNREDACTED_PUBLIC');
  assert.throws(() => store.publicReport(runId, owner), (e) => e.code === 'NOT_COMMITTED');
  store.commitManifest(runId, {});
  const report = store.publicReport(runId, owner);
  assert.deepEqual(report.artifacts.map((a) => a.artifactId), [pub.artifactId]);
  assert.ok(!JSON.stringify(report).includes(png.artifactId));
  assert.throws(() => store.publicReport(runId, other));
});

test('retention prunes only finished containers past the window', () => {
  let now = 1000; const dir = tmp();
  const store = createEvidenceStore({ dir, clock: { now: () => now }, retentionMs: 100 });
  const done = C.newId('run'); const live = C.newId('run');
  store.registerRun(done, { ownerId: 'o' }); store.registerRun(live, { ownerId: 'o' });
  store.putArtifact(done, { kind: 'a', data: { v: 1 } }); store.commitManifest(done, {});
  now += 500;
  assert.equal(store.prune(), 1);
  assert.equal(store.hasRun(done), false); assert.equal(store.hasRun(live), true);
  assert.equal(fs.existsSync(path.join(dir, done)), false);
});

test('a restart reloads containers and ownership', () => {
  const { dir, store, runId } = setup();
  const a = store.putArtifact(runId, { kind: 'a', data: { v: 1 } });
  const again = createEvidenceStore({ dir });
  assert.ok(again.read(a.uri, owner)); assert.throws(() => again.read(a.uri, other));
  assert.equal(again.ownerOf(runId), 'owner');
});
