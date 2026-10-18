// Local Pro licence activation. A licence is a token that can be verified offline,
// so Free stays useful without phoning home:
//
//     BRW1.<payload base64url>.<signature base64url>
//
// The signature is Ed25519 over the ASCII bytes `BRW1.<payload>`. The app ships
// only PUBLIC keys (see build-config.js); the private key stays with whoever
// issues licences (scripts/issue-license.js), so nothing in a copy of the app can
// mint a licence. The previous scheme used an HMAC secret that was part of the
// source, which meant anyone could issue themselves a key; HMAC-era tokens are
// now rejected.
//
// Whether Pro features are actually gated is a property of the build, not of the
// environment the app happens to run in (see build-config.js).
const crypto = require('crypto');
const { PRO_FEATURES } = require('../config');
const buildConfig = require('../build-config');
const { isE2E } = require('../env');

const PREFIX = 'BRW1';
const SIGNATURE_BYTES = 64;
const CLOCK_SKEW_MS = 24 * 3600 * 1000;

// Test seam: lets a test pin the build posture and trusted keys without writing a
// build-config.json. `null` restores the real configuration.
let override = null;
let keyCache = { source: null, keys: [] };
let demoPair = null;

function configure(next) {
  override = next ? buildConfig.normalize(next) : null;
  keyCache = { source: null, keys: [] };
  demoPair = null;
}

