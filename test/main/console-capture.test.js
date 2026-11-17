'use strict';
// Guest console capture on its way out of the app: every path (prompt export,
// markdown export, the agent hand-off file, prompt templates) renders the
// capture through format/console.js, which redacts and bounds it via
// src/shared/redact.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactConsoleEntry, redactConsoleLog, CONSOLE_MAX_ENTRIES, CONSOLE_MAX_MESSAGE } = require('../../src/shared/redact');
const { consoleLines } = require('../../src/main/services/format/console');
const { buildExport } = require('../../src/main/services/export');
const { writeRequest } = require('../../src/main/services/agent/handoff');
const { applyTemplate, AGENT_PRESETS } = require('../../src/main/services/agent/templates');

// Synthetic credentials, shaped like the real thing.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXN5bnRoZXRpYw';
const KEY = 'sk-synthetic0123456789abcdef';
const PW = 'hunter2-synthetic';
const SECRETS = [JWT, KEY, PW, 'code-synthetic-9f3a'];

const NOISY = [
  { level: 3, message: `auth failed: Authorization: Bearer ${JWT}` },
  { level: 3, message: `login rejected password=${PW} for ada@example.test` },
  { level: 2, message: `fetch failed with api_key: "${KEY}"` },
  { kind: 'load-error', message: 'ERR_CONNECTION_REFUSED (-102) http://localhost:3000/cb?code=code-synthetic-9f3a&state=xyz' },
  { level: 3, message: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')\n    at render (http://localhost:3000/static/app.js:12:5)" },
];

const SESSION = { id: 's1', name: 'Checkout review', url: 'http://localhost:3000/' };
const NOTES = [{ id: 'a1', sessionId: 's1', kind: 'element', action: 'fix', note: 'Button is misaligned', url: 'http://localhost:3000/', target: { selector: '#cta', tag: 'button' } }];

function assertNoSecrets(text, where) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} leaked ${s}`);
}

test('console entries are redacted but stay useful to an agent', () => {
  const out = redactConsoleLog(NOISY);
  assert.equal(out.length, NOISY.length);
  assertNoSecrets(JSON.stringify(out), 'redactConsoleLog');
  // What the agent needs survives: the error text, the script location, the failing URL without its query values.
  assert.match(out[4].message, /Cannot read properties of undefined \(reading 'map'\)/);
  assert.match(out[4].message, /http:\/\/localhost:3000\/static\/app\.js:12:5/);
  assert.ok(!/[\r\n]/.test(out[4].message), 'a stack trace is folded onto one line');
  assert.match(out[3].message, /ERR_CONNECTION_REFUSED \(-102\) http:\/\/localhost:3000\/cb\?code=/);
  assert.equal(out[3].kind, 'load-error');
  assert.equal(out[0].level, 3);
  assert.equal(NOISY[0].message.includes(JWT), true, 'input is not mutated');
});

test('script locations survive; secrets inside URLs do not', () => {
  const one = (message) => redactConsoleEntry({ level: 3, message }).message;
  // A deep path is 32+ "key-like" characters to the generic text redactor; it must stay readable here.
  const deep = 'TypeError at http://localhost:3000/src/components/checkout/PaymentStep2.tsx:14:9';
  assert.equal(one(deep), deep);
  const file = 'ERR_FILE_NOT_FOUND (-6) file:///home/ada/projects/shop-frontend-2/build/static/checkout/index.html';
  assert.equal(one(file), file);
  // …while a token in a path segment, a query value, and a slash-bearing key outside a URL are all dropped.
  const token = 'rst' + 'a1B2c3D4'.repeat(5);
  const reset = one(`mail sent: https://app.example.test/reset/${token}/confirm?session=${token}&next=home`);
  assert.equal(reset, 'mail sent: https://app.example.test/reset/[redacted]/confirm?session=[redacted]&next=[redacted]');
  const slashKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYSYNTHETIC1';
  assert.ok(!one(`aws secret ${slashKey} rejected`).includes('K7MDENG'));
  assert.ok(!one(`open ws://user:${PW}@localhost:9000/socket`).includes(PW), 'URL credentials are dropped');
  // The page cannot forge the stand-in the redactor uses for URLs.
  const forged = one('⟦U0⟧ see http://localhost:3000/a.js ⟦U1⟧ ⟦U0⟧');
  assert.equal(forged, 'U0 see http://localhost:3000/a.js U1 U0');
});

test('the capture is bounded: newest entries win, long messages are cut, the shape is rebuilt', () => {
  const many = Array.from({ length: 400 }, (_v, i) => ({ level: 2, message: `warning number ${i}` }));
  const out = redactConsoleLog(many);
  assert.equal(out.length, CONSOLE_MAX_ENTRIES);
  assert.equal(out[out.length - 1].message, 'warning number 399');
  assert.equal(out[0].message, `warning number ${400 - CONSOLE_MAX_ENTRIES}`);

  const long = redactConsoleEntry({ level: 3, message: 'x '.repeat(200000) });
  assert.ok(long.message.length <= CONSOLE_MAX_MESSAGE);

  // Only level / kind / message survive, and only in the expected shapes.
  const odd = redactConsoleEntry({ level: 99, kind: '<img src=x onerror=alert(1)>', message: 'boom', token: KEY, source: `http://x.test/?t=${KEY}` });
  assert.deepEqual(odd, { message: 'boom' });
  assert.deepEqual(redactConsoleLog([null, 7, 'str', { message: '' }, { message: '   ' }, { level: 3 }]), []);
  assert.deepEqual(redactConsoleLog(undefined), []);
  assert.deepEqual(redactConsoleLog({ length: 3 }), []);
});

test('consoleLines renders labelled, redacted bullets and tolerates garbage', () => {
  const lines = consoleLines(NOISY);
  assert.equal(lines.length, NOISY.length);
  assert.match(lines[0], /^- \[error\] /);
  assert.match(lines[2], /^- \[warning\] /);
  assert.match(lines[3], /^- \[load-error\] /);
  assertNoSecrets(lines.join('\n'), 'consoleLines');
  for (const l of lines) assert.ok(l.length <= 320, 'each bullet is short');
  assert.deepEqual(consoleLines(null), []);
  assert.deepEqual(consoleLines('nope'), []);
});

test('prompt and markdown exports carry the console section without the secrets', () => {
  for (const format of ['prompt', 'markdown']) {
    const out = buildExport(format, { session: SESSION, annotations: NOTES, consoleLog: NOISY });
    assert.match(out.content, /Console \/ load errors/, `${format} has the console section`);
    assert.match(out.content, /Cannot read properties of undefined/);
    assertNoSecrets(out.content, `${format} export`);
    // No console entries: no section (the argument stays optional).
    const bare = buildExport(format, { session: SESSION, annotations: NOTES });
    assert.ok(!/Console \/ load errors/.test(bare.content));
  }
});

test('the agent hand-off file and prompt templates carry the redacted console capture', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-console-'));
  try {
    const res = writeRequest({ session: SESSION, annotations: NOTES, project: null, appDir, consoleLog: NOISY });
    const text = fs.readFileSync(res.file, 'utf8');
    assert.match(text, /Console \/ load errors observed on the page/);
    assert.match(text, /\[load-error\] ERR_CONNECTION_REFUSED/);
    assertNoSecrets(text, 'hand-off file');
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  for (const preset of AGENT_PRESETS) {
    const templated = applyTemplate(preset.id, { session: SESSION, annotations: NOTES, project: null, consoleErrors: NOISY });
    assertNoSecrets(String(templated), `template ${preset.id}`);
  }
});
