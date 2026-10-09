'use strict';
// RF-08 (one canonical child filter, identity-first handlers) and CE-11 (source
// identity captured before structural edits), against the REAL inspector.js.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

const order = (h, sel) =>
  h.qa(sel + ' > *')
    .filter((n) => !n.hasAttribute('data-caos'))
    .map((n) => n.id || n.tagName.toLowerCase());

async function setup(html, opts) {
  const h = await loadInspector(Object.assign({ html }, opts || {}));
  // selectors are anchor.js's business; tests compare against what it says
  h.path = (el) => h.requireWebview('anchor.js').cssPath(el);
  return h;
}

function tree(h) {
  h.ipc.clear();
  h.ipc.emit('caos:request-dom-tree');
  return h.ipc.last('caos:dom-tree');
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
}

const BODY =
  '<script id="boot">1</script><style id="st"></style><section id="one">One</section>' +
  '<noscript id="ns">x</noscript><section id="two">Two</section><section id="three">Three</section>' +
  '<div data-caos id="overlay"></div>';

test('RF-08: serializer indexes agree with the reorder handler despite script/style/noscript/overlay nodes', async () => {
  const h = await setup(BODY);
  try {
    const t = tree(h);
    assert.deepStrictEqual(t.children.map((c) => c.id), ['one', 'two', 'three']);
    assert.deepStrictEqual(t.children.map((c) => c.index), [0, 1, 2]);
    // domIndex is the REAL position among all element children
    assert.deepStrictEqual(t.children.map((c) => c.domIndex), [2, 4, 5]);
    assert.ok(t.children.every((c) => typeof c.nid === 'string' && c.nid));

    // Drag visible #one from position 0 to 1 (the audit reproducer)
    h.ipc.clear();
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'body', fromIndex: 0, toIndex: 1 });
    assert.deepStrictEqual(order(h, 'body'), ['boot', 'st', 'ns', 'two', 'one', 'three']);
    const ann = h.ipc.last('caos:annotation');
    assert.match(ann.note, /`#one`/); // not #boot
    assert.match(ann.note, /position 1 to position 2/);
    assert.strictEqual(h.ipc.last('caos:structure-result').ok, true);
  } finally {
    h.dispose();
  }
});

test('RF-08: node id / selector identity wins over a stale index', async () => {
  const h = await setup(BODY);
  try {
    const t = tree(h);
    const three = find(t, (n) => n.id === 'three');
    // fromIndex lies (points at #one); the id names #three
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'body', nodeId: three.nid, fromIndex: 0, toIndex: 0 });
    assert.deepStrictEqual(order(h, 'body').filter((x) => /one|two|three/.test(x)), ['three', 'one', 'two']);

    // a named selector that is not a child of the parent is rejected, not guessed
    h.ipc.clear();
    const before = order(h, 'body');
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'body', selector: '#nope', fromIndex: 0, toIndex: 2 });
    assert.deepStrictEqual(order(h, 'body'), before);
    const r = h.ipc.last('caos:structure-result');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'source-not-found');
  } finally {
    h.dispose();
  }
});

test('RF-08: real DOM index fallback only applies when no identity is sent', async () => {
  const h = await setup(BODY);
  try {
    // fromDomIndex 4 is #two
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'body', fromDomIndex: 4, toIndex: 0 });
    assert.deepStrictEqual(order(h, 'body').filter((x) => /one|two|three/.test(x)), ['two', 'one', 'three']);
    // a DOM index that lands on a script is not a content child -> rejected
    h.ipc.clear();
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'body', fromDomIndex: 0, toIndex: 1 });
    assert.strictEqual(h.ipc.last('caos:structure-result').ok, false);
  } finally {
    h.dispose();
  }
});

