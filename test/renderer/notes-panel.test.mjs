// Notes panel: filtered reorder sends the FULL order, numbering matches pins,
// bulk failures stay visible and retryable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click, tick } from './dom-env.mjs';

const { window, document } = setupDom();
const { createNotesPanel } = await load('components/notes-panel.js');

const config = {
  actionTags: [{ id: 'fix', label: 'Fix', color: '#f00' }, { id: 'change', label: 'Change', color: '#0f0' }],
  priorities: ['low', 'normal', 'high'],
};
const note = (id, action, status = 'open') => ({ id, note: 'note ' + id, action, status, kind: 'element', target: { selector: '#' + id }, createdAt: '2026-01-01T00:00:00Z' });
const NOTES = () => [note('n1', 'fix'), note('n2', 'change'), note('n3', 'fix'), note('n4', 'change'), note('n5', 'fix')];

function mount(over = {}) {
  const calls = { reorder: [], bulkUpdate: [], bulkRemove: [] };
  const panel = createNotesPanel(config, {
    onCount: () => {}, locate() {}, copySelector() {}, toggleStatus() {}, remove() {}, setPriority() {}, editNote() {},
    reorder: (ids, opts) => { calls.reorder.push([ids, opts]); },
    bulkUpdate: (list, patch) => { calls.bulkUpdate.push([list.map((n) => n.id), patch]); },
    bulkRemove: (list) => { calls.bulkRemove.push(list.map((n) => n.id)); },
    ...over,
  });
  document.body.appendChild(panel.root);
  panel.setAnnotations(NOTES());
  return { panel, calls };
}

const cards = (panel) => Array.from(panel.root.querySelectorAll('.note'));
const order = (panel) => cards(panel).map((c) => c.querySelector('.note-text').textContent.replace('note ', ''));
const numbers = (panel) => cards(panel).map((c) => c.querySelector('.note-num').textContent);

function drop(panel, fromId, targetCard, { before } = {}) {
  const dt = { data: { 'text/braiwser-note': fromId }, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; }, effectAllowed: '' };
  targetCard.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 });
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = dt;
  ev.clientY = before ? 10 : 90;
  targetCard.dispatchEvent(ev);
}

function filterTo(panel, label) {
  const chip = Array.from(panel.root.querySelectorAll('.chip')).find((c) => c.textContent.trim() === label);
  click(chip);
}

test('unfiltered reorder sends the full order', () => {
  const { panel, calls } = mount();
  drop(panel, 'n5', cards(panel)[0], { before: true });
  assert.deepEqual(calls.reorder[0][0], ['n5', 'n1', 'n2', 'n3', 'n4']);
  assert.equal(calls.reorder[0][1].filtered, false);
});

test('regression: reordering under a filter sends ALL ids, hidden notes keep their slots', () => {
  const { panel, calls } = mount();
  filterTo(panel, 'Fix'); // visible: n1, n3, n5
  assert.deepEqual(order(panel), ['n1', 'n3', 'n5']);
  // drag n5 above n1 (both visible)
  drop(panel, 'n5', cards(panel)[0], { before: true });
  const [ids, opts] = calls.reorder[0];
  assert.deepEqual(ids, ['n5', 'n1', 'n2', 'n3', 'n4'], 'full list, hidden n2/n4 untouched relative to others');
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.equal(opts.filtered, true);
});

test('dropping below a visible note under a filter lands after it in the full order', () => {
  const { panel, calls } = mount();
  filterTo(panel, 'Fix');
  drop(panel, 'n1', cards(panel)[1], { before: false }); // n1 after n3
  assert.deepEqual(calls.reorder[0][0], ['n2', 'n3', 'n1', 'n4', 'n5']);
});

