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

module.exports = {
  SECRET_PLACEHOLDER,
  isSecretStep,
  redactStep,
  redactSteps,
  redactRecording,
  recordingHasSecrets,
};
