// RF-09: row-level keydown handlers must not hijack Enter/Space from nested
// action buttons, and keyboard focus must survive a re-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, press, key, click } from './dom-env.mjs';

const { document } = setupDom();
const { h } = await load('lib/dom.js');
const { createSidebar } = await load('components/sidebar.js');
const { createTabStrip } = await load('components/tabs.js');
const { createSectionsPanel } = await load('components/sections-panel.js');
const { createLayersPanel } = await load('components/layers-panel.js');

function mountSidebar(calls, over = {}) {
  const actions = new Proxy({ ...over }, {
    get(t, name) {
      if (name in t) return t[name];
      return (...args) => { calls.push([String(name), ...args]); };
    },
  });
  const panels = { sections: h('div'), layers: h('div') };
  const sb = createSidebar(actions, panels);
  document.body.appendChild(sb.root);
  return sb;
}

const baseState = (projects) => ({
  projects, currentProject: null, sessions: [], currentSession: null, recordings: [],
  selectedRecording: null, sessionCounts: {}, history: [], bookmarks: [],
});

test('sidebar: Enter/Space on a nested Delete button is not swallowed by the row', () => {
  const calls = [];
  const sb = mountSidebar(calls);
  const p = { id: 'p1', name: 'Alpha', kind: 'local', path: '/a' };
  sb.update(baseState([p]));
  const del = sb.root.querySelector('.sr-act.danger');
  assert.ok(del, 'delete button rendered');
  for (const k of ['Enter', ' ']) {
    calls.length = 0;
    del.focus();
    const ev = press(del, k);
    assert.equal(ev.defaultPrevented, false, `${JSON.stringify(k)} default must not be prevented`);
    assert.deepEqual(calls.map((c) => c[0]), ['deleteProject'], `exactly one action for ${JSON.stringify(k)}`);
  }
});

test('sidebar: Enter/Space on the row itself opens it exactly once', () => {
  const calls = [];
  const sb = mountSidebar(calls);
  const p = { id: 'p1', name: 'Alpha', kind: 'local', path: '/a' };
  sb.update(baseState([p]));
  const row = sb.root.querySelector('.side-row');
  for (const k of ['Enter', ' ']) {
    calls.length = 0;
    const ev = press(row, k);
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(calls.map((c) => c[0]), ['openProject']);
  }
});

test('sidebar: rename + export buttons also keep their own keyboard activation', () => {
  const calls = [];
  const sb = mountSidebar(calls);
  const p = { id: 'p1', name: 'Alpha', kind: 'local', path: '/a' };
  sb.update(baseState([p]));
  const btns = Array.from(sb.root.querySelectorAll('.sr-act'));
  for (const b of btns) press(b, 'Enter');
  assert.deepEqual(calls.map((c) => c[0]), ['exportBundle', 'renameProject', 'deleteProject']);
});

test('sidebar: arrow keys move between rows, only from the row', () => {
  const sb = mountSidebar([]);
  sb.update(baseState([{ id: 'a', name: 'A', kind: 'url' }, { id: 'b', name: 'B', kind: 'url' }]));
  const [r1, r2] = Array.from(sb.root.querySelectorAll('.side-row'));
  r1.focus();
  key(r1, 'ArrowDown');
  assert.equal(document.activeElement, r2);
  key(r2, 'ArrowUp');
  assert.equal(document.activeElement, r1);
});

test('sidebar: focus is retained on the same control across update()', () => {
  const sb = mountSidebar([]);
  const ps = [{ id: 'a', name: 'A', kind: 'url' }, { id: 'b', name: 'B', kind: 'url' }];
  sb.update(baseState(ps));
  const ren = sb.root.querySelectorAll('.side-row')[1].querySelector('[data-act="Rename"]');
  ren.focus();
  sb.update(baseState(ps.map((p) => ({ ...p }))));
  const now = document.activeElement;
  assert.equal(now.dataset.act, 'Rename');
  assert.equal(now.closest('.side-row').dataset.focusKey, 'project:b');
});

