import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBoxes, normalizeBoxReply, sameMeasure } from '../../../src/renderer/lib/screenshots.js';
import { captureScreenshot } from '../../../src/renderer/controllers/screenshot-capture.js';

const el = (x, y, w, h, extra) => ({ x, y, w, h, space: 'viewport', source: 'live', ...extra });
const region = (x, y, w, h, extra) => ({ x, y, w, h, space: 'page', source: 'live', ...extra });

test('CE-13: page-space region is shifted by the scroll origin on a viewport shot (500 -> 200 at scroll 300)', () => {
  const { placed } = placeBoxes([{ box: region(10, 500, 50, 40) }], { kind: 'viewport', scroll: { x: 0, y: 300 }, size: { w: 1000, h: 800 } });
  assert.equal(placed[0].box.y, 200);
});

test('CE-13: viewport-space element box is NOT shifted on a viewport shot; is on a full-page shot', () => {
  const v = placeBoxes([{ box: el(10, 100, 50, 40) }], { kind: 'viewport', scroll: { x: 0, y: 300 }, size: { w: 1000, h: 800 } });
  assert.equal(v.placed[0].box.y, 100);
  const f = placeBoxes([{ box: el(10, 100, 50, 40) }], { kind: 'fullpage', scroll: { x: 0, y: 300 }, size: { w: 1000, h: 3000 } });
  assert.equal(f.placed[0].box.y, 400);
});

test('CE-13: boxes entirely outside the captured area are skipped and counted', () => {
  const r = placeBoxes([{ box: region(0, 5000, 10, 10) }, { box: region(0, 100, 10, 10) }, { box: null }], { kind: 'viewport', scroll: { x: 0, y: 0 }, size: { w: 800, h: 600 } });
  assert.equal(r.placed.length, 1);
  assert.equal(r.skipped, 2);
});

test('normalizeBoxReply: legacy bare array is page space; caos:boxes reply keeps tags, scroll, dpr, documentId', () => {
  const legacy = normalizeBoxReply([{ x: 1, y: 2, w: 3, h: 4 }, null], 2);
  assert.equal(legacy.boxes[0].space, 'page');
  assert.equal(legacy.boxes[1], null);
  const n = normalizeBoxReply({ requestId: 'q', space: 'viewport', documentId: 'd1', scroll: { x: 0, y: 300 }, dpr: 2, viewport: { w: 1000, h: 700 }, page: { w: 1000, h: 4000 }, boxes: [{ x: 1, y: 2, w: 3, h: 4, space: 'viewport', source: 'stored' }] }, 1);
  assert.deepEqual([n.requestId, n.documentId, n.dpr, n.scroll, n.viewport], ['q', 'd1', 2, { x: 0, y: 300 }, { w: 1000, h: 700 }, ]);
  assert.equal(n.boxes[0].source, 'stored');
});

test('sameMeasure detects scroll / resize / dpr drift', () => {
  const a = { scroll: { x: 0, y: 300 }, viewport: { w: 1000, h: 700 }, dpr: 1 };
  assert.ok(sameMeasure(a, { ...a }));
  assert.ok(!sameMeasure(a, { ...a, scroll: { x: 0, y: 340 } }));
  assert.ok(!sameMeasure(a, { ...a, dpr: 2 }));
  assert.ok(!sameMeasure(a, null));
});

// ---- orchestration -------------------------------------------------------------
function deps(over = {}) {
  const calls = [];
  const d = {
    calls,
    staleReason: () => null,
    measure: async () => ({ scroll: { x: 0, y: 300 }, dpr: 1, viewport: { w: 1000, h: 700 } }),
    captureViewport: async () => 'VIEWPORT',
    captureFull: async () => ({ ok: true, dataUrl: 'FULL', cssWidth: 1000, cssHeight: 3000 }),
    requestBoxes: async (c, items, space) => {
      calls.push(['boxes', space]);
      return { requestId: 'q', space, documentId: 'd1', scroll: { x: 0, y: 300 }, dpr: 1, viewport: { w: 1000, h: 700 }, boxes: items.map((a) => a.__box) };
    },
    annotationsFor: () => [],
    documentIdOf: () => 'd1',
    composite: async (url, items) => { calls.push(['composite', items.map((i) => i.box)]); return 'COMPOSED'; },
    fallbackWidth: () => 1000,
    ...over,
  };
  return d;
}
const ann = (box, extra) => ({ action: 'fix', note: 'n', kind: 'element', target: {}, __box: box, ...extra });

