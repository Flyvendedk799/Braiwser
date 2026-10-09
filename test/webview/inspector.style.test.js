'use strict';
// CE-10 (reverting back to baseline retracts the note, restores original inline
// value + priority) and RF-07 guest side (number+unit from one source, no-op
// commits do nothing).

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

async function setup(html) {
  const h = await loadInspector({ html });
  h.ipc.emit('caos:set-mode', 'edit');
  h.ipc.emit('caos:edit-select', { selector: '#t' });
  return h;
}

const apply = (h, props, commit = true) => h.ipc.emit('caos:apply-style', { selector: '#t', props, commit });
const notes = (h) => h.ipc.sent('caos:annotation');
const retracted = (h) => h.ipc.sent('caos:edit-undo');
const updates = (h) => h.ipc.sent('caos:annotation-update');

test('CE-10: reverting the only changed property retracts its note and clears undo/redo', async () => {
  const h = await setup('<p id="t">Hi</p>');
  try {
    const t = h.q('#t');
    apply(h, { color: 'red' });
    assert.strictEqual(notes(h).length, 1);
    assert.match(notes(h)[0].edit.css, /color: red;/);
    assert.deepStrictEqual(h.ipc.last('caos:edit-stacks'), { undo: 1, redo: 0, dropped: 0 });

    apply(h, { color: '' }); // the panel's revert action
    assert.strictEqual(t.getAttribute('style') || '', '');
    assert.strictEqual(retracted(h).length, 1);
    assert.strictEqual(retracted(h)[0].id, notes(h)[0].id);
    assert.deepStrictEqual(h.ipc.last('caos:edit-stacks'), { undo: 0, redo: 0, dropped: 0 });
    // nothing left to undo / redo
    h.ipc.emit('caos:undo-edit');
    h.ipc.emit('caos:redo-edit');
    assert.strictEqual(retracted(h).length, 1);

    // a new change after the revert files a NEW note, not an update to the retracted one
    apply(h, { color: 'blue' });
    assert.strictEqual(notes(h).length, 2);
    assert.notStrictEqual(notes(h)[1].id, notes(h)[0].id);
    assert.match(notes(h)[1].edit.css, /color: blue;/);
  } finally {
    h.dispose();
  }
});

test('CE-10: multi-property revert-to-baseline updates, then retracts, the note', async () => {
  const h = await setup('<p id="t">Hi</p>');
  try {
    const t = h.q('#t');
    apply(h, { color: 'red', 'font-size': '20px' });
    assert.strictEqual(notes(h).length, 1);
    apply(h, { color: '' });
    // one property remains -> the note is UPDATED to say only that
    assert.strictEqual(updates(h).length, 1);
    assert.doesNotMatch(updates(h)[0].patch.edit.css, /color/);
    assert.match(updates(h)[0].patch.edit.css, /font-size: 20px;/);
    assert.strictEqual(retracted(h).length, 0);
    assert.strictEqual(t.style.getPropertyValue('color'), '');
    apply(h, { 'font-size': '' });
    assert.strictEqual(retracted(h).length, 1);
    assert.strictEqual(t.getAttribute('style') || '', '');
    assert.strictEqual(h.ipc.last('caos:edit-stacks').undo, 0);
  } finally {
    h.dispose();
  }
});

test('CE-10: set back to the original value behaves like a revert', async () => {
  const h = await setup('<p id="t" style="color: blue">Hi</p>');
  try {
    apply(h, { color: 'red' });
    assert.strictEqual(notes(h).length, 1);
    apply(h, { color: 'blue' });
    assert.strictEqual(retracted(h).length, 1);
    assert.strictEqual(h.q('#t').style.getPropertyValue('color'), 'blue');
  } finally {
    h.dispose();
  }
});

test('CE-10: individual revert restores the original inline value and priority, not just removes it', async () => {
  const h = await setup('<p id="t" style="color: green !important; margin: 4px">Hi</p>');
  try {
    const t = h.q('#t');
    apply(h, { color: 'red', 'margin-top': '9px' });
    assert.strictEqual(t.style.getPropertyValue('color'), 'red');
    assert.strictEqual(t.style.getPropertyPriority('color'), '');
    const ann = notes(h)[0];
    assert.strictEqual(ann.edit.details.original.color, 'green !important');
    assert.strictEqual(ann.edit.details.original['margin-top'], '4px');

    apply(h, { color: '' });
    assert.strictEqual(t.style.getPropertyValue('color'), 'green');
    assert.strictEqual(t.style.getPropertyPriority('color'), 'important');
    assert.strictEqual(retracted(h).length, 0); // margin-top still differs
    apply(h, { 'margin-top': '' });
    assert.strictEqual(t.style.getPropertyValue('margin-top'), '4px');
    assert.strictEqual(retracted(h).length, 1);
    // the whole visit is back to the exact original attribute
    assert.strictEqual(t.getAttribute('style'), 'color: green !important; margin: 4px');
  } finally {
    h.dispose();
  }
});

