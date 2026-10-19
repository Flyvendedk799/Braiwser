// Wire schemas shared by the MCP adapter and the CLI. Everything is strict:
// unknown keys are rejected on input, and every output is projected into these
// shapes (never passed through) so a broker/page field cannot leak by accident.
import { z } from 'zod';
import core from './workflow-core.js';

export const SCHEMA_VERSION = 1;
export const CAPABILITY_VERSION = '1.1.0';
export const closeResultSchema = z.strictObject({ closed: z.literal(true) });
export const DEFAULT_RESPONSE_BUDGET = 64 * 1024; // bytes; audit target

export const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/, 'Invalid identifier');
const page = { sessionId: id, pageId: id };
const nonneg = z.number().int().nonnegative();
const uri = z.string().regex(/^braiwser:\/\/[\x21-\x7e]+$/, 'Expected a braiwser:// URI').max(400);
export const cursor = z.string().regex(/^[\x21-\x7e]{1,512}$/, 'Invalid cursor');

export const ERROR_CODES = ['STALE_REF', 'AMBIGUOUS_TARGET', 'DENIED', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED', 'UNAVAILABLE', 'INTERNAL'];
export const RETRY = ['refresh', 'safe-read', 'after-approval', 'never'];

export const errorSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string().max(500),
  dispatched: z.boolean(),
  effectUnknown: z.boolean(),
  retry: z.enum(RETRY),
});

export const LIFECYCLE = ['queued', 'running', 'needsApproval', 'needsHuman', 'passed', 'failed',
  'cancelled', 'timedOut', 'uncertain', 'interrupted'];
export const VERDICTS = ['pending', 'passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown'];
export const TERMINAL_STATES = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted']);

export const runSchema = z.strictObject({
  runId: id,
  state: z.enum(LIFECYCLE),
  verdict: z.enum(VERDICTS),
  sequence: nonneg,
  cancelRequested: z.boolean(),
  planned: nonneg, executed: nonneg, passed: nonneg, skipped: nonneg, cancelled: nonneg, timedOut: nonneg,
  evidenceComplete: z.boolean(),
  uncertainEffect: z.boolean(),
  requiredAssertions: nonneg,
  passedAssertions: nonneg,
  deadlineAt: z.iso.datetime({ offset: true }),
  pending: nonneg, failed: nonneg, unknown: nonneg,
  events: z.array(z.strictObject({
    sequence: z.number().int(), stepId: id.optional(),
    kind: z.string().max(80), summary: z.string().max(300),
  })).max(100),
  nextSequence: nonneg,
  manifestUri: uri,
});

export const coverageSchema = z.record(z.string().max(60), z.union([z.number(), z.boolean(), z.string().max(200)]));

// Bounded structure payloads of table/grid and list nodes (see drivers/observe.js). A cell is text, '' (empty) or
// null (withheld: secret-looking column or control). Page text: untrusted like every other node name.
const structCell = z.string().max(100).nullable();
export const tableSchema = z.strictObject({
  rowCount: nonneg, rowsExact: z.boolean(), columnCount: nonneg, hasHeader: z.boolean(),
  headers: z.array(z.string().max(100)).max(12),
  cells: z.array(z.array(structCell).max(12)).max(50),
  truncated: z.strictObject({ rows: z.boolean(), columns: z.boolean(), cells: nonneg }),
  merged: z.boolean(), withheld: z.array(z.number().int().min(0).max(11)).max(12),
});
export const listSchema = z.strictObject({
  ordered: z.boolean(), itemCount: nonneg, itemsExact: z.boolean(), items: z.array(structCell).max(30),
  truncated: z.strictObject({ items: z.boolean(), cells: nonneg }),
});
export const nodeSchema = z.strictObject({
  ref: id, role: z.string().max(80), name: z.string().max(200),
  enabled: z.boolean().optional(), editable: z.boolean().optional(), frameId: id.optional(),
  table: tableSchema.optional(), list: listSchema.optional(),
});
// Next / previous page controls, found by accessible name only; they are ordinary refs from the same observation.
const pageLink = z.strictObject({ ref: id, name: z.string().max(200), enabled: z.boolean() });
export const paginationSchema = z.strictObject({
  next: pageLink.optional(), prev: pageLink.optional(), ambiguous: z.array(z.enum(['next', 'prev'])).max(2).optional(),
});