test('CE-13: viewport capture asks for VIEWPORT-space boxes right after the pixels and draws them as measured', async () => {
  const d = deps({ annotationsFor: () => [ann(el(10, 100, 50, 40))] });
  const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.dataUrl, 'COMPOSED');
  assert.deepEqual(d.calls[0], ['boxes', 'viewport']);
  assert.deepEqual(d.calls[1][1][0], { x: 10, y: 100, w: 50, h: 40 });
});

test('CE-13: full-page capture asks for PAGE-space boxes and keeps them', async () => {
  const d = deps({ annotationsFor: () => [ann(region(10, 1500, 50, 40), { kind: 'region' })] });
  const res = await captureScreenshot({ tabId: 'A' }, { full: true }, d);
  assert.equal(res.count, 1);
  assert.equal(d.calls[0][1], 'page');
  assert.equal(d.calls[1][1][0].y, 1500);
});

test('CE-13: a region reported in page space is converted for a viewport shot at the captured scroll', async () => {
  const d = deps({ annotationsFor: () => [ann(region(10, 500, 50, 40), { kind: 'region' })] });
  const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(res.count, 1);
  assert.equal(d.calls[1][1][0].y, 200);
});

test('CE-13: post-layout shift (scroll changed between pixels and boxes) draws nothing and says so', async () => {
  let n = 0;
  const d = deps({
    annotationsFor: () => [ann(el(10, 100, 50, 40))],
    measure: async () => ({ scroll: { x: 0, y: n++ ? 340 : 300 }, dpr: 1, viewport: { w: 1000, h: 700 } }),
    requestBoxes: async () => ({ documentId: 'd1', boxes: [el(10, 100, 50, 40)], scroll: { x: 0, y: 340 }, viewport: { w: 1000, h: 700 }, dpr: 1 }),
  });
  const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.skipped, 1);
  assert.match(res.note, /moved/);
  assert.equal(res.dataUrl, 'VIEWPORT');
});

test('CE-13: device scale / zoom — cssWidth comes from the guest viewport, not the host element', async () => {
  let width;
  const d = deps({ annotationsFor: () => [ann(el(0, 0, 10, 10))], composite: async (u, items, o) => { width = o.cssWidth; return 'C'; }, fallbackWidth: () => 1234 });
  await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(width, 1000);
});

test('CE-13: tab switched / navigated while capturing -> cancelled, nothing composited', async () => {
  for (const reason of ['the tab is no longer in front', 'the page navigated']) {
    let calls = 0;
    const d = deps({ annotationsFor: () => [ann(el(0, 0, 10, 10))], staleReason: () => (++calls >= 2 ? reason : null) });
    const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
    assert.equal(res.ok, false);
    assert.match(res.error, /cancelled/);
    assert.ok(!d.calls.some(([k]) => k === 'composite'));
  }
});

test('CE-13: a reply from a different document is refused', async () => {
  const d = deps({ annotationsFor: () => [ann(el(0, 0, 10, 10))], documentIdOf: () => 'd-current' });
  const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(res.ok, false);
  assert.match(res.error, /replaced/);
});

test('CE-13: stored element boxes (could not be re-resolved) are never drawn; stored regions are', async () => {
  const d = deps({
    annotationsFor: () => [ann(el(10, 10, 5, 5, { source: 'stored' })), ann(region(10, 400, 5, 5, { source: 'stored' }), { kind: 'region' })],
  });
  const res = await captureScreenshot({ tabId: 'A' }, { full: false }, d);
  assert.equal(res.count, 1);
  assert.equal(res.skipped, 1);
});

test('full-page capture failure is reported, not swallowed', async () => {
  const d = deps({ captureFull: async () => ({ ok: false, error: 'debugger busy' }) });
  const res = await captureScreenshot({ tabId: 'A' }, { full: true }, d);
  assert.equal(res.ok, false);
  assert.match(res.error, /debugger busy/);
});
