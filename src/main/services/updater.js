// Auto-update + opt-in crash breadcrumb wiring for packaged builds.
//
// Nothing here talks to the network on its own: no check is made at start-up, only
// when the user asks (`checkForUpdates`). An update that is found is then
// downloaded from the GitHub release feed in package.json and installed when the
// app quits. Unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false in CI) cannot
// auto-update on macOS, which requires a signed app.
let updater = null;

function runningPackaged() {
  try {
    const { app } = require('electron');
    return !!(app && app.isPackaged);
  } catch (_e) {
    return false;
  }
}

function initUpdater({ getWindow, repos, packaged = runningPackaged() }) {
  // Updates only make sense for an installed build; a source run has no update feed.
  if (!packaged) return { ok: false, reason: 'updates are only available in packaged builds' };
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
