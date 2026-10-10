'use strict';
// Closed workflow DSL: schema, canonical digest, upgrade diff, and the pure
// recording -> workflow migration.
//
// CommonJS on purpose. The ESM adapter (workflow.mjs) re-exports this module and
// the CJS skill registry / broker run state machine require it directly, so
// there is exactly ONE validator. Nothing in here executes anything: a plan is
// data that the broker interprets with its own grants.
//
// What the language deliberately does NOT have: arbitrary JavaScript, shell,
// file paths, regular-expression assertions, optional branches, loops, secret
// values. Every step is mandatory; a plan must end with an assertion so a
// trailing action can never be mistaken for a verified outcome. Add features
// only with a schemaVersion bump and tests.
const crypto = require('node:crypto');
const { z } = require('zod');
const { isSecretStep, redactSteps, SECRET_PLACEHOLDER } = require('../../../shared/redact');
const { normalizeAssertion, controlOfStep } = require('../../../shared/assertions');

const SCHEMA_VERSION = 1;
const SEMVER = /^\d+\.\d+\.\d+$/;
const short = z.string().min(1).max(200);
const stepId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, 'Invalid step ID');
const inputKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Invalid input key');
const KEYS = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'];
// The broker's validatePlan (src/shared/browser-contracts.js) is the authority; every limit here must be equal or
// tighter so a plan that passes this schema is never refused by the broker (test: plan-subset).
const { VIEWPORT_MIN, VIEWPORT_MAX } = require('../../../shared/browser-contracts');

// Semantic locators only. Refs are ephemeral and CSS paths are brittle; neither
// is a durable, reviewable contract. The broker resolves a target into a fresh
// observation/ref and refuses (AMBIGUOUS_TARGET / STALE_REF) instead of picking
// the first of several matches.
const target = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('role'), role: short, name: short.optional() }),
  z.strictObject({ by: z.literal('testId'), value: short }),
  z.strictObject({ by: z.literal('label'), value: short }),
]);

const httpUrl = z.string().max(2000).url().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch (_e) { return false; }
}, 'Only http(s) URLs without embedded credentials');

const STATE_CHANGING = new Set(['navigate', 'click', 'fill', 'select', 'check', 'press']);
const ASSERT_KINDS = ['visible', 'exists', 'text', 'count', 'url'];
const step = z.discriminatedUnion('type', [
  z.strictObject({ id: stepId, type: z.literal('navigate'), url: httpUrl }),
  z.strictObject({ id: stepId, type: z.literal('click'), target }),
  z.strictObject({ id: stepId, type: z.literal('fill'), target, inputKey }),
  z.strictObject({ id: stepId, type: z.literal('select'), target, inputKey }),
  z.strictObject({ id: stepId, type: z.literal('check'), target, checked: z.boolean() }),
  z.strictObject({ id: stepId, type: z.literal('press'), target, key: z.enum(KEYS) }),
  z.strictObject({ id: stepId, type: z.literal('setViewport'),
    width: z.number().int().min(VIEWPORT_MIN).max(VIEWPORT_MAX), height: z.number().int().min(VIEWPORT_MIN).max(VIEWPORT_MAX) }),
  // Evidence only: a capture can never make a run pass.
  z.strictObject({ id: stepId, type: z.literal('capture'), label: short, target: target.optional() }),
  z.strictObject({ id: stepId, type: z.literal('assert'), target: target.optional(),
    kind: z.enum(ASSERT_KINDS), op: z.enum(['equals', 'contains']), expected: z.string().max(1000) }),
]);

