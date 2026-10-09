import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMcpReceipt, ReceiptScopeError } from '../../../src/main/services/automation/receipt.mjs';
import { receiptSchema } from '../../../src/main/services/automation/schemas.mjs';

const persisted = (over = {}) => ({ uri: 'braiwser://runs/run_1/operations/op_1', operationId: 'op_1', sessionId: 'bs_1', pageId: 'pg_1',
  afterObservationId: 'ob_2', ...over });
const kernel = (status, over = {}) => ({ operationId: 'op_1', sessionId: 'bs_1', pageId: 'pg_1', status, ...over });

test('verified is the only status with effectUnknown false', () => {
  for (const [status, dispatched, unknown] of [['not_attempted', false, false], ['dispatched', true, true], ['verified', true, false], ['uncertain', true, true]]) {
    const r = toMcpReceipt(kernel(status), persisted());
    assert.equal(r.dispatched, dispatched, status);
    assert.equal(r.effectUnknown, unknown, status);
    assert.doesNotThrow(() => receiptSchema.parse(r));
  }
});

test('code defaults: OK only for verified, otherwise OUTCOME_NOT_VERIFIED', () => {
  assert.equal(toMcpReceipt(kernel('verified'), persisted()).code, 'OK');
  assert.equal(toMcpReceipt(kernel('dispatched'), persisted()).code, 'OUTCOME_NOT_VERIFIED');
  assert.equal(toMcpReceipt(kernel('uncertain', { code: 'TIMEOUT_AFTER_DISPATCH' }), persisted()).code, 'TIMEOUT_AFTER_DISPATCH');
});

test('afterObservationId is optional and defaults to null', () => {
  assert.equal(toMcpReceipt(kernel('verified'), persisted({ afterObservationId: undefined })).afterObservationId, null);
});

test('scope or evidence mismatches throw instead of fabricating a verified result', () => {
  const bad = [
    persisted({ operationId: 'op_other' }), persisted({ sessionId: 'bs_other' }), persisted({ pageId: 'pg_other' }),
    persisted({ uri: 'https://example.test/evidence' }), persisted({ uri: undefined }), null, undefined,
  ];
  for (const p of bad) assert.throws(() => toMcpReceipt(kernel('verified'), p), ReceiptScopeError);
  assert.throws(() => toMcpReceipt(kernel('success'), persisted()), ReceiptScopeError, 'unknown status is refused');
  assert.throws(() => toMcpReceipt(null, persisted()), ReceiptScopeError);
});

test('kernel-supplied dispatched/effectUnknown flags are ignored: the status decides', () => {
  const r = toMcpReceipt(kernel('dispatched', { dispatched: false, effectUnknown: false }), persisted());
  assert.equal(r.dispatched, true);
  assert.equal(r.effectUnknown, true);
});
