'use strict';
// Unit tests for the pure guest helpers: the canonical child filter, node ids,
// identity-first resolution, and the text diff.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

async function load(html) {
  const h = await loadInspector({ html, inspector: false });
  h.dom = h.requireWebview('inspector.dom.js');
  h.te = h.requireWebview('inspector.textedit.js');
  return h;
}

test('dom: contentChildren excludes script/style/noscript and Braiwser nodes, keeps order', async () => {
  const h = await load(
    '<div id="p"><script></script><b id="a"></b><style></style><i id="b"></i><noscript></noscript><div data-caos></div><u id="c"></u></div>'
  );
  try {
    const p = h.q('#p');
    assert.deepStrictEqual(h.dom.contentChildren(p).map((n) => n.id), ['a', 'b', 'c']);
    assert.deepStrictEqual(h.dom.contentChildren(p, h.q('#b')).map((n) => n.id), ['a', 'c']);
    assert.strictEqual(h.dom.contentIndex(p, h.q('#c')), 2);
    assert.strictEqual(h.dom.domIndex(p, h.q('#c')), 6);
    assert.strictEqual(h.dom.contentIndex(p, p.firstElementChild), -1); // a script is not a child
  } finally {
    h.dispose();
  }
});

test('dom: insertAtContentIndex lands relative to content children only', async () => {
  const h = await load('<div id="p"><script id="s"></script><b id="a"></b><i id="b"></i></div><u id="x"></u>');
  try {
    const p = h.q('#p');
    const x = h.q('#x');
    assert.strictEqual(h.dom.insertAtContentIndex(p, x, 0), 0);
    assert.deepStrictEqual(Array.from(p.children).map((n) => n.id), ['s', 'x', 'a', 'b']);
    assert.strictEqual(h.dom.insertAtContentIndex(p, x, 1), 1);
    assert.deepStrictEqual(Array.from(p.children).map((n) => n.id), ['s', 'a', 'x', 'b']);
    assert.strictEqual(h.dom.insertAtContentIndex(p, x, 50), 2);
    assert.deepStrictEqual(Array.from(p.children).map((n) => n.id), ['s', 'a', 'b', 'x']);
  } finally {
    h.dispose();
  }
});

test('dom: node ids are stable per element, unique, and die with the node', async () => {
  const h = await load('<div id="p"><b id="a"></b><i id="b"></i></div>');
  try {
    const reg = h.dom.createNodeRegistry();
    const a = h.q('#a');
    const id = reg.idFor(a);
    assert.strictEqual(reg.idFor(a), id);
    assert.notStrictEqual(reg.idFor(h.q('#b')), id);
    assert.strictEqual(reg.lookup(id), a);
    a.remove();
    assert.strictEqual(reg.lookup(id), null); // disconnected
    assert.strictEqual(reg.lookup('nope'), null);
    assert.strictEqual(reg.lookup(undefined), null);
  } finally {
    h.dispose();
  }
});

test('dom: resolveChild prefers identity, rejects a lost identity, falls back to indexes only when none was named', async () => {
  const h = await load('<div id="p"><script></script><b id="a"></b><i id="b"></i></div><div id="q"><b id="z"></b></div>');
  try {
    const reg = h.dom.createNodeRegistry();
    const p = h.q('#p');
    const doc = h.document;
    const idB = reg.idFor(h.q('#b'));
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { nodeId: idB, fromIndex: 0 }, 'from').id, 'b');
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { selector: '#a', fromIndex: 1 }, 'from').id, 'a');
    // identity names a node in ANOTHER parent -> rejected even though fromIndex is valid
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { selector: '#z', fromIndex: 0 }, 'from'), null);
    // invalid selector is a rejection, not an exception
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { selector: '!!', fromIndex: 0 }, 'from'), null);
    // no identity: content index and DOM index
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { fromIndex: 1 }, 'from').id, 'b');
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { fromDomIndex: 1 }, 'from').id, 'a');
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { fromDomIndex: 0 }, 'from'), null); // the script
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { fromIndex: 9 }, 'from'), null);
    // 'before' prefix
    assert.strictEqual(h.dom.resolveChild(doc, reg, p, { beforeSelector: '#b' }, 'before').id, 'b');
  } finally {
    h.dispose();
  }
});

test('text diff (property): any rewrite keeps every child element and yields exactly the new text', async () => {
  const h = await load('<p id="t">Alpha <b id="b">beta gamma</b> delta <i id="i">epsilon</i> zeta</p>');
  try {
    const t = h.q('#t');
    const b = h.q('#b');
    const i = h.q('#i');
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const words = ['Alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'THETA', 'x', '', '😀', 'é'];
    for (let n = 0; n < 200; n++) {
      const parts = [];
      const len = Math.floor(rnd() * 9);
      for (let k = 0; k < len; k++) parts.push(words[Math.floor(rnd() * words.length)]);
      const next = parts.join(rnd() < 0.5 ? ' ' : '');
      const snap = h.te.captureTextState(t);
      const changed = h.te.applyTextDiff(t, next);
      assert.strictEqual(t.textContent, next, 'text for ' + JSON.stringify(next));
      assert.strictEqual(changed, snap.text !== next);
      assert.strictEqual(t.querySelector('#b'), b);
      assert.strictEqual(t.querySelector('#i'), i);
      h.te.restoreTextState(snap);
      assert.strictEqual(t.textContent, snap.text);
      assert.strictEqual(t.innerHTML, 'Alpha <b id="b">beta gamma</b> delta <i id="i">epsilon</i> zeta');
    }
  } finally {
    h.dispose();
  }
});

test('text diff: an edit inside one word stays inside the element that holds it', async () => {
  const h = await load('<p id="t">Alpha <b id="b">beta gamma</b> delta</p>');
  try {
    const t = h.q('#t');
    h.te.applyTextDiff(t, 'Alpha <b>BETA gamma</b> delta'.replace('<b>', '').replace('</b>', ''));
    assert.strictEqual(h.q('#b').textContent, 'BETA gamma');
    assert.strictEqual(t.firstChild.data, 'Alpha ');
  } finally {
    h.dispose();
  }
});

test('text state: too large a subtree is refused rather than snapshotted lossily', async () => {
  const h = await load('<p id="t">' + '<b>x</b>'.repeat(50) + '</p>');
  try {
    assert.strictEqual(h.te.captureTextState(h.q('#t'), { maxNodes: 10 }), null);
    assert.ok(h.te.captureTextState(h.q('#t')));
  } finally {
    h.dispose();
  }
});
