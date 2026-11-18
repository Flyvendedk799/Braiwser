// Shared secret redaction for recorded journeys (audit CE-01).
//
// A recorded text-entry step carries `value`. When the field is a secret
// (password, one-time code, card number …) that value must never reach disk,
// an export, a bundle or a log. This module is the SECOND boundary: the guest
// recorder should already omit the value before the first IPC emission, but the
// repository write path, import, and every exporter run steps through here too,
// so a record produced by an older build, an imported bundle or a buggy
// capture can't smuggle a credential through.
//
// Redacted step shape (exact):
//
//   { ...otherFields, type:'input', secret:true, placeholder:'{{secret}}' }
//
// i.e. `secret: true`, NO `value` key at all (JSON can't carry `undefined`, and
// we delete rather than set it so `'value' in step === false`), and
// `placeholder: SECRET_PLACEHOLDER`. Replay / generated specs substitute the
// placeholder with a runtime-supplied secret (or type nothing); the placeholder
// itself is not a credential.
//
// CommonJS on purpose: usable from main, the webview preload and tests.
'use strict';

const SECRET_PLACEHOLDER = '{{secret}}';

// `autocomplete` tokens whose value is a credential or payment datum.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-type',
  'cc-name',
  'cc-given-name',
  'cc-additional-name',
  'cc-family-name',
  'transaction-amount',
]);

// Field names / labels / selectors that name a credential. Deliberately narrow:
// a false positive only drops a replay value, a false negative leaks a secret.
const SENSITIVE_HINT =
  /pass(?:word|wd|code|phrase)|\bpwd\b|\botp\b|one[-_ ]?time[-_ ]?(?:code|pass)|\bcvv\b|\bcvc\b|\bcsc\b|card[-_ ]?(?:number|no)\b|\bsecret\b|\bssn\b|\bpin[-_ ]?code\b/i;

// Keys under which a captured value may travel besides `value`.
const VALUE_KEYS = ['value', 'oldValue', 'previousValue', 'newValue', 'inputValue', 'typed', 'text_value'];

function str(v) {
  return typeof v === 'string' ? v : '';
}

function autocompleteTokens(v) {
  return str(v).toLowerCase().split(/\s+/).filter(Boolean);
}

// Is this step a text entry into a secret field?
function isSecretStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.secret === true || step.secret === 'true' || step.secret === 1) return true;
  // Everything below only applies to value-bearing entries.
  const type = str(step.type).toLowerCase();
  const isEntry = type === 'input' || type === 'fill' || type === 'type' || type === 'change' || type === 'select';
  if (!isEntry) return false;

  const inputTypes = [step.inputType, step.fieldType, step.elementType, step.targetType,
    step.target && step.target.type, step.target && step.target.inputType];
  if (inputTypes.some((t) => str(t).toLowerCase() === 'password')) return true;

  const ac = [step.autocomplete, step.autoComplete, step.target && step.target.autocomplete];
  if (ac.some((a) => autocompleteTokens(a).some((tok) => SENSITIVE_AUTOCOMPLETE.has(tok)))) return true;

  // `[type=password]` / `[type="password"]` inside a recorded selector.
  if (/\[\s*type\s*=\s*["']?password["']?\s*\]/i.test(str(step.selector))) return true;
  // Names / labels / ids hinting at a credential.
  const hints = [step.name, step.fieldName, step.label, step.text, step.placeholderText, step.ariaLabel,
    step.target && step.target.name, step.target && step.target.label];
  if (hints.some((h) => SENSITIVE_HINT.test(str(h)))) return true;
  if (SENSITIVE_HINT.test(str(step.selector))) return true;
  return false;
}

// Returns a step safe to persist. Non-secret steps are returned AS-IS (same
// reference) so callers can cheaply detect "nothing changed".
function redactStep(step) {
  if (!isSecretStep(step)) return step;
  // Already redacted: keep identity so "nothing changed" stays detectable.
  if (step.secret === true && step.placeholder === SECRET_PLACEHOLDER && !VALUE_KEYS.some((k) => k in step)) return step;
  const out = { ...step };
  for (const k of VALUE_KEYS) delete out[k];
  out.secret = true;
  out.placeholder = SECRET_PLACEHOLDER;
  return out;
}

// Array form; returns the SAME array when no step needed redaction. Also scrubs
// any other string field that exactly repeats a secret value seen earlier in
// the same recording (an assertion's `expected`, a pasted URL …).
function redactSteps(steps) {
  if (!Array.isArray(steps)) return steps;
  const secrets = new Set();
  for (const s of steps) {
    if (isSecretStep(s)) {
      for (const k of VALUE_KEYS) {
        if (typeof s[k] === 'string' && s[k].length >= 4) secrets.add(s[k]);
      }
    }
  }
  let changed = false;
  const out = steps.map((s) => {
    let r = redactStep(s);
    if (secrets.size && r && typeof r === 'object' && r === s) {
      // Not itself secret: look for verbatim repeats of a secret value.
      let copy = null;
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'string' && secrets.has(v)) {
          if (!copy) copy = { ...s };
          copy[k] = SECRET_PLACEHOLDER;
        }
      }
      if (copy) r = copy;
    }
    if (r !== s) changed = true;
    return r;
  });
  return changed ? out : steps;
}

