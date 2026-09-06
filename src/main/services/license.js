// Local Pro license activation. Offline-verifiable signed tokens so Free stays
// useful without phoning home. Format: BRW1.<payloadB64>.<sigB64>
//
// Dev / demo keys use HMAC with a public demo secret. Production can replace
// LICENSE_SECRET via env BRAIWSER_LICENSE_SECRET without changing callers.
const crypto = require('crypto');
const { PRO_FEATURES } = require('../config');

const DEMO_SECRET = 'braiwser-demo-license-v1';

function secret() {
  return process.env.BRAIWSER_LICENSE_SECRET || DEMO_SECRET;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

function signPayload(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  return `BRW1.${payload}.${sig}`;
}

function verifyKey(key) {
  if (!key || typeof key !== 'string') return { ok: false, tier: 'free', reason: 'empty' };
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'BRW1') return { ok: false, tier: 'free', reason: 'malformed' };
  const [, payload, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, tier: 'free', reason: 'bad-signature' };
  }
  let data;
  try {
    data = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch (_e) {
    return { ok: false, tier: 'free', reason: 'bad-payload' };
  }
  if (data.exp && Date.now() > Number(data.exp)) {
    return { ok: false, tier: 'free', reason: 'expired', data };
  }
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

function status(repos) {
  const stored = repos.license.get();
  const key = (stored && stored.key) || (repos.settings.get().licenseKey) || '';
  if (!key) return { tier: 'free', pro: false, features: [] };
  const result = verifyKey(key);
  if (!result.ok) return { tier: 'free', pro: false, features: [], error: result.reason };
  return {
    tier: result.tier,
    pro: true,
    features: PRO_FEATURES.slice(),
    email: result.data && result.data.email,
    seats: result.data && result.data.seats,
  };
}

function canUse(repos, feature) {
  // Free forever: core browse/annotate/export markdown. Everything listed in
  // PRO_FEATURES needs Pro/Team when BRAIWSER_ENFORCE_LICENSE=1. Dev, e2e, and
  // contributors stay unblocked unless that flag is set on a release build.
  if (!PRO_FEATURES.includes(feature)) return { allowed: true, soft: false, pro: true, feature };
  const st = status(repos);
  if (process.env.BRAIWSER_ENFORCE_LICENSE === '1') {
    return { allowed: st.pro, soft: false, pro: st.pro, feature };
  }
  return { allowed: true, soft: true, pro: st.pro, feature };
}

function issueDemoKey({ email = 'dev@braiwser.local', tier = 'pro', days = 365, seats = 1 } = {}) {
  return signPayload({
    email,
    tier,
    seats,
    iat: Date.now(),
    exp: Date.now() + days * 86400000,
  });
}

module.exports = { activate, status, canUse, verifyKey, issueDemoKey, PRO_FEATURES, signPayload };
