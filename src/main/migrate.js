// One-time data migrations for Braiwser store identity.
//
// 1) Chrome AI OS → Braiwser app rename: copy legacy appData stores into the
//    current userData tree.
// 2) Store folder rename: userData/caos → userData/braiwser.
//
// Old directories are left untouched so a downgrade still works. Failures never
// throw — a botched migration must not stop the app from booting.
//
// Staged + atomic (audit MB-06):
//   1. copy the source into a sibling staging dir  `<target>.migrating`
//   2. verify every source file arrived with the same size
//   3. write the completion marker `.braiwser-migrated.json` into staging
//   4. rename staging → target (atomic on one volume)
// The target therefore either does not exist or is complete; an interruption at
// any stage leaves only a staging dir, which the next launch wipes and redoes
// (the source is never modified). A target left half-filled by an older build
// (no user-data files in it, no marker) is completed by copying only the files
// it is MISSING — nothing already there is ever overwritten.
const fs = require('fs');
const path = require('path');

const LEGACY_APP_DIRS = ['chrome-ai-os', 'Chrome AI OS'];
const LEGACY_STORE_DIR = 'caos';
const STORE_DIR = 'braiwser';
const MARKER = '.braiwser-migrated.json';
const STAGING_SUFFIX = '.migrating';
// Files whose presence means "this store holds real user data".
const DATA_FILES = ['projects.json', 'settings.json', 'sessions.json', 'annotations.json', 'recordings.json'];

function listFiles(fsx, root, rel = '', out = []) {
  for (const entry of fsx.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) listFiles(fsx, root, r, out);
    else if (entry.isFile() && !/\.tmp$/.test(entry.name) && entry.name !== MARKER) out.push(r);
  }
  return out;
}

// Copies `files` (relative paths) from → to. With skipExisting, never replaces a
// file that is already there. Each file lands via a temp name + rename.
function copyFiles(fsx, from, to, files, { skipExisting = false } = {}) {
  let copied = 0;
  for (const rel of files) {
    const dst = path.join(to, rel);
    if (skipExisting && fsx.existsSync(dst)) continue;
    fsx.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + '.migrating.tmp';
    fsx.copyFileSync(path.join(from, rel), tmp);
    fsx.renameSync(tmp, dst);
    copied += 1;
  }
  return copied;
}

function verify(fsx, from, to, files) {
  for (const rel of files) {
    const a = fsx.statSync(path.join(from, rel));
    let b;
    try { b = fsx.statSync(path.join(to, rel)); } catch (_e) { throw new Error(`verification failed: ${rel} is missing`); }
    if (a.size !== b.size) throw new Error(`verification failed: ${rel} size mismatch`);
  }
}

function writeMarker(fsx, dir, info) {
  const file = path.join(dir, MARKER);
  const tmp = file + '.tmp';
  fsx.writeFileSync(tmp, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...info }, null, 2));
  fsx.renameSync(tmp, file);
}

function hasUserData(fsx, dir) {
  return DATA_FILES.some((n) => fsx.existsSync(path.join(dir, n)));
}

// Migrate `source` into `target`. Returns { migrated, resumed? }.
function promote(fsx, source, target, kind) {
  const files = listFiles(fsx, source);
  const staging = target + STAGING_SUFFIX;

  // An existing target is only touched if an older build left it incomplete:
  // no marker AND no user-data file of its own.
  if (fsx.existsSync(target)) {
    if (fsx.existsSync(path.join(target, MARKER)) || hasUserData(fsx, target)) return { migrated: false };
    copyFiles(fsx, source, target, files, { skipExisting: true });
    verify(fsx, source, target, files);
    writeMarker(fsx, target, { from: source, kind, files: files.length, resumed: true });
    return { migrated: true, resumed: true };
  }

  fsx.rmSync(staging, { recursive: true, force: true }); // a previous interrupted attempt
  try {
    fsx.mkdirSync(staging, { recursive: true });
    copyFiles(fsx, source, staging, files);
    verify(fsx, source, staging, files);
    writeMarker(fsx, staging, { from: source, kind, files: files.length });
    fsx.renameSync(staging, target);
  } catch (err) {
    try { fsx.rmSync(staging, { recursive: true, force: true }); } catch (_e) { /* next launch wipes it */ }
    throw err;
  }
  return { migrated: true };
}

function migrateLegacyUserData({ appDataDir, userDataDir, fs: fsImpl }) {
  const fsx = fsImpl || fs;
  try {
    const target = path.join(userDataDir, STORE_DIR);
    const legacyLocal = path.join(userDataDir, LEGACY_STORE_DIR);
    fsx.mkdirSync(userDataDir, { recursive: true });

    // Prefer an existing braiwser/ store. Otherwise promote caos/ in place.
    if (fsx.existsSync(legacyLocal) && (!fsx.existsSync(target) || (!fsx.existsSync(path.join(target, MARKER)) && !hasUserData(fsx, target)))) {
      const r = promote(fsx, legacyLocal, target, 'store-rename');
      if (r.migrated) return { ...r, from: legacyLocal, kind: 'store-rename' };
    }

    if (fsx.existsSync(target) && (fsx.existsSync(path.join(target, MARKER)) || hasUserData(fsx, target))) {
      return { migrated: false };
    }

    for (const legacy of LEGACY_APP_DIRS) {
      for (const storeName of [STORE_DIR, LEGACY_STORE_DIR]) {
        const source = path.join(appDataDir, legacy, storeName);
        if (source === target || !fsx.existsSync(source)) continue;
        const r = promote(fsx, source, target, 'app-rename');
        if (r.migrated) return { ...r, from: source, kind: 'app-rename' };
      }
    }
    return { migrated: false };
  } catch (err) {
    return { migrated: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { migrateLegacyUserData, STORE_DIR, LEGACY_STORE_DIR, MARKER, STAGING_SUFFIX };