test('sidebar: deleting the focused row moves focus to a neighbour, not <body>', () => {
  const sb = mountSidebar([]);
  const ps = [{ id: 'a', name: 'A', kind: 'url' }, { id: 'b', name: 'B', kind: 'url' }];
  sb.update(baseState(ps));
  sb.root.querySelectorAll('.side-row')[0].querySelector('.sr-act.danger').focus();
  sb.update(baseState([ps[1]]));
  assert.ok(sb.root.contains(document.activeElement), 'focus stays inside the sidebar');
  assert.equal(document.activeElement.closest('.side-row').dataset.focusKey, 'project:b');
  sb.update(baseState([]));
  assert.ok(document.activeElement.classList.contains('side-add'), 'empty list lands on the add button');
});

test('sidebar: tablists use roving tabindex + arrows', () => {
  const calls = [];
  const sb = mountSidebar(calls);
  sb.setView('workspace');
  const tabs = Array.from(sb.root.querySelectorAll('.side-view-tab'));
  assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1]);
  tabs[0].focus();
  key(tabs[0], 'ArrowRight');
  assert.equal(document.activeElement, tabs[1]);
  assert.deepEqual(calls.filter((c) => c[0] === 'selectView').pop(), ['selectView', 'page']);
  sb.setTab('layers');
  const pt = Array.from(sb.root.querySelectorAll('.side-tab'));
  assert.deepEqual(pt.map((t) => t.tabIndex), [-1, 0]);
});

test('tabs: Enter/Space on the close button closes, never selects the tab', () => {
  const calls = [];
  const strip = createTabStrip({ selectTab: (id) => calls.push(['select', id]), closeTab: (id) => calls.push(['close', id]), newTab: () => {} });
  document.body.appendChild(strip.root);
  strip.update([{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }], 't1');
  const close = strip.root.querySelector('.tc-close');
  close.focus();
  const ev = press(close, 'Enter');
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(calls, [['close', 't1']]);
  calls.length = 0;
  const chip = strip.root.querySelector('.tab-chip');
  press(chip, ' ');
  assert.deepEqual(calls, [['select', 't1']]);
});

test('tabs: arrows move + keep focus on the new chip after the re-render', () => {
  const tabs = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }, { id: 't3', title: 'Three' }];
  let active = 't1';
  let strip;
  strip = createTabStrip({ selectTab: (id) => { active = id; strip.update(tabs, active); }, closeTab: () => {}, newTab: () => {} });
  document.body.appendChild(strip.root);
  strip.update(tabs, active);
  const chips = () => Array.from(strip.root.querySelectorAll('.tab-chip'));
  chips()[0].focus();
  key(document.activeElement, 'ArrowRight');
  assert.equal(active, 't2');
  assert.equal(document.activeElement.dataset.tabId, 't2');
  assert.deepEqual(chips().map((c) => c.tabIndex), [-1, 0, -1]);
  key(document.activeElement, 'End');
  assert.equal(document.activeElement.dataset.tabId, 't3');
  key(document.activeElement, 'Home');
  assert.equal(document.activeElement.dataset.tabId, 't1');
});

test('tabs: focus on a close button survives a re-render', () => {
  const tabs = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }];
  const strip = createTabStrip({ selectTab: () => {}, closeTab: () => {}, newTab: () => {} });
  document.body.appendChild(strip.root);
  strip.update(tabs, 't1');
  strip.root.querySelectorAll('.tc-close')[1].focus();
  strip.update(tabs.map((t) => ({ ...t, loading: true })), 't1');
  assert.ok(document.activeElement.classList.contains('tc-close'));
  assert.equal(document.activeElement.closest('.tab-chip').dataset.tabId, 't2');
});

const tree = () => ({
  tag: 'body', selector: 'body',
  children: [
    { tag: 'section', id: 'one', selector: '#one', classes: [], children: [{ tag: 'div', selector: '#one > div', classes: [], children: [] }] },
    { tag: 'section', id: 'two', selector: '#two', classes: [], children: [] },
  ],
});

test('sections: Enter on the eye button toggles visibility and does not select the row', () => {
  const calls = [];
  const panel = createSectionsPanel({
    select: (n) => calls.push(['select', n.selector]), hover: () => {}, hoverClear: () => {}, refresh: () => {},
    toggleHidden: (n) => calls.push(['hide', n.selector]), reorder: () => {}, moveInto: () => {},
  });
  document.body.appendChild(panel.root);
  panel.setTree(tree());
  calls.length = 0;
  const eye = panel.root.querySelector('.sec-eye');
  eye.focus();
  const ev = press(eye, 'Enter');
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(calls, [['hide', '#one']]);
  calls.length = 0;
  const row = panel.root.querySelector('.sec-row');
  press(row, 'Enter');
  assert.deepEqual(calls, [['select', '#one']]);
});