test('RF-08: cross-container insertion counts content children only', async () => {
  const h = await setup(
    '<div id="src"><p id="a">a</p><p id="b">b</p></div>' +
      '<div id="dst"><script id="s1"></script><style id="s2"></style><p id="x">x</p><p id="y">y</p></div>'
  );
  try {
    // index 1 in dst's CONTENT children == before #y
    h.ipc.emit('caos:move-into', { selector: '#a', parentSelector: '#dst', index: 1 });
    assert.deepStrictEqual(order(h, '#dst'), ['s1', 's2', 'x', 'a', 'y']);
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.edit.type, 'reparent');
    assert.strictEqual(ann.edit.details.toIndex, 1);
    assert.strictEqual(ann.edit.details.fromIndex, 0);

    // index 0 lands before the first CONTENT child (after the leading script/style)
    h.ipc.emit('caos:move-into', { selector: '#b', parentSelector: '#dst', index: 0 });
    assert.deepStrictEqual(order(h, '#dst'), ['s1', 's2', 'b', 'x', 'a', 'y']);

    // past the end appends
    h.ipc.emit('caos:move-into', { selector: '#b', parentSelector: '#dst', index: 99 });
    assert.deepStrictEqual(order(h, '#dst'), ['s1', 's2', 'x', 'a', 'y', 'b']);

    // cycles and non-containers are rejected
    h.ipc.clear();
    h.ipc.emit('caos:move-into', { selector: '#dst', parentSelector: '#a', index: 0 });
    assert.strictEqual(h.ipc.last('caos:structure-result').reason, 'cycle');
  } finally {
    h.dispose();
  }
});

test('RF-08: same-parent move-into reports the same coordinates the tree shows', async () => {
  const h = await setup('<ul id="l"><script></script><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>');
  try {
    h.ipc.emit('caos:move-into', { selector: '#a', parentSelector: '#l', index: 2 });
    assert.deepStrictEqual(order(h, '#l'), ['script', 'b', 'c', 'a']);
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.edit.type, 'reorder');
    assert.strictEqual(ann.edit.details.fromIndex, 0);
    assert.strictEqual(ann.edit.details.toIndex, 2);
    // no-op drop: nothing recorded, DOM untouched
    h.ipc.clear();
    h.ipc.emit('caos:move-into', { selector: '#a', parentSelector: '#l', index: 2 });
    assert.strictEqual(h.ipc.sent('caos:annotation').length, 0);
    assert.deepStrictEqual(order(h, '#l'), ['script', 'b', 'c', 'a']);
  } finally {
    h.dispose();
  }
});

test('RF-08: undo restores the exact original position among scripts', async () => {
  const h = await setup('<div id="l"><span id="a">A</span><script id="s"></script><span id="b">B</span></div>');
  try {
    h.ipc.emit('caos:reorder-sibling', { parentSelector: '#l', fromIndex: 0, toIndex: 1 });
    assert.deepStrictEqual(order(h, '#l'), ['s', 'b', 'a']);
    h.ipc.emit('caos:undo-edit');
    assert.deepStrictEqual(order(h, '#l'), ['a', 's', 'b']); // a is again BEFORE the script
    h.ipc.emit('caos:redo-edit');
    assert.deepStrictEqual(order(h, '#l'), ['s', 'b', 'a']);
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------- CE-11 -------

const LIST = '<ul><li>A</li><li>B</li><li>C</li></ul>';

test('CE-11: reorder annotation keeps the SOURCE identity; preview position is separate', async () => {
  const h = await setup(LIST);
  try {
    const aEl = h.q('li');
    const srcSel = h.path(aEl);
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'ul', fromIndex: 0, toIndex: 1 });
    assert.deepStrictEqual(h.qa('li').map((l) => l.textContent), ['B', 'A', 'C']);
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.target.selector, srcSel); // A as the source has it
    assert.strictEqual(ann.target.text, 'A');
    assert.strictEqual(ann.edit.details.sourceSelector, srcSel);
    assert.strictEqual(ann.edit.details.previewSelector, h.path(aEl)); // where the preview put it
    assert.notStrictEqual(ann.edit.details.previewSelector, srcSel);
    assert.ok(ann.note.includes('`' + srcSel + '`'));

    h.dispose();
    // Reload the unchanged page: the stored target resolves to A, not B.
    const fresh = await setup(LIST);
    try {
      const anchor = fresh.requireWebview('anchor.js');
      assert.strictEqual(anchor.resolve(ann.target).textContent, 'A');
    } finally {
      fresh.dispose();
    }
  } finally {
    h.dispose();
  }
});

for (const [from, to] of [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]) {
  test(`CE-11: every moved sibling keeps its source selector (${from} -> ${to}) through undo/redo`, async () => {
    const h = await setup(LIST);
    try {
      const names = ['A', 'B', 'C'];
      const srcSel = h.path(h.qa('li')[from]);
      h.ipc.emit('caos:reorder-sibling', { parentSelector: 'ul', fromIndex: from, toIndex: to });
      const ann = h.ipc.last('caos:annotation');
      assert.strictEqual(ann.target.text, names[from]);
      assert.strictEqual(ann.target.selector, srcSel);
      h.ipc.emit('caos:undo-edit');
      assert.deepStrictEqual(h.qa('li').map((l) => l.textContent), names);
      assert.strictEqual(h.ipc.last('caos:edit-undo').id, ann.id);
      h.ipc.clear();
      h.ipc.emit('caos:redo-edit');
      const again = h.ipc.last('caos:annotation');
      assert.strictEqual(again.id, ann.id);
      assert.strictEqual(again.target.selector, ann.target.selector);
    } finally {
      h.dispose();
    }
  });
}

