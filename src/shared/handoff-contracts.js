// Handoff protocol v2. Shared by the broker, the viewer gateway and the MCP
// projection. Possession of an id is not authorization. Pure CommonJS.
'use strict';

const PROTOCOL_VERSION = 2;
const CONTROL_STATES = Object.freeze(['agent', 'pausing', 'paused', 'human', 'quarantined', 'closed']);
const HANDOFF_STATES = Object.freeze(['pausing', 'paused', 'human', 'quarantined', 'closed', 'readyToResume']);
const V2_ERRORS = Object.freeze([
  'UNSUPPORTED_HANDOFF', 'VIEWER_UNREACHABLE', 'CONTROL_BUSY', 'STALE_CONTROL_EPOCH',
  'ACCESS_EXPIRED', 'ACCESS_REVOKED', 'IN_FLIGHT_UNSETTLED', 'RECONCILIATION_REQUIRED',
  'PRIVATE_INPUT_ACTIVE', 'RESUME_NOT_AUTHORIZED', 'IDEMPOTENCY_CONFLICT',
]);
// Closed MCP vocabulary. Rich v2 codes travel in the message prefix.
const PUBLIC_FOR = Object.freeze({
  UNSUPPORTED_HANDOFF: 'UNSUPPORTED',
  VIEWER_UNREACHABLE: 'UNAVAILABLE',
  CONTROL_BUSY: 'DENIED',
  STALE_CONTROL_EPOCH: 'DENIED',
  ACCESS_EXPIRED: 'DENIED',
  ACCESS_REVOKED: 'DENIED',
  IN_FLIGHT_UNSETTLED: 'UNAVAILABLE',
  RECONCILIATION_REQUIRED: 'DENIED',
  PRIVATE_INPUT_ACTIVE: 'DENIED',
  RESUME_NOT_AUTHORIZED: 'DENIED',
  IDEMPOTENCY_CONFLICT: 'DENIED',
});

const REASON_CODES = Object.freeze(['needsHuman', 'userRequested', 'approval', 'privateInput', 'other']);

function v2Error(code, message, extra = {}) {
  const v2 = V2_ERRORS.includes(code) ? code : 'UNSUPPORTED_HANDOFF';
  const publicCode = PUBLIC_FOR[v2] || 'INTERNAL';
  const err = new Error(`${v2}: ${message}`);
  err.v2Code = v2;
  err.code = v2;
  err.publicError = {
    code: publicCode,
    message: `${v2}: ${message}`.slice(0, 500),
    dispatched: extra.dispatched === true,
    effectUnknown: extra.effectUnknown === true,
    retry: 'never',
  };
  return err;
}

// A loopback URL is reachable by a person on this machine. A remote deployment
// must name a non-loopback https origin; returning localhost there is a bug.
function viewerUrlAllowed(baseUrl, deployment) {
  let url;
  try { url = new URL(baseUrl); } catch { return { ok: false, code: 'VIEWER_UNREACHABLE' }; }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (deployment === 'remote') {
    if (loopback || url.protocol !== 'https:') return { ok: false, code: 'VIEWER_UNREACHABLE' };
  } else if (!loopback && url.protocol !== 'https:') {
    return { ok: false, code: 'VIEWER_UNREACHABLE' };
  }
  return { ok: true, url };
}

module.exports = {
  PROTOCOL_VERSION, CONTROL_STATES, HANDOFF_STATES, V2_ERRORS, PUBLIC_FOR, REASON_CODES,
  v2Error, viewerUrlAllowed,
};