function cfg() {
  return override || buildConfig.get();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

function publicKeyObject(pem) {
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (_e) {
    return null;
  }
}

// An in-process keypair that exists only where demo licences are allowed (dev,
// e2e and CI builds). Its private half never leaves this process and is never
// written to disk; a release build does not trust it.
function demoKeyPair() {
  if (!demoPair) demoPair = crypto.generateKeyPairSync('ed25519');
  return demoPair;
}

function trustedKeys() {
  const config = cfg();
  if (keyCache.source !== config) {
    keyCache = { source: config, keys: config.licensePublicKeys.map(publicKeyObject).filter(Boolean) };
  }
  return config.demoKeys ? keyCache.keys.concat(demoKeyPair().publicKey) : keyCache.keys;
}

function demoKeysEnabled() {
  return cfg().demoKeys === true;
}

// Sign a payload with a private key (PEM string or KeyObject). Used by the issuing
// script and by tests; the app itself holds no private key.
function signPayload(payloadObj, privateKey) {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  const payload = b64url(JSON.stringify(payloadObj));
  const signed = `${PREFIX}.${payload}`;
  const sig = b64url(crypto.sign(null, Buffer.from(signed, 'ascii'), key));
  return `${signed}.${sig}`;
}

function verifyKey(key) {
  if (!key || typeof key !== 'string') return { ok: false, tier: 'free', reason: 'empty' };
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, tier: 'free', reason: 'malformed' };
  const [, payload, sig] = parts;

  const sigBytes = fromB64url(sig);
  if (sigBytes.length !== SIGNATURE_BYTES) return { ok: false, tier: 'free', reason: 'bad-signature' };

  const keys = trustedKeys();
  if (!keys.length) return { ok: false, tier: 'free', reason: 'no-public-key' };
  const signed = Buffer.from(`${PREFIX}.${payload}`, 'ascii');
  const valid = keys.some((k) => {
    try { return crypto.verify(null, signed, k, sigBytes); } catch (_e) { return false; }
  });
  if (!valid) return { ok: false, tier: 'free', reason: 'bad-signature' };

  let data;
  try {
    data = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch (_e) {
    return { ok: false, tier: 'free', reason: 'bad-payload' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, tier: 'free', reason: 'bad-payload' };
  const now = Date.now();
  if (data.iat && Number(data.iat) > now + CLOCK_SKEW_MS) return { ok: false, tier: 'free', reason: 'not-yet-valid', data };
  if (data.exp && now > Number(data.exp)) return { ok: false, tier: 'free', reason: 'expired', data };
  const tier = data.tier === 'team' || data.tier === 'pro' ? data.tier : 'pro';
  return { ok: true, tier, data };
}

function activate(repos, key) {
  const result = verifyKey(key);
  if (!result.ok) {
    repos.license.set({ key: '', activatedAt: null, tier: 'free', lastError: result.reason });
    repos.settings.set({ licenseKey: '' });
    return { ok: false, tier: 'free', error: result.reason };
  }
  const activatedAt = new Date().toISOString();
  repos.license.set({ key: key.trim(), activatedAt, tier: result.tier, lastError: null });
  repos.settings.set({ licenseKey: key.trim() });
  repos.auditLog.append('license.activate', { tier: result.tier });
  repos.analytics.track('pro_activate', { tier: result.tier });
  return { ok: true, tier: result.tier, activatedAt };
}

// What this build does about Pro features, stated plainly so the UI can label a
// development build as such instead of implying a paid boundary that is not there.
function buildInfo() {
  const config = cfg();
  const enforced = config.enforceLicense === true;
  return {
    channel: config.channel,
    enforced,
    // True when Pro features are usable without a licence in this build.
    proUnlockedForAll: !enforced,
    demoKeys: config.demoKeys === true,
  };
}

function status(repos) {
  const build = buildInfo();
  const stored = repos.license.get();
  const key = (stored && stored.key) || (repos.settings.get().licenseKey) || '';
  if (!key) return { tier: 'free', pro: false, features: [], build };
  const result = verifyKey(key);
  if (!result.ok) return { tier: 'free', pro: false, features: [], error: result.reason, build };
  return {
    tier: result.tier,
    pro: true,
    features: PRO_FEATURES.slice(),
    email: result.data && result.data.email,
    seats: result.data && result.data.seats,
    build,
  };
}

function canUse(repos, feature) {
  // Free forever: core browse/annotate/export markdown. Everything in
  // PRO_FEATURES needs a valid licence when the build enforces it. Development
  // builds do not enforce; the e2e bypass applies only to builds that opted in
  // at build time (never a release), so setting BRAIWSER_E2E on an installed
  // release does not unlock anything.
  if (!PRO_FEATURES.includes(feature)) return { allowed: true, soft: false, pro: true, feature };
  const config = cfg();
  const st = status(repos);
  const bypass = isE2E() && config.e2eBypass === true;
  if (config.enforceLicense && !bypass) {
    return { allowed: st.pro, soft: false, pro: st.pro, feature };
  }
  return { allowed: true, soft: true, pro: st.pro, feature };
}

// The IPC channels that deliver Pro add-ons, by feature. The main process is the only
// real boundary (a renderer check is advisory), so ipc/index.js asks `assertChannel`
// before running any handler. In a build that does not enforce licences (source runs,
// the e2e bypass) this never refuses.
//
// NOT listed, on purpose: `agent-handoff` and `ai-polish`. Copying a prompt, handing
// off to a coding agent and running AI tasks are the product's core flow, and no
// channel maps cleanly onto "templates" or "polish"; they stay open until the product
// decides where that line sits. `canUse()` still reports them as Pro.
const PRO_CHANNELS = {
  'caos:review.clientPack': 'client-pack',
  'caos:review.htmlReport': 'html-report',
  'caos:bundle.export': 'project-bundle',
  'caos:bundle.import': 'project-bundle',
  'caos:integrations.issue': 'integrations',
  'caos:integrations.ciStarter': 'integrations',
  'caos:integrations.webhook': 'integrations',
  'caos:integrations.slack': 'integrations',
  'caos:sync.signIn': 'sync',
  'caos:sync.enqueue': 'sync',
  'caos:sync.drain': 'sync',
  'caos:team.create': 'team',
  'caos:team.invite': 'team',
  'caos:team.comments.add': 'team',
};

function featureForChannel(channel, args) {
  if (channel === 'caos:export.recording') return args && args[0] === 'json' ? null : 'playwright-export';
  return PRO_CHANNELS[channel] || null;
}

class LicenseRequiredError extends Error {
  constructor(feature) {
    super(`"${feature}" is a Pro feature in this build. Activate a licence key in Settings to use it.`);
    this.name = 'LicenseRequiredError';
    this.code = 'LICENSE_REQUIRED';
    this.feature = feature;
  }
}

// Throws LicenseRequiredError when `channel` is a Pro add-on and the build enforces
// licences and none is active.
function assertChannel(repos, channel, args) {
  const feature = featureForChannel(channel, args);
  if (!feature) return;
  if (!canUse(repos, feature).allowed) throw new LicenseRequiredError(feature);
}

// Development / e2e / CI only. A release build refuses, so there is no way to
// obtain a working licence from an installed copy.
function issueDemoKey({ email = 'dev@braiwser.local', tier = 'pro', days = 365, seats = 1 } = {}) {
  if (!demoKeysEnabled()) throw new Error('Demo licences are not available in this build');
  return signPayload({
    email,
    tier,
    seats,
    demo: true,
    iat: Date.now(),
    exp: Date.now() + days * 86400000,
  }, demoKeyPair().privateKey);
}

module.exports = {
  activate,
  status,
  canUse,
  verifyKey,
  issueDemoKey,
  demoKeysEnabled,
  assertChannel,
  featureForChannel,
  LicenseRequiredError,
  PRO_CHANNELS,
  buildInfo,
  signPayload,
  configure,
  PRO_FEATURES,
};