// Recording-level form. Returns the same object when untouched.
function redactRecording(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const steps = redactSteps(rec.steps);
  return steps === rec.steps ? rec : { ...rec, steps };
}

// True when the recording still holds a plaintext secret value.
function recordingHasSecrets(rec) {
  return !!rec && redactRecording(rec) !== rec;
}

// ---- guest console capture ---------------------------------------------------
// Console messages and load errors captured from the page travel into the agent
// hand-off, the prompt/markdown exports and prompt templates. A page logs
// whatever it likes (`console.error('auth failed', token)`, a failing request
// URL with a signed query string), so every entry passes through here before it
// is written anywhere. The shape is rebuilt from scratch — only `level`, `kind`
// and a redacted, length-capped `message` survive — and the list is bounded to
// the most recent entries, because the caller is the renderer and its payload
// is not trusted to be small or well-formed.
//
// The text redactor lives in browser-redact.js and is required lazily: it is only
// needed where console output is written (the main process), and recorded-step
// redaction above stays dependency-free.
const CONSOLE_MAX_ENTRIES = 50;
const CONSOLE_MAX_MESSAGE = 500;
const CONSOLE_KIND = /^[a-z][a-z-]{0,23}$/;

// Same shape browser-redact.js recognises as a URL.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s"'<>]+/gi;
// Stand-in for a URL while the rest of the message is redacted. The brackets are
// removed from the input first, so a page cannot forge one.
const HOLD_OPEN = '⟦';
const HOLD_CLOSE = '⟧';
const HOLD = /⟦U(\d+)⟧/g;

// The text redactor treats any 32+ character run of [A-Za-z0-9+/_-] holding a
// letter and a digit as a key. `/` is in that class, so an ordinary script URL
// (`/src/components/checkout/PaymentStep2.tsx:14:9`) is swallowed whole — and
// where an error came from is exactly what the agent needs from a console line.
// URLs are therefore redacted on their own: query values dropped as usual, and
// each path segment judged separately (a token in a path is still caught).
function redactConsoleText(raw, max) {
  const { redactText, redactUrl, REDACTED } = require('./browser-redact');
  const held = [];
  // eslint-disable-next-line no-control-regex
  const input = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f⟦⟧]/g, '');
  const masked = input.replace(URL_IN_TEXT, (m) => {
    const url = redactUrl(m);
    if (url == null) return REDACTED;
    held.push(url.split('/').map((seg) => redactText(seg)).join('/'));
    return `${HOLD_OPEN}U${held.length - 1}${HOLD_CLOSE}`;
  });
  const out = redactText(masked, masked.length + 64) // no truncation here: it could cut a stand-in in half
    .replace(HOLD, (_m, i) => held[Number(i)] || '')
    .replace(/[⟦⟧]/g, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return out.length > max ? out.slice(0, Math.max(0, max - 1)) + '…' : out;
}

function redactConsoleEntry(entry, { maxMessage = CONSOLE_MAX_MESSAGE } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = typeof entry.message === 'string' ? entry.message : entry.message == null ? '' : String(entry.message);
  // Cap the input before the regex passes so a multi-megabyte log line is cheap.
  const message = redactConsoleText(raw.slice(0, maxMessage * 4), maxMessage);
  if (!message) return null;
  const out = { message };
  const level = Number(entry.level);
  if (Number.isInteger(level) && level >= 0 && level <= 3) out.level = level;
  if (typeof entry.kind === 'string' && CONSOLE_KIND.test(entry.kind)) out.kind = entry.kind;
  return out;
}

// Returns a NEW array of at most `maxEntries` redacted entries (the most recent).
function redactConsoleLog(entries, { maxEntries = CONSOLE_MAX_ENTRIES, maxMessage = CONSOLE_MAX_MESSAGE } = {}) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries.slice(-maxEntries)) {
    const r = redactConsoleEntry(e, { maxMessage });
    if (r) out.push(r);
  }
  return out;
}

module.exports = {
  CONSOLE_MAX_ENTRIES,
  CONSOLE_MAX_MESSAGE,
  redactConsoleEntry,
  redactConsoleLog,
  SECRET_PLACEHOLDER,
  isSecretStep,
  redactStep,
  redactSteps,
  redactRecording,
  recordingHasSecrets,
};
