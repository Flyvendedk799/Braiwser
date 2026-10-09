const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const license = require('../../src/main/services/license');
const buildConfig = require('../../src/main/build-config');

function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function fakeRepos() {
  let lic = { key: '', activatedAt: null, tier: 'free' };
  let settings = { licenseKey: '' };
  return {
    license: { get: () => lic, set: (p) => { lic = { ...lic, ...p }; return lic; } },
    settings: { get: () => settings, set: (p) => { settings = { ...settings, ...p }; return settings; } },
    auditLog: { append() {} },
    analytics: { track() {} },
  };
}

const RELEASE = (publicPem) => ({ channel: 'release', enforceLicense: true, e2eBypass: false, demoKeys: false, licensePublicKey: publicPem });

test.afterEach(() => {
  license.configure(null);
  delete process.env.BRAIWSER_E2E;
  delete process.env.CAOS_E2E;
  delete process.env.BRAIWSER_ENFORCE_LICENSE;
  delete process.env.BRAIWSER_LICENSE_SECRET;
});

test('Ed25519 licence signed by the vendor key verifies; tampering is rejected', () => {
  const { publicPem, privatePem } = pair();
  license.configure(RELEASE(publicPem));
  const key = license.signPayload({ email: 'a@b.co', tier: 'team', seats: 4, iat: Date.now(), exp: Date.now() + 86400000 }, privatePem);
  const ok = license.verifyKey(key);
  assert.equal(ok.ok, true);
  assert.equal(ok.tier, 'team');

  const [prefix, , sig] = key.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'x@y.z', tier: 'team', seats: 999, exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(license.verifyKey(`${prefix}.${forged}.${sig}`).reason, 'bad-signature');
});

test('a key signed by a different private key is rejected', () => {
  const vendor = pair();
  const attacker = pair();
  license.configure(RELEASE(vendor.publicPem));
  const key = license.signPayload({ tier: 'pro', exp: Date.now() + 1e6 }, attacker.privatePem);
  assert.equal(license.verifyKey(key).reason, 'bad-signature');
});

