'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECRET_PLACEHOLDER, isSecretStep, redactStep, redactSteps, redactRecording, recordingHasSecrets,
} = require('../../src/shared/redact');

const PW = 'S3cret-synthetic-pw!';

test('secret:true step loses its value and gets the runtime placeholder', () => {
  const step = { type: 'input', selector: '#pw', value: PW, secret: true, tag: 'input', text: 'Password' };
  const out = redactStep(step);
  assert.equal(out.secret, true);
  assert.equal(out.placeholder, SECRET_PLACEHOLDER);
  assert.equal('value' in out, false);
  assert.equal(out.selector, '#pw');
  assert.ok(!JSON.stringify(out).includes(PW));
  assert.equal(step.value, PW, 'input is not mutated');
});

test('detects secrets by input type, autocomplete, selector and label even without the flag', () => {
  assert.ok(isSecretStep({ type: 'input', inputType: 'password', value: PW }));
  assert.ok(isSecretStep({ type: 'input', autocomplete: 'current-password', value: PW }));
  assert.ok(isSecretStep({ type: 'input', autocomplete: 'section-x one-time-code', value: '123456' }));
  assert.ok(isSecretStep({ type: 'input', selector: 'input[type="password"]', value: PW }));
  assert.ok(isSecretStep({ type: 'input', selector: '#x', text: 'Card number', value: '4111' }));
  assert.ok(!isSecretStep({ type: 'input', selector: '#email', text: 'Email', value: 'a@b.c' }));
  assert.ok(!isSecretStep({ type: 'click', selector: '#login', text: 'Password reset' }));
  assert.ok(!isSecretStep(null));
});

test('non-secret steps keep identity so callers can detect "unchanged"', () => {
  const step = { type: 'input', selector: '#name', value: 'Ada' };
  assert.equal(redactStep(step), step);
  const steps = [step, { type: 'click', selector: '#go' }];
  assert.equal(redactSteps(steps), steps);
});

test('redaction is idempotent and coalesced replacement steps are covered', () => {
  const replace = { type: 'input', selector: '#pw', value: PW + '2', secret: true, replaceLast: true };
  const once = redactStep(replace);
  assert.equal(once.replaceLast, true);
  assert.deepEqual(redactStep(once), once);
  assert.ok(!JSON.stringify(once).includes(PW));
});

test('verbatim repeats of a secret value elsewhere in the recording are scrubbed', () => {
  const steps = [
    { type: 'input', selector: '#pw', value: PW, secret: true },
    { type: 'assert', kind: 'text', selector: '#echo', expected: PW },
    { type: 'input', selector: '#name', value: 'Ada' },
  ];
  const out = redactSteps(steps);
  assert.ok(!JSON.stringify(out).includes(PW));
  assert.equal(out[1].expected, SECRET_PLACEHOLDER);
  assert.equal(out[2], steps[2]);
});

test('redactRecording / recordingHasSecrets', () => {
  const rec = { id: 'r', name: 'Login', steps: [{ type: 'input', selector: '#pw', value: PW, secret: true }] };
  assert.ok(recordingHasSecrets(rec));
  const clean = redactRecording(rec);
  assert.ok(!recordingHasSecrets(clean));
  assert.equal(clean.name, 'Login');
  assert.equal(redactRecording(clean), clean);
});