const Workflow = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  skillId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64),
  version: z.string().regex(SEMVER),
  inputKeys: z.array(inputKey).max(20),
  maxDurationMs: z.number().int().min(1000).max(300000),
  steps: z.array(step).min(1).max(200),
}).superRefine((plan, context) => {
  const invalid = (message, path) => context.addIssue({ code: 'custom', message, path });
  if (new Set(plan.steps.map((s) => s.id)).size !== plan.steps.length) invalid('Duplicate step ID', ['steps']);
  if (new Set(plan.inputKeys).size !== plan.inputKeys.length) invalid('Duplicate input key', ['inputKeys']);
  if (!plan.steps.some((s) => s.type === 'assert')) invalid('Verification requires an assertion', ['steps']);
  // No state-changing step may follow the last assertion: its effect would be unverified.
  let lastAssert = -1;
  plan.steps.forEach((s, i) => { if (s.type === 'assert') lastAssert = i; });
  plan.steps.forEach((s, i) => {
    if (i > lastAssert && STATE_CHANGING.has(s.type)) {
      invalid('A trailing action would be unverified; end the plan with an assertion', ['steps', i]);
    }
  });
  plan.steps.forEach((s, i) => {
    const at = ['steps', i];
    if ((s.type === 'fill' || s.type === 'select')) {
      if (!plan.inputKeys.includes(s.inputKey)) invalid('Undeclared input key', at);
    }
    if (s.type === 'assert') {
      const needsTarget = s.kind !== 'url';
      if (needsTarget && !s.target) invalid(`${s.kind} assertion requires a target`, at);
      if (!needsTarget && s.target) invalid('url assertion takes no target', at);
      if (s.kind === 'visible' && (s.op !== 'equals' || s.expected !== 'visible')) invalid('Invalid visibility assertion', at);
      if (s.kind === 'exists' && (s.op !== 'equals' || s.expected !== 'exists')) invalid('Invalid existence assertion', at);
      if (s.kind === 'text' && !s.expected) invalid('text assertion needs an expected value', at);
      if (s.kind === 'url' && !s.expected) invalid('url assertion needs an expected value', at);
      if (s.kind === 'count' && !/^\d{1,9}$/.test(s.expected)) invalid('count assertion needs a non-negative integer', at);
      if (s.target && s.target.by === 'role' && !s.target.name && !['count', 'exists', 'visible'].includes(s.kind)) {
        invalid('A role target needs a name for this assertion', at);
      }
    } else if (s.target && s.target.by === 'role' && !s.target.name && s.type !== 'capture') {
      invalid('A role target needs an accessible name', at);
    }
  });
});

function validateWorkflow(raw) { return Workflow.parse(raw); }

function safeValidateWorkflow(raw) {
  const parsed = Workflow.safeParse(raw);
  if (parsed.success) return { ok: true, plan: parsed.data, issues: [] };
  return { ok: false, plan: null,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(plan)'}: ${i.message}`) };
}

// ---------------------------------------------------------------- digests

function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite number is not canonicalizable');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    default: throw new TypeError(`Cannot canonicalize ${typeof value}`);
  }
}

