// Who is paying for an AI call, and how the request proves it.
//
// Braiwser talks to Anthropic and OpenAI four ways, and `@flyvendedk799/ai-auth`
// carries the parts of that which are easy to get subtly wrong:
//
//   claude-code  the `claude` CLI login already on this machine — a subscription,
//                so the AI features work with nothing pasted anywhere
//   codex        the same trick for a ChatGPT subscription via the Codex CLI
//   anthropic    a metered Anthropic API key, encrypted at rest
//   openai       a metered OpenAI API key, encrypted at rest
//
// The library is ESM-only and this process is CommonJS, so it is pulled in with a
// dynamic import and cached. That import is deliberately lazy: the AI panel is one
// feature among many, and a user who never opens it should not pay to load it.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// One account row, because this is a single-user desktop app rather than a server
// with tenants. The library takes an id so that the same store can serve many.
const ACCOUNT_ID = 'local';

let libPromise = null;
let parts = null;

function lib() {
  if (!libPromise) libPromise = import('@flyvendedk799/ai-auth');
  return libPromise;
}

// The secret the API keys are encrypted under.
//
// It is generated once and kept beside them. On its own that is only worth so much
// — a key file next to the box it opens — so where the OS offers real protection
// (Keychain, DPAPI, libsecret) we put the secret behind `safeStorage` and the file
// holds ciphertext. Where it does not, the file is still better than the plaintext
// `secrets.json` this replaced, and it is written 0600.
function machineSecret(dir) {
  const file = path.join(dir, 'machine.key');
  let safeStorage = null;
  try { ({ safeStorage } = require('electron')); } catch (_e) { /* not in Electron (tests) */ }
  const usable = safeStorage && safeStorage.isEncryptionAvailable();

  try {
    const raw = fs.readFileSync(file);
    if (usable) {
      // A file written before the OS keyring was available stays readable: fall
      // back to treating it as plaintext rather than locking the user out of
      // their own keys, then leave it alone.
      try { return safeStorage.decryptString(raw); } catch (_e) { return raw.toString('utf8'); }
    }
    return raw.toString('utf8');
  } catch (_e) { /* first run */ }

  const secret = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, usable ? safeStorage.encryptString(secret) : secret, { mode: 0o600 });
  } catch (_e) { /* a read-only home still gets a working session, just not a saved key */ }
  return secret;
}

// Everything stateful, built once against the store directory.
async function ensure(dir) {
  if (parts) return parts;
  const m = await lib();
  const store = new m.JsonFileCredentialStore({ path: path.join(dir, 'credentials.json') });
  const secret = machineSecret(dir);
  parts = {
    m,
    store,
    keys: new m.ApiKeyStore({ store, secret }),
    accounts: new m.ClaudeAccountStore({ store, secret }),
    cli: new m.ClaudeCodeCredential(),
  };
  return parts;
}

// ---- one-time migration -------------------------------------------------------
// Keys used to sit in plaintext in secrets.json under the old provider names.
// Move them into the encrypted store, then blank the old file so the plaintext
// does not linger on disk. Runs at most once; failure is non-fatal because a
// failed migration must not stop the app from starting.
async function migratePlaintextKeys(dir, secretsDoc) {
  try {
    const data = secretsDoc.data();
    const legacy = { anthropic: data.claude, openai: data.openai };
    const pending = Object.entries(legacy).filter(([, v]) => typeof v === 'string' && v);
    if (!pending.length) return;
    const { keys } = await ensure(dir);
    for (const [wire, key] of pending) await keys.set(wire, key);
    for (const name of ['claude', 'openai']) secretsDoc.unset(name);
  } catch (err) {
    console.log('[ai-auth] key migration skipped: ' + ((err && err.message) || err));
  }
}

