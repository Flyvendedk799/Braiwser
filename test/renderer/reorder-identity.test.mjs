// RF-08 (panel side): reorder / move payloads carry the identity the guest
// resolves (nid, selector) in the field names its handlers read (parentId,
// nodeId, beforeId, beforeSelector, fromDomIndex), instead of only a visual index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, key, tick } from './dom-env.mjs';

const { window, document } = setupDom();
const { createSectionsPanel } = await load('components/sections-panel.js');
const { createLayersPanel } = await load('components/layers-panel.js');

// Body children in the real DOM: script#boot (0), section#one (1), section#two (2),
// style (3), section#three (4). The serializer drops the script/style nodes, so
// the visible list is [one, two, three] with index 0..2 and domIndex 1, 2, 4.
const tree = () => ({
  tag: 'body', selector: 'body', nid: 'n-body',
  children: [
    { tag: 'section', id: 'one', selector: '#one', nid: 'n-one', classes: [], index: 0, domIndex: 1, children: [] },
    { tag: 'section', id: 'two', selector: '#two', nid: 'n-two', classes: [], index: 1, domIndex: 2, children: [{ tag: 'div', selector: '#two > div', nid: 'n-two-div', classes: [], index: 0, domIndex: 0, children: [] }] },
    { tag: 'section', id: 'three', selector: '#three', nid: 'n-three', classes: [], index: 2, domIndex: 4, children: [] },
  ],
});

function mount(t = tree()) {
  const sent = { reorder: [], moveInto: [] };
  const panel = createSectionsPanel({
    select: () => {}, hover: () => {}, hoverClear: () => {}, refresh: () => {}, toggleHidden: () => {},
    reorder: (p) => sent.reorder.push(p), moveInto: (p) => sent.moveInto.push(p),
  });
  document.body.appendChild(panel.root);
  panel.setTree(t);
  return { panel, sent };
}

// jsdom has no layout: give every row a fake box so the drop resolver can work.
function layOut(panel) {
  const rows = Array.from(panel.root.querySelectorAll('.sec-row'));
  rows.forEach((r, i) => {
    const top = i * 30;
    r.getBoundingClientRect = () => ({ top, bottom: top + 28, left: 0, right: 200, width: 200, height: 28 });
  });
  panel.root.querySelector('.sec-list').getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 200, width: 200, height: 500 });
  return rows;
}

function drag(row, fromY, toY) {
  const ev = (type, y) => new window.MouseEvent(type, { bubbles: true, clientX: 10, clientY: y, button: 0 });
  row.dispatchEvent(ev('pointerdown', fromY));
  window.dispatchEvent(ev('pointermove', fromY + 6));
  window.dispatchEvent(ev('pointermove', toY));
  window.dispatchEvent(ev('pointerup', toY));
}

test('same-parent drag sends parent/node identity, the final slot and the DOM index', async () => {
  const { panel, sent } = mount();
  const rows = layOut(panel);
  // Rows: #one(0) #two(1) #two > div(2) #three(3). Drag #one below #three's top half.
  drag(rows[0], 5, 3 * 30 + 20);
  await tick(5);
  assert.equal(sent.reorder.length, 1);
  const p = sent.reorder[0];
  assert.equal(p.parentSelector, 'body');
  assert.equal(p.parentId, 'n-body');
  assert.equal(p.nodeId, 'n-one');
  assert.equal(p.selector, '#one');
  assert.equal(p.fromIndex, 0);
  assert.equal(p.toIndex, 2, 'final content index');
  assert.equal(p.destSelector, '#three');
  assert.equal(p.destId, 'n-three');
  assert.equal(p.placement, 'after');
  assert.equal(p.fromDomIndex, 1, 'real DOM index, not the visual 0');
});

test('moving up names the sibling it lands before', async () => {
  const { panel, sent } = mount();
  const rows = layOut(panel);
  drag(rows[3], 3 * 30 + 5, 2); // #three to the very top
  await tick(5);
  const p = sent.reorder[0];
  assert.equal(p.nodeId, 'n-three');
  assert.equal(p.destId, 'n-one');
  assert.equal(p.placement, 'before');
  assert.equal(p.fromDomIndex, 4);
  assert.equal(p.toIndex, 0);
});

