'use strict';
// CE-09: text editing / undo keeps inline markup, child node identity, and the
// element's own editing-related attributes and style priorities.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

const PARA = '<p id="t">Hello <strong id="s">world</strong> and <a id="l" href="#x">link</a>!</p>';

async function setup(html) {
  const h = await loadInspector({ html });
  h.ipc.emit('caos:set-mode', 'edit');
  return h;
}

function refs(h) {
  const t = h.q('#t');
  return { t, s: h.q('#s'), l: h.q('#l'), nodes: Array.from(t.childNodes) };
}

test('CE-09: panel text change keeps inline children (identity and listeners) through edit / Undo / Redo', async () => {
  const h = await setup(PARA);
  try {
    const r = refs(h);
    let clicks = 0;
    r.s.addEventListener('click', () => clicks++);
    const html0 = r.t.innerHTML;

    // change text that lives in the <strong>, and the text before it
    h.ipc.emit('caos:set-text', { selector: '#t', text: 'Howdy WORLD and link!' });
    assert.strictEqual(r.t.textContent, 'Howdy WORLD and link!');
    assert.strictEqual(h.q('#s'), r.s);
    assert.strictEqual(h.q('#l'), r.l);
    assert.strictEqual(r.s.textContent, 'WORLD');
    assert.strictEqual(r.l.getAttribute('href'), '#x');
    r.s.dispatchEvent(new h.window.Event('click'));
    assert.strictEqual(clicks, 1);
    const ann = h.ipc.last('caos:annotation');
    assert.strictEqual(ann.edit.type, 'text');
    assert.strictEqual(ann.edit.details.before, 'Hello world and link!');
    assert.strictEqual(ann.edit.details.after, 'Howdy WORLD and link!');
    assert.strictEqual(ann.target.text, 'Hello world and link!'); // identity before the copy changed

    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(r.t.innerHTML, html0);
    assert.deepStrictEqual(Array.from(r.t.childNodes), r.nodes); // the very same nodes
    r.s.dispatchEvent(new h.window.Event('click'));
    assert.strictEqual(clicks, 2); // listener survived the undo

    h.ipc.emit('caos:redo-edit');
    assert.strictEqual(r.t.textContent, 'Howdy WORLD and link!');
    assert.strictEqual(h.q('#s'), r.s);
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(r.t.innerHTML, html0);
  } finally {
    h.dispose();
  }
});

test('CE-09: panel edit inserting/deleting across node boundaries never drops child elements', async () => {
  const h = await setup(PARA);
  try {
    const r = refs(h);
    const html0 = r.t.innerHTML;
    for (const next of ['', 'X', 'Hello world and link', 'Hello big world and link!', 'Hello  and link!', 'world']) {
      h.ipc.emit('caos:set-text', { selector: '#t', text: next || 'Hello world and link!x' });
      const want = next || 'Hello world and link!x';
      assert.strictEqual(r.t.textContent, want);
      assert.strictEqual(h.q('#s'), r.s);
      assert.strictEqual(h.q('#l'), r.l);
      h.ipc.emit('caos:undo-edit');
      assert.strictEqual(r.t.innerHTML, html0);
    }
  } finally {
    h.dispose();
  }
});

test('CE-09: typed edit (contenteditable) then Undo / Redo restores the exact nodes', async () => {
  const h = await setup(PARA);
  try {
    const r = refs(h);
    const html0 = r.t.innerHTML;
    h.ipc.emit('caos:edit-select', { selector: '#t', text: true });
    assert.strictEqual(r.t.getAttribute('contenteditable'), 'plaintext-only');
    // the "user" types in the first text node and deletes the <strong> entirely
    r.nodes[0].data = 'Howdy ';
    r.s.remove();
    r.t.dispatchEvent(new h.window.Event('blur'));
    assert.strictEqual(r.t.hasAttribute('contenteditable'), false);
    assert.strictEqual(h.ipc.last('caos:annotation').edit.type, 'text');

    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(r.t.innerHTML, html0);
    assert.deepStrictEqual(Array.from(r.t.childNodes), r.nodes);
    assert.strictEqual(h.q('#s'), r.s); // the original <strong>, not a rebuilt one

    h.ipc.emit('caos:redo-edit');
    assert.strictEqual(r.t.querySelector('#s'), null);
    assert.ok(r.t.textContent.startsWith('Howdy '));
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(h.q('#s'), r.s);
  } finally {
    h.dispose();
  }
});

