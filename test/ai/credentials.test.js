// AI-01: absent credentials answer locally and say so; present-but-unusable ones
// fail loudly; the E2E flag no longer bypasses the decision; initialisation is
// single-flight; key-file faults are never reinterpreted as "first run".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('../../src/main/services/ai/auth');
const { runAiTask, cancelAiTask } = require('../../src/main/services/ai');

const never = () => new Promise(() => {});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brw-ai-'));
}

// Credential sources with nothing connected, and a network that must not be used.
function disconnected(extra = {}) {
  return {
    env: {},
    claudeFile: null,
    codexFile: null,
    readKeychain: async () => null,
    readClaudeFile: async () => null,
    readCodexFile: async () => null,
    ...extra,
  };
}

function repos(dir, settings = {}) {
  const annotations = [
    { id: 'a1', sessionId: 's1', kind: 'element', action: 'fix', note: 'Remove this CTA', priority: 'high', status: 'open', target: { selector: '#cta' } },
  ];
  return {
    dir,
    settings: { get: () => ({ aiProvider: 'claude-code', models: {}, aiTimeoutMs: 120000, ...settings }) },
    sessions: { get: () => ({ id: 's1', title: 'Home', url: 'https://example.test' }) },
    annotations: { bySession: () => annotations },
  };
}

const denyNetwork = async () => { throw new Error('network must not be used'); };

test.afterEach(() => {
  auth.configureSources(null);
  delete process.env.BRAIWSER_E2E;
  delete process.env.CAOS_E2E;
});

for (const provider of ['claude-code', 'codex', 'anthropic', 'openai']) {
  test(`${provider}: no credential anywhere -> local synthesis, labelled, no network`, async () => {
    const dir = tmp();
    auth.configureSources(disconnected());
    const res = await runAiTask({ task: 'summary', sessionId: 's1', provider }, repos(dir), { fetchImpl: denyNetwork });
    assert.equal(res.ok, true);
    assert.equal(res.local, true);
    assert.equal(res.reason, 'no-credential');
    assert.match(res.text, /Generated locally/);
    assert.match(res.text, /no AI provider is connected/);
    assert.match(res.text, /Remove this CTA/);
  });
}

test('E2E flag does not bypass the decision path: it only supplies disconnected sources', async () => {
  const dir = tmp();
  process.env.BRAIWSER_E2E = '1';
  // Real-looking credentials in the process environment must be invisible to the harness.
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-seen';
  process.env.OPENAI_API_KEY = 'sk-should-not-be-seen';
  try {
    for (const provider of ['claude-code', 'anthropic', 'openai', 'codex']) {
      const res = await runAiTask({ task: 'summary', sessionId: 's1', provider }, repos(dir), { fetchImpl: denyNetwork });
      assert.equal(res.ok && res.local, true, provider);
    }
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
  }
});

test('the production path really consults credentials: with E2E off, an env key is used', async () => {
  const dir = tmp();
  auth.configureSources(disconnected({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }));
  let seen;
  const res = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'anthropic' }, repos(dir), {
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ content: [{ type: 'text', text: 'model says hi' }] }), text: async () => '' };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.local, undefined);
  assert.equal(res.text, 'model says hi');
  assert.equal(seen.headers['x-api-key'], 'sk-ant-test');
});

test('expired Claude login with no refresh token is a meaningful error, not a local answer', async () => {
  const dir = tmp();
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: 'at', expiresAt: 1, subscriptionType: 'max' } });
  auth.configureSources(disconnected({ readClaudeFile: async () => expired }));
  const res = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'claude-code' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(res.ok, false);
  assert.equal(res.local, undefined);
  assert.match(res.error, /expired|sign in/i);
});

test('a corrupt Claude login file is reported, not treated as signed out', async () => {
  const dir = tmp();
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, '{ not json');
  auth.configureSources(disconnected({ claudeFile: file }));
  const res = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'claude-code' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(res.ok, false);
  assert.match(res.error, /not valid JSON/);
  // A logged-out CLI (valid JSON, no tokens) is simply "absent".
  fs.writeFileSync(file, '{}');
  const loggedOut = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'claude-code' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(loggedOut.local, true);
});

test('a corrupt Codex login file is reported; an expired one is an error', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, 'garbage');
  auth.configureSources(disconnected({ codexFile: file }));
  const bad = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'codex' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Codex login file/);

  auth.configureSources(disconnected({ readCodexFile: async () => JSON.stringify({ tokens: { access_token: 'x.y.z' } }) }));
  const expired = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'codex' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);
});

