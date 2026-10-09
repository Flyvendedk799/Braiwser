#!/usr/bin/env node
// Writes src/main/build-config.json, the build-time configuration the packaged app
// reads (see src/main/build-config.js). Run it immediately before electron-builder:
//
//   BRAIWSER_LICENSE_PUBLIC_KEY="$(cat license-public.pem)" \
//     node scripts/gen-build-config.js --channel release
//
// Channels
//   release  Pro features gated, no demo licences, no e2e bypass. Requires an
//            Ed25519 PUBLIC key; the build fails without one, because a release
//            that enforces licences but trusts no key would lock every Pro
//            feature for everybody.
//   ci       Pro features gated, but demo licences and the e2e bypass are on so the
//            packaged smoke test can drive the whole app. Never published.
//   dev      Remove any generated file; running from source uses the development
//            defaults.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT = path.join(__dirname, '..', 'src', 'main', 'build-config.json');

// CI secret stores often flatten a PEM to one line with literal "\n" sequences.
function normalizePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function assertEd25519Public(pem) {
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (err) {
    throw new Error(`BRAIWSER_LICENSE_PUBLIC_KEY is not a valid public key: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`BRAIWSER_LICENSE_PUBLIC_KEY must be an Ed25519 key, got ${key.asymmetricKeyType}`);
  }
  if (key.type !== 'public') throw new Error('BRAIWSER_LICENSE_PUBLIC_KEY must be a public key');
  return key.export({ type: 'spki', format: 'pem' }).toString().trim();
}

function buildConfig(channel, env = process.env) {
  const rawKey = normalizePem(env.BRAIWSER_LICENSE_PUBLIC_KEY);
  if (channel === 'release') {
    if (!rawKey) throw new Error('A release build needs BRAIWSER_LICENSE_PUBLIC_KEY (Ed25519 public key, PEM). Generate a pair with scripts/gen-license-keypair.js and keep the private key out of the repository.');
    return {
      channel,
      enforceLicense: true,
      e2eBypass: false,
      demoKeys: false,
      licensePublicKey: assertEd25519Public(rawKey),
    };
  }
  if (channel === 'ci') {
    return {
      channel,
      enforceLicense: true,
      e2eBypass: true,
      demoKeys: true,
      licensePublicKey: rawKey ? assertEd25519Public(rawKey) : '',
    };
  }
  throw new Error(`Unknown channel "${channel}" (expected release, ci or dev)`);
}

function main(argv) {
  const i = argv.indexOf('--channel');
  const channel = i >= 0 ? argv[i + 1] : '';
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : OUT;
  if (channel === 'dev') {
    try { fs.unlinkSync(out); } catch (_e) { /* nothing to remove */ }
    console.log('Removed generated build config; running from source uses development defaults.');
    return;
  }
  const config = buildConfig(channel);
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), out)} (channel=${config.channel}, enforceLicense=${config.enforceLicense}, demoKeys=${config.demoKeys}, publicKey=${config.licensePublicKey ? 'yes' : 'no'})`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildConfig, normalizePem };