export const observationSchema = z.strictObject({
  ...page, observationId: id, documentEpoch: nonneg,
  url: z.string().max(2000),
  nodes: z.array(nodeSchema).max(200),
  coverage: coverageSchema,
  pagination: paginationSchema.optional(),
  truncated: z.boolean(),
  nextCursor: cursor.nullable(),
  trust: z.literal('untrusted-page'),
  evidenceUri: uri,
});

const ACT_KEYS = core.KEYS;
export const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), ref: id }),
  // Text fills only. There is no secret form of fill: password/OTP/payment
  // targets are rejected by the broker at dispatch, and unknown keys (such as
  // `secret`) are rejected here.
  z.strictObject({ kind: z.literal('fill'), ref: id, text: z.string().max(10000) }),
  z.strictObject({ kind: z.literal('press'), ref: id, key: z.enum(ACT_KEYS) }),
  z.strictObject({ kind: z.literal('select'), ref: id, value: z.string().max(1000) }),
  z.strictObject({ kind: z.literal('check'), ref: id, checked: z.boolean() }),
  // Emulated window size. Changes the document epoch: observe again afterwards.
  z.strictObject({ kind: z.literal('setViewport'), width: z.number().int().min(240).max(4096), height: z.number().int().min(240).max(4096) }),
  z.strictObject({ kind: z.literal('navigate'), url: z.string().max(2000).url().refine((v) => {
    try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; }
    catch { return false; }
  }, 'Only http(s) URLs without credentials') }),
]);

export const receiptSchema = z.strictObject({
  operationId: id,
  status: z.enum(['not_attempted', 'dispatched', 'verified', 'uncertain']),
  ...page,
  code: z.string().max(80),
  dispatched: z.boolean(),
  effectUnknown: z.boolean(),
  afterObservationId: id.nullable(),
  evidenceUri: uri,
});

const jsonRecord = z.record(z.string().max(80), z.unknown()).refine(
  (v) => JSON.stringify(v).length <= 8192, 'Too large');

export const sessionSchema = z.strictObject({ ...page, capabilities: jsonRecord, limits: jsonRecord });

export const extractFieldInput = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
  target: z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('ref'), ref: id }),
    z.strictObject({ by: z.literal('role'), role: z.string().min(1).max(80), name: z.string().min(1).max(200) }),
  ]),
  required: z.boolean().default(true),
});

export const extractSchema = z.strictObject({
  ...page, observationId: id, documentEpoch: nonneg,
  trust: z.literal('untrusted-page'),
  complete: z.boolean(),
  truncated: z.boolean(),
  fields: z.array(z.strictObject({
    name: z.string().max(40),
    status: z.enum(['found', 'missing', 'ambiguous']),
    required: z.boolean(),
    value: z.string().max(2000).nullable(),
    valueTruncated: z.boolean(),
    source: z.strictObject({ ref: id, role: z.string().max(80), observationId: id }).nullable(),
    reason: z.string().max(80).nullable(),
  })).max(40),
  evidenceUri: uri,
});

export const handoffSchema = z.strictObject({
  ...page,
  owner: z.string().max(40),
  documentEpoch: nonneg,
  method: z.enum(['native', 'remote-view', 'checkpoint-relaunch', 'unsupported']),
  userAction: z.string().max(400),
  handoffId: id.optional(),
  state: z.enum(['pausing', 'paused', 'human', 'quarantined', 'closed', 'readyToResume']).optional(),
  controlOwner: z.string().max(40).optional(),
  controlEpoch: nonneg.optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  viewerUrl: z.string().max(400).nullable().optional(),
  nextSequence: nonneg.optional(),
  resumeEligible: z.boolean().optional(),
  blocker: z.string().max(80).nullable().optional(),
  events: z.array(z.strictObject({
    sequence: z.number().int(), kind: z.string().max(80), summary: z.string().max(300),
  })).max(100).optional(),
});

export const pauseResultSchema = z.strictObject({
  runId: id,
  sessionId: id,
  state: z.enum(['pausing', 'paused', 'quarantined']),
  controlEpoch: nonneg,
  affectedRunIds: z.array(id).max(50),
});

export const resumeResultSchema = z.strictObject({
  handoffId: id,
  runId: id.nullable(),
  controlOwner: z.literal('agent'),
  controlEpoch: nonneg,
  requireFreshObservation: z.literal(true),
  resumed: z.literal(true),
});

