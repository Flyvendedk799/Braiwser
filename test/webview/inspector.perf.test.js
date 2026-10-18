'use strict';
// Layer-overlap sweep (bounded, honest) and the per-document history budget.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');
const layers = require('../../src/webview/inspector.layers');
const history = require('../../src/webview/inspector.history');

function rect(x, y, w, h) {
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
}

function brute(rects, minRatio = 0.3) {
  return rects.map((a, i) =>
    rects.some((b, j) => j !== i && layers.overlapRatio(a, b) > minRatio)
  );
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('perf: sweep gives exactly the brute-force answer on random layouts', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const n = 5 + Math.floor(r() * 60);
    const rects = [];
    for (let i = 0; i < n; i++) {
      // include zero-area boxes and identical boxes on purpose
      const w = r() < 0.1 ? 0 : Math.floor(r() * 120);
      const h = r() < 0.1 ? 0 : Math.floor(r() * 80);
      rects.push(rect(Math.floor(r() * 300), Math.floor(r() * 300), w, h));
    }
    if (n > 10) rects.push(rects[3]);
    const res = layers.computeOverlaps(rects);
    assert.strictEqual(res.complete, true);
    assert.deepStrictEqual(res.overlapping, brute(rects), 'seed ' + seed);
  }
});

test('perf: 20000 side-by-side siblings do near-linear work, not n^2', () => {
  const rects = [];
  for (let i = 0; i < 20000; i++) rects.push(rect(i * 10, 0, 9, 9));
  const t0 = Date.now();
  const res = layers.computeOverlaps(rects);
  assert.strictEqual(res.complete, true);
  assert.ok(res.steps < 20000 * 3, 'steps=' + res.steps); // brute force would be 200M comparisons
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(res.overlapping.every((v) => v === false));
});

test('perf: pathological full stack is capped and reports an incomplete result honestly', () => {
  const rects = [];
  for (let i = 0; i < 3000; i++) rects.push(rect(0, 0, 100, 100)); // all identical -> all overlap
  const res = layers.computeOverlaps(rects, { maxSteps: 5000 });
  assert.ok(res.steps <= 5001);
  assert.strictEqual(res.complete, false);
  const full = layers.computeOverlaps(rects.slice(0, 200));
  assert.strictEqual(full.complete, true);
  assert.ok(full.overlapping.every(Boolean));
});

test('perf: Layers payload flags overlaps and reports overlapComplete', async () => {
  let html = '<div id="c">';
  for (let i = 0; i < 6; i++) html += '<div id="k' + i + '">k' + i + '</div>';
  html += '</div>';
  const h = await loadInspector({ html });
  try {
    const kids = h.qa('#c > div');
    kids.forEach((k, i) => h.setRect(k, { x: i < 2 ? 0 : 500 + i * 120, y: 0, w: 100, h: 50 }));
    h.ipc.emit('caos:request-layout', { selector: '#k4' });
    const info = h.ipc.last('caos:layout-picked');
    assert.deepStrictEqual(info.siblings.map((s) => s.overlapping), [true, true, false, false, false, false]);
    assert.strictEqual(info.container.overlapComplete, true);
    assert.deepStrictEqual(info.siblings.map((s) => s.index), [0, 1, 2, 3, 4, 5]);
  } finally {
    h.dispose();
  }
});

// ------------------------------------------------------------ history budget ---

test('history (unit): trimStack evicts oldest first, keeps the newest, honors both limits', () => {
  const mk = (n, cost) => ({ ann: { id: 'a' + n }, cost });
  const stack = [mk(1, 10), mk(2, 10), mk(3, 10), mk(4, 10)];
  const dropped = history.trimStack(stack, { maxEntries: 2, maxBytes: 1e9 });
  assert.deepStrictEqual(dropped.map((e) => e.ann.id), ['a1', 'a2']);
  assert.deepStrictEqual(stack.map((e) => e.ann.id), ['a3', 'a4']);

  const big = [mk(1, 500000), mk(2, 500000), mk(3, 900000)];
  const d2 = history.trimStack(big, { maxEntries: 100, maxBytes: 1000000 });
  assert.deepStrictEqual(big.map((e) => e.ann.id), ['a3']);
  assert.strictEqual(d2.length, 2);

  const one = [mk(1, 9e9)];
  assert.strictEqual(history.trimStack(one, { maxBytes: 10 }).length, 0); // newest is always kept
});

test('history: a long editing session stays within the entry budget and reports what was dropped', async () => {
  const h = await loadInspector({ html: '<div id="box"><p id="t">Hi</p></div>' });
  try {
    h.ipc.emit('caos:set-mode', 'edit');
    // 300 distinct notes: leave the element between them so each is its own edit
    for (let i = 0; i < 300; i++) {
      h.ipc.emit('caos:edit-select', { selector: '#t' });
      h.ipc.emit('caos:apply-style', { selector: '#t', props: { 'letter-spacing': i + 1 + 'px' }, commit: true });
      h.ipc.emit('caos:edit-select', { selector: '#box' });
    }
    const stacks = h.ipc.last('caos:edit-stacks');
    assert.ok(stacks.undo <= history.DEFAULT_LIMITS.maxEntries, 'undo=' + stacks.undo);
    assert.ok(stacks.undo >= 1);
    assert.strictEqual(stacks.undo + stacks.dropped, 300);
    // the most recent edit is still undoable
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(h.ipc.last('caos:edit-stacks').undo, stacks.undo - 1);
    assert.strictEqual(h.ipc.last('caos:edit-stacks').redo, 1);
  } finally {
    h.dispose();
  }
});

test('history: edits whose element the page removed are pruned on same-document navigation', async () => {
  const h = await loadInspector({ html: '<div id="app"><p id="a">A</p></div><p id="b">B</p>' });
  try {
    h.ipc.emit('caos:set-mode', 'edit');
    h.ipc.emit('caos:apply-style', { selector: '#a', props: { color: 'red' }, commit: true });
    h.ipc.emit('caos:edit-select', { selector: '#b' });
    h.ipc.emit('caos:apply-style', { selector: '#b', props: { color: 'red' }, commit: true });
    assert.strictEqual(h.ipc.last('caos:edit-stacks').undo, 2);
    h.q('#app').remove(); // the SPA re-rendered the route
    h.window.dispatchEvent(new h.window.Event('popstate'));
    await new Promise((r) => setTimeout(r, 10));
    const s = h.ipc.last('caos:edit-stacks');
    assert.strictEqual(s.undo, 1);
    assert.strictEqual(s.dropped, 1);
  } finally {
    h.dispose();
  }
});

test('history: pagehide releases every retained edit', async () => {
  const h = await loadInspector({ html: '<p id="a">A</p>' });
  try {
    h.ipc.emit('caos:set-mode', 'edit');
    h.ipc.emit('caos:apply-style', { selector: '#a', props: { color: 'red' }, commit: true });
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    h.ipc.emit('caos:request-stacks');
    const s = h.ipc.last('caos:edit-stacks');
    assert.strictEqual(s.undo, 0);
    assert.strictEqual(s.redo, 0);
  } finally {
    h.dispose();
  }
});
