#!/usr/bin/env node
// Issues a licence token signed with the private key from gen-license-keypair.js.
//
//   node scripts/issue-license.js --email a@b.co [--tier pro|team] [--seats 1] [--days 365] [--key .license-keys/license-private.pem]
//
// Runs on the vendor's machine only; the app can verify tokens but never mint them.
const fs = require('fs');
const path = require('path');
const { signPayload } = require('../src/main/services/license');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const email = arg('email');
if (!email) {
  console.error('--email is required');
  process.exit(1);
}
const tier = arg('tier', 'pro');
if (tier !== 'pro' && tier !== 'team') {
  console.error('--tier must be pro or team');
  process.exit(1);
}
const keyFile = path.resolve(arg('key', path.join(__dirname, '..', '.license-keys', 'license-private.pem')));
let pem;
try {
  pem = fs.readFileSync(keyFile, 'utf8');
} catch (err) {
  console.error(`Cannot read private key ${keyFile}: ${err.message}`);
  process.exit(1);
}
const days = Math.max(1, Number(arg('days', 365)) || 365);
const seats = Math.max(1, Number(arg('seats', 1)) || 1);
console.log(signPayload({ email, tier, seats, iat: Date.now(), exp: Date.now() + days * 86400000 }, pem));