test('numbering is by full order and renumbers at once after a reorder', () => {
  const { panel } = mount();
  assert.deepEqual(numbers(panel), ['#1', '#2', '#3', '#4', '#5']);
  filterTo(panel, 'Fix');
  assert.deepEqual(numbers(panel), ['#1', '#3', '#5'], 'filtered cards keep their pin numbers');
  drop(panel, 'n5', cards(panel)[0], { before: true }); // n5 -> first
  assert.deepEqual(order(panel), ['n5', 'n1', 'n3']);
  assert.deepEqual(numbers(panel), ['#1', '#2', '#4'], 'matches the pins the page will redraw');
});

test('dropping where it already is does nothing', () => {
  const { panel, calls } = mount();
  drop(panel, 'n2', cards(panel)[0], { before: false }); // n2 right after n1 already
  assert.equal(calls.reorder.length, 0);
});

test('a rejected reorder rolls the list back and says so', async () => {
  const { panel } = mount({ reorder: async () => { throw new Error('disk full'); } });
  drop(panel, 'n5', cards(panel)[0], { before: true });
  assert.deepEqual(order(panel), ['n5', 'n1', 'n2', 'n3', 'n4']);
  await tick(10);
  assert.deepEqual(order(panel), ['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.ok(Array.from(document.querySelectorAll('.toast-msg')).some((t) => /Could not reorder notes: disk full/.test(t.textContent)));
});

test('bulk update with partial failure: failures stay visible, selected and retryable', async () => {
  let attempt = 0;
  const seen = [];
  const { panel } = mount({
    bulkUpdate: async (list, patch) => {
      seen.push([list.map((n) => n.id), patch]);
      attempt++;
      return attempt === 1 ? { failed: [{ id: 'n2', error: 'locked' }] } : { failed: [] };
    },
  });
  for (const c of cards(panel).slice(0, 3)) {
    const box = c.querySelector('.note-check');
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  const resolve = Array.from(panel.root.querySelectorAll('.bulk-bar button')).find((b) => b.textContent === 'Resolve');
  click(resolve);
  await tick(5);
  const fail = panel.root.querySelector('.bulk-fail');
  assert.ok(fail, 'failure banner shown');
  assert.match(fail.textContent, /1 of 3 could not be updated/);
  assert.match(fail.textContent, /locked/);
  assert.deepEqual(panel.selectedIds(), ['n2'], 'only the failed note stays selected');
  assert.ok(Array.from(document.querySelectorAll('.toast-msg')).some((t) => /1 of 3 notes could not be updated/.test(t.textContent)));
  click(panel.root.querySelector('.bulk-retry'));
  await tick(5);
  assert.deepEqual(seen[1], [['n2'], { status: 'resolved' }], 'retry targets just the failed note');
  assert.equal(panel.root.querySelector('.bulk-fail'), null, 'cleared after a clean retry');
});

test('bulk action that rejects is reported, not swallowed', async () => {
  const { panel } = mount({ bulkRemove: async () => { throw new Error('Error invoking remote method \'x\': store offline'); } });
  const box = cards(panel)[0].querySelector('.note-check');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  click(Array.from(panel.root.querySelectorAll('.bulk-bar button')).find((b) => b.textContent === 'Delete'));
  await tick(5);
  assert.match(panel.root.querySelector('.bulk-fail').textContent, /1 of 1 could not be deleted\. store offline/);
});

test('bulk action that returns nothing keeps working exactly as before', async () => {
  const { panel, calls } = mount();
  const box = cards(panel)[0].querySelector('.note-check');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  click(Array.from(panel.root.querySelectorAll('.bulk-bar button')).find((b) => b.textContent === 'Resolve'));
  await tick(5);
  assert.deepEqual(calls.bulkUpdate, [[['n1'], { status: 'resolved' }]]);
  assert.equal(panel.root.querySelector('.bulk-fail'), null);
});

test('a throwing single-note action becomes a visible error', async () => {
  const { panel } = mount({ remove: async () => { throw new Error('nope'); } });
  click(cards(panel)[0].querySelector('[aria-label="Delete note"]'));
  await tick(5);
  assert.ok(Array.from(document.querySelectorAll('.toast-msg')).some((t) => /Delete note failed: nope/.test(t.textContent)));
});
