// One-time data migration for the Chrome AI OS → Braiwser rename.
//
// Electron derives userData from the package name, so renaming the app moved
// the store from <appData>/chrome-ai-os to <appData>/braiwser. Existing users
// would otherwise open v1 to an empty workspace. On first launch under the new
// name we copy the old `caos/` store across verbatim; the old directory is left
// untouched so a downgrade still works.
const fs = require('fs');
const path = require('path');

const LEGACY_APP_DIRS = ['chrome-ai-os', 'Chrome AI OS'];
const STORE_DIR = 'caos';

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// Returns { migrated:boolean, from?:string } — never throws, since a failed
// migration must not stop the app from booting.
function migrateLegacyUserData({ appDataDir, userDataDir }) {
  try {
    const target = path.join(userDataDir, STORE_DIR);
    if (fs.existsSync(target)) return { migrated: false };

    for (const legacy of LEGACY_APP_DIRS) {
      const source = path.join(appDataDir, legacy, STORE_DIR);
      if (source === target || !fs.existsSync(source)) continue;
      copyTree(source, target);
      return { migrated: true, from: source };
    }
    return { migrated: false };
  } catch (err) {
    return { migrated: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { migrateLegacyUserData };