// ---- tool inputs -----------------------------------------------------------

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
// A grant REQUEST. The broker intersects it with the authenticated principal's
// scope ceiling (what the human allowed this client); asking for more than the
// ceiling is silently narrowed or denied, never honoured. The request cannot
// name file roots, fixtures that skip approvals, or the credentials / download /
// upload / preview-edit tool classes: those are not requestable over MCP.
const originPattern = z.string().regex(/^https?:\/\/[^\s/?#]{1,250}$/, 'Expected a bare http(s) origin');
export const grantRequest = z.strictObject({
  allowedOrigins: z.array(originPattern).max(20).optional(),
  toolClasses: z.array(z.enum(['observe', 'navigate', 'interact', 'submit'])).max(4).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  projectId: id.optional(),
  budgets: z.strictObject({
    maxActions: nonneg.optional(), maxObservations: nonneg.optional(),
    maxNavigations: nonneg.optional(), maxDurationMs: nonneg.optional(),
  }).optional(),
});

export const inputs = {
  browser_session_open: z.strictObject({
    driver: z.enum(['playwright', 'electron-embedded']),
    mode: z.enum(['headless', 'visible']),
    profile: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
    reviewSessionId: id.optional(),
    grant: grantRequest,
  }),
  browser_session_close: z.strictObject({ sessionId: id }),
  browser_observe: z.strictObject({
    ...page, maxNodes: z.number().int().min(1).max(200).default(80),
    focus: z.string().max(200).optional(), cursor: cursor.optional(),
  }),
  browser_act: z.strictObject({
    ...page, runId: id.optional(), observationId: id, documentEpoch: nonneg, operationId: id,
    approvalId: id.optional(), action: actionSchema,
  }),
  browser_extract: z.strictObject({
    ...page, observationId: id.optional(), documentEpoch: nonneg.optional(),
    focus: z.string().max(200).optional(),
    fields: z.array(extractFieldInput).min(1).max(40),
  }).superRefine((v, ctx) => {
    const names = v.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Duplicate field name' });
  }),
  browser_run: z.strictObject({
    ...page, requestKey: id,
    skillId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64),
    skillVersion: semver,
    skillDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    maxDurationMs: z.number().int().min(1000).max(300000).default(120000),
    inputs: z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 16384, 'Inputs too large'),
  }),
  browser_run_status: z.strictObject({
    runId: id, afterSequence: nonneg.default(0), maxEvents: z.number().int().min(1).max(100).default(30),
  }),
  browser_run_cancel: z.strictObject({ runId: id }),
  browser_handoff: z.strictObject({
    ...page, runId: id.optional(), reason: z.string().min(1).max(300),
    requestKey: id.optional(),
    reasonCode: z.enum(['needsHuman', 'userRequested', 'approval', 'privateInput', 'other']).optional(),
  }),
  browser_run_pause: z.strictObject({
    runId: id, requestKey: id, expectedControlEpoch: nonneg, reason: z.string().max(300).optional(),
  }),
  browser_handoff_status: z.strictObject({
    handoffId: id, afterSequence: nonneg.default(0), maxEvents: z.number().int().min(1).max(100).default(30),
  }),
  browser_run_resume: z.strictObject({
    runId: id.optional(), handoffId: id, expectedControlEpoch: nonneg, requestKey: id,
  }),
};

// ---- run consistency -------------------------------------------------------

// Lifecycle -> verdict mapping from the audit. A run DTO that violates it is a
// broker/adapter bug, never a result to relay.
export function verdictConsistent(run) {
  switch (run.state) {
    case 'queued': case 'running': case 'needsApproval': case 'needsHuman': return run.verdict === 'pending';
    case 'uncertain': case 'interrupted': return run.verdict === 'unknown';
    case 'cancelled': return run.verdict === 'cancelled';
    case 'timedOut': return run.verdict === 'timedOut';
    case 'failed': return run.verdict === 'failed';
    case 'passed': return run.verdict === 'passed';
    default: return false;
  }
}

// The only way a run may be reported as passed (audit "Proof contract").
export function isProvenPass(s) {
  return s.state === 'passed' && s.verdict === 'passed' && s.evidenceComplete === true && s.uncertainEffect === false
    && s.requiredAssertions > 0 && s.passedAssertions === s.requiredAssertions
    && s.planned > 0 && s.executed === s.planned && s.passed === s.planned
    && s.failed === 0 && s.skipped === 0 && s.pending === 0 && s.unknown === 0
    && s.cancelled === 0 && s.timedOut === 0;
}

export function envelope(valueSchema) {
  return z.strictObject({ ok: z.boolean(), value: valueSchema.nullable(), error: errorSchema.nullable() })
    .refine((v) => (v.ok ? v.value !== null && v.error === null : v.value === null && v.error !== null),
      'ok must pair with value, !ok with error');
}