test('CE-10: Undo of a style edit restores the original attribute; Redo reapplies', async () => {
  const h = await setup('<p id="t" style="color: blue">Hi</p>');
  try {
    const t = h.q('#t');
    apply(h, { color: 'red' });
    h.ipc.emit('caos:undo-edit');
    assert.strictEqual(t.getAttribute('style'), 'color: blue');
    h.ipc.emit('caos:redo-edit');
    assert.strictEqual(t.style.getPropertyValue('color'), 'red');
  } finally {
    h.dispose();
  }
});

// -------------------------------------------------------------- RF-07 --------

test('RF-07: a no-op commit (same value) neither mutates the DOM nor files a note', async () => {
  const h = await setup('<p id="t" style="font-size: 2rem; width: 50%">Hi</p>');
  try {
    const t = h.q('#t');
    const before = t.getAttribute('style');
    apply(h, { 'font-size': '2rem' });
    apply(h, { width: '50%' }, true);
    apply(h, { color: '' }); // revert of something never changed
    assert.strictEqual(t.getAttribute('style'), before);
    assert.strictEqual(notes(h).length, 0);
    assert.strictEqual(h.ipc.sent('caos:edit-stacks').length, 0);
  } finally {
    h.dispose();
  }
});

test('RF-07: style payload pairs the number with the unit of the SAME source', async () => {
  const h = await setup(
    '<p id="t" style="font-size: 2rem; width: 50%; line-height: 1.5; padding-top: calc(1px + 2px); margin: 8px 4px">Hi</p>'
  );
  try {
    h.ipc.emit('caos:request-style', { selector: '#t' });
    const p = h.ipc.last('caos:style-picked');
    // inline relative units are reported as authored, never as computed-number + inline-unit
    assert.deepStrictEqual(
      { v: p.specified['font-size'].value, u: p.specified['font-size'].unit, s: p.specified['font-size'].source },
      { v: 2, u: 'rem', s: 'inline' }
    );
    assert.deepStrictEqual([p.specified.width.value, p.specified.width.unit], [50, '%']);
    assert.deepStrictEqual([p.specified['line-height'].value, p.specified['line-height'].unit], [1.5, '']);
    assert.strictEqual(p.specified['padding-top'].unsupported, true);
    assert.strictEqual(p.specified['padding-top'].value, null);
    assert.deepStrictEqual([p.specified['margin-top'].value, p.specified['margin-top'].unit], [8, 'px']);
    assert.deepStrictEqual([p.specified['margin-left'].value, p.specified['margin-left'].unit], [4, 'px']);
    // nothing inline -> computed value, always px
    assert.strictEqual(p.specified['padding-left'].source, 'computed');
    assert.strictEqual(p.specified['padding-left'].unit, 'px');
    // existing fields are unchanged
    assert.strictEqual(p.inline['font-size'], '2rem');
    assert.strictEqual(p.inlinePriority['font-size'], '');
    assert.ok(p.computed['font-size'] !== undefined);
    assert.deepStrictEqual(p.session, { active: false, annId: null, changed: [] });
  } finally {
    h.dispose();
  }
});

test('RF-07: !important is carried as a priority, and the session reports what changed', async () => {
  const h = await setup('<p id="t">Hi</p>');
  try {
    const t = h.q('#t');
    apply(h, { color: 'red !important' }, false);
    assert.strictEqual(t.style.getPropertyValue('color'), 'red');
    assert.strictEqual(t.style.getPropertyPriority('color'), 'important');
    h.ipc.emit('caos:request-style', { selector: '#t' });
    const p = h.ipc.last('caos:style-picked');
    assert.strictEqual(p.inlinePriority.color, 'important');
    assert.deepStrictEqual(p.session.changed, ['color']);
    assert.strictEqual(p.session.active, true);
    apply(h, {}, true);
    assert.match(notes(h)[0].edit.css, /color: red !important;/);
  } finally {
    h.dispose();
  }
});
