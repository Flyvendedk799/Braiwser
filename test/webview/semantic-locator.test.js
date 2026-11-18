'use strict';
// A recorded step carries a durable semantic locator only when it names exactly
// one element, and an ordinary recording then migrates into a closed workflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('./_dom');
const wf = require('../../src/main/services/automation/workflow-core');

function load(html) {
  const d = dom.install(html);
  // jsdom has no layout: the probe's occlusion check needs the method to exist.
  d.window.document.elementFromPoint = () => null;
  for (const k of Object.keys(require.cache)) {
    if (/src[\\/]webview[\\/](recorder|anchor|cursor|secret-field|semantic-locator|probe)\.js$/.test(k)) delete require.cache[k];
  }
  const recorder = require('../../src/webview/recorder');
  const semantic = require('../../src/webview/semantic-locator');
  const steps = [];
  return { w: d.window, doc: d.window.document, recorder, semantic, steps, collect: (s) => { if (s.replaceLast) steps[steps.length - 1] = s; else steps.push(s); } };
}

test.afterEach(() => {
  try { require('../../src/webview/recorder').stop(); } catch (_e) { /* ignore */ }
  dom.uninstall();
});

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
const type = (w, el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

test('a test id wins; a unique role + name is the fallback', () => {
  const { doc, semantic } = load(`<body>
    <button data-testid="save">Save</button>
    <button id="plain">Publish</button>
    <a href="/docs" id="docs">Docs</a></body>`);
  assert.deepEqual(semantic.locatorFor(doc.querySelector('[data-testid]')), { by: 'testId', value: 'save' });
  assert.deepEqual(semantic.locatorFor(doc.getElementById('plain')), { by: 'role', role: 'button', name: 'Publish' });
  assert.deepEqual(semantic.locatorFor(doc.getElementById('docs')), { by: 'role', role: 'link', name: 'Docs' });
});

test('two controls with the same name get no locator: never the first match', () => {
  const { doc, semantic } = load('<body><button id="a">Delete</button><button id="b">Delete</button></body>');
  assert.equal(semantic.locatorFor(doc.getElementById('a')), null);
  assert.equal(semantic.locatorFor(doc.getElementById('b')), null);
});

test('a duplicated test id falls back to the role + name when that is unique', () => {
  const { doc, semantic } = load('<body><button data-testid="x" id="a">One</button><button data-testid="x">Two</button></body>');
  assert.deepEqual(semantic.locatorFor(doc.getElementById('a')), { by: 'role', role: 'button', name: 'One' });
});

test('a click inside a button is recorded against the button; a bare div gets nothing', () => {
  const { doc, semantic } = load('<body><button><span id="inner"><b id="deep">Go</b></span></button><div id="div" data-testid="card">card</div></body>');
  assert.deepEqual(semantic.locatorFor(doc.getElementById('deep')), { by: 'role', role: 'button', name: 'Go' });
  // The runtime cannot act on a generic element, so an action locator would be a promise it cannot keep.
  assert.equal(semantic.locatorFor(doc.getElementById('div')), null);
  // An assertion can still target it by its test id.
  assert.deepEqual(semantic.locatorFor(doc.getElementById('div'), { action: false }), { by: 'testId', value: 'card' });
});

test('assertion targets: headings by role + name, unnamed generic elements get nothing', () => {
  const { doc, semantic } = load('<body><h1 id="h">Welcome back</h1><p id="p">Hello</p></body>');
  assert.deepEqual(semantic.locatorFor(doc.getElementById('h'), { action: false }), { by: 'role', role: 'heading', name: 'Welcome back' });
  assert.equal(semantic.locatorFor(doc.getElementById('p'), { action: false }), null);
});

test('fields are named by their label and the value is never part of the locator', () => {
  const { doc, semantic } = load('<body><label for="e">Email address</label><input id="e" value="someone@example.test"></body>');
  const l = semantic.locatorFor(doc.getElementById('e'));
  assert.deepEqual(l, { by: 'role', role: 'textbox', name: 'Email address' });
  assert.ok(!JSON.stringify(l).includes('someone'));
});

test('an ordinary recording with no test ids migrates into a closed workflow', () => {
  const { w, doc, recorder, steps, collect } = load(`<body><form>
    <label for="n">Display name</label><input id="n">
    <label><input type="checkbox" id="c"> Subscribe</label>
    <button type="button" id="s">Save changes</button></form><h1 id="h">Saved</h1></body>`);
  recorder.start(collect);
  type(w, doc.getElementById('n'), 'A');
  type(w, doc.getElementById('n'), 'Ada');
  const c = doc.getElementById('c'); c.checked = true; c.dispatchEvent(new w.Event('change', { bubbles: true }));
  click(w, doc.getElementById('s'));
  recorder.stop();

  const acted = steps.filter((s) => s.type === 'input' || (s.type === 'click' && s.tag === 'button'));
  assert.equal(acted.length, 3);
  for (const s of acted) assert.ok(s.locator, `step ${s.type} has a locator`);
  assert.deepEqual(acted[0].locator, { by: 'role', role: 'textbox', name: 'Display name' });
  assert.equal(acted[0].value, 'Ada', 'coalesced typing keeps one step and its locator');

  const semantic = require('../../src/webview/semantic-locator');
  const assertStep = { type: 'assert', kind: 'visible', selector: '#h', locator: semantic.locatorFor(doc.getElementById('h'), { action: false }) };
  const migrated = wf.recordingToWorkflow({ name: 'Save profile', startUrl: 'https://example.test/page/index.html', steps: [...acted, assertStep] },
    { skillId: 'verify-journey', version: '1.0.0', maxDurationMs: 60000 });
  assert.equal(migrated.ok, true, JSON.stringify(migrated.refused));
  const types = migrated.plan.steps.map((s) => s.type);
  assert.deepEqual(types, ['navigate', 'fill', 'check', 'click', 'assert']);
  assert.deepEqual(migrated.plan.steps[3].target, { by: 'role', role: 'button', name: 'Save changes' });
});

test('the same recording without locators is still refused, step by step', () => {
  const migrated = wf.recordingToWorkflow({ name: 'x', startUrl: 'https://example.test/', steps: [
    { type: 'click', selector: 'div.card > span:nth-of-type(2)', tag: 'span', text: 'Open' },
    { type: 'assert', kind: 'exists', selector: '#h' }] }, { skillId: 'verify-journey', version: '1.0.0' });
  assert.equal(migrated.ok, false);
  assert.ok(migrated.refused.every((r) => r.code === 'NO_SEMANTIC_LOCATOR'));
});

test('a secret field still records no value, and its locator is only its label', () => {
  const { w, doc, recorder, steps, collect } = load('<body><label for="pw">Password</label><input id="pw" type="password"></body>');
  recorder.start(collect);
  type(w, doc.getElementById('pw'), 'S3cr3t-Pa55w0rd!xyz');
  recorder.stop();
  assert.equal(steps.length, 1);
  assert.equal('value' in steps[0], false);
  assert.deepEqual(steps[0].locator, { by: 'role', role: 'textbox', name: 'Password' });
  assert.ok(!JSON.stringify(steps).includes('S3cr3t'));
});

test('a label click is marked and dropped by the migration; the control click carries the action', () => {
  const { w, doc, recorder, steps, collect } = load('<body><label id="l"><input type="checkbox" id="c"> Subscribe</label><h1>Prefs</h1></body>');
  recorder.start(collect);
  click(w, doc.getElementById('l'));
  recorder.stop();
  const label = steps.find((s) => s.type === 'click' && s.tag === 'label');
  assert.equal(label.via, 'label');
  assert.equal(label.locator, undefined);
  const migrated = wf.recordingToWorkflow({ name: 'x', startUrl: 'https://example.test/', steps: [
    label, { type: 'click', selector: '#c', locator: { by: 'role', role: 'checkbox', name: 'Subscribe' } },
    { type: 'assert', kind: 'exists', selector: 'h1', locator: { by: 'role', role: 'heading', name: 'Prefs' } }] },
  { skillId: 'verify-journey', version: '1.0.0' });
  assert.equal(migrated.ok, true, JSON.stringify(migrated.refused));
  assert.deepEqual(migrated.plan.steps.map((s) => s.type), ['navigate', 'click', 'assert']);
  assert.equal(migrated.dropped.length, 1);
});