// ---- status -------------------------------------------------------------------
// What the settings page shows. Every provider answers the same three questions:
// is it usable, where did its credential come from, and what can we say about it.
async function status(dir) {
  const { m, keys, accounts, cli } = await ensure(dir);

  const [cliStatus, account, anthropicKey, openaiKey] = await Promise.all([
    cli.status().catch(() => ({ connected: false })),
    accounts.status(ACCOUNT_ID).catch(() => ({ connected: false })),
    keys.resolve('anthropic').catch(() => ({ source: 'none', ready: false })),
    keys.resolve('openai').catch(() => ({ source: 'none', ready: false })),
  ]);
  const [anthropicHint, openaiHint] = await Promise.all([
    keys.hint('anthropic').catch(() => null),
    keys.hint('openai').catch(() => null),
  ]);

  // A Claude Code login can come from the CLI on this machine or from signing in
  // inside Braiwser. Either satisfies the provider, so report them as one row and
  // say which is answering.
  const claudeCode = cliStatus.connected
    ? { ready: true, via: 'cli', plan: cliStatus.subscriptionType, detail: `Signed in via the \`claude\` CLI (${cliStatus.source === 'keychain' ? 'Keychain' : 'credentials file'})` }
    : account.connected
      ? { ready: true, via: 'browser', plan: account.subscriptionType || null, detail: 'Signed in through Braiwser' }
      : { ready: false, via: null, plan: null, detail: 'Run `claude` and sign in, or connect a subscription here' };

  return {
    'claude-code': claudeCode,
    codex: await codexStatus(m),
    anthropic: { ready: anthropicKey.ready, via: anthropicKey.source, hint: anthropicHint, detail: sourceDetail(anthropicKey.source, 'ANTHROPIC_API_KEY') },
    openai: { ready: openaiKey.ready, via: openaiKey.source, hint: openaiHint, detail: sourceDetail(openaiKey.source, 'OPENAI_API_KEY') },
  };
}

async function codexStatus(m) {
  try {
    const identity = await m.readCodexLogin();
    if (!identity) return { ready: false, via: null, plan: null, detail: 'Run `codex` and sign in to use a ChatGPT subscription' };
    return {
      ready: !m.isCodexExpired(identity),
      via: 'cli',
      plan: null,
      detail: m.isCodexExpired(identity) ? 'The Codex login on this machine has expired — run `codex` again' : 'Signed in via the `codex` CLI',
    };
  } catch (err) {
    return { ready: false, via: null, plan: null, detail: (err && err.message) || String(err) };
  }
}

function sourceDetail(source, envName) {
  if (source === 'stored') return 'Using the key saved here';
  if (source === 'environment') return `Using ${envName} from the environment`;
  return 'No key saved';
}

// ---- resolving a credential for a call ----------------------------------------
// Returns what the provider client needs, in the shape it needs it. The callers
// never see a token they did not ask to use.
async function credentialFor(dir, provider) {
  const { m, keys, accounts, cli } = await ensure(dir);

  if (provider === 'claude-code') {
    // Prefer the CLI's own login. It is the freshest thing on the machine, and it
    // costs the user nothing to keep current.
    const cliStatus = await cli.status().catch(() => ({ connected: false }));
    if (cliStatus.connected) return { kind: 'subscription', token: await cli.token() };
    const account = await accounts.status(ACCOUNT_ID).catch(() => ({ connected: false }));
    if (account.connected) return { kind: 'subscription', token: await accounts.token(ACCOUNT_ID) };
    throw new m.ClaudeCodeAuthError('No Claude subscription connected. Run `claude` and sign in, or connect one in Settings.', true);
  }

  if (provider === 'codex') {
    const identity = await m.readCodexLogin();
    if (!identity) throw new Error('No Codex login found on this machine. Run `codex` and sign in.');
    return { kind: 'codex', options: m.codexOptions(identity) };
  }

  const resolved = await keys.resolve(provider);
  if (!resolved.ready || !resolved.key) return null; // caller falls back to a local answer
  return { kind: 'key', key: resolved.key };
}

// ---- writing credentials ------------------------------------------------------
async function setKey(dir, wire, key) {
  const { keys } = await ensure(dir);
  await keys.set(wire, key);
}

async function clearKey(dir, wire) {
  const { keys } = await ensure(dir);
  await keys.set(wire, null);
}

