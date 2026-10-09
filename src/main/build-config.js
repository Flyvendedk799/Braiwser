// Build-time configuration, baked into the package.
//
// The packaged app must not take its licensing posture from the end user's
// environment: a variable set while *building* is not visible to the installed
// app, and a variable set while *running* is controlled by whoever runs it.
// `scripts/gen-build-config.js` therefore writes `src/main/build-config.json`
// before `electron-builder` packs `src/**`, and this module is the only reader.
//
//   generated file present        -> it is authoritative
//   absent, running from source   -> development defaults (nothing enforced, demo
//                                    licences available, no production key)
//   absent, packaged              -> fail closed: Pro features gated, no demo keys
//
// Nothing here consults the environment except the development branch, where a
// contributor may point at a locally generated public key or turn enforcement on.
const fs = require('fs');
const path = require('path');

const GENERATED = path.join(__dirname, 'build-config.json');

const CHANNELS = ['dev', 'ci', 'release', 'unconfigured', 'invalid'];

function isPackaged() {
  try {
    const { app } = require('electron');
    return !!(app && app.isPackaged);
  } catch (_e) {
    return false;
  }
}

function keyList(raw) {
  const list = [];
  if (typeof raw.licensePublicKey === 'string' && raw.licensePublicKey.trim()) list.push(raw.licensePublicKey.trim());
  if (Array.isArray(raw.licensePublicKeys)) {
    for (const k of raw.licensePublicKeys) if (typeof k === 'string' && k.trim()) list.push(k.trim());
  }
  return Array.from(new Set(list));
}

function normalize(raw) {
  return {
    channel: CHANNELS.includes(raw.channel) ? raw.channel : 'invalid',
    enforceLicense: raw.enforceLicense === true,
    e2eBypass: raw.e2eBypass === true,
    demoKeys: raw.demoKeys === true,
    licensePublicKeys: keyList(raw),
  };
}

function developmentDefaults(env) {
  return normalize({
    channel: 'dev',
    enforceLicense: env.BRAIWSER_ENFORCE_LICENSE === '1',
    e2eBypass: true,
    demoKeys: true,
    licensePublicKey: env.BRAIWSER_LICENSE_PUBLIC_KEY || '',
  });
}

function failClosed(channel) {
  return normalize({ channel, enforceLicense: true, e2eBypass: false, demoKeys: false });
}

// Pure so it can be tested without touching the filesystem.
function resolveConfig({ generated, packaged, env = {} }) {
  if (generated && generated.parseError) return failClosed('invalid');
  if (generated) return normalize(generated);
  return packaged ? failClosed('unconfigured') : developmentDefaults(env);
}

function readGenerated(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { parseError: true };
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { parseError: true };
  } catch (_e) {
    return { parseError: true };
  }
}

let cached = null;

function get() {
  if (!cached) {
    cached = resolveConfig({ generated: readGenerated(GENERATED), packaged: isPackaged(), env: process.env });
  }
  return cached;
}

function reset() {
  cached = null;
}

module.exports = { get, reset, resolveConfig, normalize, readGenerated, GENERATED, CHANNELS, isPackaged };
