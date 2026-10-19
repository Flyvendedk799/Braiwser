// General-purpose redaction for agent-runtime output (observations, receipts,
// manifests, ledger summaries, public errors). Complements src/shared/redact.js,
// which only knows recorded-journey steps. Pure CommonJS, no Electron.
//
// This is defence in depth, NOT a guarantee: visible page text can contain a
// secret nothing here can recognise. Callers must still keep secret field
// values out of observations at the driver.
'use strict';

const REDACTED = '[redacted]';
const MAX_STRING = 2000;
const MAX_DEPTH = 8;
const MAX_ARRAY = 200;
const MAX_KEYS = 100;

const SENSITIVE_KEY = /passw|passphrase|secret|token|authoriz|cookie|api[-_]?key|private[-_]?key|credential|otp|cvv|cvc|csrf|xsrf|\bssn\b|card[-_]?n|bearer|signature|session[-_]?(token|cookie|secret)/i;
const SENSITIVE_PARAM = /./; // every query value is dropped; names are kept

const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ' + REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(pass(?:word|wd|code|phrase)?|pwd|secret|token|api[-_]?key|otp)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=' + REDACTED],
];

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol === 'data:' || u.protocol === 'javascript:' || u.protocol === 'blob:') return `${u.protocol}${REDACTED}`;
  const base = u.protocol === 'file:' ? `file://${u.pathname}` : `${u.origin}${u.pathname}`;
  if (!u.search) return base;
  const names = [...u.searchParams.keys()].slice(0, 20).map((k) => `${encodeURIComponent(k).slice(0, 40)}=${REDACTED}`);
  return `${base}?${names.join('&')}`;
}

function createRedactor({ secrets = [] } = {}) {
  const known = new Set();
  const forms = [];
  function addSecret(value, { minimumLength = 4 } = {}) {
    if (typeof value !== 'string' || value.length < minimumLength || known.has(value)) return;
    known.add(value);
    forms.push(value, encodeURIComponent(value), Buffer.from(value).toString('base64'));
    forms.sort((a, b) => b.length - a.length);
  }
  secrets.forEach(addSecret);

  function text(input, max = MAX_STRING) {
    let s = typeof input === 'string' ? input : String(input == null ? '' : input);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    for (const f of forms) if (f && s.includes(f)) s = s.split(f).join(REDACTED);
    s = s.replace(/\b[a-z][a-z0-9+.-]{1,12}:\/\/[^\s"'<>]+/gi, (m) => {
      const out = redactUrl(m);
      return out == null ? REDACTED : out;
    });
    s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
      const d = m.replace(/[ -]/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d) ? REDACTED : m;
    });
    for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
    // long opaque strings that mix letters and digits look like keys
    s = s.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? REDACTED : m));
    for (const f of forms) if (f && s.includes(f)) s = s.split(f).join(REDACTED);
    return s.length > max ? s.slice(0, Math.max(0, max - 12)) + '…[truncated]' : s;
  }

  function value(input, depth = 0, seen = new WeakSet()) {
    if (input == null || typeof input === 'boolean' || typeof input === 'number') {
      return typeof input === 'number' && !Number.isFinite(input) ? null : input;
    }
    if (typeof input === 'string') return text(input);
    if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint') return undefined;
    if (input instanceof Uint8Array) return `[binary ${input.length} bytes]`;
    if (depth >= MAX_DEPTH) return '[max-depth]';
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) {
      const out = input.slice(0, MAX_ARRAY).map((x) => value(x, depth + 1, seen));
      if (input.length > MAX_ARRAY) out.push(`[${input.length - MAX_ARRAY} more]`);
      return out;
    }
    const out = {};
    let n = 0;
    for (const k of Object.keys(input)) {
      if (n++ >= MAX_KEYS) { out['[more]'] = true; break; }
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : value(input[k], depth + 1, seen);
    }
    return out;
  }

  return Object.freeze({ text, value, url: redactUrl, addSecret, REDACTED });
}

const defaultRedactor = createRedactor();

module.exports = { createRedactor, redactUrl, redactText: defaultRedactor.text, redactValue: defaultRedactor.value, REDACTED, SENSITIVE_KEY, SENSITIVE_PARAM };