test('CE-09: Escape cancels a typed edit back to the original nodes', async () => {
  const h = await setup(PARA);
  try {
    const r = refs(h);
    const html0 = r.t.innerHTML;
    h.ipc.emit('caos:edit-select', { selector: '#t', text: true });
    r.nodes[0].data = 'Nope ';
    r.s.remove();
    r.t.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.strictEqual(r.t.innerHTML, html0);
    assert.strictEqual(h.q('#s'), r.s);
    assert.strictEqual(r.t.hasAttribute('contenteditable'), false);
    assert.strictEqual(h.ipc.sent('caos:annotation').length, 0);
  } finally {
    h.dispose();
  }
});

test('CE-09: no-op enter/exit preserves the original contenteditable, outline, outline-offset, user-select exactly', async () => {
  const styles = [
    null, // no style attribute at all
    '',
    'outline:  1px   solid red !important; user-select:none',
    'color:red;outline-offset:3px',
  ];
  for (const style of styles) {
    for (const ce of [null, 'true', 'false']) {
      const attrs = (ce == null ? '' : ' contenteditable="' + ce + '"') + (style == null ? '' : ' style="' + style + '"');
      const h = await setup('<p id="t"' + attrs + '>Plain words</p>');
      try {
        const t = h.q('#t');
        const before = { ce: t.getAttribute('contenteditable'), style: t.getAttribute('style') };
        h.ipc.emit('caos:edit-select', { selector: '#t', text: true });
        assert.strictEqual(t.getAttribute('contenteditable'), 'plaintext-only');
        t.dispatchEvent(new h.window.Event('blur'));
        assert.strictEqual(t.getAttribute('contenteditable'), before.ce, 'contenteditable ' + ce);
        assert.strictEqual(t.getAttribute('style'), before.style, 'style ' + style);
        assert.strictEqual(h.ipc.sent('caos:annotation').length, 0);
        assert.strictEqual(h.ipc.last('caos:edit-stacks'), undefined);
      } finally {
        h.dispose();
      }
    }
  }
});

test('CE-09: a typed edit also restores the original editing attributes when it commits', async () => {
  const h = await setup('<p id="t" contenteditable="true" style="outline: 1px solid red !important;">Words</p>');
  try {
    const t = h.q('#t');
    h.ipc.emit('caos:edit-select', { selector: '#t', text: true });
    t.firstChild.data = 'Changed';
    t.dispatchEvent(new h.window.Event('blur'));
    assert.strictEqual(t.getAttribute('contenteditable'), 'true');
    assert.strictEqual(t.getAttribute('style'), 'outline: 1px solid red !important;');
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(t.textContent, 'Words');
    assert.strictEqual(t.getAttribute('style'), 'outline: 1px solid red !important;');
  } finally {
    h.dispose();
  }
});

// ------------------------------------------------ textedit.js directly --------

test('CE-09 (unit): endEditing restores per-property value AND priority when the style was touched meanwhile', async () => {
  const h = await loadInspector({ html: '<p id="t" style="outline: 1px solid red !important;">x</p>', inspector: false });
  try {
    const te = h.requireWebview('inspector.textedit.js');
    const t = h.q('#t');
    const token = te.beginEditing(t, { color: '#fff' });
    assert.strictEqual(t.style.getPropertyPriority('outline'), '');
    t.style.setProperty('color', 'blue'); // somebody else writes a style meanwhile
    te.endEditing(t, token);
    assert.strictEqual(t.style.getPropertyValue('outline'), '1px solid red');
    assert.strictEqual(t.style.getPropertyPriority('outline'), 'important');
    assert.strictEqual(t.style.getPropertyValue('color'), 'blue');
    assert.strictEqual(t.style.getPropertyValue('outline-offset'), '');
    assert.strictEqual(t.style.getPropertyValue('user-select'), '');
  } finally {
    h.dispose();
  }
});

test('CE-09 (unit): applyTextDiff handles multibyte text without splitting surrogate pairs', async () => {
  const h = await loadInspector({ html: '<p id="t">a😀b<em>c😀d</em></p>', inspector: false });
  try {
    const te = h.requireWebview('inspector.textedit.js');
    const t = h.q('#t');
    const em = t.querySelector('em');
    assert.strictEqual(te.applyTextDiff(t, 'a😀X<em>'), true);
    assert.strictEqual(t.textContent, 'a😀X<em>');
    assert.strictEqual(t.querySelector('em'), em);
    assert.strictEqual(te.applyTextDiff(t, t.textContent), false);
  } finally {
    h.dispose();
  }
});