test('a stored API key that cannot be decrypted is an error, not "no key"', async () => {
  const dir = tmp();
  auth.configureSources(disconnected());
  await auth.setKey(dir, 'anthropic', 'sk-ant-real');
  // The credential file survives but the machine secret changes.
  auth.reset();
  fs.writeFileSync(path.join(dir, 'machine.key'), Buffer.from('A'.repeat(43) + '=')); // a valid-format, different secret
  const res = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'anthropic' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(res.ok, false);
  assert.match(res.error, /could not be decrypted/);
});

test('an unusable credential store (unrecognised machine.key) fails the task and is not overwritten', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'machine.key'), 'this is not a key');
  auth.configureSources(disconnected());
  const res = await runAiTask({ task: 'summary', sessionId: 's1', provider: 'anthropic' }, repos(dir), { fetchImpl: denyNetwork });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in a recognised format/);
  assert.equal(fs.readFileSync(path.join(dir, 'machine.key'), 'utf8'), 'this is not a key');
  const status = await auth.status(dir);
  assert.equal(status.anthropic.ready, false);
  assert.match(status.anthropic.detail, /recognised format/);
});

test('initialisation is single-flight and a failure is not cached', async () => {
  const dir = tmp();
  auth.configureSources(disconnected());
  const a = auth.ensure(dir);
  const b = auth.ensure(dir);
  assert.equal(a, b);
  await a;
  const results = await Promise.all(Array.from({ length: 6 }, () => auth.credentialFor(dir, 'anthropic')));
  assert.deepEqual(results, Array(6).fill(null));

  const bad = tmp();
  fs.writeFileSync(path.join(bad, 'machine.key'), 'junk');
  auth.reset();
  await assert.rejects(auth.ensure(bad), /recognised format/);
  fs.rmSync(path.join(bad, 'machine.key'));
  const parts = await auth.ensure(bad); // fixed on disk: retry works
  assert.ok(parts.keys);
});

test('machineSecret: only ENOENT means first run; formats are validated', () => {
  const dir = tmp();
  const first = auth.machineSecret(dir, null);
  assert.match(first, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(auth.machineSecret(dir, null), first);

  // unreadable (a directory where the file should be) is a fault, not a reset
  const odd = tmp();
  fs.mkdirSync(path.join(odd, 'machine.key'));
  assert.throws(() => auth.machineSecret(odd, null), /Cannot read the credential key file/);

  // ciphertext from an OS keyring that is not available now must not become a "secret"
  const cipher = tmp();
  fs.writeFileSync(path.join(cipher, 'machine.key'), Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff, 0xfe, 0x01]));
  assert.throws(() => auth.machineSecret(cipher, null), /not in a recognised format/);
  assert.deepEqual([...fs.readFileSync(path.join(cipher, 'machine.key'))], [0x76, 0x31, 0x30, 0x00, 0xff, 0xfe, 0x01]);
});

test('machineSecret: round-trips through an OS keyring and accepts a pre-keyring plaintext file', () => {
  const keyring = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => {
      const t = b.toString('utf8');
      if (!t.startsWith('enc:')) throw new Error('bad');
      return t.slice(4);
    },
  };
  const dir = tmp();
  const secret = auth.machineSecret(dir, keyring);
  assert.ok(fs.readFileSync(path.join(dir, 'machine.key'), 'utf8').startsWith('enc:'));
  assert.equal(auth.machineSecret(dir, keyring), secret);

  const legacy = tmp();
  const plain = auth.machineSecret(legacy, null);
  assert.equal(auth.machineSecret(legacy, keyring), plain); // keyring appeared later
});

test('cancelAiTask aborts an in-flight request through the service boundary', async () => {
  const dir = tmp();
  auth.configureSources(disconnected({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }));
  let reached;
  const fetched = new Promise((r) => { reached = r; });
  const p = runAiTask({ task: 'summary', sessionId: 's1', provider: 'anthropic', requestId: 'req-1', timeoutMs: 600000 }, repos(dir), {
    fetchImpl: async () => { reached(); return { ok: true, status: 200, headers: new Map(), json: never, text: never }; },
  });
  await fetched;
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelAiTask('req-1'), true);
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.equal(cancelAiTask('req-1'), false); // settled and deregistered
});

test('a stalled provider body settles runAiTask with a timeout error', async (t) => {
  const dir = tmp();
  auth.configureSources(disconnected({ env: { OPENAI_API_KEY: 'sk-test' } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reached;
  const fetched = new Promise((r) => { reached = r; });
  const p = runAiTask({ task: 'summary', sessionId: 's1', provider: 'openai', timeoutMs: 5000 }, repos(dir), {
    fetchImpl: async () => { reached(); return { ok: true, status: 200, headers: new Map(), json: never, text: never }; },
  });
  await fetched;
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(5000);
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out after 5s/);
});
