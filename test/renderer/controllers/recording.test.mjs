import test from 'node:test';
import assert from 'node:assert/strict';
import * as rc from '../../../src/renderer/controllers/recording-controller.js';

function world() {
  const sent = [];
  const send = (tab, channel, payload) => sent.push([tab.id, channel, payload]);
  const A = { id: 'A' }; const B = { id: 'B' };
  return { sent, send, A, B, tabs: [A, B] };
}

test('RF-02: start arms the owner with recordingId + ownerTabId', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'http://a/', ownerTabId: 'A' });
  assert.ok(rc.arm(buf, w.A, w.send));
  assert.deepEqual(w.sent[0], ['A', 'caos:start-recording', { recordingId: buf.recordingId, ownerTabId: 'A' }]);
  assert.equal(buf.steps[0].type, 'navigate');
});

test('RF-02: every new document of the owner is re-armed on dom-ready (idempotent protocol)', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'http://a/', ownerTabId: 'A' });
  rc.arm(buf, w.A, w.send);
  w.sent.length = 0;
  rc.onDomReady(buf, w.A, w.send); // document 2
  rc.onDomReady(buf, w.A, w.send); // document 3
  assert.equal(w.sent.filter(([, c]) => c === 'caos:start-recording').length, 2);
  assert.ok(w.sent.every(([id, , p]) => id === 'A' && p.recordingId === buf.recordingId));
});

test('RF-02: non-owner dom-ready never arms another tab', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'x', ownerTabId: 'A' });
  assert.equal(rc.onDomReady(buf, w.B, w.send), false);
  assert.equal(w.sent.length, 0);
});

test('RF-02: guest status active:false re-arms (bounded), active:true does not', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'x', ownerTabId: 'A' });
  assert.equal(rc.onStatus(buf, w.A, { active: true }, w.send), false);
  let rearmed = 0;
  for (let i = 0; i < 6; i++) if (rc.onStatus(buf, w.A, { active: false, reason: 'document-ready' }, w.send)) rearmed++;
  assert.equal(rearmed, 3, 'retries are bounded so a broken guest cannot loop');
  rc.onDomReady(buf, w.A, w.send); // a fresh document restores the budget
  assert.equal(rc.onStatus(buf, w.A, { active: false }, w.send), true);
});

test('RF-02: only the owner tab contributes steps', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'http://a/', ownerTabId: 'A' });
  assert.equal(rc.accepts(buf, w.A), true);
  assert.equal(rc.accepts(buf, w.B), false);
  assert.equal(rc.pushNavigation(buf, w.B, 'http://b/'), false);
  assert.equal(rc.pushNavigation(buf, w.A, 'http://a/next'), true);
  assert.equal(rc.pushNavigation(buf, w.A, 'http://a/next'), false, 'deduped');
});

test('RF-02: tab switch then stop stops EVERY armed guest, not just the front one', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'x', ownerTabId: 'A' });
  rc.arm(buf, w.A, w.send);
  w.sent.length = 0;
  const stopped = rc.stopAll(buf, w.tabs, w.send);
  assert.deepEqual(stopped, ['A']);
  assert.deepEqual(w.sent, [['A', 'caos:stop-recording', undefined]]);
  assert.equal(buf.armed.size, 0);
});

test('stop skips tabs that were closed (not in the list)', () => {
  const w = world();
  const buf = rc.createRecordingBuffer({ startUrl: 'x', ownerTabId: 'A' });
  rc.arm(buf, w.A, w.send);
  assert.deepEqual(rc.stopAll(buf, [w.B], w.send), []);
});

test('steps: stale recordingId and re-sent (documentId,generation,seq) are dropped; stamps are stripped', () => {
  const buf = rc.createRecordingBuffer({ startUrl: 'http://a/', ownerTabId: 'A' });
  const base = { documentId: 'd1', recordingId: buf.recordingId, ownerTabId: 'A', generation: 1 };
  const s1 = rc.pushGuestStep(buf, { ...base, seq: 1, type: 'click', selector: '#a' });
  assert.deepEqual(Object.keys(s1).sort(), ['selector', 'type']);
  assert.equal(rc.pushGuestStep(buf, { ...base, seq: 1, type: 'click', selector: '#a' }), null);
  assert.equal(rc.pushGuestStep(buf, { ...base, recordingId: 'old', seq: 2, type: 'click' }), null);
  assert.equal(buf.steps.length, 2);
});

test('steps from a SECOND document (post-navigation typing, click, scroll) are kept in order', () => {
  const buf = rc.createRecordingBuffer({ startUrl: 'http://a/', ownerTabId: 'A' });
  const st = (documentId, seq, extra) => ({ documentId, recordingId: buf.recordingId, generation: 1, seq, ...extra });
  rc.pushGuestStep(buf, st('d1', 1, { type: 'click', selector: '#link' }));
  rc.pushNavigation(buf, { id: 'A' }, 'http://a/two');
  rc.pushGuestStep(buf, st('d2', 1, { type: 'input', selector: '#q', value: 'h' }));
  rc.pushGuestStep(buf, st('d2', 2, { type: 'input', selector: '#q', value: 'hi', replaceLast: true }));
  rc.pushGuestStep(buf, st('d2', 3, { type: 'click', selector: '#go' }));
  rc.pushGuestStep(buf, st('d2', 4, { type: 'scroll', x: 0, y: 300 }));
  assert.deepEqual(buf.steps.map((s) => s.type), ['navigate', 'click', 'navigate', 'input', 'click', 'scroll']);
  assert.equal(buf.steps[3].value, 'hi');
});