test('legacy fields are still sent (index-only guests keep working)', async () => {
  const { panel, sent } = mount();
  const rows = layOut(panel);
  drag(rows[0], 5, 3 * 30 + 20);
  await tick(5);
  const p = sent.reorder[0];
  assert.ok('parentSelector' in p && 'fromIndex' in p && 'toIndex' in p);
});

test('an older guest without nid/domIndex: selector identity still goes out, no undefined ids', async () => {
  const t = tree();
  delete t.nid;
  t.children.forEach((c) => { delete c.nid; delete c.domIndex; delete c.index; });
  const { panel, sent } = mount(t);
  const rows = layOut(panel);
  drag(rows[0], 5, 3 * 30 + 20);
  await tick(5);
  const p = sent.reorder[0];
  assert.equal(p.selector, '#one');
  assert.equal(p.destSelector, '#three');
  for (const k of ['parentId', 'nodeId', 'destId', 'fromDomIndex']) assert.ok(!(k in p), k + ' absent');
});

test('cross-container move names the node, the target container and the sibling it lands before', async () => {
  const { panel, sent } = mount();
  const rows = layOut(panel);
  // Drop #one onto the child row inside #two (index 2): lands before #two > div.
  drag(rows[0], 5, 2 * 30 + 4);
  await tick(5);
  assert.equal(sent.moveInto.length, 1);
  const m = sent.moveInto[0];
  assert.equal(m.nodeId, 'n-one');
  assert.equal(m.selector, '#one');
  assert.equal(m.parentSelector, '#two');
  assert.equal(m.parentId, 'n-two');
  assert.equal(m.index, 0);
  assert.equal(m.beforeId, 'n-two-div');
  assert.equal(m.beforeSelector, '#two > div');
});

test('dropping at the end of a container sends no beforeId (the guest appends)', async () => {
  const { panel, sent } = mount();
  const rows = layOut(panel);
  drag(rows[0], 5, 2 * 30 + 26); // lower half of #two > div => after it
  await tick(5);
  const m = sent.moveInto[0];
  assert.equal(m.parentId, 'n-two');
  assert.equal(m.index, 1);
  assert.ok(!('beforeId' in m) && !('beforeSelector' in m));
});

test('keyboard: Alt+ArrowDown reorders a section with the same identity payload', () => {
  const { panel, sent } = mount();
  const row = panel.root.querySelector('.sec-row');
  row.focus();
  key(row, 'ArrowDown', { altKey: true });
  assert.equal(sent.reorder.length, 1);
  const p = sent.reorder[0];
  assert.deepEqual([p.nodeId, p.destId, p.placement, p.fromDomIndex, p.toIndex], ['n-one', 'n-two', 'after', 1, 1]);
});

test('layers: reorder carries container + moved layer identity', () => {
  const sent = [];
  const panel = createLayersPanel({ selectLayout: () => {}, hover: () => {}, hoverClear: () => {}, toggleHidden: () => {}, zOrder: () => {}, smartLayout: () => {}, reorder: (p) => sent.push(p) });
  document.body.appendChild(panel.root);
  panel.setLayout({
    breadcrumb: [{ selector: 'body', tag: 'body' }, { selector: '#a', tag: 'div' }],
    container: { selector: 'body', nid: 'n-body', tag: 'body', kind: 'column', childCount: 3 },
    siblings: [
      { selector: '#a', nid: 'n-a', tag: 'div', isTarget: true, domIndex: 1 },
      { selector: '#b', nid: 'n-b', tag: 'div', domIndex: 3 },
      { selector: '#c', nid: 'n-c', tag: 'div', domIndex: 4 },
    ],
  });
  const rows = Array.from(panel.root.querySelectorAll('.layer-row'));
  rows[1].focus();
  key(rows[1], 'ArrowUp', { altKey: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(
    [sent[0].parentSelector, sent[0].parentId, sent[0].fromIndex, sent[0].toIndex, sent[0].selector, sent[0].nodeId, sent[0].destSelector, sent[0].destId, sent[0].placement, sent[0].fromDomIndex],
    ['body', 'n-body', 1, 0, '#b', 'n-b', '#a', 'n-a', 'before', 3]
  );
  // Alt+Up on the first row is a no-op, not an out-of-range index.
  sent.length = 0;
  key(rows[0], 'ArrowUp', { altKey: true });
  assert.equal(sent.length, 0);
});
