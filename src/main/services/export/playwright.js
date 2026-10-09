// Playwright exporter — turns a recorded journey into a runnable spec file.
//
// A journey recorded in Braiwser is already a precise, selector-anchored step
// list with assertions; this renders it as idiomatic @playwright/test code so
// the review artefact becomes a real regression test in the user's repo.
//
// This is a COMPILER with a closed input schema (CE-03). Recording data is
// untrusted (imports, old builds), so:
//   - step types, assertion kinds/ops and input controls are strict enums; a
//     step outside the schema is never turned into code - it becomes an explicit
//     `throw` in the spec (so a journey with a hole can never go green) and an
//     entry in the returned `skipped` list (or an error, with { strict: true });
//   - every user-supplied string reaches the output through JSON.stringify
//     (line terminators U+2028/2029 additionally escaped) - never concatenated;
//   - the only user-derived text allowed in a comment is safeLine(): one line of
//     printable ASCII;
//   - numbers are emitted only after Number.isFinite checks.
// Assertion semantics come from src/shared/assertions.js (CE-07). Secret values
// are never emitted; a runtime placeholder reads process.env (CE-01).
// Pure function, no I/O.

const { normalizeAssertion, controlOfStep, STEP_TYPES } = require('../../../shared/assertions');
const { scrubRecording, safeLine } = require('./scrub');

const NAV = 'navigate';
const ASSERT_TIMEOUT = 5000;
const MAX_STEPS = 5000;
const MAX_SELECTOR = 2000;
const MAX_VALUE = 100000;
const MAX_MULTI = 200;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const KEY_RE = /^[A-Za-z0-9]{1,24}(\+[A-Za-z0-9]{1,24}){0,3}$/;

const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');

// The ONLY way user text becomes a JS literal in generated code.
function quote(value) {
  return JSON.stringify(String(value == null ? '' : value)).replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
}

function loc(selector) {
  return `page.locator(${quote(selector)})`;
}

function testName(recording) {
  const n = recording && typeof recording.name === 'string' ? recording.name.trim() : '';
  return n.slice(0, 200) || 'recorded journey';
}

