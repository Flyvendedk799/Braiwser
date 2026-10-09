'use strict';
// Inspector <-> recorder/replay wiring.

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');

test('wiring: recorder protocol is attached and the new document announces itself inactive', async () => {
  const h = await loadInspector({ html: '<button id="b">B</button>' });
  try {
    for (const ch of ['caos:start-recording', 'caos:stop-recording', 'caos:recording-status']) {
      assert.ok(h.ipc.hasHandler(ch), ch);
    }
    const first = h.ipc.sent('caos:recording-status')[0];
    assert.ok(first, 'document-ready status');
    assert.strictEqual(first.active, false);
    h.ipc.emit('caos:start-recording', { recordingId: 'rec1', ownerTabId: 't1' });
    assert.strictEqual(h.ipc.last('caos:recording-status').active, true);
    h.ipc.emit('caos:stop-recording');
    assert.strictEqual(h.ipc.last('caos:recording-status').active, false);
  } finally {
    h.dispose();
  }
});

test('wiring: replay ack forwards the whole executeStep result and correlation ids', async () => {
  const h = await loadInspector({ html: '<button id="b">B</button>' });
  try {
    h.ipc.emit('caos:replay-step', { step: { type: 'bogus' }, index: 3, runId: 'r9', stepIndex: 2, opts: { fast: true } });
    await new Promise((r) => setTimeout(r, 20));
    const ack = h.ipc.last('caos:replay-ack');
    assert.strictEqual(ack.index, 3);
    assert.strictEqual(ack.runId, 'r9');
    assert.strictEqual(ack.stepIndex, 2);
    assert.strictEqual(ack.ok, false);
    assert.ok('status' in ack, 'status is forwarded: ' + JSON.stringify(ack));

    h.ipc.emit('caos:replay-step', { step: { type: 'navigate', url: 'x' }, index: 4, opts: { fast: true } });
    await new Promise((r) => setTimeout(r, 20));
    const nav = h.ipc.last('caos:replay-ack');
    assert.strictEqual(nav.status, 'skipped');
    assert.strictEqual(nav.effect, 'none');
  } finally {
    h.dispose();
  }
});