test('CE-11: on the edited DOM a restored edit pin / highlight lands on the moved element, not its selector twin', async () => {
  const h = await setup(LIST);
  try {
    h.ipc.emit('caos:reorder-sibling', { parentSelector: 'ul', fromIndex: 0, toIndex: 1 });
    const ann = h.ipc.last('caos:annotation');
    const [b, a] = h.qa('li'); // live order is now B, A, C
    h.setRect(b, { x: 0, y: 10, w: 50, h: 10 });
    h.setRect(a, { x: 0, y: 200, w: 50, h: 10 });
    // The stored selector now matches B in the live DOM; text reconciliation must pick A.
    h.ipc.clear();
    h.ipc.emit('caos:highlight-target', ann.target);
    assert.strictEqual(h.ipc.last('caos:highlight-ack').ok, true);
    const flashes = h.qa('[data-caos-flash]');
    assert.strictEqual(flashes[flashes.length - 1].style.top, '200px');
  } finally {
    h.dispose();
  }
});

test('CE-11: reparent annotation describes source parent and destination as the source code has them', async () => {
  const h = await setup('<div><p>one</p><p>two</p></div><div><p>three</p></div>');
  try {
    const divs = h.qa('div');
    // move the SECOND div's only child into the first div at the front; selectors
    // for the destination must be the pre-move ones
    const three = divs[1].firstElementChild;
    const sel = { src: h.path(three), from: h.path(divs[1]), to: h.path(divs[0]) };
    h.ipc.emit('caos:move-into', { selector: sel.src, parentSelector: sel.to, index: 0 });
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.edit.type, 'reparent');
    assert.strictEqual(ann.target.text, 'three');
    assert.strictEqual(ann.target.selector, sel.src);
    assert.strictEqual(ann.edit.details.fromParentSelector, sel.from);
    assert.strictEqual(ann.edit.details.parentSelector, sel.to);
    assert.strictEqual(divs[0].firstElementChild.textContent, 'three');
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(divs[1].firstElementChild.textContent, 'three');
  } finally {
    h.dispose();
  }
});

// ------------------------------------------------- drag + nudge (arrange mode)

function pointer(h, type, x, y, target) {
  const ev = new h.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, detail: 1 });
  (target || h.document).dispatchEvent(ev);
}

test('CE-11: drag reorder files the annotation against the source element and position', async () => {
  const h = await setup(LIST);
  try {
    const [a, b, c] = h.qa('li');
    const ul = h.q('ul');
    const srcSel = h.path(a);
    h.setRect(ul, { x: 0, y: 0, w: 100, h: 60 });
    h.setRect(a, { x: 0, y: 0, w: 100, h: 20 });
    h.setRect(b, { x: 0, y: 20, w: 100, h: 20 });
    h.setRect(c, { x: 0, y: 40, w: 100, h: 20 });
    h.document.elementFromPoint = (x, y) => (y < 20 ? a : y < 40 ? b : c);
    h.ipc.emit('caos:set-mode', 'arrange');
    pointer(h, 'pointerdown', 50, 10, a);
    pointer(h, 'pointermove', 50, 30, h.window);
    pointer(h, 'pointermove', 50, 57, h.window);
    pointer(h, 'pointerup', 50, 57, h.window);
    assert.deepStrictEqual(h.qa('li').map((l) => l.textContent), ['B', 'C', 'A']);
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.edit.type, 'reorder');
    assert.strictEqual(ann.target.text, 'A');
    assert.strictEqual(ann.target.selector, srcSel);
    assert.strictEqual(ann.edit.details.fromIndex, 0);
    assert.strictEqual(ann.edit.details.toIndex, 2);
    assert.strictEqual(ann.edit.details.previewSelector, h.path(a));
    assert.notStrictEqual(ann.edit.details.previewSelector, srcSel);
    assert.match(ann.note, /position 1 to position 3/);
    h.ipc.emit('caos:undo-edit');
    assert.deepStrictEqual(h.qa('li').map((l) => l.textContent), ['A', 'B', 'C']);
  } finally {
    h.dispose();
  }
});