test('sections: tree keys (Right opens/descends, Left collapses/ascends, Down moves) and focus survives re-render', () => {
  const panel = createSectionsPanel({
    select: () => {}, hover: () => {}, hoverClear: () => {}, refresh: () => {},
    toggleHidden: () => {}, reorder: () => {}, moveInto: () => {},
  });
  document.body.appendChild(panel.root);
  panel.setTree(tree());
  const rows = () => Array.from(panel.root.querySelectorAll('.sec-row'));
  const names = () => rows().map((r) => r._node.selector);
  // Depth-0 sections start expanded, so #one's child row is already rendered.
  assert.deepEqual(names(), ['#one', '#one > div', '#two']);
  rows()[0].focus();
  key(document.activeElement, 'ArrowRight'); // open parent: descend into the first child
  assert.equal(document.activeElement._node.selector, '#one > div');
  key(document.activeElement, 'ArrowLeft'); // leaf: ascend to the parent
  assert.equal(document.activeElement._node.selector, '#one');
  key(document.activeElement, 'ArrowLeft'); // open parent: collapse -> full re-render must keep focus
  assert.deepEqual(names(), ['#one', '#two']);
  assert.equal(document.activeElement._node.selector, '#one', 'focus kept across the re-render');
  key(document.activeElement, 'ArrowRight'); // collapsed parent: expand (stay on the row)
  assert.deepEqual(names(), ['#one', '#one > div', '#two']);
  assert.equal(document.activeElement._node.selector, '#one');
  key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement._node.selector, '#one > div');
  key(document.activeElement, 'End');
  assert.equal(document.activeElement._node.selector, '#two');
  // roving: exactly one tab stop
  assert.equal(rows().filter((r) => r.tabIndex === 0).length, 1);
});

test('layers: keys on raise/lower/hide buttons are theirs; row keys act on the row only', () => {
  const calls = [];
  const panel = createLayersPanel({
    selectLayout: (s) => calls.push(['select', s.selector]), hover: () => {}, hoverClear: () => {},
    toggleHidden: (s) => calls.push(['hide', s.selector]), zOrder: (s, d) => calls.push(['z', s.selector, d]),
    reorder: (p) => calls.push(['reorder', p]), smartLayout: () => {},
  });
  document.body.appendChild(panel.root);
  panel.setLayout({
    breadcrumb: [{ selector: 'body', tag: 'body' }, { selector: '#a', tag: 'div' }],
    container: { selector: 'body', tag: 'body', kind: 'column', childCount: 2 },
    siblings: [
      { selector: '#a', tag: 'div', isTarget: true, position: 'absolute', overlapping: true },
      { selector: '#b', tag: 'div', position: 'absolute', overlapping: true },
    ],
  });
  const row = panel.root.querySelector('.layer-row');
  const eye = row.querySelector('.layer-act-eye');
  eye.focus();
  const ev = press(eye, 'Enter');
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(calls, [['hide', '#a']]);
  calls.length = 0;
  const raise = row.querySelector('[title="Bring to front"]');
  press(raise, ' ');
  assert.deepEqual(calls, [['z', '#a', 'front']]);
  calls.length = 0;
  press(row, 'Enter');
  assert.deepEqual(calls, [['select', '#a']]);
});

test('layers: focus survives setLayout re-render', () => {
  const panel = createLayersPanel({ selectLayout: () => {}, hover: () => {}, hoverClear: () => {}, toggleHidden: () => {}, zOrder: () => {}, reorder: () => {}, smartLayout: () => {} });
  document.body.appendChild(panel.root);
  const info = () => ({
    breadcrumb: [{ selector: 'body', tag: 'body' }, { selector: '#a', tag: 'div' }],
    container: { selector: 'body', tag: 'body', kind: 'column', childCount: 2 },
    siblings: [{ selector: '#a', tag: 'div', isTarget: true }, { selector: '#b', tag: 'div' }],
  });
  panel.setLayout(info());
  const rows = () => Array.from(panel.root.querySelectorAll('.layer-row'));
  rows()[1].focus();
  panel.setLayout(info());
  assert.equal(document.activeElement._layer.selector, '#b');
  click(document.body);
});
