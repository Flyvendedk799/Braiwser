// One-time data migrations for Braiwser store identity.
//
// 1) Chrome AI OS → Braiwser app rename: copy legacy appData stores into the
//    current userData tree.
// 2) Store folder rename: userData/caos → userData/braiwser.
//
// Old directories are left untouched so a downgrade still works. Failures never
// throw — a botched migration must not stop the app from booting.
const fs = require('fs');
const path = require('path');

const LEGACY_APP_DIRS = ['chrome-ai-os', 'Chrome AI OS'];
const LEGACY_STORE_DIR = 'caos';
const STORE_DIR = 'braiwser';

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

function migrateLegacyUserData({ appDataDir, userDataDir }) {
  try {
    const target = path.join(userDataDir, STORE_DIR);
    const legacyLocal = path.join(userDataDir, LEGACY_STORE_DIR);

    // Prefer an existing braiwser/ store. Otherwise promote caos/ in place.
    if (!fs.existsSync(target) && fs.existsSync(legacyLocal)) {
      copyTree(legacyLocal, target);
      return { migrated: true, from: legacyLocal, kind: 'store-rename' };
    }

    if (fs.existsSync(target)) return { migrated: false };

    for (const legacy of LEGACY_APP_DIRS) {
      for (const storeName of [STORE_DIR, LEGACY_STORE_DIR]) {
        const source = path.join(appDataDir, legacy, storeName);
        if (source === target || !fs.existsSync(source)) continue;
        copyTree(source, target);
        return { migrated: true, from: source, kind: 'app-rename' };
      }
    }
    return { migrated: false };
  } catch (err) {
    return { migrated: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { migrateLegacyUserData, STORE_DIR, LEGACY_STORE_DIR };
