'use strict';
// Pure unit tests for the shared observation builder (no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const obs = require('../../../src/main/services/browser/drivers/observe');

const item = (name, extra) => ({ kind: 'interactable', role: 'button', name, tag: 'button', type: '', ctx: '', enabled: true, ...(extra || {}) });
const entryOf = (i, frameId) => ({ item: i, node: obs.publicNode(i, frameId), fingerprint: obs.fingerprintOf(i), frameId: frameId || null });

function collected(items, total) {
  return { entries: items.map((i) => entryOf(i)), frames: [{ frameId: 'f0', origin: 'http://x', crossOrigin: false, nodes: items.length, available: true }],
    stats: { candidates: items.length, candidatesCapped: false, shadowRootsOpen: 0, possibleClosedShadowHosts: 0, canvases: 0, iframes: 0, title: 't' }, total: total ?? items.length };
}

function harness() {
  const refs = new Map();
  let n = 0;
  const api = {
    mint: (e, observationId) => { const id = `r${++n}`; refs.set(id, { observationIds: new Set([observationId]), dead: null }); return id; },
    rebind: (id, ob) => { const r = refs.get(id); if (!r || r.dead) return false; r.observationIds.add(ob); return true; },
    kill: (id, reason) => { const r = refs.get(id); if (r) r.dead = reason; },
    dispose: () => {},
  };
  const snapshots = new obs.SnapshotStore();
  let seq = 0;
  const run = (items, over) => obs.assembleObservation({ pageId: 'pg', documentEpoch: 1, url: 'http://x/', snapshots, newId: (p) => `${p}${++seq}`,
    offset: 0, want: 100, focus: null, ...(over || {}) }, collected(items, over && over.total), api);
  return { refs, run, snapshots };
}

test('driverError carries a public DTO and never an unknown code', () => {
  const e = obs.driverError('STALE_REF', 'gone', { detail: 'TARGET_CHANGED', dispatched: false });
  assert.deepEqual(e.publicError, { code: 'STALE_REF', message: 'gone', dispatched: false, effectUnknown: false, retry: false });
  assert.equal(e.detail, 'TARGET_CHANGED');
  assert.equal(obs.driverError('SOMETHING_ELSE', 'x').code, 'INTERNAL');
  const late = obs.driverError('TIMEOUT', 'x', { dispatched: true, effectUnknown: true });
  assert.equal(late.publicError.effectUnknown, true);
});

test('clipText strips control, bidi and zero-width characters and bounds length', () => {
  assert.equal(obs.clipText('a‮b​c\u0007d', 50), 'a b c d');
  assert.equal(obs.clipText('x'.repeat(500), 120).length, 120);
  assert.ok(obs.clipText('x'.repeat(500), 120).endsWith('…'));
  assert.equal(obs.clipText(null, 5), '');
  assert.equal(obs.sanitizeFilename('..\\..\\evil<>.txt'), 'evil__.txt');
  assert.equal(obs.sanitizeFilename(''), 'download');
});

