// Auto-update + opt-in crash breadcrumb wiring for packaged builds.
let updater = null;

function initUpdater({ getWindow, repos }) {
  // electron-updater is optional until installed in package.json; packaged
  // apps enable it when the dependency resolves.
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (_e) {
    return { ok: false, reason: 'electron-updater not installed' };
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('caos:update', { state: 'available', info });
  });
  updater.on('update-downloaded', (info) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('caos:update', { state: 'downloaded', info });
  });
  updater.on('error', (err) => {
    if (repos) {
      try {
        const analytics = require('./analytics');
        analytics.writeCrashBreadcrumb(repos, { type: 'updater', message: String(err && err.message || err) });
      } catch (_e) { /* ignore */ }
    }
  });
  return { ok: true };
}

async function checkForUpdates() {
  if (!updater) return { ok: false, error: 'Updater unavailable in this build' };
  try {
    const result = await updater.checkForUpdates();
    return { ok: true, result: result && result.updateInfo };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

function quitAndInstall() {
  if (!updater) return { ok: false };
  updater.quitAndInstall();
  return { ok: true };
}

module.exports = { initUpdater, checkForUpdates, quitAndInstall };