function sha256(data) {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

function canonicalJson(value) { return canonicalize(value); }
function digestOf(value) { return sha256(canonicalize(value)); }
function workflowDigest(plan) { return digestOf(validateWorkflow(plan)); }
function inputDigest(inputs) { return digestOf(inputs || {}); }

// ---------------------------------------------------------------- effects & diff

const MUTATING = new Set(['click', 'fill', 'select', 'check', 'press']);

function describeEffects(plan) {
  const p = validateWorkflow(plan);
  const actions = {};
  for (const s of p.steps) actions[s.type] = (actions[s.type] || 0) + 1;
  const origins = new Set();
  for (const s of p.steps) if (s.type === 'navigate') origins.add(new URL(s.url).origin);
  return {
    origins: [...origins].sort(),
    actions,
    mutating: p.steps.some((s) => MUTATING.has(s.type)),
    inputKeys: [...p.inputKeys],
    assertions: p.steps.filter((s) => s.type === 'assert').length,
    requires: requiredCapabilities(p),
  };
}

function requiredCapabilities(plan) {
  const need = new Set();
  for (const s of plan.steps) {
    if (s.type === 'navigate') need.add('navigate');
    else if (s.type === 'setViewport') need.add('viewport');
    else if (s.type === 'capture') need.add('screenshots');
    else if (s.type === 'assert') need.add('assert');
    else need.add('interact');
  }
  return [...need].sort();
}

// Upgrade preview. Pure; says what changed and whether the new version asks for
// more than the old one did. It does not approve anything.
function diffWorkflows(before, after) {
  const a = validateWorkflow(before);
  const b = validateWorkflow(after);
  const byId = (p) => new Map(p.steps.map((s, i) => [s.id, { s, i }]));
  const ma = byId(a), mb = byId(b);
  const added = [], removed = [], changed = [];
  for (const [id, { s }] of mb) if (!ma.has(id)) added.push(id);
  for (const [id, { s, i }] of ma) {
    if (!mb.has(id)) { removed.push(id); continue; }
    const other = mb.get(id);
    if (canonicalize(s) !== canonicalize(other.s)) {
      const fields = [...new Set([...Object.keys(s), ...Object.keys(other.s)])]
        .filter((k) => canonicalize(s[k]) !== canonicalize(other.s[k]));
      changed.push({ id, fields });
    }
  }
  const common = a.steps.map((s) => s.id).filter((id) => mb.has(id));
  const commonB = b.steps.map((s) => s.id).filter((id) => ma.has(id));
  const reordered = canonicalize(common) !== canonicalize(commonB);
  const ea = describeEffects(a), eb = describeEffects(b);
  const newOrigins = eb.origins.filter((o) => !ea.origins.includes(o));
  const newActionTypes = Object.keys(eb.actions).filter((t) => !(t in ea.actions));
  const newInputKeys = b.inputKeys.filter((k) => !a.inputKeys.includes(k));
  const assertionIds = (p) => new Set(p.steps.filter((s) => s.type === 'assert').map((s) => s.id));
  const aa = assertionIds(a), ab = assertionIds(b);
  const weakened = [...aa].filter((id) => !ab.has(id));
  const scopeExpansion = {
    newOrigins, newActionTypes, newInputKeys,
    longerDeadline: b.maxDurationMs > a.maxDurationMs,
    becameMutating: !ea.mutating && eb.mutating,
  };
  const expandsScope = newOrigins.length > 0 || newActionTypes.length > 0 || newInputKeys.length > 0
    || scopeExpansion.longerDeadline || scopeExpansion.becameMutating;
  const digestBefore = digestOf(a), digestAfter = digestOf(b);
  return {
    identical: digestBefore === digestAfter,
    version: { from: a.version, to: b.version },
    digest: { from: digestBefore, to: digestAfter },
    steps: { added, removed, changed, reordered },
    // Removing an assertion is the one change that can turn a failing check green.
    assertions: { removed: weakened, added: [...ab].filter((id) => !aa.has(id)) },
    scopeExpansion, expandsScope,
    requiresReapproval: expandsScope || weakened.length > 0 || added.length > 0 || removed.length > 0 || changed.length > 0,
    sameVersionDifferentBytes: a.version === b.version && digestBefore !== digestAfter,
  };
}

// Where a step sits in the journey: the viewport and page in force, and the ids of
// every step before it. Lets a failed assertion be paired with a reproducible
// target, viewport and URL without re-deriving them from prose.
function locateStep(plan, id) {
  const p = validateWorkflow(plan);
  let viewport = null, url = null;
  const before = [];
  for (const s of p.steps) {
    if (s.id === id) return { stepId: id, index: before.length, step: s, viewport, url, precedingStepIds: before };
    if (s.type === 'setViewport') viewport = { width: s.width, height: s.height };
    if (s.type === 'navigate') url = s.url;
    before.push(s.id);
  }
  return null;
}

// ---------------------------------------------------------------- recording -> workflow

const SENSITIVE_QUERY = /(^|[_-])(token|key|secret|password|passwd|pwd|auth|session|sid|code|otp|jwt|sig|signature|credential|apikey)([_-]|$)/i;

function refusal(index, step, code, reason) {
  return { stepIndex: index, type: step && typeof step.type === 'string' ? step.type : 'unknown', code, reason };
}

// Semantic locator for a recorded step, or null. Never guesses: a CSS path is
// NOT turned into a role/name pair; only developer-owned contracts and explicit
// accessible names are accepted.
function locatorFor(recorded) {
  const explicit = recorded.locator;
  if (explicit && typeof explicit === 'object') {
    const parsed = target.safeParse(explicit);
    if (parsed.success) return { target: parsed.data };
    return { error: 'LOCATOR_INVALID', reason: 'The recorded semantic locator does not match the closed locator schema.' };
  }
  const selector = typeof recorded.selector === 'string' ? recorded.selector : '';
  const tag = String(recorded.tag || '').toLowerCase();
  const attr = (name) => {
    const m = selector.match(new RegExp(`^(?:[a-z][a-z0-9-]*)?\\[${name}="((?:[^"\\\\]|\\\\.)*)"\\]$`, 'i'));
    return m ? m[1].replace(/\\(.)/g, '$1') : null;
  };
  const testId = attr('data-testid');
  if (testId) return { target: { by: 'testId', value: testId } };
  const aria = attr('aria-label');
  if (aria) {
    if (tag === 'button') return { target: { by: 'role', role: 'button', name: aria } };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return { target: { by: 'label', value: aria } };
    return { error: 'NO_SEMANTIC_LOCATOR', reason: `An aria-label on <${tag || 'element'}> does not name a role the recorder verified.` };
  }
  const text = typeof recorded.text === 'string' ? recorded.text.trim() : '';
  if (tag === 'button' && text && text.length < 60 && !/\[(?:name|placeholder)=/.test(selector)) {
    // The recorder prefers aria-label > placeholder > name > innerText. A button
    // addressed by a name/placeholder attribute would record that attribute, not
    // its accessible name, so those selectors are excluded.
    return { target: { by: 'role', role: 'button', name: text },
      note: 'Button role/name derived from recorded text; replay fails closed if the accessible name differs.' };
  }
  return { error: 'NO_SEMANTIC_LOCATOR',
    reason: `Recorded CSS selector ${JSON.stringify(selector).slice(0, 120)} has no data-testid, aria-label or explicit accessible name. Re-record with a test id or add a semantic locator; the migration never falls back to the first match.` };
}

function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch (_e) { return { code: 'URL_INVALID', reason: 'Navigation URL is not absolute.' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 'UNSUPPORTED_URL_SCHEME', reason: `Scheme ${url.protocol} is not supported; only http(s).` };
  }
  if (url.username || url.password) return { code: 'URL_HAS_CREDENTIALS', reason: 'URL embeds credentials.' };
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      return { code: 'SENSITIVE_URL_QUERY', reason: `Query parameter "${key}" looks like a credential; it would be persisted in the plan.` };
    }
  }
  return { url: url.toString() };
}