function specFileName(recording) {
  const slug = String(testName(recording))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'journey'}.spec.js`;
}

function escapeRegex(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class Unsupported extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function bad(reason) { throw new Unsupported(reason); }

function checkSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) bad('missing selector');
  if (selector.length > MAX_SELECTOR) bad('selector is too long');
  return selector;
}

function checkUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 8000) bad('missing or invalid url');
  let parsed;
  try { parsed = new URL(url); } catch (_e) { bad('url is not absolute'); }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) bad('url scheme is not allowed');
  return url;
}

function finiteNumber(v, label) {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) bad(`${label} is not a finite number`);
  return v;
}

// Env var a secret step reads at run time: BRAIWSER_SECRET_<NAME>.
function secretEnvName(step, used) {
  const sel = typeof step.selector === 'string' ? step.selector : '';
  const idMatch = /#([A-Za-z0-9_-]{1,40})/.exec(sel) || /\[name=["']?([A-Za-z0-9_-]{1,40})/.exec(sel);
  const raw = (typeof step.name === 'string' && step.name) || (idMatch && idMatch[1]) || '';
  let name = String(raw).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!name) name = 'FIELD';
  let candidate = `BRAIWSER_SECRET_${name}`;
  const owner = used.get(candidate);
  if (owner !== undefined && owner !== sel) {
    let n = 2;
    while (used.has(`${candidate}_${n}`) && used.get(`${candidate}_${n}`) !== sel) n += 1;
    candidate = `${candidate}_${n}`;
  }
  used.set(candidate, sel);
  return candidate;
}

function assertLines(step) {
  const n = normalizeAssertion(step);
  if (!n.ok) bad(n.error);
  const { kind, op, selector, expected } = n.assertion;
  const t = `{ timeout: ${ASSERT_TIMEOUT} }`;
  switch (kind) {
    case 'exists':
      // >= 1 match (shared spec); .first() keeps strict mode quiet for multi-match.
      return [`  await expect(${loc(selector)}.first()).toBeAttached(${t});`];
    case 'visible':
      return [`  await expect(${loc(selector)}.first()).toBeVisible(${t});`];
    case 'count':
      if (op === 'contains') {
        return [`  await expect.poll(() => ${loc(selector)}.count(), ${t}).toBeGreaterThanOrEqual(${expected});`];
      }
      return [`  await expect(${loc(selector)}).toHaveCount(${expected}, ${t});`];
    case 'text':
      if (op === 'equals') {
        return [`  await expect(${loc(selector)}.first()).toHaveText(${quote(expected)}, { useInnerText: true, timeout: ${ASSERT_TIMEOUT} });`];
      }
      if (op === 'matches') {
        // The shared spec tests regexes against whitespace-normalised text.
        return [`  await expect.poll(async () => normText(await ${loc(selector)}.first().innerText({ timeout: ${ASSERT_TIMEOUT} })), ${t}).toMatch(new RegExp(${quote(expected)}));`];
      }
      return [`  await expect(${loc(selector)}.first()).toContainText(${quote(expected)}, { ignoreCase: true, useInnerText: true, timeout: ${ASSERT_TIMEOUT} });`];
    case 'url':
      if (op === 'equals') return [`  await expect(page).toHaveURL(${quote(expected)}, ${t});`];
      if (op === 'matches') return [`  await expect(page).toHaveURL(new RegExp(${quote(expected)}), ${t});`];
      return [`  await expect(page).toHaveURL(new RegExp(${quote(escapeRegex(expected))}, 'i'), ${t});`];
    default:
      return bad('unsupported assertion kind');
  }
}

function inputLines(step, ctx) {
  const selector = checkSelector(step.selector);
  const control = controlOfStep(step);
  const target = `${loc(selector)}.first()`;
  switch (control) {
    case 'secret': {
      const env = secretEnvName(step, ctx.secretNames);
      ctx.secretList.add(env);
      return [`  await ${target}.fill(secretFromEnv(${quote(env)}));`];
    }
    case 'checkbox': {
      if (typeof step.value !== 'boolean') bad('checkbox step has no boolean value');
      return [`  await ${target}.setChecked(${step.value ? 'true' : 'false'});`];
    }
    case 'radio': {
      if (typeof step.value !== 'boolean') bad('radio step has no boolean value');
      return step.value
        ? [`  await ${target}.check();`]
        : ['  // (a radio button cannot be unchecked; nothing to replay)'];
    }
    case 'select': {
      if (typeof step.value !== 'string' && typeof step.value !== 'number') bad('select step has no value');
      return [`  await ${target}.selectOption(${quote(step.value)});`];
    }
    case 'multiselect': {
      const values = Array.isArray(step.value) ? step.value : typeof step.value === 'string' ? [step.value] : null;
      if (!values || values.length > MAX_MULTI || values.some((v) => typeof v !== 'string' && typeof v !== 'number')) {
        bad('multiselect step has no valid values');
      }
      return [`  await ${target}.selectOption([${values.map(quote).join(', ')}]);`];
    }
    case 'text':
    default: {
      const v = step.value;
      if (v != null && typeof v !== 'string' && typeof v !== 'number') bad('text step has no text value');
      const text = v == null ? '' : String(v);
      if (text.length > MAX_VALUE) bad('text value is too long');
      return [`  await ${target}.fill(${quote(text)});`];
    }
  }
}

function stepLines(step, ctx) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) bad('step is not an object');
  const type = step.type;
  if (typeof type !== 'string' || !STEP_TYPES.includes(type)) bad('unknown step type');
  switch (type) {
    case NAV:
      return [`  await page.goto(${quote(checkUrl(step.url))});`];
    case 'click':
      return [`  await ${loc(checkSelector(step.selector))}.first().click();`];
    case 'input':
      return inputLines(step, ctx);
    case 'key': {
      const key = step.key == null || step.key === '' ? 'Enter' : step.key;
      if (typeof key !== 'string' || !KEY_RE.test(key)) bad('unsupported key');
      return [`  await ${loc(checkSelector(step.selector))}.first().press(${quote(key)});`];
    }
    case 'scroll':
      return [`  await page.evaluate(() => window.scrollTo(${finiteNumber(step.x, 'scroll x')}, ${finiteNumber(step.y, 'scroll y')}));`];
    case 'assert':
      return assertLines(step);
    default:
      return bad('unknown step type');
  }
}

// recording: { name, startUrl, steps[] }
// opts: { strict } - throw instead of emitting a `throw` for unsupported steps.
// returns { defaultName, content, skipped:[{index,type,reason}], secrets:[ENV_NAMES] }
function toPlaywrightSpec(recording, opts = {}) {
  const rec = scrubRecording(recording) || {};
  const rawSteps = Array.isArray(rec.steps) ? rec.steps : [];
  const steps = rawSteps.slice(0, MAX_STEPS);
  const ctx = { secretNames: new Map(), secretList: new Set() };
  const skipped = [];
  const body = [];

  if (rawSteps.length > MAX_STEPS) skipped.push({ index: MAX_STEPS, type: '', reason: `journey has more than ${MAX_STEPS} steps; the rest were not exported` });

  const emit = (index, step, fn) => {
    try {
      body.push(...fn());
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      const type = step && typeof step.type === 'string' ? safeLine(step.type, 30) : '';
      skipped.push({ index, type, reason: err.reason });
      // A hole in the journey must fail visibly, never pass silently.
      const label = index < 0 ? 'start url' : `step ${index + 1}${type ? ` (${type})` : ''}`;
      body.push(`  throw new Error(${quote(`Braiwser export: ${label} is not supported and was not exported - ${err.reason}`)});`);
    }
  };

  if (!steps.length) {
    body.push('  // This journey has no steps yet.');
  } else {
    // A journey always starts somewhere; if the first step is not a navigate,
    // fall back to the recorded startUrl so the spec is self-contained.
    const first = steps[0];
    if (!(first && first.type === NAV) && rec.startUrl) {
      emit(-1, null, () => [`  await page.goto(${quote(checkUrl(rec.startUrl))});`]);
    }
    steps.forEach((step, i) => emit(i, step, () => stepLines(step, ctx)));
  }

  if (skipped.length && opts.strict) {
    const err = new Error(`Journey has ${skipped.length} unsupported step(s) and cannot be exported: ` +
      skipped.slice(0, 5).map((s) => `#${s.index + 1} ${s.reason}`).join('; '));
    err.code = 'UNSUPPORTED_STEPS';
    err.skipped = skipped;
    throw err;
  }

  const needsNorm = body.some((l) => l.includes('normText('));
  const secrets = Array.from(ctx.secretList);
  const out = [];
  out.push('// Generated by Braiwser from the recorded journey ' + safeLine(testName(rec), 80) + '.');
  out.push('// Run with:  npx playwright test');
  if (secrets.length) {
    out.push('// Secret values are never exported. Set these environment variables before running:');
    for (const s of secrets) out.push('//   ' + s);
  }
  if (skipped.length) {
    out.push('// UNSUPPORTED steps were not exported; the test fails at each of them:');
    for (const s of skipped.slice(0, 20)) {
      out.push('//   ' + (s.index < 0 ? 'start url' : `step ${s.index + 1}`) + (s.type ? ` (${s.type})` : '') + ': ' + safeLine(s.reason, 100));
    }
  }
  out.push("import { test, expect } from '@playwright/test';");
  out.push('');
  if (secrets.length) {
    out.push('function secretFromEnv(name) {');
    out.push('  const value = process.env[name];');
    out.push("  if (value === undefined) throw new Error('Set the ' + name + ' environment variable to replay this journey.');");
    out.push('  return value;');
    out.push('}');
    out.push('');
  }
  if (needsNorm) {
    out.push("const normText = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();");
    out.push('');
  }
  out.push(`test(${quote(testName(rec))}, async ({ page }) => {`);
  out.push(...body);
  out.push('});');
  out.push('');
  return { defaultName: specFileName(rec), content: out.join('\n'), skipped, secrets };
}

// Raw journey JSON, for archiving or re-import. Secret values are scrubbed.
function toRecordingJson(recording) {
  const rec = scrubRecording(recording) || {};
  return {
    defaultName: (specFileName(rec).replace(/\.spec\.js$/, '') || 'journey') + '.json',
    content: JSON.stringify({ recording: rec, exportedAt: new Date().toISOString() }, null, 2),
  };
}

module.exports = { toPlaywrightSpec, toRecordingJson, specFileName, quote };
