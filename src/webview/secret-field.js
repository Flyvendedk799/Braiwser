// Braiwser — secret-field.js
// Decides, from an element's *attributes only*, whether a form control holds a
// credential or payment datum. It never reads `.value`: the recorder must be
// able to classify a field before it is allowed to look at what was typed (CE-01).
//
// Deliberately biased to fail closed — a false positive costs a replay value
// the user can bind at run time, a false negative leaks a credential into a
// journey, an export or a bundle.

'use strict';

// autocomplete tokens whose value is a credential or a payment/identity datum.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'transaction-amount',
]);

// Words that name a secret in a field's name / id / label / placeholder.
// camelCase is split first ("cardNumber" -> "card number").
const SECRET_WORDS =
  /(?:^|[^a-z0-9])(?:pass(?:word|wd|code|phrase)?|pwd|otp|totp|hotp|2fa|mfa|pin|cvv|cvc|csc|secret|ssn|iban|(?:card|cc)[\s_-]*(?:number|num|no|exp\w*|cvv|cvc|csc)|(?:security|verification|auth(?:entication)?|one[\s_-]?time|backup|recovery|sms|login)[\s_-]*(?:code|token)|api[\s_-]*key|access[\s_-]*token|private[\s_-]*key)(?:[^a-z0-9]|$)/i;

function words(v) {
  return String(v == null ? '' : v)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function attr(el, name) {
  try {
    return el.getAttribute ? el.getAttribute(name) : null;
  } catch (_e) {
    return null;
  }
}

// -> reason string when the control is (probably) secret, else null.
function secretReason(el) {
  try {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.nodeName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;

    const type = String(attr(el, 'type') || el.type || '').toLowerCase();
    if (type === 'password') return 'password-type';
    // Controls that cannot carry typed text (only a boolean / a fixed choice).
    if (/^(checkbox|radio|range|color|file|button|submit|reset|image|hidden)$/.test(type)) return null;

    const tokens = String(attr(el, 'autocomplete') || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    for (const tok of tokens) {
      if (SENSITIVE_AUTOCOMPLETE.has(tok)) return 'autocomplete:' + tok;
      if (tok.indexOf('cc-') === 0) return 'autocomplete:' + tok;
    }

    // An input rendered like a password (masking) is a password.
    try {
      const mask = (el.style && (el.style.webkitTextSecurity || el.style.getPropertyValue('-webkit-text-security'))) || '';
      if (mask && mask !== 'none') return 'masked-text';
    } catch (_e) {
      /* ignore */
    }

    // Names/labels. Text content of the control itself is deliberately NOT
    // consulted (a textarea's text is its value).
    const hay = [
      attr(el, 'name'),
      el.id,
      attr(el, 'aria-label'),
      attr(el, 'placeholder'),
      attr(el, 'data-testid'),
      attr(el, 'data-test'),
      attr(el, 'data-cy'),
      attr(el, 'data-qa'),
    ];
    // An associated <label>'s text names the field too.
    try {
      if (el.labels && el.labels.length) {
        for (const l of el.labels) hay.push(l.textContent);
      }
    } catch (_e) {
      /* ignore */
    }
    for (const h of hay) {
      if (h && SECRET_WORDS.test(words(h))) return 'name-hint';
    }
    return null;
  } catch (_e) {
    // Cannot classify -> treat as secret rather than risk a leak.
    return 'unclassifiable';
  }
}

function isSecretField(el) {
  return secretReason(el) !== null;
}

module.exports = { isSecretField, secretReason };
