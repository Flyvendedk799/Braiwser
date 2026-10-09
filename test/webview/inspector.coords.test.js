'use strict';
// CE-13 guest side: boxes are tagged with their coordinate space, and fresh
// boxes can be requested in a named space.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

async function setup() {
  const h = await loadInspector({
    html: '<button id="cta">Buy</button><p id="far">Far</p>',
    viewport: { w: 800, h: 600 },
    dpr: 2,
  });
  h.setRect(h.q('#cta'), { x: 10, y: 400, w: 100, h: 30 });
  h.setRect(h.q('#far'), { x: 10, y: 900, w: 100, h: 30 });
  return h;
}

test('CE-13: caos:ready carries documentId and devicePixelRatio', async () => {
  const h = await setup();
  try {
    const ready = h.ipc.last('caos:ready');
    assert.ok(ready.documentId);
    assert.strictEqual(ready.devicePixelRatio, 2);
  } finally {
    h.dispose();
  }
});

test('CE-13: element annotations are tagged viewport, region annotations page, with scroll origin and dpr', async () => {
  const h = await setup();
  try {
    h.setScroll(0, 300);
    // an element note, via the compose bubble flow: pick, then click the "+" bubble
    const cta = h.q('#cta');
    h.ipc.emit('caos:set-mode', 'inspect');
    h.document.elementFromPoint = () => cta;
    h.document.dispatchEvent(new h.window.MouseEvent('click', { clientX: 20, clientY: 410, bubbles: true, cancelable: true, detail: 1 }));
    h.q('[data-caos-bubble="new"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const ta = h.q('textarea');
    ta.value = 'make bigger';
    h.q('[data-save]').click();
    const el = h.ipc.last('caos:annotation');
    assert.strictEqual(el.target.space, 'viewport');
    assert.deepStrictEqual(el.target.pageBox, { x: 10, y: 700, w: 100, h: 30 }); // 400 + 300 scroll
    assert.strictEqual(el.target.capture.scrollY, 300);
    assert.strictEqual(el.target.capture.dpr, 2);
    assert.deepStrictEqual(el.target.capture.viewport, { w: 800, h: 600 });
    assert.ok(el.target.capture.documentId);

    // a drawn region
    h.ipc.clear();
    h.ipc.emit('caos:set-mode', 'draw');
    const canvas = h.q('canvas[data-caos]');
    const pe = (type, x, y) => canvas.dispatchEvent(new h.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    pe('pointerdown', 100, 100);
    pe('pointermove', 200, 160);
    pe('pointerup', 200, 160);
    const ta2 = h.q('textarea');
    ta2.value = 'this area';
    h.q('[data-save]').click();
    const region = h.ipc.last('caos:annotation');
    assert.strictEqual(region.target.space, 'page');
    assert.deepStrictEqual(region.target.box, { x: 100, y: 400, w: 100, h: 60 }); // client 100 + scroll 300
    assert.strictEqual(region.target.capture.scrollY, 300);
  } finally {
    h.dispose();
  }
});

const ANNS = () => [
  { kind: 'element', target: { selector: '#cta', tag: 'button', text: 'Buy', box: { x: 10, y: 400, w: 100, h: 30 } } },
  { kind: 'region', target: { box: { x: 100, y: 500, w: 40, h: 20 } } },
  { kind: 'element', target: { selector: '#gone', box: { x: 5, y: 50, w: 10, h: 10 }, space: 'viewport' } },
  { kind: 'element', target: { selector: '#gone2', box: { x: 5, y: 50, w: 10, h: 10 }, space: 'page' } },
  { kind: 'element' },
];

test('CE-13: caos:request-boxes returns fresh boxes in the requested space at the current scroll origin', async () => {
  const h = await setup();
  try {
    h.setScroll(0, 300);
    h.ipc.emit('caos:request-boxes', { requestId: 'r1', space: 'viewport', annotations: ANNS() });
    const v = h.ipc.last('caos:boxes');
    assert.strictEqual(v.requestId, 'r1');
    assert.strictEqual(v.space, 'viewport');
    assert.deepStrictEqual(v.scroll, { x: 0, y: 300 });
    assert.strictEqual(v.dpr, 2);
    assert.deepStrictEqual(v.viewport, { w: 800, h: 600 });
    assert.ok(v.documentId);
    assert.strictEqual(v.url, 'https://example.test/page');
    // live element: re-measured now (viewport) ; region page y=500 -> viewport y=200 (the audit example)
    assert.deepStrictEqual(v.boxes[0], { x: 10, y: 400, w: 100, h: 30, space: 'viewport', source: 'live' });
    assert.deepStrictEqual(v.boxes[1], { x: 100, y: 200, w: 40, h: 20, space: 'viewport', source: 'stored' });
    // unresolved elements fall back to the stored box in its OWN space, converted
    assert.deepStrictEqual(v.boxes[2], { x: 5, y: 50, w: 10, h: 10, space: 'viewport', source: 'stored' });
    assert.deepStrictEqual(v.boxes[3], { x: 5, y: -250, w: 10, h: 10, space: 'viewport', source: 'stored' });
    assert.strictEqual(v.boxes[4], null);

    h.ipc.emit('caos:request-boxes', { requestId: 'r2', space: 'page', annotations: ANNS() });
    const p = h.ipc.last('caos:boxes');
    assert.strictEqual(p.requestId, 'r2');
    assert.deepStrictEqual(p.boxes[0], { x: 10, y: 700, w: 100, h: 30, space: 'page', source: 'live' });
    assert.deepStrictEqual(p.boxes[1], { x: 100, y: 500, w: 40, h: 20, space: 'page', source: 'stored' });
    assert.deepStrictEqual(p.boxes[2], { x: 5, y: 350, w: 10, h: 10, space: 'page', source: 'stored' });
  } finally {
    h.dispose();
  }
});

test('CE-13: boxes follow the scroll origin at request time, not at annotation time', async () => {
  const h = await setup();
  try {
    const anns = [{ kind: 'region', target: { box: { x: 0, y: 500, w: 10, h: 10 } } }];
    for (const [sy, want] of [[0, 500], [300, 200], [450, 50]]) {
      h.setScroll(0, sy);
      h.ipc.emit('caos:request-boxes', { space: 'viewport', annotations: anns });
      assert.strictEqual(h.ipc.last('caos:boxes').boxes[0].y, want);
      assert.strictEqual(h.ipc.last('caos:boxes').scroll.y, sy);
    }
  } finally {
    h.dispose();
  }
});

test('CE-13: legacy caos:request-page-boxes still answers a bare array, now in true page space', async () => {
  const h = await setup();
  try {
    h.setScroll(0, 300);
    h.ipc.emit('caos:request-page-boxes', ANNS());
    const boxes = h.ipc.last('caos:page-boxes');
    assert.ok(Array.isArray(boxes));
    assert.deepStrictEqual(boxes[0], { x: 10, y: 700, w: 100, h: 30 });
    assert.deepStrictEqual(boxes[1], { x: 100, y: 500, w: 40, h: 20 });
    // a stored viewport-space element box is converted, not returned as if it were page space
    assert.deepStrictEqual(boxes[2], { x: 5, y: 350, w: 10, h: 10 });
  } finally {
    h.dispose();
  }
});
