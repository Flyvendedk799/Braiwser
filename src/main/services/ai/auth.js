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
const os = require('os');
const crypto = require('crypto');
const { isE2E } = require('../../env');

// One account row, because this is a single-user desktop app rather than a server
// with tenants. The library takes an id so that the same store can serve many.
const ACCOUNT_ID = 'local';

let libPromise = null;

function lib() {
  if (!libPromise) libPromise = import('@flyvendedk799/ai-auth');
  return libPromise;
}

// ---- where credentials are looked for -----------------------------------------
// Production reads the machine's own logins and environment. The e2e harness must
// never spend (or even see) the developer's real credentials, but it must also
// exercise the SAME decision code production runs - so instead of short-circuiting
// the decision, it is handed credential sources that are all disconnected. Tests
// inject their own through `configureSources`.
const DISCONNECTED = {
  env: {},
  claudeFile: null,
  codexFile: null,
  readKeychain: async () => null,
  readClaudeFile: async () => null,
  readCodexFile: async () => null,
};

let sourceOverride = null;

function sources() {
  return sourceOverride || (isE2E() ? DISCONNECTED : {});
}

function configureSources(next) {
  sourceOverride = next || null;
  reset();
}

function claudeCredentialsPath(src) {
  if (src.claudeFile !== undefined) return src.claudeFile;
  const env = src.env || process.env;
  return env.CLAUDE_CREDENTIALS_FILE || path.join(os.homedir(), '.claude', '.credentials.json');
}

function codexAuthPath(src) {
  if (src.codexFile !== undefined) return src.codexFile;
  const env = src.env || process.env;
  return env.CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');
}

// The library reports a login file it cannot make sense of exactly like a missing
// one. "Not signed in" is a state to answer locally; "the file is there but is not
// readable JSON" is a fault the user should hear about instead of silently losing
// their subscription. A valid JSON object without tokens is what a logged-out CLI
// leaves behind, and counts as absent.
function loginFileState(file) {
  if (!file) return 'missing';
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 'missing';
    return 'unreadable';
  }
  if (!raw.trim()) return 'logged-out';
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 'logged-out' : 'corrupt';
  } catch (_e) {
    return 'corrupt';
  }
}

function loginFileProblem(file, who, command) {
  const state = loginFileState(file);
  if (state === 'corrupt' || state === 'unreadable') {
    return new Error(`The ${who} login file (${file}) is ${state === 'corrupt' ? 'not valid JSON' : 'not readable'}, so it was not treated as signed out. Fix or remove it, or run \`${command}\` and sign in again.`);
  }
  return null;
}

// ---- the secret API keys are encrypted under ------------------------------------
//
// It is generated once and kept beside them. On its own that is only worth so much
// - a key file next to the box it opens - so where the OS offers real protection
// (Keychain, DPAPI, libsecret) we put the secret behind `safeStorage` and the file
// holds ciphertext. Where it does not, the file is still better than the plaintext
// `secrets.json` this replaced, and it is written 0600.
//
// Only a file that is genuinely absent means "first run". A file that exists but
// cannot be read, decrypted or recognised is a fault: generating a fresh secret
// over it would orphan every stored key and login, which then read as "not
// configured" with no hint why.
const SECRET_FORMAT = /^[A-Za-z0-9+/]{43}=$/; // 32 random bytes, base64

class MachineKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MachineKeyError';
  }
}

function electronSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' ? safeStorage : null;
  } catch (_e) {
    return null; // not in Electron (tests)
  }
}

function machineSecret(dir, safeStorageOverride) {
  const file = path.join(dir, 'machine.key');
  const safeStorage = safeStorageOverride !== undefined ? safeStorageOverride : electronSafeStorage();
  const usable = !!(safeStorage && safeStorage.isEncryptionAvailable());

  let raw = null;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw new MachineKeyError(`Cannot read the credential key file (${file}): ${err && err.message}. Stored AI keys and logins were left untouched.`);
    }
  }

  if (raw) {
    if (usable) {
      try { return safeStorage.decryptString(raw); } catch (_e) { /* maybe a pre-keyring plaintext file */ }
    }
    const text = raw.toString('utf8').trim();
    if (SECRET_FORMAT.test(text)) return text; // a plaintext file written before the OS keyring was available
    throw new MachineKeyError(`The credential key file (${file}) is not in a recognised format${usable ? '' : ', or was encrypted by an OS keyring that is not available now'}. It was not replaced, so stored AI keys and logins are untouched; remove the file to start over.`);
  }

  const secret = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 'wx': never overwrite a key another process created in the meantime.
    fs.writeFileSync(file, usable ? safeStorage.encryptString(secret) : secret, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return machineSecret(dir, safeStorageOverride);
    /* a read-only home still gets a working session, just not a saved key */
  }
  return secret;
}

// Everything stateful, built once against the store directory. The promise is
// cached (single-flight): concurrent first callers - status and a task at start-up
// - share one initialisation instead of racing to create the key file and store.
// A failed initialisation is not cached, so fixing the fault and retrying works.
let partsPromise = null;
let partsDir = null;

function reset() {
  partsPromise = null;
  partsDir = null;
}

