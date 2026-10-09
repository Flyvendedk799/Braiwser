'use strict';
// jsdom tests for src/webview/probe.js (layout is stubbed: jsdom has none).
// Real-layout behaviour (occlusion, visibility) is covered by the real-browser suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const probe = require('../../../src/webview/probe');
const dom = require('../../webview/_dom');

function load(html) {
  const d = dom.install(`<!doctype html><html><body>${html}</body></html>`);
  const w = d.window;
  let row = 0;
  w.Element.prototype.getBoundingClientRect = function box() {
    if (this.closest && this.closest('[hidden]')) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    row += 1;
    return { left: 5, top: 20 * row, width: 80, height: 16, right: 85, bottom: 20 * row + 16 };
  };
  Object.defineProperty(w, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: 100000, configurable: true });
  w.document.elementFromPoint = () => null;
  return d;
}
test.afterEach(() => dom.uninstall());

const collect = (args) => probe.collect({ max: 200, ...(args || {}) });
const names = (r) => r.items.map((i) => i.name);

test('the probe is a closed command set with no execution bridge', () => {
  assert.deepEqual(probe.COMMANDS.slice().sort(), ['assertFacts', 'badgeState', 'clearHighlight', 'clickPoint', 'collect',
    'describe', 'highlight', 'setBadge', 'viewportInfo', 'watchClick']);
  load('<button>Hi</button>');
  assert.throws(() => probe.run('eval', { code: '1+1' }), /PROBE_UNKNOWN_COMMAND/);
  assert.throws(() => probe.run('__proto__', {}), /PROBE_UNKNOWN_COMMAND/);
  assert.equal(typeof window.run, 'undefined', 'nothing is installed on window');
  assert.ok(!/\beval\s*\(|new Function\s*\(|Function\s*\(/.test(probe.PROBE_SOURCE), 'no dynamic code evaluation in the probe');
});

test('PROBE_SOURCE is self-contained: it runs by value in a different realm', () => {
  const d = load('<main><button>Go</button></main>');
  const ctx = vm.createContext({ document: d.window.document, window: d.window });
  const fn = vm.runInContext(`(${probe.PROBE_SOURCE})`, ctx);
  const r = fn('collect', { max: 50 });
  assert.ok(r.items.some((i) => i.name === 'Go' && i.role === 'button'));
  const viaObject = fn({ cmd: 'collect', args: { max: 50 } });
  assert.equal(viaObject.total, r.total);
});

test('roles, names, states and secret traits', () => {
  load(`<main>
    <label for="e">Email</label><input id="e" type="email">
    <label>Password <input type="password"></label>
    <input type="text" name="cardnumber" aria-label="Number on card">
    <input type="text" autocomplete="one-time-code" aria-label="Code">
    <input type="checkbox" checked aria-label="Remember me">
    <button disabled>Nope</button>
    <a href="/x">Docs</a><a>not a link</a>
    <button aria-labelledby="lbl">ignored</button><span id="lbl">Labelled by span</span>
    <button aria-label="Close dialog">x</button>
    <select aria-label="Plan"><option>Free</option><option>Pro</option></select>
    <div role="button" tabindex="0">Custom button</div>
    <div role="checkbox" aria-checked="mixed" aria-label="Partial"></div>
    <textarea aria-label="Notes"></textarea>
  </main>`);
  const r = collect();
  const by = (n) => r.items.find((i) => i.name === n);
  assert.equal(by('Email').role, 'textbox');
  assert.equal(by('Email').editable, true);
  assert.equal(by('Remember me').checked, true);
  assert.equal(by('Nope').enabled, false);
  assert.equal(by('Docs').role, 'link');
  assert.ok(!names(r).includes('not a link'));
  assert.ok(names(r).includes('Labelled by span'));
  assert.ok(names(r).includes('Close dialog'));
  assert.equal(by('Plan').role, 'combobox');
  assert.equal(by('Plan').editable, undefined);
  assert.equal(by('Custom button').role, 'button');
  assert.equal(by('Partial').checked, 'mixed');
  assert.equal(by('Notes').editable, true);
  assert.equal(r.items.find((i) => /^Password/.test(i.name)).secret, true);
  assert.equal(by('Number on card').secret, true);
  assert.equal(by('Code').secret, true);
  assert.equal(by('Email').secret, undefined);
  // values are never read
  assert.ok(!JSON.stringify(r).includes('hunter'));
});

test('a select label does not swallow its options', () => {
  load('<label>Plan <select><option>Free</option><option>Pro</option></select></label>');
  assert.deepEqual(names(collect()), ['Plan']);
});

test('page-controlled labels are bounded and stripped in the page', () => {
  load(`<button>${'A'.repeat(5000)}</button><button aria-label="x&#x202E;&#x200B;y">z</button>`);
  const r = collect();
  assert.ok(r.items.every((i) => i.name.length <= 120));
  assert.ok(r.items.some((i) => i.name === 'x y'), JSON.stringify(names(r)));
});

test('duplicates are ambiguous unless their context differs; counts ignore the focus filter', () => {
  load('<button>Delete</button><button>Delete</button><ul><li>Alice <button>Remove</button></li><li>Bob <button>Remove</button></li></ul>');
  const r = collect();
  const del = r.items.filter((i) => i.name === 'Delete');
  assert.ok(del.length === 2 && del.every((i) => i.ambiguous && i.dupCount === 2));
  assert.ok(r.items.filter((i) => i.name === 'Remove').every((i) => !i.ambiguous));
  const focused = collect({ focus: { role: 'button', name: 'delete', exact: true } });
  assert.equal(focused.items.length, 2);
  assert.equal(focused.total, 2);
  assert.equal(collect({ focus: { name: 'bob' } }).items.length, 0, 'focus.name matches the accessible name only');
  assert.equal(collect({ focus: { text: 'bob' } }).items.length, 1, 'focus.text also matches context');
});

test('open shadow roots are traversed and slots resolved; closed hosts are counted, not claimed', () => {
  load('<x-card id="h"></x-card><x-closed></x-closed><div id="out"></div>');
  const host = document.getElementById('h');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button>Inside shadow</button><slot></slot>';
  host.innerHTML = '<button>Slotted</button>';
  const r = collect();
  assert.ok(names(r).includes('Inside shadow'));
  assert.ok(names(r).includes('Slotted'));
  assert.equal(r.stats.shadowRootsOpen, 1);
  assert.equal(r.stats.possibleClosedShadowHosts, 1);
});

test('hidden, aria-hidden and inert content is not observed; own UI is ignored', () => {
  load(`<button hidden>Hidden</button><div aria-hidden="true"><button>Aria hidden</button></div>
    <div data-caos="x"><button>Own UI</button></div><div id="__caos_root"><button>Root UI</button></div><button>Visible</button>`);
  assert.deepEqual(names(collect()), ['Visible']);
});

test('landmarks, headings, status and alerts are observed as non-actionable nodes', () => {
  load(`<header><h1>Title</h1></header><nav aria-label="Primary"><a href="/">Home</a></nav><main><h2>Sub</h2><h3>Skipped</h3>
    <div role="alert">Something failed</div><div role="status">Saved</div></main>`);
  const r = collect();
  const kinds = Object.fromEntries(r.items.map((i) => [i.name || i.role, i.kind]));
  assert.equal(kinds.Primary, 'landmark');
  assert.equal(kinds.Title, 'heading');
  assert.equal(kinds.Sub, 'heading');
  assert.ok(!('Skipped' in kinds));
  assert.equal(kinds['Something failed'], 'error');
  assert.equal(kinds.Saved, 'status');
  assert.ok(r.items.every((i) => i.hi >= 0), 'every returned node is addressable; only interactables can be acted on');
});

test('canvas is reported as a limitation', () => {
  load('<canvas aria-label="Chart"></canvas>');
  const r = collect();
  assert.equal(r.items[0].kind, 'canvas');
  assert.equal(r.items[0].limitation, 'canvas-content-not-observable');
  assert.equal(r.stats.canvases, 1);
});

test('collect pages a stable ordered list: offset/max/total', () => {
  load(Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join(''));
  const a = collect({ offset: 0, max: 10 });
  const b = collect({ offset: 10, max: 10 });
  assert.equal(a.total, 30);
  assert.deepEqual(names(a), Array.from({ length: 10 }, (_, i) => `B${i}`));
  assert.deepEqual(names(b), Array.from({ length: 10 }, (_, i) => `B${i + 10}`));
  assert.equal(collect({ max: 0 }).items.length, 0);
  assert.equal(a.elements.length, 10, 'only the returned window carries elements');
});

test('describe reports identity, duplicates and traits for a live element', () => {
  load('<button id="a">Go</button><button id="b">Go</button><input id="p" type="password" aria-label="Password">');
  const d = probe.describe({ el: document.getElementById('a') });
  assert.equal(d.connected, true);
  assert.equal(d.dupCount, 2);
  assert.equal(d.role, 'button');
  assert.equal(probe.describe({ el: document.getElementById('p') }).secret, true);
  const gone = document.getElementById('b');
  gone.remove();
  assert.equal(probe.describe({ el: gone }).connected, false);
  assert.equal(probe.describe({ el: document.getElementById('a') }).dupCount, 1);
});

test('assertFacts excludes own UI and fails closed on an invalid selector', () => {
  load('<p class="x">One</p><p class="x">Two</p><div data-caos="1"><p class="x">Mine</p></div>');
  const f = probe.assertFacts({ selector: '.x' });
  assert.equal(f.matchCount, 2);
  assert.equal(f.firstText, 'One');
  assert.deepEqual(probe.assertFacts({ selector: '((' }), { error: 'invalid-selector' });
  assert.equal(probe.assertFacts({ selector: '.none' }).firstText, null);
});

test('highlight draws one overlay for the referenced node only and is removable; badge replaces itself', () => {
  load('<button id="a">A</button><button id="b">B</button>');
  probe.highlight({ el: document.getElementById('a'), label: 'step' });
  probe.highlight({ el: document.getElementById('b'), label: 'next' });
  const hs = document.querySelectorAll('[data-caos="agent-highlight"]');
  assert.equal(hs.length, 1, 'a new highlight replaces the previous one');
  assert.equal(hs[0].getAttribute('aria-hidden'), 'true');
  assert.equal(hs[0].style.pointerEvents, 'none');
  assert.equal(probe.clearHighlight({}).removed, 1);
  probe.setBadge({ owner: 'agent' });
  probe.setBadge({ owner: 'human' });
  assert.equal(document.querySelectorAll('[data-caos="agent-badge"]').length, 1);
  assert.equal(probe.badgeState({}).owner, 'human');
  probe.setBadge({ owner: 'none' });
  assert.equal(probe.badgeState({}).owner, 'none');
  assert.equal(collect().items.length, 2, 'overlays never appear in observations');
  assert.equal(probe.highlight({ el: null }).ok, false);
});

test('status / alert nodes: name is the accessible name, text is the live content; testId is surfaced', () => {
  load('<div role="status" aria-label="Status">Saved 3 items</div><div role="alert">Boom</div><button data-testid="go-btn">Go</button>');
  const r = collect();
  const status = r.items.find((i) => i.role === 'status');
  assert.equal(status.name, 'Status');
  assert.equal(status.text, 'Saved 3 items');
  const alert = r.items.find((i) => i.role === 'alert');
  assert.equal(alert.name, 'Boom');
  assert.equal(alert.text, undefined, 'unlabelled: the text IS the name');
  assert.equal(r.items.find((i) => i.name === 'Go').testId, 'go-btn');
});

test('assertFacts resolves semantic locators exactly (role+name, label, testId) and fails closed on others', () => {
  load(`<div role="status" aria-label="Status">Done</div><label>Email <input type="email"></label>
    <button data-testid="x-1">One</button><button data-testid="x-1">Two</button><div data-caos="1" role="status" aria-label="Status">Mine</div>`);
  const role = probe.assertFacts({ target: { by: 'role', role: 'status', name: 'Status' } });
  assert.equal(role.matchCount, 1, 'own UI is excluded');
  assert.equal(role.firstText, 'Done');
  assert.equal(probe.assertFacts({ target: { by: 'role', role: 'status', name: 'Stat' } }).matchCount, 0, 'no partial name matches');
  assert.equal(probe.assertFacts({ target: { by: 'label', value: 'Email' } }).matchCount, 1);
  assert.equal(probe.assertFacts({ target: { by: 'testId', value: 'x-1' } }).matchCount, 2);
  assert.equal(probe.assertFacts({ target: { by: 'text', value: 'Done' } }).error, 'invalid-target');
});

// ---- tables and lists (layout stubbed; the real-browser suite covers visibility) ------------------------------------
test('tables: header names, bounded matrix, hidden rows skipped, secret columns and controls withheld', () => {
  load(`<main>
    <table><caption>Users</caption>
      <thead><tr><th>Name</th><th>Password</th><th>Note</th></tr></thead>
      <tbody>
        <tr><td>ada</td><td>CANARY-pw-1</td><td>a</td></tr>
        <tr hidden><td>ghost</td><td>CANARY-pw-2</td><td>b</td></tr>
        <tr><td>grace</td><td>CANARY-pw-3</td><td><input type="password" value="CANARY-pw-4"></td></tr>
        <tr><td>alan</td><td></td><td><input type="text" value="CANARY-visible-input"> x</td></tr>
      </tbody>
    </table>
    <table aria-label="Rows">${Array.from({ length: 60 }, (_, i) => `<tr><th>H</th>${Array.from({ length: 14 }, (_x, j) => `<td>${i}-${j}</td>`).join('')}</tr>`).join('')}</table>
  </main>`);
  const r = collect();
  const users = r.items.find((i) => i.kind === 'table' && i.name === 'Users');
  assert.deepEqual(users.table.headers, ['Name', 'Password', 'Note']);
  assert.equal(users.table.rowCount, 3, 'the hidden row is neither counted nor returned');
  assert.deepEqual(users.table.cells.map((row) => row[0]), ['ada', 'grace', 'alan']);
  assert.deepEqual(users.table.withheld, [1]);
  assert.ok(users.table.cells.every((row) => row[1] === null));
  assert.equal(users.table.cells[1][2], null, 'a password control withholds its own cell');
  assert.equal(users.table.cells[2][2], 'x', 'input values are never read');
  assert.equal(users.table.cells[0][2], 'a');
  const json = JSON.stringify(r);
  assert.ok(!/CANARY/.test(json), 'no secret or input value in the whole collection, including row context labels');

  const rows = r.items.find((i) => i.kind === 'table' && i.name === 'Rows');
  assert.equal(rows.table.hasHeader, false, 'a <th> that is not the whole row is a row header, not a header row');
  assert.equal(rows.table.rowCount, 60); assert.equal(rows.table.cells.length, 50); assert.equal(rows.table.truncated.rows, true);
  assert.ok(rows.table.cells.every((row) => row.length === 12)); assert.equal(rows.table.truncated.columns, true);
  assert.equal(rows.table.columnCount, 15);
});

test('tables: ARIA grids, merged cells, nested tables and caps on how many structures are returned', () => {
  load(`<main>
    <div role="grid" aria-label="G"><div role="row"><div role="columnheader">K</div><div role="columnheader">V</div></div>
      <div role="row"><div role="gridcell">a</div><div role="gridcell">1</div></div></div>
    <table aria-label="M"><tr><th>A</th><th colspan="2">B</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
    <table aria-label="Outer"><tr><th>X</th></tr><tr><td><table aria-label="Inner"><tr><th>Y</th></tr><tr><td>y1</td></tr></table></td></tr></table>
  </main>`);
  const r = collect();
  const t = (n) => r.items.find((i) => i.kind === 'table' && i.name === n).table;
  assert.deepEqual(t('G').cells, [['a', '1']]); assert.deepEqual(t('G').headers, ['K', 'V']);
  assert.equal(t('M').merged, true);
  assert.equal(t('Outer').rowCount, 1, 'rows of a nested table belong to the nested table');
  assert.deepEqual(t('Inner').cells, [['y1']]);
  load(Array.from({ length: 30 }, (_, i) => `<table aria-label="T${i}"><tr><th>H</th></tr><tr><td>v</td></tr></table>`).join(''));
  const many = collect();
  assert.equal(many.items.filter((i) => i.kind === 'table').length, 20);
  assert.equal(many.stats.structuresCapped, true, 'the cap is reported, not silent');
});

test('lists: ordered flag, bounded items; menus, single items and link-only lists are skipped', () => {
  load(`<main>
    <nav><ul><li>one</li><li>two</li></ul></nav>
    <ul id="a"><li>apples</li><li>pears</li></ul>
    <ol aria-label="Steps"><li>Open</li><li>Edit</li></ol>
    <ul id="one"><li>solo</li></ul>
    <ul id="links"><li><a href="/1">One</a></li><li><a href="/2">Two</a></li></ul>
    <ul aria-label="Long">${Array.from({ length: 40 }, (_, i) => `<li>item ${i}</li>`).join('')}</ul>
  </main>`);
  const lists = collect().items.filter((i) => i.kind === 'list');
  assert.deepEqual(lists.map((l) => l.name), ['', 'Steps', 'Long']);
  assert.deepEqual(lists[0].list.items, ['apples', 'pears']); assert.equal(lists[1].list.ordered, true);
  assert.equal(lists[2].list.items.length, 30); assert.equal(lists[2].list.itemCount, 40); assert.equal(lists[2].list.truncated.items, true);
});

test('role locators without a name match any name; an empty name still means "no accessible name"', () => {
  load('<main><button>Save</button><button aria-label=" "></button><div role="row">r1</div><div role="row">r2</div></main>');
  const facts = (target) => probe.run('assertFacts', { target });
  assert.equal(facts({ by: 'role', role: 'row' }).matchCount, 2);
  assert.equal(facts({ by: 'role', role: 'button' }).matchCount, 2);
  assert.equal(facts({ by: 'role', role: 'button', name: 'Save' }).matchCount, 1);
  assert.equal(facts({ by: 'role', role: 'button', name: '' }).matchCount, 1);
});
