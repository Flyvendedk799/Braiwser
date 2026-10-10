// RF-10: modal stack — only the topmost modal handles Escape/Tab, close is
// idempotent, the focus trap skips disabled/hidden controls, and focus returns
// to the still-open parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, settle, key, tick } from './dom-env.mjs';

const { document, window } = setupDom();
const { h, modal, modalDepth, focusableIn, guarded, menu } = await load('lib/dom.js');

async function closeAll(...ms) {
  ms.forEach((m) => m.close());
  await tick(250);
}

test('Escape closes only the topmost modal; the unsaved parent stays intact', async () => {
  const parentInput = h('input', { type: 'text', value: 'draft step' });
  let parentClosed = 0, childClosed = 0;
  const parent = modal({ title: 'Edit recording', body: parentInput, onClose: () => parentClosed++ });
  await settle();
  parentInput.value = 'unsaved edit';
  const addBtn = h('button', { text: 'Add assertion' });
  parent.card.querySelector('.modal-body').appendChild(addBtn);
  addBtn.focus();
  const childInput = h('input', { type: 'text' });
  const child = modal({ title: 'Add assertion', body: childInput, onClose: () => childClosed++ });
  await settle();
  assert.equal(modalDepth(), 2);

  key(document.activeElement, 'Escape');
  assert.equal(childClosed, 1, 'child closes');
  assert.equal(parentClosed, 0, 'parent must NOT close');
  assert.equal(modalDepth(), 1);
  assert.equal(parentInput.value, 'unsaved edit', 'unsaved parent edits intact');
  assert.ok(document.body.contains(parent.card));
  assert.equal(document.activeElement, addBtn, 'focus returns to the control that opened the child');
  assert.equal(parent.backdrop.hasAttribute('inert'), false, 'parent interactive again');

  key(document.activeElement, 'Escape');
  assert.equal(parentClosed, 1);
  assert.equal(modalDepth(), 0);
  await tick(250);
});

test('close() is idempotent: onClose fires once however many paths race', async () => {
  let n = 0;
  const m = modal({ title: 'x', body: h('div', { text: 'hi' }), onClose: () => n++ });
  await settle();
  m.close();
  m.close();
  key(document.body, 'Escape');
  assert.equal(n, 1);
  assert.equal(modalDepth(), 0);
  await tick(250);
});

test('backdrop click closes only the top modal', async () => {
  let p = 0, c = 0;
  const parent = modal({ title: 'p', body: h('div', { text: 'p' }), onClose: () => p++ });
  const child = modal({ title: 'c', body: h('div', { text: 'c' }), onClose: () => c++ });
  await settle();
  // A click on the covered parent's backdrop must do nothing.
  parent.backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(p, 0);
  assert.equal(c, 0);
  child.backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(c, 1);
  assert.equal(p, 0);
  await closeAll(parent, child);
});

test('Tab cycles inside the top modal and skips disabled / hidden controls', async () => {
  const a = h('button', { text: 'a' });
  const dis = h('button', { text: 'dis', disabled: true });
  const hid = h('button', { text: 'hid', hidden: 'hidden' });
  const hid2 = h('button', { text: 'hid2', style: { display: 'none' } });
  const neg = h('button', { text: 'neg', tabindex: '-1' });
  const z = h('button', { text: 'z' });
  const m = modal({ title: 'trap', body: h('div', {}, [a, dis, hid, hid2, neg, z]) });
  await settle();
  const names = focusableIn(m.card).map((e) => e.textContent || e.getAttribute('aria-label'));
  assert.ok(names.includes('a') && names.includes('z'));
  for (const bad of ['dis', 'hid', 'hid2', 'neg']) assert.ok(!names.includes(bad), bad + ' must not be focusable');

  const f = focusableIn(m.card);
  const last = f[f.length - 1];
  last.focus();
  const ev = key(last, 'Tab');
  assert.ok(ev.defaultPrevented, 'Tab on last wraps');
  assert.equal(document.activeElement, f[0]);
  const evBack = key(f[0], 'Tab', { shiftKey: true });
  assert.ok(evBack.defaultPrevented);
  assert.equal(document.activeElement, last);
  await closeAll(m);
});

test('Tab with focus outside the modal pulls focus back in', async () => {
  const outside = h('button', { text: 'outside' });
  document.body.appendChild(outside);
  const m = modal({ title: 't', body: h('button', { text: 'inner' }) });
  await settle();
  outside.focus();
  const ev = key(outside, 'Tab');
  assert.ok(ev.defaultPrevented);
  assert.ok(m.card.contains(document.activeElement));
  outside.remove();
  await closeAll(m);
});

test('only the top modal traps Tab (parent controls are not reachable)', async () => {
  const parentBtn = h('button', { text: 'parent-btn' });
  const parent = modal({ title: 'p', body: parentBtn });
  const childBtn = h('button', { text: 'child-btn' });
  const child = modal({ title: 'c', body: childBtn });
  await settle();
  assert.ok(parent.backdrop.hasAttribute('inert'));
  const f = focusableIn(child.card);
  f[f.length - 1].focus();
  key(document.activeElement, 'Tab');
  assert.ok(child.card.contains(document.activeElement));
  await closeAll(child, parent);
});

test('closing the parent out of order does not steal focus from the child', async () => {
  const parent = modal({ title: 'p', body: h('input', { type: 'text' }) });
  const childInput = h('input', { type: 'text' });
  const child = modal({ title: 'c', body: childInput });
  await settle();
  childInput.focus();
  parent.close();
  assert.equal(modalDepth(), 1);
  assert.equal(document.activeElement, childInput);
  key(childInput, 'Escape');
  assert.equal(modalDepth(), 0);
  await tick(250);
});

test('Escape consumed by an open popover menu does not also close the modal', async () => {
  let closed = 0;
  const anchor = h('button', { text: 'anchor' });
  const m = modal({ title: 'm', body: anchor, onClose: () => closed++ });
  await settle();
  const pm = menu(anchor, [{ label: 'One' }]);
  await tick(10);
  key(document.activeElement, 'Escape');
  assert.equal(closed, 0, 'modal must survive the Escape that closed the menu');
  assert.equal(document.querySelector('.popover-menu'), null);
  pm.close();
  await closeAll(m);
});

test('guarded() turns thrown and rejected callbacks into visible error toasts', async () => {
  const sync = guarded(() => { throw new Error('boom'); }, 'Save');
  sync();
  const rej = guarded(async () => { throw new Error('Error invoking remote method \'x\': nope'); }, 'Export');
  await rej();
  const toasts = Array.from(document.querySelectorAll('.toast-msg')).map((n) => n.textContent);
  assert.ok(toasts.includes('Save failed: boom'), toasts.join('|'));
  assert.ok(toasts.includes('Export failed: nope'), toasts.join('|'));
});
