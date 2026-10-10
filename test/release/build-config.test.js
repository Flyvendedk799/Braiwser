const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildConfig } = require('../../scripts/gen-build-config');
const { verifyConfig, readConfig } = require('../../scripts/verify-packaged-config');

const { publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const { publicKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('release config requires an Ed25519 public key and disables demo and e2e bypass', () => {
  assert.throws(() => buildConfig('release', {}), /BRAIWSER_LICENSE_PUBLIC_KEY/);
  assert.throws(() => buildConfig('release', { BRAIWSER_LICENSE_PUBLIC_KEY: rsa.export({ type: 'spki', format: 'pem' }) }), /Ed25519/);
  assert.throws(() => buildConfig('release', { BRAIWSER_LICENSE_PUBLIC_KEY: 'garbage' }), /not a valid public key/);
  const oneLine = PUB.trim().split('\n').join('\\n');
  assert.ok(!oneLine.includes('\n'));
  const cfg = buildConfig('release', { BRAIWSER_LICENSE_PUBLIC_KEY: oneLine });
  assert.equal(cfg.enforceLicense, true);
  assert.equal(cfg.demoKeys, false);
  assert.equal(cfg.e2eBypass, false);
  assert.match(cfg.licensePublicKey, /BEGIN PUBLIC KEY/);
  assert.deepEqual(verifyConfig(cfg, 'release'), []);
});

test('ci config enforces licences but allows the e2e bypass and demo keys', () => {
  const cfg = buildConfig('ci', {});
  assert.equal(cfg.enforceLicense, true);
  assert.equal(cfg.e2eBypass, true);
  assert.equal(cfg.demoKeys, true);
  assert.deepEqual(verifyConfig(cfg, 'ci'), []);
  assert.ok(verifyConfig(cfg, 'release').length > 0);
});

test('a real asar round-trips and a missing config is reported', async () => {
  const asar = require('@electron/asar');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-asar-'));
  try {
    const src = path.join(root, 'app');
    fs.mkdirSync(path.join(src, 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(src, 'src', 'main', 'build-config.json'), JSON.stringify(buildConfig('ci', {})));
    const out = path.join(root, 'app.asar');
    await asar.createPackage(src, out);
    assert.equal(readConfig(out).channel, 'ci');

    fs.rmSync(path.join(src, 'src', 'main', 'build-config.json'));
    fs.writeFileSync(path.join(src, 'src', 'main', 'other.js'), '');
    const out2 = path.join(root, 'app2.asar');
    await asar.createPackage(src, out2);
    assert.throws(() => readConfig(out2), /missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
