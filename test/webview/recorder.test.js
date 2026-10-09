'use strict';
// CE-01 (guest side): the recorder never reads or emits a secret field's value.
// RF-02 (guest side): idempotent start, status query, per-document ids, clean stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('./_dom');

const SECRET = 'S3cr3t-Pa55w0rd!xyz';

function load(html) {
  const d = dom.install(html);
  // A fresh document gets a fresh preload: drop the module cache like Electron does.
  for (const k of Object.keys(require.cache)) {
    if (/src[\\/]webview[\\/](recorder|anchor|cursor|secret-field)\.js$/.test(k)) delete require.cache[k];
  }
  const recorder = require('../../src/webview/recorder');
  const steps = [];
  return { d, w: d.window, doc: d.window.document, recorder, steps, collect: (s) => steps.push(s) };
}

function type(w, el, value, evt = 'input') {
  el.value = value;
  el.dispatchEvent(new w.Event(evt, { bubbles: true }));
}

test.afterEach(() => {
  try { require('../../src/webview/recorder').stop(); } catch (_e) { /* ignore */ }
  dom.uninstall();
});

// ---- CE-01 --------------------------------------------------------------------------
test('password field: type, edit, blur -> no value anywhere, secret flag and placeholder', () => {
  const { w, doc, recorder, steps, collect } = load('<body><form><input id="pw" type="password" name="pw"></form></body>');
  recorder.start(collect);
  const pw = doc.getElementById('pw');
  type(w, pw, 'S');
  type(w, pw, SECRET);
  type(w, pw, SECRET.slice(0, -2));
  pw.dispatchEvent(new w.Event('change', { bubbles: true }));
  pw.dispatchEvent(new w.Event('blur'));
  assert.ok(steps.length >= 1);
  for (const s of steps) {
    assert.equal(s.type, 'input');
    assert.equal(s.secret, true);
    assert.equal(s.control, 'secret');
    assert.equal(s.placeholder, '{{secret}}');
    assert.equal('value' in s, false);
  }
  assert.ok(!JSON.stringify(steps).includes('S3cr3t'));
  assert.ok(!JSON.stringify(steps).includes(SECRET.slice(0, 6)));
  assert.equal(steps.some((s) => s.replaceLast), false, 'coalescing path emits nothing for a secret');
});

test('the value of a secret field is never even read', () => {
  const { w, doc, recorder, steps, collect } = load('<body><input id="pw" type="password"></body>');
  const pw = doc.getElementById('pw');
  let reads = 0;
  Object.defineProperty(pw, 'value', { get() { reads++; return SECRET; }, set() {}, configurable: true });
  recorder.start(collect);
  pw.dispatchEvent(new w.Event('input', { bubbles: true }));
  pw.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(reads, 0);
  assert.equal(steps.length >= 1, true);
});

test('credential-like fields are secret by autocomplete token, name hint or label', () => {
  const { w, doc, recorder, steps, collect } = load(`<body>
    <input id="a" autocomplete="cc-number">
    <input id="b" autocomplete="one-time-code">
    <input id="c" autocomplete="new-password">
    <input id="d" autocomplete="current-password">
    <input id="e" name="otp_code">
    <input id="f" name="loginPassword" type="text">
    <input id="g" aria-label="Card number">
    <label for="h">Verification code</label><input id="h">
    <input id="i" name="cvv">
    <input id="j" data-testid="pin">
    <input id="ok" name="email" placeholder="Email address">
  </body>`);
  recorder.start(collect);
  for (const id of 'abcdefghij') type(w, doc.getElementById(id), 'v-' + id + SECRET);
  type(w, doc.getElementById('ok'), 'me@example.test');
  const secretSteps = steps.filter((s) => s.secret === true);
  assert.equal(secretSteps.length, 10);
  assert.ok(!JSON.stringify(steps).includes(SECRET));
  const ok = steps.find((s) => s.secret === false);
  assert.equal(ok.value, 'me@example.test');
  assert.equal(ok.control, 'text');
});

test('checkbox/radio named like a secret keep their boolean; non-secret text coalesces with value', () => {
  const { w, doc, recorder, steps, collect } = load('<body><input id="rp" type="checkbox" name="remember-password"><input id="q" name="q"></body>');
  recorder.start(collect);
  const rp = doc.getElementById('rp');
  rp.checked = true;
  rp.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(steps[0].value, true);
  assert.equal(steps[0].control, 'checkbox');

  const q = doc.getElementById('q');
  type(w, q, 'a');
  type(w, q, 'ab');
  const last = steps[steps.length - 1];
  assert.equal(last.replaceLast, true);
  assert.equal(last.value, 'ab');
});

test('select and multiselect record their control kind', () => {
  const { w, doc, recorder, steps, collect } = load(`<body>
    <select id="s"><option value="a">A</option><option value="b">B</option></select>
    <select id="m" multiple><option value="x">X</option><option value="y">Y</option></select></body>`);
  recorder.start(collect);
  const s = doc.getElementById('s');
  s.value = 'b';
  s.dispatchEvent(new w.Event('change', { bubbles: true }));
  const m = doc.getElementById('m');
  m.options[0].selected = true;
  m.options[1].selected = true;
  m.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(steps[0].control, 'select');
  assert.equal(steps[0].value, 'b');
  assert.equal(steps[1].control, 'multiselect');
  assert.deepEqual(steps[1].value, ['x', 'y']);
});