function ensure(dir) {
  if (partsPromise && partsDir === dir) return partsPromise;
  partsDir = dir;
  const attempt = build(dir);
  partsPromise = attempt;
  attempt.catch(() => { if (partsPromise === attempt) reset(); });
  return attempt;
}

async function build(dir) {
  const m = await lib();
  const src = sources();
  const store = new m.JsonFileCredentialStore({ path: path.join(dir, 'credentials.json') });
  const secret = machineSecret(dir);
  const cliOptions = {};
  if (src.env) cliOptions.env = src.env;
  if (src.readKeychain) cliOptions.readKeychain = src.readKeychain;
  if (src.readClaudeFile) cliOptions.readFile = src.readClaudeFile;
  return {
    m,
    src,
    store,
    keys: new m.ApiKeyStore({ store, secret, ...(src.env ? { env: src.env } : {}) }),
    accounts: new m.ClaudeAccountStore({ store, secret }),
    cli: new m.ClaudeCodeCredential(cliOptions),
    codexOptions: {
      ...(src.env ? { env: src.env } : {}),
      ...(src.readCodexFile ? { readFile: src.readCodexFile } : {}),
    },
  };
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
  let parts;
  try {
    parts = await ensure(dir);
  } catch (err) {
    // The credential store itself is unusable (for instance an unrecognised
    // machine.key). Say so on every row rather than failing the settings page.
    const detail = (err && err.message) || String(err);
    const broken = { ready: false, via: null, plan: null, detail, error: true };
    return { 'claude-code': broken, codex: broken, anthropic: { ...broken, hint: null }, openai: { ...broken, hint: null } };
  }
  const { m, keys, accounts, cli, codexOptions } = parts;

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
      ? { ready: true, via: 'browser', plan: account.plan || null, detail: 'Signed in through Braiwser' }
      : { ready: false, via: null, plan: null, detail: 'Run `claude` and sign in, or connect a subscription here' };

  return {
    'claude-code': claudeCode,
    codex: await codexStatus(m, codexOptions),
    anthropic: { ready: anthropicKey.ready, via: anthropicKey.source, hint: anthropicHint, detail: sourceDetail(anthropicKey.source, 'ANTHROPIC_API_KEY') },
    openai: { ready: openaiKey.ready, via: openaiKey.source, hint: openaiHint, detail: sourceDetail(openaiKey.source, 'OPENAI_API_KEY') },
  };
}

async function codexStatus(m, codexOptions) {
  try {
    const identity = await m.readCodexLogin(codexOptions);
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
//
// The three outcomes are deliberately different:
//   - a credential            -> `{ kind, ... }`
//   - genuinely no credential -> `null`: the caller answers locally and says so
//   - a credential that is present but unusable (expired with no way to refresh,
//     rejected, unreadable, undecryptable, corrupt login file) -> THROWS a
//     meaningful error. Quietly falling back to local synthesis there would hide a
//     fault the user can fix behind an answer that looks like it came from the model.
async function credentialFor(dir, provider) {
  const { m, src, store, keys, accounts, cli, codexOptions } = await ensure(dir);

  if (provider === 'claude-code') {
    // Prefer the CLI's own login. It is the freshest thing on the machine, and it
    // costs the user nothing to keep current.
    const cliStatus = await cli.status();
    if (cliStatus.connected) return { kind: 'subscription', token: await cli.token() };

    const account = await accounts.status(ACCOUNT_ID);
    if (account.connected) return { kind: 'subscription', token: await accounts.token(ACCOUNT_ID) };
    if (await store.read(`claude:${ACCOUNT_ID}`)) {
      throw new m.ClaudeCodeAuthError('The Claude sign-in saved in Braiwser could not be read. Disconnect it and connect again in Settings.', true);
    }
    const problem = loginFileProblem(claudeCredentialsPath(src), 'Claude Code', 'claude');
    if (problem) throw problem;
    return null;
  }

  if (provider === 'codex') {
    const identity = await m.readCodexLogin(codexOptions);
    if (!identity) {
      const problem = loginFileProblem(codexAuthPath(src), 'Codex', 'codex');
      if (problem) throw problem;
      return null;
    }
    if (m.isCodexExpired(identity)) throw new Error('The Codex login on this machine has expired. Run `codex` and sign in again.');
    return { kind: 'codex', options: m.codexOptions(identity) };
  }

  const resolved = await keys.resolve(provider);
  if (resolved.ready && resolved.key) return { kind: 'key', key: resolved.key };
  if (await store.read(`key:${provider}`)) {
    // A key was saved, but it will not open (the machine secret changed, or the row
    // was damaged). That is not "no key".
    throw new Error(`The saved ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key could not be decrypted. Enter it again in Settings.`);
  }
  return null;
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

const ensureForTests = (dir) => ensure(dir);

module.exports = {
  ACCOUNT_ID,
  anthropicShape,
  openaiShape,
  beginClaudeLogin,
  clearKey,
  completeClaudeLogin,
  configureSources,
  credentialFor,
  ensure: ensureForTests,
  machineSecret,
  MachineKeyError,
  loginFileState,
  reset,
  describeError,
  disconnectClaudeLogin,
  migratePlaintextKeys,
  modelsFor,
  setKey,
  status,
};