test('the legacy public demo HMAC secret no longer mints accepted licences', () => {
  const { publicPem } = pair();
  license.configure(RELEASE(publicPem));
  const payload = Buffer.from(JSON.stringify({ tier: 'pro', exp: Date.now() + 1e9 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'braiwser-demo-license-v1').update(payload).digest().toString('base64url');
  assert.equal(license.verifyKey(`BRW1.${payload}.${sig}`).ok, false);
  process.env.BRAIWSER_LICENSE_SECRET = 'braiwser-demo-license-v1';
  assert.equal(license.verifyKey(`BRW1.${payload}.${sig}`).ok, false);
});

test('expired licences and builds with no trusted key are rejected', () => {
  const { publicPem, privatePem } = pair();
  license.configure(RELEASE(publicPem));
  const old = license.signPayload({ tier: 'pro', exp: Date.now() - 1000 }, privatePem);
  assert.equal(license.verifyKey(old).reason, 'expired');
  license.configure(RELEASE(''));
  const fresh = license.signPayload({ tier: 'pro', exp: Date.now() + 1e6 }, privatePem);
  assert.equal(license.verifyKey(fresh).reason, 'no-public-key');
});

test('release build: demo keys cannot be issued and a demo-signed token is rejected', () => {
  const { publicPem } = pair();
  license.configure({ ...RELEASE(publicPem), demoKeys: true });
  const demo = license.issueDemoKey({ days: 1 });
  assert.equal(license.verifyKey(demo).ok, true);
  license.configure(RELEASE(publicPem));
  assert.throws(() => license.issueDemoKey({}), /not available/);
  assert.equal(license.verifyKey(demo).ok, false);
});

test('unlicensed Pro features stay gated in an enforcing build, even with E2E and legacy env flags set', () => {
  const { publicPem } = pair();
  license.configure(RELEASE(publicPem));
  process.env.BRAIWSER_E2E = '1';
  process.env.CAOS_E2E = '1';
  process.env.BRAIWSER_ENFORCE_LICENSE = '0';
  const repos = fakeRepos();
  const gated = license.canUse(repos, 'agent-handoff');
  assert.equal(gated.allowed, false);
  assert.equal(gated.soft, false);
  assert.equal(license.canUse(repos, 'not-a-pro-feature').allowed, true);
});

test('a valid licence unlocks Pro features in an enforcing build', () => {
  const { publicPem, privatePem } = pair();
  license.configure(RELEASE(publicPem));
  const repos = fakeRepos();
  const key = license.signPayload({ email: 'a@b.co', tier: 'pro', exp: Date.now() + 1e8 }, privatePem);
  assert.equal(license.activate(repos, key).ok, true);
  assert.equal(license.canUse(repos, 'agent-handoff').allowed, true);
  assert.equal(license.status(repos).pro, true);
});

test('activating a rejected key leaves the app unlicensed', () => {
  const { publicPem } = pair();
  license.configure(RELEASE(publicPem));
  const repos = fakeRepos();
  assert.equal(license.activate(repos, 'BRW1.e30.AAAA').ok, false);
  assert.equal(license.status(repos).pro, false);
});

test('CI channel: e2e bypass applies only when the build opted in and E2E is set', () => {
  license.configure({ channel: 'ci', enforceLicense: true, e2eBypass: true, demoKeys: true });
  const repos = fakeRepos();
  assert.equal(license.canUse(repos, 'sync').allowed, false);
  process.env.BRAIWSER_E2E = '1';
  const e2e = license.canUse(repos, 'sync');
  assert.equal(e2e.allowed, true);
  assert.equal(e2e.soft, true);
});

test('status labels an unenforced development build honestly', () => {
  license.configure({ channel: 'dev', enforceLicense: false, e2eBypass: true, demoKeys: true });
  const st = license.status(fakeRepos());
  assert.equal(st.build.channel, 'dev');
  assert.equal(st.build.enforced, false);
  assert.equal(st.build.proUnlockedForAll, true);
  assert.equal(license.canUse(fakeRepos(), 'sync').soft, true);
});

test('build config: packaged without a generated file fails closed; source runs use dev defaults', () => {
  const packaged = buildConfig.resolveConfig({ generated: null, packaged: true, env: { BRAIWSER_ENFORCE_LICENSE: '0' } });
  assert.equal(packaged.enforceLicense, true);
  assert.equal(packaged.demoKeys, false);
  assert.equal(packaged.channel, 'unconfigured');
  const dev = buildConfig.resolveConfig({ generated: null, packaged: false, env: {} });
  assert.equal(dev.enforceLicense, false);
  assert.equal(dev.demoKeys, true);
  const corrupt = buildConfig.resolveConfig({ generated: { parseError: true }, packaged: false, env: {} });
  assert.equal(corrupt.enforceLicense, true);
  assert.equal(corrupt.channel, 'invalid');
  // The runtime environment cannot weaken a generated config.
  const generated = buildConfig.resolveConfig({ generated: { channel: 'release', enforceLicense: true }, packaged: true, env: { BRAIWSER_ENFORCE_LICENSE: '0', BRAIWSER_LICENSE_PUBLIC_KEY: 'x' } });
  assert.equal(generated.enforceLicense, true);
  assert.deepEqual(generated.licensePublicKeys, []);
});

test('Pro add-on channels are refused by the main-process gate in an enforcing build, and open otherwise', () => {
  const { publicPem, privatePem } = pair();
  license.configure(RELEASE(publicPem));
  const repos = fakeRepos();
  for (const channel of ['caos:review.clientPack', 'caos:bundle.export', 'caos:integrations.issue', 'caos:sync.signIn', 'caos:team.invite']) {
    assert.throws(() => license.assertChannel(repos, channel, []), (e) => e.code === 'LICENSE_REQUIRED' && !!e.feature);
  }
  // Playwright export is gated; the JSON format of the same channel is not.
  assert.throws(() => license.assertChannel(repos, 'caos:export.recording', ['playwright', 'r1']), /Pro feature/);
  assert.doesNotThrow(() => license.assertChannel(repos, 'caos:export.recording', ['json', 'r1']));
  // Core flows and unrelated channels are never gated.
  for (const channel of ['caos:annotations.create', 'caos:export.build', 'caos:agent.write', 'caos:ai.run', 'caos:license.activate']) {
    assert.doesNotThrow(() => license.assertChannel(repos, channel, []), channel);
  }
  // A valid licence opens them.
  const key = license.signPayload({ tier: 'pro', exp: Date.now() + 1e8 }, privatePem);
  license.activate(repos, key);
  assert.doesNotThrow(() => license.assertChannel(repos, 'caos:review.clientPack', []));
  // And an unenforced build never refuses.
  license.configure({ channel: 'dev', enforceLicense: false, demoKeys: true });
  assert.doesNotThrow(() => license.assertChannel(fakeRepos(), 'caos:review.clientPack', []));
});
