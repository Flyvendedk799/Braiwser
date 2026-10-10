// Serialize the ownership kernel's internal receipt into the MCP wire DTO.
// `persisted` is the evidence-store receipt { uri, operationId, sessionId, pageId,
// afterObservationId? } that the broker committed (redacted, owner-scoped) BEFORE
// answering. A URI that did not come from the store, or a scope mismatch, throws:
// the caller must then report a classified uncertain error, never a verified
// result with a fabricated address.
export class ReceiptScopeError extends Error {
  constructor(message = 'Receipt/evidence scope mismatch') {
    super(message);
    this.name = 'ReceiptScopeError';
  }
}

const ALLOWED = new Set(['not_attempted', 'dispatched', 'verified', 'uncertain']);

export function toMcpReceipt(kernel, persisted) {
  if (!kernel || typeof kernel !== 'object' || !ALLOWED.has(kernel.status) ||
      typeof persisted?.uri !== 'string' || !persisted.uri.startsWith('braiwser://') ||
      persisted.operationId !== kernel.operationId ||
      persisted.sessionId !== kernel.sessionId || persisted.pageId !== kernel.pageId) {
    throw new ReceiptScopeError();
  }
  return {
    operationId: kernel.operationId, sessionId: kernel.sessionId, pageId: kernel.pageId,
    status: kernel.status,
    code: typeof kernel.code === 'string' && kernel.code
      ? kernel.code.slice(0, 80)
      : (kernel.status === 'verified' ? 'OK' : 'OUTCOME_NOT_VERIFIED'),
    dispatched: kernel.status !== 'not_attempted',
    // effectUnknown denotes "intended outcome not verified": a dispatched-only
    // receipt therefore stays true.
    effectUnknown: ['dispatched', 'uncertain'].includes(kernel.status),
    afterObservationId: persisted.afterObservationId || null,
    evidenceUri: persisted.uri,
  };
}
