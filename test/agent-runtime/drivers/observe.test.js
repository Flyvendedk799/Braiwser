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

// ---- tables, lists, pagination hints ----------------------------------------------------------------------------
const tableItem = (name, table) => ({ kind: 'table', role: 'table', name, tag: 'table', type: '', ctx: '', table });
const smallTable = (cells) => ({ rowCount: cells.length, rowsExact: true, columnCount: 2, hasHeader: true, headers: ['A', 'B'], cells, truncated: { rows: false, columns: false, cells: 0 }, merged: false, withheld: [] });

test('publicNode carries a bounded table / list payload and re-clips every string', () => {
  const t = obs.publicNode(tableItem('Orders', smallTable([['a‮b', 'x'.repeat(500)], [null, '']])), null);
  assert.equal(t.table.cells[0][0], 'a b');
  assert.ok(t.table.cells[0][1].length <= 80);
  assert.deepEqual(t.table.cells[1], [null, ''], 'withheld (null) and empty ("") stay distinguishable');
  const l = obs.publicNode({ kind: 'list', role: 'list', name: '', tag: 'ul', list: { ordered: true, itemCount: 100, items: Array.from({ length: 100 }, (_, i) => `i${i}`), truncated: { items: true, cells: 0 } } }, null);
  assert.equal(l.list.items.length, 30); assert.equal(l.list.itemCount, 100); assert.equal(l.list.truncated.items, true);
  const evil = obs.boundTable({ headers: new Array(40).fill('h'), cells: new Array(90).fill(new Array(40).fill('c')), withheld: [1, -1, 99, 'x'], rowCount: 'many' });
  assert.equal(evil.headers.length, 12); assert.ok(evil.cells.length <= 50); assert.ok(evil.cells.every((r) => r.length <= 12));
  assert.deepEqual(evil.withheld, [1]); assert.equal(evil.rowCount, evil.cells.length); assert.equal(evil.truncated.rows, true);
  assert.equal(obs.boundTable(null).cells.length, 0, 'garbage in, an empty bounded table out');
});

test('a table\'s content is part of its state signature, so a delta cannot hide a changed cell', () => {
  const a = obs.publicNode(tableItem('Orders', smallTable([['1', 'x']])), null);
  const b = obs.publicNode(tableItem('Orders', smallTable([['1', 'y']])), null);
  assert.notEqual(obs.stateSig(a), obs.stateSig(b));
  assert.equal(obs.stateSig(a), obs.stateSig(obs.publicNode(tableItem('Orders', smallTable([['1', 'x']])), null)));
});

test('assembled observations stay within 64 KiB and 200 nodes with many large tables', () => {
  const big = Array.from({ length: 50 }, (_, i) => Array.from({ length: 12 }, (_x, j) => `${i}-${j}-` + 'é'.repeat(70)));
  const items = Array.from({ length: 12 }, (_, i) => tableItem(`T${i}`, smallTable(big)));
  const h = harness();
  const o = h.run(items);
  assert.ok(obs.serializedBytes(o) <= obs.LIMITS.maxBytes, `${obs.serializedBytes(o)} bytes`);
  assert.ok(o.nodes.length < items.length && o.truncated === true && o.nextCursor, 'tables beyond the byte budget move to the next page, explicitly');
});

test('pagination hints: accessible names only, links and buttons only, ambiguity reported without a ref', () => {
  const node = (role, name, extra) => ({ refId: `r_${role}_${name}`, role, name, ...(extra || {}) });
  assert.deepEqual(obs.paginationHints([node('link', 'Next'), node('link', 'Previous', { enabled: false }), node('heading', 'Next')]),
    { next: { refId: 'r_link_Next', name: 'Next', enabled: true }, prev: { refId: 'r_link_Previous', name: 'Previous', enabled: false } });
  assert.equal(obs.paginationHints([node('link', 'Nextel'), node('textbox', 'Next'), node('link', 'Go to next section')]), null);
  for (const name of ['Next page', 'Older', 'next ›', '›', '»', 'Forward']) assert.ok(obs.paginationHints([node('button', name)]).next, name);
  for (const name of ['Prev', 'Previous page', 'Newer', '‹', '« Previous', 'Back']) assert.ok(obs.paginationHints([node('button', name)]).prev, name);
  const amb = obs.paginationHints([node('link', 'Next'), node('button', 'Next page'), node('link', 'Previous')]);
  assert.deepEqual(amb.ambiguous, ['next']); assert.equal(amb.next, undefined); assert.ok(amb.prev);
  assert.equal(obs.paginationHints([]), null);
});

test('assembleObservation attaches the hint with the refs minted for this observation', () => {
  const h = harness();
  const o = h.run([item('Save'), { ...item('Next'), role: 'link' }, tableItem('Orders', smallTable([['1', '2']]))]);
  const next = o.nodes.find((n) => n.name === 'Next');
  assert.deepEqual(o.pagination, { next: { refId: next.refId, name: 'Next', enabled: true } });
});

test('viewport evidence uses the closed state-change kind and role locators may omit the name', () => {
  assert.deepEqual(obs.evidence.viewport(375, 812, true, 4), { kind: 'state-change', observed: true, change: 'viewport', width: 375, height: 812, matches: true, documentEpoch: 4 });
  assert.deepEqual(obs.normalizeLocator({ by: 'role', role: 'Row' }), { by: 'role', role: 'row' });
  assert.deepEqual(obs.normalizeLocator({ by: 'role', role: 'row', name: '' }), { by: 'role', role: 'row', name: '' });
  assert.equal(obs.normalizeLocator({ by: 'role', role: 'row', name: 5 }), null);
  assert.equal(obs.locatorLabel({ by: 'role', role: 'row' }), 'role=row');
  assert.equal(obs.LIMITS.minViewport, 240); assert.equal(obs.LIMITS.maxViewport, 4096);
});