// ---- signing in with a Claude subscription, in the browser --------------------
// The authorize page shows a code rather than redirecting to a loopback port, so
// the flow is: open the browser, sign in, paste the code back. The verifier stays
// in this process and is never sent anywhere but the token exchange.
let pendingLogin = null;

async function beginClaudeLogin() {
  const m = await lib();
  const start = m.startClaudeLogin();
  pendingLogin = { verifier: start.verifier, state: start.state, startedAt: Date.now() };
  return { url: start.url };
}

async function completeClaudeLogin(dir, pasted) {
  const { m, accounts } = await ensure(dir);
  if (!pendingLogin) throw new m.ClaudeLoginError('Start the sign-in again — this one was not begun in this session.', true);

  const parsedCode = m.parsePastedCode(String(pasted || ''));
  if (!parsedCode) throw new m.ClaudeLoginError('That does not look like a sign-in code. Copy the whole code from the browser.', false);

  // The authorize page appends the state to the code. When it is there it must
  // match; when it is not, the code itself is still bound to our verifier.
  if (parsedCode.state && !m.sameState(pendingLogin.state, parsedCode.state)) {
    throw new m.ClaudeLoginError('That code was issued for a different sign-in. Start again.', true);
  }

  const identity = await m.exchangeClaudeCode({
    code: parsedCode.code,
    state: pendingLogin.state,
    verifier: pendingLogin.verifier,
  });
  await accounts.save(ACCOUNT_ID, identity);
  pendingLogin = null;
  return { connected: true, plan: identity.subscriptionType || null };
}

async function disconnectClaudeLogin(dir) {
  const { accounts } = await ensure(dir);
  await accounts.forget(ACCOUNT_ID);
}

// ---- turning a credential into request parts ----------------------------------
// The library hands back option objects shaped for the Anthropic/OpenAI SDKs.
// Braiwser talks to both over plain fetch, so translate — carefully, because the
// two traps the library documents both live in this translation.

// Anthropic. `apiKey: null` in the subscription options is not "unset", it is
// "must not be sent": Anthropic validates x-api-key whenever the header is
// present, so a key sitting alongside a perfectly good bearer token fails the
// call. And a subscription request has to open with the Claude Code identity
// block or the premium models come back 429 while Haiku answers fine.
async function anthropicShape(credential, system) {
  const m = await lib();
  if (credential.kind === 'subscription') {
    const options = m.anthropicSubscriptionOptions(credential.token);
    return {
      headers: { authorization: `Bearer ${credential.token}`, ...options.defaultHeaders },
      system: m.withClaudeCodeIdentity(system),
    };
  }
  return { headers: { 'x-api-key': credential.key }, system };
}

// OpenAI. Codex speaks the same wire at its own host and needs the account header
// to know which subscription is paying.
function openaiShape(credential) {
  if (credential.kind === 'codex') {
    const { apiKey, baseURL, defaultHeaders } = credential.options;
    return { headers: { authorization: `Bearer ${apiKey}`, ...defaultHeaders }, baseUrl: baseURL };
  }
  return { headers: { authorization: `Bearer ${credential.key}` }, baseUrl: null };
}

// Model catalogue + error prose, straight from the library so the ids Braiwser
// offers cannot drift from the ones the providers actually answer to.
async function modelsFor(provider) {
  const m = await lib();
  try { return m.modelsFor(provider).map((s) => ({ id: s.id, label: s.label || s.id, tier: s.tier })); }
  catch (_e) { return []; }
}

async function describeError(err, provider, model) {
  try {
    const m = await lib();
    return m.describeProviderError(err, provider, model, { configureAt: 'Settings' });
  } catch (_e) { return null; }
}

module.exports = {
  ACCOUNT_ID,
  anthropicShape,
  openaiShape,
  beginClaudeLogin,
  clearKey,
  completeClaudeLogin,
  credentialFor,
  describeError,
  disconnectClaudeLogin,
  migratePlaintextKeys,
  modelsFor,
  setKey,
  status,
};