test('fingerprints ignore volatile state and include identity', () => {
  const a = obs.fingerprintOf(item('Save'));
  assert.equal(obs.fingerprintOf(item('Save', { enabled: false, checked: true })), a);
  assert.notEqual(obs.fingerprintOf(item('Save', { ctx: 'row 2' })), a);
  assert.notEqual(obs.fingerprintOf(item('Discard')), a);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('publicNode bounds names and keeps only notable flags', () => {
  const n = obs.publicNode(item('x'.repeat(900), { ambiguous: true, dupCount: 2, secret: true, ctx: 'c'.repeat(300) }), 'fr_1');
  assert.ok(n.name.length <= 120);
  assert.ok(n.context.length <= 60);
  assert.equal(n.frameId, 'fr_1');
  assert.equal(n.secret, true);
  assert.ok(!('editable' in n) && !('occluded' in n));
});

test('cursor: opaque, epoch- and focus-bound', () => {
  const c = obs.encodeCursor({ epoch: 3, offset: 40, focus: { role: 'button' } });
  assert.equal(obs.decodeCursor(c, { epoch: 3, focus: { role: 'button' } }).offset, 40);
  assert.throws(() => obs.decodeCursor(c, { epoch: 4, focus: { role: 'button' } }), (e) => e.code === 'STALE_REF' && e.detail === 'CURSOR_STALE');
  assert.throws(() => obs.decodeCursor(c, { epoch: 3, focus: null }), (e) => e.detail === 'CURSOR_FOCUS_MISMATCH');
  for (const bad of ['', 'nope', Buffer.from('{"v":2}').toString('base64url'), Buffer.from('{"v":1,"o":-1,"e":0}').toString('base64url')]) {
    assert.throws(() => obs.decodeCursor(bad, { epoch: 0 }), (e) => e.code === 'UNSUPPORTED');
  }
});

test('hard caps: node cap, byte cap, whole-observation size', () => {
  assert.equal(obs.clampNodes(9999), 200);
  assert.equal(obs.clampNodes(0), 1);
  assert.equal(obs.clampNodes(undefined), 100);
  const { run } = harness();
  const many = Array.from({ length: 500 }, (_, i) => item(`Button ${i}`));
  const o = run(many, { want: 1000 });
  assert.equal(o.nodes.length, 200);
  assert.equal(o.truncated, true);
  assert.ok(obs.decodeCursor(o.nextCursor, { epoch: 1 }).offset === 200);
  assert.ok(obs.serializedBytes(o) <= 64 * 1024);
  // multi-byte, maximum-length labels hit the byte cap first
  const wide = Array.from({ length: 300 }, (_, i) => item(`漢${i}`.padEnd(400, '字'), { ctx: '語'.repeat(200) }));
  const w = harness().run(wide, { want: 200 });
  assert.ok(w.nodes.length < 200, `${w.nodes.length}`);
  assert.ok(obs.serializedBytes(w) <= 64 * 1024, String(obs.serializedBytes(w)));
  assert.equal(w.truncated, true);
});

test('truncation is explicit; a small page is complete', () => {
  const { run } = harness();
  const o = run([item('A'), item('B')]);
  assert.equal(o.truncated, false);
  assert.equal(o.nextCursor, null);
  assert.equal(o.trust, 'untrusted-page');
  assert.equal(o.coverage.nodesReturned, 2);
  assert.ok(o.coverage.limitations.includes('closed-shadow-roots-not-observable'));
  const paged = harness().run([item('A'), item('B')], { total: 5, want: 2 });
  assert.equal(paged.truncated, true, 'more candidates exist than were returned');
});

test('delta: unchanged nodes keep base refs; only added/changed are returned; removed refs die', () => {
  const h = harness();
  const base = h.run([item('A'), item('B'), item('C')]);
  const refA = base.nodes[0].refId;
  const refC = base.nodes[2].refId;
  const next = h.run([item('A'), item('B', { enabled: false }), item('D')], { baseObservationId: base.observationId });
  assert.equal(next.delta.available, true);
  assert.equal(next.delta.unchanged, 1);
  assert.equal(next.delta.changed, 1);
  assert.equal(next.delta.added, 1);
  assert.equal(next.delta.removed, 1);
  assert.deepEqual(next.nodes.map((n) => n.name), ['B', 'D']);
  assert.ok(h.refs.get(refA).observationIds.has(next.observationId), 'the unchanged ref is valid under the new observation');
  assert.equal(h.refs.get(refC).dead, 'REF_REMOVED');
});

test('delta is refused (full snapshot) when the base is missing, stale, paged or truncated', () => {
  const h = harness();
  const base = h.run([item('A'), item('B')]);
  const missing = h.run([item('A')], { baseObservationId: 'ob_nope' });
  assert.deepEqual([missing.delta.available, missing.delta.reason, missing.nodes.length], [false, 'BASE_UNAVAILABLE', 1]);
  const epoch = h.run([item('A')], { baseObservationId: base.observationId, documentEpoch: 2 });
  assert.equal(epoch.delta.reason, 'BASE_EPOCH_CHANGED');
  const paged = h.run([item('A')], { baseObservationId: base.observationId, offset: 1, total: 3 });
  assert.equal(paged.delta.reason, 'PAGED');
  const trunc = h.run([item('A'), item('B')], { baseObservationId: base.observationId, total: 9, want: 2 });
  assert.equal(trunc.delta.reason, 'TRUNCATED');
  assert.equal(trunc.nodes.length, 2, 'a full bounded snapshot, never a partial delta');
  const noDelta = h.run([item('A')]);
  assert.equal(noDelta.delta, null);
});

test('snapshot store is bounded', () => {
  const s = new obs.SnapshotStore(2);
  s.remember('a', {}); s.remember('b', {}); s.remember('c', {});
  assert.equal(s.has('a'), false);
  assert.equal(s.has('c'), true);
});

test('coverage reports cross-origin and unavailable frames without flattening', () => {
  const cov = obs.buildCoverage({
    frames: [{ frameId: 'm', origin: 'http://a', crossOrigin: false, nodes: 3, available: true },
      { frameId: 'x', parentFrameId: 'm', origin: 'http://b', crossOrigin: true, nodes: 2, available: true },
      { frameId: 'y', parentFrameId: 'm', origin: 'http://c', crossOrigin: true, nodes: 0, available: false }],
    stats: { shadowRootsOpen: 1, possibleClosedShadowHosts: 2, canvases: 1, candidatesCapped: true },
    nodesReturned: 5, nodesTotal: 5,
  });
  assert.equal(cov.framesSeen, 3);
  assert.equal(cov.framesUnavailable, 1);
  assert.equal(cov.crossOriginFrames, 2);
  for (const l of ['closed-shadow-roots-not-observable', 'possible-closed-shadow-hosts', 'canvas-content-not-observable', 'frames-unavailable', 'candidate-scan-capped']) {
    assert.ok(cov.limitations.includes(l), l);
  }
});
