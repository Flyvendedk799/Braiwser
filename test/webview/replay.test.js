'use strict';
// CE-06 / CE-01: replay fails closed and never types stored secrets; assertion
// evaluation conforms to the shared table (src/shared/assertions.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('./_dom');
const { cases } = require('../shared/assertions.table');

const FAST = { fast: true, actionTimeoutMs: 60 };

function load(html, { layout = true } = {}) {
  const d = dom.install(html);
  const w = d.window;
  w.scrollTo = () => {};
  if (layout) {
    // jsdom has no layout: every element gets a box on screen, display:none gets none.
    w.Element.prototype.getBoundingClientRect = function rect() {
      const hidden = w.getComputedStyle(this).display === 'none';
      const r = { left: 10, top: 300, width: hidden ? 0 : 100, height: hidden ? 0 : 20 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
    };
  }
  // Hit testing: by default whatever the test names as topmost.
  w.document.elementsFromPoint = () => (w.__stack ? w.__stack() : []);
  return { w, doc: w.document, replay: require('../../src/webview/replay') };
}

test.afterEach(() => dom.uninstall());

// ---- assertion conformance table --------------------------------------------------
for (const c of cases) {
  test(`assert conformance: ${c.name}`, () => {
    const { replay } = load(`<!doctype html><body>${c.html || ''}</body>`);
    // location is per-JSDOM; re-create with the case URL for url assertions.
    dom.uninstall();
    const d = dom.install(`<!doctype html><body>${c.html || ''}</body>`, { url: c.url });
    d.window.Element.prototype.getBoundingClientRect = function rect() {
      const hidden = d.window.getComputedStyle(this).display === 'none';
      return { left: 0, top: 0, width: hidden ? 0 : 50, height: hidden ? 0 : 10, right: 50, bottom: 10, x: 0, y: 0 };
    };
    const r = replay.evaluateAssert({ type: 'assert', ...c.assertion });
    assert.equal(r.ok, c.ok, JSON.stringify(r));
    assert.equal(r.status, c.ok ? 'passed' : 'failed');
  });
}

test('unrecognised assertion kind with a nonexistent selector fails (was a silent pass)', async () => {
  const { replay } = load('<body></body>');
  const r = await replay.executeStep({ type: 'assert', kind: 'teleports', selector: '#nope' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'unsupported-assertion');
});

// ---- click actionability ---------------------------------------------------------------
test('disabled button: click fails, counter stays 0', async () => {
  const { w, doc, replay } = load('<body><button id="b" disabled>Go</button></body>');
  let n = 0;
  doc.getElementById('b').addEventListener('click', () => { n++; });
  w.__stack = () => [doc.getElementById('b')];
  const r = await replay.executeStep({ type: 'click', selector: '#b', tag: 'button' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(n, 0);
});

test('aria-disabled (own or ancestor) and inert block a click', async () => {
  const { w, doc, replay } = load('<body><div aria-disabled="true"><button id="a">A</button></div><div inert><button id="i">I</button></div></body>');
  for (const [id, reason] of [['a', 'disabled'], ['i', 'inert']]) {
    w.__stack = () => [doc.getElementById(id)];
    const r = await replay.executeStep({ type: 'click', selector: '#' + id }, FAST);
    assert.equal(r.ok, false, id);
    assert.equal(r.reason, reason);
  }
});

test('hidden button: click fails with not-visible', async () => {
  const { doc, replay } = load('<body><button id="b" style="display:none">Go</button></body>');
  let n = 0;
  doc.getElementById('b').addEventListener('click', () => { n++; });
  const r = await replay.executeStep({ type: 'click', selector: '#b' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-visible');
  assert.equal(n, 0);
});

test('covered button: click fails and names the covering element', async () => {
  const { w, doc, replay } = load('<body><button id="b">Go</button><div id="veil"></div></body>');
  let n = 0;
  doc.getElementById('b').addEventListener('click', () => { n++; });
  w.__stack = () => [doc.getElementById('veil'), doc.getElementById('b')];
  const r = await replay.executeStep({ type: 'click', selector: '#b' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'covered');
  assert.equal(r.coveredBy, '#veil');
  assert.equal(n, 0);
});

test('our own overlays do not count as covering', async () => {
  const { w, doc, replay } = load('<body><button id="b">Go</button><div data-caos id="ov"></div></body>');
  let n = 0;
  doc.getElementById('b').addEventListener('click', () => { n++; });
  w.__stack = () => [doc.getElementById('ov'), doc.getElementById('b')];
  const r = await replay.executeStep({ type: 'click', selector: '#b' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(n, 1);
});

test('actionable click is delivered and labelled honestly (dispatch-only unless the page reacted)', async () => {
  const { w, doc, replay } = load('<body><button id="b">Go</button><p id="out"></p></body>');
  const b = doc.getElementById('b');
  w.__stack = () => [b];
  let r = await replay.executeStep({ type: 'click', selector: '#b' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'dispatchOnly');
  assert.equal(r.status, 'dispatched');
  assert.equal(r.needsPostcondition, true);

  b.addEventListener('click', () => { doc.getElementById('out').textContent = 'clicked'; });
  r = await replay.executeStep({ type: 'click', selector: '#b' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'observed');
  assert.equal(r.status, 'passed');
});

test('waits (bounded) for a target to become enabled', async () => {
  const { w, doc, replay } = load('<body><button id="b" disabled>Go</button></body>');
  const b = doc.getElementById('b');
  w.__stack = () => [b];
  setTimeout(() => { b.disabled = false; }, 60);
  const r = await replay.executeStep({ type: 'click', selector: '#b' }, { fast: true, actionTimeoutMs: 1000 });
  assert.equal(r.ok, true);
});

// ---- target resolution -----------------------------------------------------------------
test('ambiguous selector fails instead of clicking the first match', async () => {
  const { w, doc, replay } = load('<body><button class="x">1</button><button class="x">2</button></body>');
  let n = 0;
  doc.querySelectorAll('.x').forEach((b) => b.addEventListener('click', () => { n++; }));
  w.__stack = () => [doc.querySelector('.x')];
  const r = await replay.executeStep({ type: 'click', selector: 'button.x', tag: 'button' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-target');
  assert.equal(n, 0);
});

test('missing target fails; navigate is host-owned; unknown step type fails', async () => {
  const { replay } = load('<body></body>');
  assert.equal((await replay.executeStep({ type: 'click', selector: '#none' }, FAST)).reason, 'target-not-found');
  const nav = await replay.executeStep({ type: 'navigate', url: 'x' }, FAST);
  assert.equal(nav.status, 'skipped');
  assert.equal(nav.effect, 'none');
  assert.equal((await replay.executeStep({ type: 'teleport', selector: 'body' }, FAST)).ok, false);
});

// ---- Enter / implicit submission -----------------------------------------------------------
test('Enter in a text field performs implicit form submission and confirms the submit event', async () => {
  const { w, doc, replay } = load('<body><form id="f"><input id="q" name="q" value="hi"><button>Send</button></form></body>');
  let submits = 0;
  doc.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submits++; });
  w.__stack = () => [doc.getElementById('q')];
  const r = await replay.executeStep({ type: 'key', selector: '#q', key: 'Enter' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'confirmed');
  assert.equal(submits, 1);
});

test('Enter on an invalid form fails (constraint validation) rather than passing', async () => {
  const { w, doc, replay } = load('<body><form id="f"><input id="q" required><button>Send</button></form></body>');
  let submits = 0;
  doc.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submits++; });
  w.__stack = () => [doc.getElementById('q')];
  const r = await replay.executeStep({ type: 'key', selector: '#q', key: 'Enter' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'form-invalid');
  assert.equal(submits, 0);
});

test('Enter with nothing to submit is dispatch-only and requires a postcondition', async () => {
  const { w, doc, replay } = load('<body><textarea id="t"></textarea></body>');
  w.__stack = () => [doc.getElementById('t')];
  const r = await replay.executeStep({ type: 'key', selector: '#t', key: 'Enter' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'dispatchOnly');
  assert.equal(r.status, 'dispatched');
  assert.equal(r.needsPostcondition, true);
});

test('Enter on a button activates it', async () => {
  const { w, doc, replay } = load('<body><button id="b">Go</button></body>');
  let n = 0;
  doc.getElementById('b').addEventListener('click', () => { n++; });
  w.__stack = () => [doc.getElementById('b')];
  const r = await replay.executeStep({ type: 'key', selector: '#b', key: 'Enter' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(n, 1);
});

// ---- input ---------------------------------------------------------------------------------
test('text input is applied and verified', async () => {
  const { w, doc, replay } = load('<body><input id="q"></body>');
  w.__stack = () => [doc.getElementById('q')];
  const r = await replay.executeStep({ type: 'input', selector: '#q', value: 'hello' }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'confirmed');
  assert.equal(doc.getElementById('q').value, 'hello');
});

test('input the page reverts is a failure, not a pass', async () => {
  const { w, doc, replay } = load('<body><input id="q"></body>');
  const q = doc.getElementById('q');
  q.addEventListener('input', () => { setTimeout(() => { q.value = ''; }, 0); });
  w.__stack = () => [q];
  const r = await replay.executeStep({ type: 'input', selector: '#q', value: 'hello' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'value-not-applied');
});

test('read-only and disabled fields refuse input', async () => {
  const { w, doc, replay } = load('<body><input id="r" readonly><input id="d" disabled></body>');
  for (const [id, reason] of [['r', 'read-only'], ['d', 'disabled']]) {
    w.__stack = () => [doc.getElementById(id)];
    const r = await replay.executeStep({ type: 'input', selector: '#' + id, value: 'x' }, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(doc.getElementById(id).value, '');
  }
});

test('select, multiselect, checkbox', async () => {
  const { w, doc, replay } = load(`<body>
    <select id="s"><option value="a">A</option><option value="b">B</option></select>
    <select id="m" multiple><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
    <input id="c" type="checkbox"></body>`);
  const s = doc.getElementById('s');
  w.__stack = () => [s];
  let r = await replay.executeStep({ type: 'input', selector: '#s', value: 'b', control: 'select' }, FAST);
  assert.equal(r.effect, 'confirmed');
  assert.equal(s.value, 'b');
  r = await replay.executeStep({ type: 'input', selector: '#s', value: 'nope', control: 'select' }, FAST);
  assert.equal(r.reason, 'option-not-found');
  assert.equal(s.value, 'b');

  const m = doc.getElementById('m');
  w.__stack = () => [m];
  r = await replay.executeStep({ type: 'input', selector: '#m', value: ['x', 'z'], control: 'multiselect' }, FAST);
  assert.equal(r.effect, 'confirmed');
  assert.deepEqual(Array.from(m.selectedOptions).map((o) => o.value), ['x', 'z']);

  const c = doc.getElementById('c');
  w.__stack = () => [c];
  r = await replay.executeStep({ type: 'input', selector: '#c', value: true, control: 'checkbox' }, FAST);
  assert.equal(r.effect, 'confirmed');
  assert.equal(c.checked, true);
  r = await replay.executeStep({ type: 'input', selector: '#c', value: false, control: 'checkbox' }, FAST);
  assert.equal(c.checked, false);
});

// ---- secrets (CE-01) ---------------------------------------------------------------------------
test('a recorded secret with no runtime binding fails and types nothing', async () => {
  const { w, doc, replay } = load('<body><input id="pw" type="password"></body>');
  const pw = doc.getElementById('pw');
  w.__stack = () => [pw];
  const r = await replay.executeStep({ type: 'input', selector: '#pw', secret: true, control: 'secret', placeholder: '{{secret}}' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'secret-binding-missing');
  assert.equal(pw.value, '');
});

test('stored plaintext on a legacy secret step is never typed', async () => {
  const { w, doc, replay } = load('<body><input id="pw" type="password"></body>');
  const pw = doc.getElementById('pw');
  w.__stack = () => [pw];
  const r = await replay.executeStep({ type: 'input', selector: '#pw', secret: true, value: 'legacy-plain-9c1' }, FAST);
  assert.equal(r.ok, false);
  assert.equal(pw.value, '');
});

test('a runtime binding is typed, verified, and not echoed in the result', async () => {
  const SECRET = 'runtime-only-Zk3!';
  for (const secrets of [{ '#pw': SECRET }, () => SECRET]) {
    const { w, doc, replay } = load('<body><input id="pw" type="password"></body>');
    const pw = doc.getElementById('pw');
    w.__stack = () => [pw];
    const r = await replay.executeStep({ type: 'input', selector: '#pw', secret: true }, { ...FAST, secrets });
    assert.equal(r.ok, true);
    assert.equal(r.effect, 'confirmed');
    assert.equal(pw.value, SECRET);
    assert.ok(!JSON.stringify(r).includes(SECRET));
    dom.uninstall();
  }
});

// ---- scroll ----------------------------------------------------------------------------------------
test('scroll step is verified, and a stuck scroll fails', async () => {
  const { w, replay } = load('<body></body>');
  let y = 0;
  Object.defineProperty(w, 'scrollY', { get: () => y, configurable: true });
  Object.defineProperty(w, 'scrollX', { get: () => 0, configurable: true });
  Object.defineProperty(w.document.documentElement, 'scrollHeight', { get: () => 5000, configurable: true });
  w.scrollTo = (a, b) => { y = typeof a === 'object' ? a.top : b; };
  let r = await replay.executeStep({ type: 'scroll', x: 0, y: 400 }, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.effect, 'confirmed');
  assert.equal(y, 400);

  w.scrollTo = () => {}; // page swallows the scroll
  r = await replay.executeStep({ type: 'scroll', x: 0, y: 900 }, FAST);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'scroll-not-reached');
});
