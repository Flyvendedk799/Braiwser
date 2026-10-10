// Store schema versioning. Every boot runs migrations whose `from` matches the
// version recorded in meta.json, then bumps to CURRENT_SCHEMA_VERSION.
//
// Safety rules (audit MB-05/MB-06):
//   • Only ENOENT means "not there yet". An unreadable or corrupt file is left
//     exactly as it is — a migration that can't read its input is SKIPPED and
//     the recorded version does not advance, so it is retried next launch
//     instead of overwriting what it could not read with defaults.
//   • meta.json is only rewritten when something actually changed, and a store
//     written by a NEWER build is never downgraded.
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./db');

const CURRENT_SCHEMA_VERSION = 2;

// Reads a JSON object. Returns { missing:true } for ENOENT and throws for
// anything else (unreadable, invalid JSON, wrong shape).
function readJsonObject(fsx, file) {
  let text;
  try {
    text = fsx.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { missing: true, value: {} };
    throw err;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return { missing: false, value };
}

// v1 → v2: introduce explicit schemaVersion + ensure settings.persona exists.
const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    run(dir, fsx) {
      const settingsPath = path.join(dir, 'settings.json');
      const { value: settings } = readJsonObject(fsx, settingsPath); // throws → step skipped
      if (!settings.persona) settings.persona = 'agent';
      if (settings.aiTimeoutMs == null) settings.aiTimeoutMs = 120000;
      if (settings.analyticsOptIn == null) settings.analyticsOptIn = false;
      if (settings.crashReportsOptIn == null) settings.crashReportsOptIn = false;
      if (settings.licenseKey == null) settings.licenseKey = '';
      if (settings.visibility == null) settings.visibility = 'internal';
      atomicWriteFile(settingsPath, settings, fsx);
    },
  },
];

function readMetaDetailed(dir, fsx = fs) {
  const file = path.join(dir, 'meta.json');
  try {
    return { ...readJsonObject(fsx, file), file };
  } catch (err) {
    // ENOENT is handled inside readJsonObject; reaching here means unreadable or
    // corrupt. Treat the store as v1 (migrations are idempotent) but remember it.
    return { missing: false, value: { schemaVersion: 1 }, damaged: err.message };
  }
}

// Plain meta object (v1 when damaged; a brand-new store is current).
function readMeta(dir, fsx = fs) {
  const r = readMetaDetailed(dir, fsx);
  return r.missing ? { schemaVersion: CURRENT_SCHEMA_VERSION } : r.value;
}

function writeMeta(dir, meta, fsx = fs) {
  atomicWriteFile(path.join(dir, 'meta.json'), meta, fsx);
}

function migrateStore(dir, opts = {}) {
  const fsx = opts.fs || fs;
  fsx.mkdirSync(dir, { recursive: true });
  const read = readMetaDetailed(dir, fsx);
  let meta = read.value;

  let hasData = false;
  if (read.missing) {
    // A store without meta is v1 if it holds data, brand new otherwise.
    hasData = ['projects.json', 'settings.json', 'sessions.json'].some((n) => fsx.existsSync(path.join(dir, n)));
    meta = { schemaVersion: hasData ? 1 : CURRENT_SCHEMA_VERSION };
  }
  let version = Number(meta.schemaVersion) || 1;
  const startVersion = version;
  const applied = [];
  const errors = [];

  if (version > CURRENT_SCHEMA_VERSION) {
    // Written by a newer build: leave it alone rather than downgrading the marker.
    return { ...meta, schemaVersion: version, newerThanApp: true, applied, errors };
  }

  for (const step of MIGRATIONS) {
    if (version === step.from) {
      try {
        step.run(dir, fsx);
      } catch (err) {
        errors.push({ step: `${step.from}->${step.to}`, message: (err && err.message) || String(err) });
        break; // do not advance past a step that could not run
      }
      version = step.to;
      applied.push(`${step.from}->${step.to}`);
    }
  }

  const next = { ...meta, schemaVersion: version };
  const changed = read.missing || version !== startVersion || meta.schemaVersion !== version;
  if (changed) {
    next.migratedAt = new Date().toISOString();
    next.applied = applied;
    try {
      if (read.damaged) {
        // Keep the damaged file for inspection before replacing it.
        try { fsx.copyFileSync(path.join(dir, 'meta.json'), path.join(dir, `meta.json.corrupt-${Date.now()}`)); } catch (_e) { /* ignore */ }
      }
      writeMeta(dir, next, fsx);
    } catch (err) {
      errors.push({ step: 'meta', message: (err && err.message) || String(err) });
    }
  }
  if (errors.length) next.errors = errors;
  if (read.damaged) next.metaDamaged = read.damaged;
  return next;
}

module.exports = { CURRENT_SCHEMA_VERSION, migrateStore, readMeta };
