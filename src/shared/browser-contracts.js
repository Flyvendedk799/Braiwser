// Shared contract for the agent browser runtime: enums, error codes, opaque ID
// generators, Zod-free input validators, the RunDTO builder and the public
// error builder. See docs/AGENT_RUNTIME_CONTRACT.md. Pure CommonJS.
'use strict';
const crypto = require('node:crypto');
const { redactText } = require('./browser-redact');

// ---- enums ----------------------------------------------------------------
const SCHEMA_VERSION = 1;
const PRINCIPAL_KINDS = Object.freeze(['ui', 'mcp', 'cli', 'skill']);
const DRIVER_NAMES = Object.freeze(['playwright', 'electron-embedded']);
const MODES = Object.freeze(['headless', 'visible']);
const ERROR_CODES = Object.freeze(['STALE_REF', 'AMBIGUOUS_TARGET', 'DENIED', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED', 'UNAVAILABLE', 'INTERNAL']);
const RETRY = Object.freeze(['refresh', 'safe-read', 'after-approval', 'never']);
const RECEIPT_STATUS = Object.freeze(['not_attempted', 'dispatched', 'verified', 'uncertain']);
const RUN_STATES = Object.freeze(['queued', 'running', 'needsApproval', 'needsHuman', 'passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted']);
const ACTIVE_STATES = Object.freeze(['queued', 'running', 'needsApproval', 'needsHuman']);
const TERMINAL_STATES = Object.freeze(['passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted']);
const VERDICTS = Object.freeze(['pending', 'passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);
const TOOL_CLASSES = Object.freeze(['observe', 'navigate', 'interact', 'submit', 'download', 'upload', 'credentials', 'preview-edit']);
const ACTION_KINDS = Object.freeze(['click', 'fill', 'press', 'select', 'check', 'navigate', 'setViewport']);
// Actions that address the page itself, not a ref from an observation.
const REFLESS_ACTIONS = Object.freeze(['navigate', 'setViewport']);
const VIEWPORT_MIN = 240;
const VIEWPORT_MAX = 4096;
const PRESS_KEYS = Object.freeze(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']);
const HANDOFF_METHODS = Object.freeze(['native', 'remote-view', 'checkpoint-relaunch', 'unsupported']);
const OWNERS = Object.freeze(['agent', 'handoff-pending', 'human', 'quarantined']);

const RUN_TRANSITIONS = Object.freeze({
  queued: ['running', 'cancelled', 'interrupted', 'failed', 'timedOut'],
  running: ['needsApproval', 'needsHuman', 'passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted'],
  needsApproval: ['running', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted'],
  needsHuman: ['running', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted'],
  passed: [], failed: [], cancelled: [], timedOut: [], uncertain: [], interrupted: [],
});
const canTransition = (from, to) => (RUN_TRANSITIONS[from] || []).includes(to);

// ---- ids -------------------------------------------------------------------
const ID_PREFIX = Object.freeze({
  session: 'bs', page: 'pg', run: 'run', operation: 'op', observation: 'ob', ref: 'r',
  approval: 'apr', artifact: 'art', cursor: 'cur', lease: 'ls', grant: 'gr',
  handoff: 'ho', viewer: 'vw', task: 'tk',
});
function newId(kind) {
  const prefix = ID_PREFIX[kind];
  if (!prefix) throw new TypeError(`unknown id kind: ${kind}`);
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}
// Server-minted ids only contain [A-Za-z0-9_-]; never used as a path unchecked.
const SERVER_ID = /^[a-z]{1,4}_[A-Za-z0-9_-]{6,64}$/;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const isServerId = (x) => typeof x === 'string' && SERVER_ID.test(x);
const isClientId = (x) => typeof x === 'string' && CLIENT_ID.test(x);

// ---- canonical json / digests ---------------------------------------------
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const canonicalJson = (v) => JSON.stringify(canonical(v));
const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonicalJson(v)).digest('hex');
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- errors -----------------------------------------------------------------
function brokerError(code, message, { dispatched = false, effectUnknown = false, retry = 'never', detail, extra } = {}) {
  const safe = ERROR_CODES.includes(code) ? code : 'INTERNAL';
  const err = new Error(String(message));
  err.code = detail || safe;
  err.publicError = { code: safe, message: redactText(String(message), 500), dispatched: !!dispatched, effectUnknown: !!effectUnknown, retry: RETRY.includes(retry) ? retry : 'never' };
  if (extra) Object.assign(err, extra);
  return err;
}
const invalid = (msg) => brokerError('DENIED', `INVALID_INPUT: ${msg}`, { detail: 'INVALID_INPUT' });

// Maps kernel / driver / internal codes to the closed public vocabulary.
const CODE_MAP = {
  STALE_DOCUMENT: ['STALE_REF', 'refresh'], STALE_REF: ['STALE_REF', 'refresh'],
  AMBIGUOUS_TARGET: ['AMBIGUOUS_TARGET', 'refresh'],
  OWNERSHIP_LOST: ['DENIED', 'refresh'], PAGE_QUARANTINED: ['DENIED', 'never'],
  RECONCILE_BEFORE_HANDOFF: ['DENIED', 'never'], NOT_HANDOFF_READY: ['DENIED', 'never'],
  IDEMPOTENCY_CONFLICT: ['DENIED', 'never'], IDEMPOTENCY_IN_FLIGHT: ['DENIED', 'never'], WRONG_SCOPE: ['DENIED', 'never'],
  DEADLINE_EXCEEDED: ['TIMEOUT', 'never'], TIMEOUT: ['TIMEOUT', 'never'],
  CANCELLED: ['CANCELLED', 'never'], HANDOFF_REQUESTED: ['CANCELLED', 'refresh'],
  OPERATION_CAPACITY: ['UNAVAILABLE', 'never'], UNAVAILABLE: ['UNAVAILABLE', 'safe-read'],
  UNSUPPORTED: ['UNSUPPORTED', 'never'], DENIED: ['DENIED', 'never'],
  COMPLETION_SCOPE_CHANGED: ['STALE_REF', 'refresh'], LEDGER_WRITE_FAILED: ['UNAVAILABLE', 'never'],
  DESTINATION_DENIED: ['DENIED', 'never'], APPROVAL_REQUIRED: ['DENIED', 'after-approval'],
};
function publicError(err, defaults = {}) {
  if (err && err.publicError && ERROR_CODES.includes(err.publicError.code)) {
    const p = err.publicError;
    return { code: p.code, message: redactText(String(p.message || ''), 500), dispatched: !!p.dispatched, effectUnknown: !!p.effectUnknown, retry: RETRY.includes(p.retry) ? p.retry : 'never' };
  }
  const internal = err && typeof err.code === 'string' ? err.code : '';
  const [code, retry] = CODE_MAP[internal] || ['INTERNAL', 'never'];
  // Never leak raw messages of unclassified errors (stacks, paths).
  const message = CODE_MAP[internal] ? redactText(String(err.message || internal), 500) : 'internal error';
  return { code, message, dispatched: !!(defaults.dispatched), effectUnknown: !!(defaults.effectUnknown), retry };
}
// Normalises any thrown value into an Error carrying .publicError.
function toBrokerError(err, defaults) {
  if (err && err.publicError) return err;
  const out = new Error(err && err.message ? String(err.message) : 'error');
  out.code = err && err.code;
  out.publicError = publicError(err, defaults);
  return out;
}

// ---- validators (Zod-free; the MCP edge uses zod separately) ------------------
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function exact(obj, allowed, what) {
  if (!isObj(obj)) throw invalid(`${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw invalid(`${what}: unknown field ${k.slice(0, 40)}`);
}
function str(v, name, { max = 160, min = 1, re } = {}) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw invalid(`${name} must be a string (${min}-${max})`);
  if (re && !re.test(v)) throw invalid(`${name} has an invalid format`);
  return v;
}
const clientId = (v, name) => str(v, name, { re: CLIENT_ID });
const opt = (v, fn) => (v === undefined || v === null ? undefined : fn(v));
function int(v, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw invalid(`${name} must be an integer ${min}..${max}`);
  return v;
}

function validatePrincipal(p) {
  if (!isObj(p) || !isClientId(p.id) || !PRINCIPAL_KINDS.includes(p.kind) || !Array.isArray(p.scopes)
      || p.scopes.length > 200 || p.scopes.some((s) => typeof s !== 'string' || s.length > 600)) {
    throw brokerError('DENIED', 'unauthenticated or malformed principal', { detail: 'BAD_PRINCIPAL' });
  }
  return freezeDeep({ id: p.id, kind: p.kind, scopes: [...p.scopes] });
}

function validateAction(a) {
  if (!isObj(a) || !ACTION_KINDS.includes(a.kind)) throw brokerError('UNSUPPORTED', 'unknown action kind', { detail: 'UNKNOWN_ACTION' });
  switch (a.kind) {
    case 'click': exact(a, ['kind', 'ref'], 'action'); return { kind: 'click', ref: clientId(a.ref, 'ref') };
    case 'fill': exact(a, ['kind', 'ref', 'text'], 'action');
      if (typeof a.text !== 'string' || a.text.length > 10000) throw invalid('text must be a string <= 10000');
      return { kind: 'fill', ref: clientId(a.ref, 'ref'), text: a.text };
    case 'press': exact(a, ['kind', 'ref', 'key'], 'action');
      if (!PRESS_KEYS.includes(a.key)) throw invalid('key not allowed');
      return { kind: 'press', ref: clientId(a.ref, 'ref'), key: a.key };
    case 'select': exact(a, ['kind', 'ref', 'value'], 'action');
      return { kind: 'select', ref: clientId(a.ref, 'ref'), value: str(a.value, 'value', { max: 1000, min: 0 }) };
    case 'check': exact(a, ['kind', 'ref', 'checked'], 'action');
      if (typeof a.checked !== 'boolean') throw invalid('checked must be boolean');
      return { kind: 'check', ref: clientId(a.ref, 'ref'), checked: a.checked };
    case 'setViewport': exact(a, ['kind', 'width', 'height'], 'action');
      return { kind: 'setViewport', width: int(a.width, 'width', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }), height: int(a.height, 'height', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }) };
    default: exact(a, ['kind', 'url'], 'action'); return { kind: 'navigate', url: str(a.url, 'url', { max: 2048 }) };
  }
}

function validateGrantRequest(g) {
  g = g === undefined ? {} : g;
  exact(g, ['projectId', 'profile', 'allowedOrigins', 'allowedRoots', 'toolClasses', 'expiresAt', 'budgets', 'trustedFixture'], 'grant');
  const list = (v, name, max) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > 600)) throw invalid(`${name} must be a string array`);
    return [...v];
  };
  const toolClasses = list(g.toolClasses, 'toolClasses', 20);
  if (toolClasses.some((c) => !TOOL_CLASSES.includes(c))) throw invalid('unknown tool class');
  if (g.expiresAt !== undefined && (typeof g.expiresAt !== 'string' || Number.isNaN(Date.parse(g.expiresAt)))) throw invalid('expiresAt must be an ISO date');
  const budgets = {};
  if (g.budgets !== undefined) {
    exact(g.budgets, ['maxActions', 'maxObservations', 'maxNavigations', 'maxDurationMs', 'maxArtifactBytes'], 'budgets');
    for (const [k, v] of Object.entries(g.budgets)) budgets[k] = int(v, `budgets.${k}`, { min: 0, max: 1e12 });
  }
  return {
    projectId: opt(g.projectId, (v) => str(v, 'projectId')), profile: opt(g.profile, (v) => str(v, 'profile', { max: 80 })),
    allowedOrigins: list(g.allowedOrigins, 'allowedOrigins', 50), allowedRoots: list(g.allowedRoots, 'allowedRoots', 20),
    toolClasses, expiresAt: g.expiresAt, budgets, trustedFixture: g.trustedFixture === true,
  };
}

function validateOpenSession(i) {
  exact(i, ['driver', 'mode', 'profile', 'reviewSessionId', 'grant', 'viewport', 'locale', 'timezoneId'], 'openSession');
  if (!DRIVER_NAMES.includes(i.driver)) throw brokerError('UNSUPPORTED', 'unknown driver', { detail: 'UNKNOWN_DRIVER' });
  if (!MODES.includes(i.mode)) throw invalid('mode must be headless|visible');
  const out = { driver: i.driver, mode: i.mode, grant: validateGrantRequest(i.grant) };
  if (i.profile !== undefined) out.profile = str(i.profile, 'profile', { max: 80, re: /^[A-Za-z0-9_.-]+$/ });
  if (i.reviewSessionId !== undefined) out.reviewSessionId = clientId(i.reviewSessionId, 'reviewSessionId');
  if (i.viewport !== undefined) {
    exact(i.viewport, ['width', 'height', 'deviceScaleFactor'], 'viewport');
    out.viewport = { width: int(i.viewport.width, 'width', { min: 200, max: 4000 }), height: int(i.viewport.height, 'height', { min: 200, max: 4000 }) };
    if (i.viewport.deviceScaleFactor !== undefined) {
      if (typeof i.viewport.deviceScaleFactor !== 'number' || i.viewport.deviceScaleFactor < 0.5 || i.viewport.deviceScaleFactor > 4) throw invalid('deviceScaleFactor');
      out.viewport.deviceScaleFactor = i.viewport.deviceScaleFactor;
    }
  }
  if (i.locale !== undefined) out.locale = str(i.locale, 'locale', { max: 20, re: /^[A-Za-z0-9-]+$/ });
  if (i.timezoneId !== undefined) out.timezoneId = str(i.timezoneId, 'timezoneId', { max: 60, re: /^[A-Za-z0-9_/+-]+$/ });
  return out;
}
const validateSessionPage = (i, what = 'request') => { exact(i, ['sessionId', 'pageId'], what); return { sessionId: clientId(i.sessionId, 'sessionId'), pageId: clientId(i.pageId, 'pageId') }; };
function validateObserve(i) {
  exact(i, ['sessionId', 'pageId', 'maxNodes', 'focus', 'cursor'], 'observe');
  return { sessionId: clientId(i.sessionId, 'sessionId'), pageId: clientId(i.pageId, 'pageId'),
    maxNodes: i.maxNodes === undefined ? 200 : int(i.maxNodes, 'maxNodes', { min: 1, max: 200 }),
    focus: opt(i.focus, (v) => str(v, 'focus', { max: 200 })), cursor: opt(i.cursor, (v) => clientId(v, 'cursor')) };
}
function validateAct(i) {
  exact(i, ['sessionId', 'pageId', 'runId', 'observationId', 'documentEpoch', 'operationId', 'action', 'approvalId', 'timeoutMs'], 'act');
  const action = validateAction(i.action);
  if (!REFLESS_ACTIONS.includes(action.kind) && i.observationId === undefined) throw invalid('observationId is required for ref actions');
  return { sessionId: clientId(i.sessionId, 'sessionId'), pageId: clientId(i.pageId, 'pageId'), runId: opt(i.runId, (v) => clientId(v, 'runId')),
    observationId: opt(i.observationId, (v) => clientId(v, 'observationId')), documentEpoch: int(i.documentEpoch, 'documentEpoch'),
    operationId: clientId(i.operationId, 'operationId'), action, approvalId: opt(i.approvalId, (v) => clientId(v, 'approvalId')),
    timeoutMs: i.timeoutMs === undefined ? 15000 : int(i.timeoutMs, 'timeoutMs', { min: 10, max: 120000 }) };
}
// Skill arguments: strings (<= 10000) or small plain JSON (depth <= 5, <= 500 nodes, <= 16 KiB in all). Which keys are
// allowed, and that plan inputs are strings, is decided against the validated plan in the broker.
function jsonArgument(v, name, state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > 500 || depth > 5) throw invalid(`${name} is too complex`);
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw invalid(`${name} must be finite`); return; }
  if (typeof v === 'string') { if (v.length > 10000) throw invalid(`${name} string is too long`); return; }
  if (Array.isArray(v)) { v.forEach((x) => jsonArgument(x, name, state, depth + 1)); return; }
  if (isObj(v) && Object.getPrototypeOf(v) === Object.prototype) { for (const k of Object.keys(v)) { str(k, 'input key', { max: 200 }); jsonArgument(v[k], name, state, depth + 1); } return; }
  throw invalid(`${name} must be plain JSON`);
}
function validateStartRun(i) {
  exact(i, ['sessionId', 'pageId', 'requestKey', 'skillId', 'skillVersion', 'maxDurationMs', 'inputs'], 'startRun');
  const inputs = i.inputs === undefined ? {} : i.inputs;
  if (!isObj(inputs) || Object.keys(inputs).length > 20) throw invalid('inputs must be an object (<=20 keys)');
  for (const [k, v] of Object.entries(inputs)) { str(k, 'input key', { max: 200 }); jsonArgument(v, 'input value'); }
  if (JSON.stringify(inputs).length > 16384) throw invalid('inputs are too large');
  return { sessionId: clientId(i.sessionId, 'sessionId'), pageId: clientId(i.pageId, 'pageId'), requestKey: clientId(i.requestKey, 'requestKey'),
    skillId: str(i.skillId, 'skillId', { max: 200 }), skillVersion: str(i.skillVersion, 'skillVersion', { max: 40, re: /^\d+\.\d+\.\d+$/ }),
    maxDurationMs: i.maxDurationMs === undefined ? 300000 : int(i.maxDurationMs, 'maxDurationMs', { min: 1000, max: 3600000 }), inputs: clone(inputs) };
}
function validateGetRun(i) {
  exact(i, ['runId', 'afterSequence', 'maxEvents'], 'getRun');
  return { runId: clientId(i.runId, 'runId'), afterSequence: i.afterSequence === undefined ? 0 : int(i.afterSequence, 'afterSequence'),
    maxEvents: i.maxEvents === undefined ? 50 : int(i.maxEvents, 'maxEvents', { min: 0, max: 100 }) };
}

// A closed workflow plan, as produced by automation/workflow.mjs. Validated
// again here: the broker never trusts a plan it did not check itself.
// workflow-core.js (zod) must stay a SUBSET of this validator (test: plan-subset).
const TARGET_BY = ['role', 'testId', 'label'];
// Action targets always need an accessible name. Assertion / capture targets may
// name a role alone ("any row"); uniqueness is then decided at resolution time.
function validateTarget(t, { nameOptional = false } = {}) {
  if (!isObj(t) || !TARGET_BY.includes(t.by)) throw invalid('step target');
  if (t.by === 'role') {
    exact(t, ['by', 'role', 'name'], 'target');
    const role = str(t.role, 'role', { max: 200 });
    if (t.name === undefined && nameOptional) return { by: 'role', role };
    return { by: 'role', role, name: str(t.name, 'name', { max: 200 }) };
  }
  exact(t, ['by', 'value'], 'target'); return { by: t.by, value: str(t.value, 'value', { max: 200 }) };
}
const ASSERT_KINDS = Object.freeze(['visible', 'text', 'exists', 'count', 'url']);
const ASSERT_OPS = Object.freeze(['equals', 'contains']);
const PLAN_STEP_TYPES = Object.freeze(['navigate', 'click', 'fill', 'select', 'check', 'press', 'setViewport', 'capture', 'assert']);
function validateAssertStep(s, id) {
  exact(s, ['id', 'type', 'target', 'kind', 'op', 'expected'], 'step');
  if (!ASSERT_KINDS.includes(s.kind) || !ASSERT_OPS.includes(s.op)) throw invalid('assert kind/op');
  if (typeof s.expected !== 'string' || s.expected.length > 1000) throw invalid('assert.expected');
  const out = { id, type: 'assert', kind: s.kind, op: s.op, expected: s.expected };
  if (s.kind === 'url') {
    if (s.target !== undefined) throw invalid('url assertion takes no target');
    if (!s.expected) throw invalid('url assertion needs an expected value');
    return out;
  }
  if (s.target === undefined) throw invalid(`${s.kind} assertion requires a target`);
  out.target = validateTarget(s.target, { nameOptional: ['visible', 'exists', 'count'].includes(s.kind) });
  if (s.kind === 'visible' && (s.op !== 'equals' || s.expected !== 'visible')) throw invalid('visibility assertion');
  if (s.kind === 'exists' && (s.op !== 'equals' || s.expected !== 'exists')) throw invalid('existence assertion');
  if (s.kind === 'text' && !s.expected) throw invalid('text assertion needs an expected value');
  if (s.kind === 'count' && !/^\d{1,9}$/.test(s.expected)) throw invalid('count assertion needs a non-negative integer');
  return out;
}
function validatePlan(plan) {
  exact(plan, ['schemaVersion', 'skillId', 'version', 'inputKeys', 'maxDurationMs', 'steps'], 'plan');
  if (plan.schemaVersion !== 1) throw invalid('plan.schemaVersion');
  if (!Array.isArray(plan.inputKeys) || plan.inputKeys.length > 20) throw invalid('plan.inputKeys');
  const inputKeys = plan.inputKeys.map((k) => str(k, 'inputKey', { max: 200 }));
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 200) throw invalid('plan.steps (1-200)');
  const ids = new Set();
  const declared = (k) => { const inputKey = str(k, 'inputKey', { max: 200 }); if (!inputKeys.includes(inputKey)) throw invalid('undeclared input key'); return inputKey; };
  const steps = plan.steps.map((s) => {
    if (!isObj(s)) throw invalid('step');
    const id = str(s.id, 'step.id', { max: 200 });
    if (ids.has(id)) throw invalid('duplicate step id');
    ids.add(id);
    switch (s.type) {
      case 'navigate': exact(s, ['id', 'type', 'url'], 'step'); return { id, type: 'navigate', url: str(s.url, 'url', { max: 2048 }) };
      case 'click': exact(s, ['id', 'type', 'target'], 'step'); return { id, type: 'click', target: validateTarget(s.target) };
      case 'fill': exact(s, ['id', 'type', 'target', 'inputKey'], 'step'); return { id, type: 'fill', target: validateTarget(s.target), inputKey: declared(s.inputKey) };
      case 'select': exact(s, ['id', 'type', 'target', 'inputKey'], 'step'); return { id, type: 'select', target: validateTarget(s.target), inputKey: declared(s.inputKey) };
      case 'check':
        exact(s, ['id', 'type', 'target', 'checked'], 'step');
        if (typeof s.checked !== 'boolean') throw invalid('check.checked must be boolean');
        return { id, type: 'check', target: validateTarget(s.target), checked: s.checked };
      case 'press':
        exact(s, ['id', 'type', 'target', 'key'], 'step');
        if (!PRESS_KEYS.includes(s.key)) throw invalid('key not allowed');
        return { id, type: 'press', target: validateTarget(s.target), key: s.key };
      case 'setViewport':
        exact(s, ['id', 'type', 'width', 'height'], 'step');
        return { id, type: 'setViewport', width: int(s.width, 'width', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }), height: int(s.height, 'height', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }) };
      case 'capture': {
        exact(s, ['id', 'type', 'label', 'target'], 'step');
        const out = { id, type: 'capture', label: str(s.label, 'label', { max: 200 }) };
        if (s.target !== undefined) out.target = validateTarget(s.target, { nameOptional: true });
        return out;
      }
      case 'assert': return validateAssertStep(s, id);
      default: throw brokerError('UNSUPPORTED', 'unknown step type', { detail: 'UNKNOWN_STEP' });
    }
  });
  if (!steps.some((s) => s.type === 'assert')) throw invalid('plan needs an assertion');
  return freezeDeep({ schemaVersion: 1, skillId: str(plan.skillId, 'skillId', { max: 200 }), version: str(plan.version, 'version', { max: 40, re: /^\d+\.\d+\.\d+$/ }),
    inputKeys, maxDurationMs: int(plan.maxDurationMs, 'plan.maxDurationMs', { min: 1000, max: 300000 }), steps });
}

// ---- RunDTO / receipt builders ---------------------------------------------------
const PENDING_STATES = new Set(['queued', 'running', 'needsApproval', 'needsHuman']);
// Lifecycle state -> public verdict. `passed` requires the canonical grader to
// agree; otherwise it degrades to `unknown` (never a false pass).
function mapVerdict(state, graderStatus) {
  if (PENDING_STATES.has(state)) return 'pending';
  if (state === 'uncertain' || state === 'interrupted') return 'unknown';
  if (state === 'passed') return graderStatus === 'passed' ? 'passed' : 'unknown';
  if (state === 'failed' || state === 'cancelled' || state === 'timedOut') return state;
  return 'unknown';
}
const RUN_KEYS = ['runId', 'state', 'verdict', 'sequence', 'cancelRequested', 'planned', 'executed', 'passed', 'skipped', 'cancelled', 'timedOut', 'evidenceComplete', 'uncertainEffect', 'requiredAssertions', 'passedAssertions', 'deadlineAt', 'pending', 'failed', 'unknown', 'events', 'nextSequence', 'manifestUri'];
function buildRunDTO({ runId, state, cancelRequested = false, grade, sequence, events, nextSequence, deadlineAt, manifestUri }) {
  const dto = {
    runId, state, verdict: mapVerdict(state, grade.status), sequence, cancelRequested: !!cancelRequested,
    planned: grade.planned, executed: grade.executed, passed: grade.passed, skipped: grade.skipped, cancelled: grade.cancelled, timedOut: grade.timedOut,
    // A non-passing/unfinished run can never advertise complete evidence for a pass.
    evidenceComplete: !!grade.evidenceComplete, uncertainEffect: !!grade.uncertainEffect,
    requiredAssertions: grade.requiredAssertions, passedAssertions: grade.passedAssertions,
    deadlineAt: new Date(deadlineAt).toISOString(), pending: grade.pending, failed: grade.failed, unknown: grade.unknown,
    events: events.slice(0, 100).map((e) => ({ sequence: e.sequence, ...(e.stepId ? { stepId: e.stepId } : {}), kind: String(e.kind).slice(0, 80), summary: redactText(String(e.summary), 300) })),
    nextSequence, manifestUri,
  };
  return freezeDeep(dto);
}
function validateRunDTO(dto) {
  const problems = [];
  if (!isObj(dto)) return ['not an object'];
  for (const k of Object.keys(dto)) if (!RUN_KEYS.includes(k)) problems.push(`extra key ${k}`);
  for (const k of RUN_KEYS) if (!(k in dto)) problems.push(`missing ${k}`);
  if (!RUN_STATES.includes(dto.state)) problems.push('state');
  if (!VERDICTS.includes(dto.verdict)) problems.push('verdict');
  for (const k of ['sequence', 'planned', 'executed', 'passed', 'skipped', 'cancelled', 'timedOut', 'requiredAssertions', 'passedAssertions', 'pending', 'failed', 'unknown', 'nextSequence']) {
    if (!Number.isInteger(dto[k]) || dto[k] < 0) problems.push(`${k} not a non-negative integer`);
  }
  for (const k of ['cancelRequested', 'evidenceComplete', 'uncertainEffect']) if (typeof dto[k] !== 'boolean') problems.push(`${k} not boolean`);
  if (typeof dto.manifestUri !== 'string' || !dto.manifestUri.startsWith('braiwser://')) problems.push('manifestUri');
  if (Number.isNaN(Date.parse(dto.deadlineAt))) problems.push('deadlineAt');
  if (!Array.isArray(dto.events) || dto.events.length > 100) problems.push('events');
  else for (const e of dto.events) if (!Number.isInteger(e.sequence) || typeof e.kind !== 'string' || e.kind.length > 80 || typeof e.summary !== 'string' || e.summary.length > 300) problems.push('event shape');
  if (dto.verdict === 'passed' && !(dto.state === 'passed' && dto.evidenceComplete && dto.requiredAssertions > 0 && dto.passedAssertions === dto.requiredAssertions && dto.pending === 0 && dto.failed === 0 && dto.unknown === 0)) problems.push('verdict passed without proof');
  return problems;
}

function buildReceipt(kernel, { afterObservationId = null, evidenceUri, code } = {}) {
  const status = RECEIPT_STATUS.includes(kernel.status) ? kernel.status : 'uncertain';
  return freezeDeep({
    operationId: kernel.operationId, sessionId: kernel.sessionId, pageId: kernel.pageId, status,
    code: String(code || kernel.code || (status === 'verified' ? 'OK' : status.toUpperCase())).slice(0, 80),
    dispatched: kernel.dispatched === true || status === 'dispatched' || status === 'verified' || status === 'uncertain',
    effectUnknown: status === 'uncertain', afterObservationId, evidenceUri,
  });
}

const URI_SCHEME = 'braiwser://';
const uris = Object.freeze({
  capabilities: () => `${URI_SCHEME}capabilities`,
  catalog: () => `${URI_SCHEME}skills/catalog`,
  manifest: (runId) => `${URI_SCHEME}runs/${runId}/manifest`,
  observation: (runId, id) => `${URI_SCHEME}runs/${runId}/observations/${id}`,
  artifact: (runId, id) => `${URI_SCHEME}runs/${runId}/artifacts/${id}`,
});
function parseUri(uri) {
  if (typeof uri !== 'string' || uri.length > 400 || !uri.startsWith(URI_SCHEME)) return null;
  const parts = uri.slice(URI_SCHEME.length).split('/');
  if (parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) return null;
  if (parts.length === 1 && parts[0] === 'capabilities') return { kind: 'capabilities' };
  if (parts.length === 2 && parts[0] === 'skills' && parts[1] === 'catalog') return { kind: 'catalog' };
  if (parts[0] === 'runs' && parts.length === 3 && parts[2] === 'manifest' && isServerId(parts[1])) return { kind: 'manifest', runId: parts[1] };
  if (parts[0] === 'runs' && parts.length === 4 && isServerId(parts[1]) && isServerId(parts[3]) && (parts[2] === 'observations' || parts[2] === 'artifacts')) return { kind: parts[2] === 'observations' ? 'observation' : 'artifact', runId: parts[1], id: parts[3] };
  return null;
}

// Serialised size cap with truncation metadata (default 64 KiB).
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
function capText(text, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, offset = 0 } = {}) {
  const buf = Buffer.from(String(text), 'utf8');
  if (offset > buf.length) offset = buf.length;
  let end = Math.min(buf.length, offset + maxBytes);
  // do not cut a UTF-8 sequence in half
  while (end < buf.length && end > offset && (buf[end] & 0xc0) === 0x80) end--;
  const truncated = end < buf.length;
  return { text: buf.slice(offset, end).toString('utf8'), truncated, totalBytes: buf.length, returnedBytes: end - offset, nextOffset: truncated ? end : null };
}

module.exports = {
  SCHEMA_VERSION, PRINCIPAL_KINDS, DRIVER_NAMES, MODES, ERROR_CODES, RETRY, RECEIPT_STATUS, RUN_STATES, ACTIVE_STATES, TERMINAL_STATES, VERDICTS,
  TOOL_CLASSES, ACTION_KINDS, REFLESS_ACTIONS, VIEWPORT_MIN, VIEWPORT_MAX, ASSERT_KINDS, ASSERT_OPS, PLAN_STEP_TYPES, PRESS_KEYS, HANDOFF_METHODS, OWNERS, RUN_TRANSITIONS, canTransition, DEFAULT_MAX_RESPONSE_BYTES,
  newId, isServerId, isClientId, canonical, canonicalJson, sha256, freezeDeep, clone,
  brokerError, invalid, publicError, toBrokerError, CODE_MAP,
  validatePrincipal, validateAction, validateGrantRequest, validateOpenSession, validateSessionPage, validateObserve, validateAct, validateStartRun, validateGetRun, validatePlan,
  mapVerdict, buildRunDTO, validateRunDTO, buildReceipt, uris, parseUri, capText,
};
