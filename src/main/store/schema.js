// Store schema versioning. Every boot runs migrations whose `from` matches the
// version recorded in meta.json, then bumps to CURRENT_SCHEMA_VERSION.
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./db');

const CURRENT_SCHEMA_VERSION = 2;

// v1 → v2: introduce explicit schemaVersion + ensure settings.persona exists.
const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    run(dir) {
      const settingsPath = path.join(dir, 'settings.json');
      let settings = {};
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (_e) {
        settings = {};
      }
      if (!settings.persona) settings.persona = 'agent';
      if (settings.aiTimeoutMs == null) settings.aiTimeoutMs = 120000;
      if (settings.analyticsOptIn == null) settings.analyticsOptIn = false;
      if (settings.crashReportsOptIn == null) settings.crashReportsOptIn = false;
      if (settings.licenseKey == null) settings.licenseKey = '';
      if (settings.visibility == null) settings.visibility = 'internal';
      atomicWriteFile(settingsPath, settings);
    },
  },
];

function readMeta(dir) {
  const file = path.join(dir, 'meta.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    // Existing stores without meta are treated as v1 so migrations run once.
    const hasData = ['projects.json', 'settings.json', 'sessions.json'].some((n) =>
      fs.existsSync(path.join(dir, n))
    );
    return { schemaVersion: hasData ? 1 : CURRENT_SCHEMA_VERSION };
  }
}

function writeMeta(dir, meta) {
  atomicWriteFile(path.join(dir, 'meta.json'), meta);
}

function migrateStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let meta = readMeta(dir);
  let version = Number(meta.schemaVersion) || 1;
  const applied = [];

  for (const step of MIGRATIONS) {
    if (version === step.from) {
      step.run(dir);
      version = step.to;
      applied.push(`${step.from}->${step.to}`);
    }
  }

  meta = {
    ...meta,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    applied,
  };
  writeMeta(dir, meta);
  return meta;
}

module.exports = { CURRENT_SCHEMA_VERSION, migrateStore, readMeta };
