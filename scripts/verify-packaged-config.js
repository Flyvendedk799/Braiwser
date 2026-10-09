#!/usr/bin/env node
// Asserts that a packaged app.asar carries the build config the release depends on.
//
//   node scripts/verify-packaged-config.js <path/to/app.asar> --channel release|ci
//
// Without this, a packaging change that dropped the generated (git-ignored)
// build-config.json would silently produce an app that fails closed in the best
// case and an ungated one in the worst, and nothing would notice until a user did.
const fs = require('fs');
const path = require('path');

function readConfig(asarPath) {
  const asar = require('@electron/asar');
  let raw;
  try {
    raw = asar.extractFile(asarPath, path.join('src', 'main', 'build-config.json')).toString('utf8');
  } catch (err) {
    throw new Error(`build-config.json is missing from ${asarPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`build-config.json in ${asarPath} is not valid JSON: ${err.message}`);
  }
}

function verifyConfig(config, channel) {
  const problems = [];
  if (config.channel !== channel) problems.push(`channel is "${config.channel}", expected "${channel}"`);
  if (config.enforceLicense !== true) problems.push('enforceLicense is not true');
  if (channel === 'release') {
    if (config.demoKeys !== false) problems.push('demoKeys must be false in a release');
    if (config.e2eBypass !== false) problems.push('e2eBypass must be false in a release');
    if (!config.licensePublicKey) problems.push('licensePublicKey is empty');
  }
  return problems;
}

function main(argv) {
  const ci = argv.indexOf('--channel');
  const channel = ci >= 0 ? argv[ci + 1] : 'release';
  const asarPath = argv.find((a, i) => !a.startsWith('--') && i !== ci + 1);
  if (!asarPath || !fs.existsSync(asarPath)) throw new Error(`app.asar not found: ${asarPath}`);
  const problems = verifyConfig(readConfig(asarPath), channel);
  if (problems.length) throw new Error('Packaged build config is wrong:\n - ' + problems.join('\n - '));
  console.log(`Packaged build config OK (${channel}): licences enforced${channel === 'release' ? ', no demo keys, no e2e bypass' : ''}.`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { readConfig, verifyConfig };