test('an Enter key step in a password field carries no description of its content', () => {
  const { w, doc, recorder, steps, collect } = load('<body><textarea id="t">preset-secret-text</textarea><input id="pw" type="password"></body>');
  recorder.start(collect);
  const pw = doc.getElementById('pw');
  pw.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  doc.getElementById('t').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(!JSON.stringify(steps).includes('preset-secret-text'));
});

// ---- RF-02 ---------------------------------------------------------------------------
test('a fresh document starts inactive with its own documentId', () => {
  const a = load('<body></body>');
  const idA = a.recorder.status().documentId;
  assert.equal(a.recorder.status().active, false);
  a.recorder.start(a.collect, { recordingId: 'r1', ownerTabId: 't1' });
  assert.equal(a.recorder.status().active, true);
  dom.uninstall();

  const b = load('<body></body>'); // new document => new preload
  const st = b.recorder.status();
  assert.equal(st.active, false);
  assert.equal(st.recordingId, null);
  assert.notEqual(st.documentId, idA);
});

test('start with the same recordingId is idempotent: no duplicate listeners or steps', () => {
  const { w, doc, recorder, steps, collect } = load('<body><button id="b">Go</button></body>');
  recorder.start(collect, { recordingId: 'r1', ownerTabId: 7 });
  const gen = recorder.status().generation;
  recorder.start(collect, { recordingId: 'r1', ownerTabId: 7 });
  recorder.start(collect, { recordingId: 'r1', ownerTabId: 7 });
  assert.equal(recorder.status().generation, gen);
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].recordingId, 'r1');
  assert.equal(steps[0].ownerTabId, 7);
  assert.equal(steps[0].documentId, recorder.status().documentId);
  assert.equal(steps[0].generation, gen);
  assert.equal(steps[0].seq, 1);
});

test('a different recordingId restarts cleanly; sequence restarts at 1', () => {
  const { w, doc, recorder, steps, collect } = load('<body><button id="b">Go</button></body>');
  recorder.start(collect, { recordingId: 'r1' });
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  recorder.start(collect, { recordingId: 'r2' });
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(steps.length, 2);
  assert.equal(steps[1].recordingId, 'r2');
  assert.equal(steps[1].seq, 1);
  assert.equal(steps[1].generation, steps[0].generation + 1);
});

test('legacy start(cb) without context still works and restarts', () => {
  const { w, doc, recorder, steps, collect } = load('<body><button id="b">Go</button></body>');
  recorder.start(collect);
  recorder.start(collect);
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(steps.length, 1);
});

test('stop removes every listener and cancels the pending scroll settle', async () => {
  const { w, doc, recorder, steps, collect } = load('<body><button id="b">Go</button><input id="i"></body>');
  recorder.start(collect, { recordingId: 'r1' });
  w.dispatchEvent(new w.Event('scroll'));
  w.dispatchEvent(new w.Event('scroll')); // second one arms the trailing settle timer
  const before = steps.length;
  const st = recorder.stop();
  assert.equal(st.active, false);
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  type(w, doc.getElementById('i'), 'late');
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(steps.length, before);
  assert.equal(recorder.status().recordingId, null);
});

test('pagehide flushes the resting scroll position', () => {
  const { w, recorder, steps, collect } = load('<body></body>');
  recorder.start(collect, { recordingId: 'r1' });
  w.dispatchEvent(new w.Event('scroll'));
  w.dispatchEvent(new w.Event('scroll'));
  assert.equal(steps.filter((s) => s.type === 'scroll').length, 1);
  w.dispatchEvent(new w.Event('pagehide'));
  assert.equal(steps.filter((s) => s.type === 'scroll').length, 2);
});

test('attachIpc: announces the new document, arms/stops/queries over the host protocol', () => {
  const { w, doc, recorder } = load('<body><button id="b">Go</button></body>');
  const handlers = {};
  const sent = [];
  const ipc = {
    on: (ch, fn) => { handlers[ch] = fn; },
    sendToHost: (ch, payload) => sent.push([ch, payload]),
  };
  recorder.attachIpc(ipc);
  assert.equal(sent[0][0], 'caos:recording-status');
  assert.equal(sent[0][1].active, false);
  assert.equal(sent[0][1].reason, 'document-ready');

  handlers['caos:start-recording']({}, { recordingId: 'rec-9', ownerTabId: 'tab-2' });
  let st = sent[sent.length - 1][1];
  assert.equal(st.active, true);
  assert.equal(st.recordingId, 'rec-9');
  assert.equal(st.ownerTabId, 'tab-2');

  // host re-sends on dom-ready of the same document: idempotent
  handlers['caos:start-recording']({}, { recordingId: 'rec-9', ownerTabId: 'tab-2' });
  doc.getElementById('b').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const recSteps = sent.filter(([ch]) => ch === 'caos:rec-step');
  assert.equal(recSteps.length, 1);
  assert.equal(recSteps[0][1].recordingId, 'rec-9');

  handlers['caos:recording-status']();
  assert.equal(sent[sent.length - 1][1].reason, 'query');
  assert.equal(sent[sent.length - 1][1].active, true);

  handlers['caos:stop-recording']();
  st = sent[sent.length - 1][1];
  assert.equal(st.active, false);
  assert.equal(st.reason, 'stop');
});
