// Export-side secret scrubbing (CE-01) and generated-text hygiene (CE-03).
//
// Every exporter (Playwright spec, raw JSON, recording report, project bundle)
// passes recordings through scrubRecording() before it reads a single field.
// This is the SECOND redaction boundary after the guest recorder / repository
// write path (src/shared/redact.js): a recording stored by an older build, an
// imported bundle or a buggy capture still cannot emit a credential here.
//
// Pure functions; no I/O.

const { redactRecording, isSecretStep, SECRET_PLACEHOLDER } = require('../../../shared/redact');

const MIN_SECRET_LEN = 4;
const VALUE_KEYS = ['value', 'oldValue', 'previousValue', 'newValue', 'inputValue', 'typed', 'text_value'];

// Plaintext secret values present on the ORIGINAL steps (before redaction).
function collectSecretValues(steps) {
  const out = new Set();
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    if (!isSecretStep(s)) continue;
    for (const k of VALUE_KEYS) {
      const v = s[k];
      if (typeof v === 'string' && v.length >= MIN_SECRET_LEN) out.add(v);
    }
  }
  return out;
}

// Replace every occurrence of any secret value inside any string of a plain
// JSON-ish structure. Returns the same reference when nothing changed.
function scrubDeep(node, secrets, depth = 0) {
  if (!secrets.size || depth > 12) return node;
  if (typeof node === 'string') {
    let out = node;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join(SECRET_PLACEHOLDER);
    return out;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((x) => { const r = scrubDeep(x, secrets, depth + 1); if (r !== x) changed = true; return r; });
    return changed ? next : node;
  }
  if (node && typeof node === 'object') {
    let copy = null;
    for (const [k, v] of Object.entries(node)) {
      const r = scrubDeep(v, secrets, depth + 1);
      if (r !== v) { if (!copy) copy = { ...node }; copy[k] = r; }
    }
    return copy || node;
  }
  return node;
}

// recording: a stored recording (or an imported one). Returns a copy that is safe
// to export: secret steps carry no value, and no string anywhere (lastRun results,
// names, urls ...) repeats a secret value that was present on the way in.
function scrubRecording(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const secrets = collectSecretValues(rec.steps);
  const redacted = redactRecording(rec);
  return scrubDeep(redacted, secrets);
}

const NON_PRINTABLE = new RegExp('[^\\x20-\\x7e]+', 'g');

// One safe, single-line, printable-ASCII fragment for use inside a generated
// comment or message. Never contains a line terminator (incl. U+2028/2029),
// control characters, or non-ASCII at all.
function safeLine(value, max = 120) {
  const s = String(value == null ? '' : value).replace(NON_PRINTABLE, '?').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}

module.exports = { scrubRecording, scrubDeep, collectSecretValues, safeLine, SECRET_PLACEHOLDER };
