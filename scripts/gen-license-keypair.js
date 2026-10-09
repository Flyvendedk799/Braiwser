#!/usr/bin/env node
// Generates an Ed25519 licence-signing keypair.
//
//   node scripts/gen-license-keypair.js [--dir .license-keys]
//
// The PUBLIC key is what ships in the app (BRAIWSER_LICENSE_PUBLIC_KEY at build
// time, or locally for development). The PRIVATE key issues licences and must never
// be committed or packaged: it is written to a git-ignored directory with mode 0600.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argDir = process.argv.indexOf('--dir');
const dir = path.resolve(argDir >= 0 ? process.argv[argDir + 1] : path.join(__dirname, '..', '.license-keys'));

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dir, 'license-private.pem'), privatePem, { mode: 0o600, flag: 'wx' });
fs.writeFileSync(path.join(dir, 'license-public.pem'), publicPem, { mode: 0o644, flag: 'wx' });

console.log(`Wrote ${path.join(dir, 'license-private.pem')} (KEEP SECRET, git-ignored)`);
console.log(`Wrote ${path.join(dir, 'license-public.pem')}`);
console.log('\nPublic key (BRAIWSER_LICENSE_PUBLIC_KEY):\n' + publicPem);