// Pure. `recording` is a saved Braiwser journey { name, startUrl, steps[] }.
// Returns { ok, plan, digest, suggestedInputs, refused[], dropped[], warnings[] }.
// The plan never contains literal typed values: they become declared inputs and
// are returned separately so the plan digest does not depend on user data.
function recordingToWorkflow(recording, options = {}) {
  const refused = [], dropped = [], warnings = [];
  const skillId = options.skillId || 'verify-journey';
  const version = options.version || '1.0.0';
  const maxDurationMs = options.maxDurationMs || 120000;
  const fail = () => ({ ok: false, plan: null, digest: null, suggestedInputs: {}, refused, dropped, warnings });

  if (!recording || typeof recording !== 'object' || !Array.isArray(recording.steps)) {
    refused.push({ stepIndex: -1, type: 'recording', code: 'INVALID_RECORDING', reason: 'Recording has no steps array.' });
    return fail();
  }
  if (recording.steps.length === 0) {
    refused.push({ stepIndex: -1, type: 'recording', code: 'EMPTY_RECORDING', reason: 'Recording has no steps.' });
    return fail();
  }
  if (recording.steps.length > 400) {
    refused.push({ stepIndex: -1, type: 'recording', code: 'TOO_MANY_STEPS', reason: 'Recording exceeds the 200-step plan limit after conversion.' });
    return fail();
  }
  // Second redaction boundary: anything that repeats a secret becomes a placeholder.
  const steps = redactSteps(recording.steps);
  const out = [];
  const suggestedInputs = {};
  const inputKeys = [];
  let n = 0;
  const nextId = () => `s${++n}`;

  const first = steps[0];
  if (first && first.type !== 'navigate') {
    if (typeof recording.startUrl === 'string' && recording.startUrl) {
      const checked = checkUrl(recording.startUrl);
      if (checked.code) refused.push(refusal(-1, { type: 'navigate' }, checked.code, checked.reason));
      else {
        out.push({ id: nextId(), type: 'navigate', url: checked.url });
        warnings.push('Recording does not begin with a navigation; the recorded startUrl was used.');
      }
    } else {
      refused.push(refusal(-1, { type: 'navigate' }, 'NO_START_URL', 'Recording does not begin with a navigation and has no startUrl.'));
    }
  }

  steps.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') { refused.push(refusal(index, null, 'INVALID_STEP', 'Step is not an object.')); return; }
    const type = raw.type;
    const needLocator = () => {
      const loc = locatorFor(raw);
      if (loc.error) { refused.push(refusal(index, raw, loc.error, loc.reason)); return null; }
      if (loc.note && !warnings.includes(loc.note)) warnings.push(loc.note);
      return loc.target;
    };
    switch (type) {
      case 'navigate': {
        const checked = checkUrl(raw.url);
        if (checked.code) { refused.push(refusal(index, raw, checked.code, checked.reason)); return; }
        out.push({ id: nextId(), type: 'navigate', url: checked.url });
        return;
      }
      case 'click': {
        const t = needLocator(); if (!t) return;
        out.push({ id: nextId(), type: 'click', target: t });
        return;
      }
      case 'input': {
        if (isSecretStep(raw) || raw.secret === true || raw.placeholder === SECRET_PLACEHOLDER) {
          refused.push(refusal(index, raw, 'SECRET_STEP',
            'Secret fields (password, one-time code, payment) are never migrated into a plan; a runtime secret binding is required and not available.'));
          return;
        }
        const control = controlOfStep(raw);
        const t = needLocator(); if (!t) return;
        if (control === 'text' || control === 'select') {
          const value = raw.value == null ? '' : raw.value;
          if (typeof value !== 'string') { refused.push(refusal(index, raw, 'UNSUPPORTED_VALUE', 'Input value is not text.')); return; }
          if (value.length > 10000) { refused.push(refusal(index, raw, 'VALUE_TOO_LONG', 'Input value exceeds 10000 characters.')); return; }
          if (value === SECRET_PLACEHOLDER) { refused.push(refusal(index, raw, 'SECRET_STEP', 'Value is a secret placeholder.')); return; }
          const key = `input_${inputKeys.length + 1}`;
          inputKeys.push(key);
          suggestedInputs[key] = value;
          out.push({ id: nextId(), type: control === 'text' ? 'fill' : 'select', target: t, inputKey: key });
        } else if (control === 'checkbox' || control === 'radio') {
          const checked = control === 'radio' ? true : raw.value === true;
          if (control === 'checkbox' && typeof raw.value !== 'boolean') {
            refused.push(refusal(index, raw, 'UNSUPPORTED_VALUE', 'Checkbox step has no boolean state.')); return;
          }
          out.push({ id: nextId(), type: 'check', target: t, checked });
        } else {
          refused.push(refusal(index, raw, 'UNSUPPORTED_CONTROL', `Control "${control}" is not supported by workflow schema ${SCHEMA_VERSION}.`));
        }
        return;
      }
      case 'key': {
        const key = raw.key || 'Enter';
        if (!KEYS.includes(key)) { refused.push(refusal(index, raw, 'UNSUPPORTED_KEY', `Key "${String(key).slice(0, 20)}" is not in the closed key list.`)); return; }
        const t = needLocator(); if (!t) return;
        out.push({ id: nextId(), type: 'press', target: t, key });
        return;
      }
      case 'scroll':
        dropped.push({ stepIndex: index, type: 'scroll', reason: 'Scroll position is not part of a verified outcome; actionability scrolls targets into view.' });
        return;
      case 'assert': {
        const norm = normalizeAssertion(raw);
        if (!norm.ok) { refused.push(refusal(index, raw, 'ASSERTION_INVALID', norm.error)); return; }
        const a = norm.assertion;
        if (a.op === 'matches') {
          refused.push(refusal(index, raw, 'REGEX_ASSERTION', 'Regular-expression assertions are not part of the closed language.')); return;
        }
        if (typeof a.expected === 'string' && a.expected.includes(SECRET_PLACEHOLDER)) {
          refused.push(refusal(index, raw, 'SECRET_IN_ASSERTION', 'Assertion repeats a redacted secret value.')); return;
        }
        let t;
        if (a.kind !== 'url') { t = needLocator(); if (!t) return; }
        if (a.kind === 'url') {
          out.push({ id: nextId(), type: 'assert', kind: 'url', op: a.op, expected: String(a.expected) });
        } else if (a.kind === 'visible') {
          out.push({ id: nextId(), type: 'assert', target: t, kind: 'visible', op: 'equals', expected: 'visible' });
        } else if (a.kind === 'exists') {
          out.push({ id: nextId(), type: 'assert', target: t, kind: 'exists', op: 'equals', expected: 'exists' });
        } else if (a.kind === 'count') {
          out.push({ id: nextId(), type: 'assert', target: t, kind: 'count', op: a.op, expected: String(a.expected) });
        } else {
          out.push({ id: nextId(), type: 'assert', target: t, kind: 'text', op: a.op, expected: String(a.expected) });
        }
        return;
      }
      default:
        refused.push(refusal(index, raw, 'UNKNOWN_STEP_TYPE', `Step type "${String(type).slice(0, 40)}" is not supported (closed language).`));
    }
  });

  if (refused.length) return fail();

  const candidate = { schemaVersion: SCHEMA_VERSION, skillId, version, inputKeys, maxDurationMs, steps: out };
  const checked = safeValidateWorkflow(candidate);
  if (!checked.ok) {
    for (const issue of checked.issues) refused.push({ stepIndex: -1, type: 'plan', code: 'PLAN_INVALID', reason: issue });
    return fail();
  }
  return { ok: true, plan: checked.plan, digest: digestOf(checked.plan), suggestedInputs, refused, dropped, warnings };
}

module.exports = {
  SCHEMA_VERSION, Workflow, validateWorkflow, safeValidateWorkflow,
  canonicalJson, digestOf, sha256, workflowDigest, inputDigest,
  describeEffects, requiredCapabilities, diffWorkflows, recordingToWorkflow, locateStep,
  target, KEYS, ASSERT_KINDS,
};
