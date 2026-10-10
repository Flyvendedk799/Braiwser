import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStructureResult, describeDroppedHistory } from '../../../src/renderer/controllers/guest-feedback.js';

test('applied move refreshes quietly', () => {
  assert.deepEqual(describeStructureResult({ ok: true }), { refresh: true, toast: null });
  assert.deepEqual(describeStructureResult(null), { refresh: false, toast: null });
});

test('lost identity warns and refreshes', () => {
  const r = describeStructureResult({ op: 'move-into', ok: false, reason: 'source-not-found' });
  assert.equal(r.refresh, true);
  assert.match(r.toast.text, /Could not move/);
  assert.match(r.toast.text, /refreshed/);
});

test('no-change is silent but resyncs; unknown reasons are shown verbatim', () => {
  assert.deepEqual(describeStructureResult({ ok: false, reason: 'no-change' }), { refresh: true, toast: null });
  assert.match(describeStructureResult({ op: 'reorder', ok: false, reason: 'weird' }).toast.text, /weird/);
});

test('dropped history reports only the newly lost entries', () => {
  assert.equal(describeDroppedHistory({ dropped: 0 }, 0).toast, null);
  const a = describeDroppedHistory({ dropped: 3 }, 0);
  assert.equal(a.dropped, 3);
  assert.match(a.toast.text, /^3 older page edits/);
  const b = describeDroppedHistory({ dropped: 4 }, 3);
  assert.match(b.toast.text, /^1 older page edit /);
  assert.equal(describeDroppedHistory({ dropped: 2 }, 3).toast, null);
});
