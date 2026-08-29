// Braiwser — Electron main process.
// Boots the store, registers IPC, installs the native menu, and creates the
// shell window. The guest web project loads inside a <webview> in the renderer;
// all persistence and AI calls flow through IPC to this process.
const { app, BrowserWindow, nativeTheme, shell } = require('electron');
const path = require('path');
const { createRepositories } = require('./store/repositories');
const { migrateLegacyUserData } = require('./migrate');
const { installMenu } = require('./menu');
const config = require('./config');
const registerIpc = require('./ipc');

let mainWindow = null;
let videoSourceId = null; // the webContents the renderer may film

// A replay we are filming must keep painting even if the user clicks away to
// another window. Chromium otherwise throttles occluded/background renderers to
// a crawl, which turns an export into a few frozen frames.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// On Windows the occlusion detector alone will park the compositor the moment
// another window covers ours, which empties the capture stream mid-take.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Window chrome must not flash the wrong colour before the renderer paints.
function shellBackground(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0e0f13' : '#f6f7f9';
}

function createWindow(settings) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    title: 'Braiwser',
    backgroundColor: shellBackground(settings && settings.theme),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const e2e = process.env.CAOS_E2E === '1';
  if (e2e) {
    const levels = ['log', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${levels[level] || level}] ${message}`);
    });
    // A crash mid-suite should still report how far it got.
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[render-process-gone] ${JSON.stringify(details)}`);
      try {
        const ipc = require('./ipc');
        const partial = ipc.e2ePartial ? ipc.e2ePartial() : [];
        const passed = partial.filter((c) => c.pass).length;
        console.log('CAOS_E2E_REPORT ' + JSON.stringify({ ok: false, crashed: true, passed, total: partial.length, checks: partial }));
      } catch (_err) {
        /* ignore */
      }
      setTimeout(() => app.quit(), 150);
    });
  }
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Forward renderer console + load failures to the terminal for debugging.
    const levels = ['log', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${levels[level] || level}] ${message}  (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[render-process-gone] ${JSON.stringify(details)}`);
      // Print whatever the self-test had reached, then leave — a crash used to
      // swallow the whole run and tell you nothing about where it got to.
      try {
        const ipc = require('./ipc');
        const partial = ipc.e2ePartial ? ipc.e2ePartial() : [];
        const passed = partial.filter((c) => c.pass).length;
        console.log('CAOS_E2E_REPORT ' + JSON.stringify({ ok: false, crashed: true, passed, total: partial.length, checks: partial }));
      } catch (_err) {
        /* ignore */
      }
      setTimeout(() => app.quit(), 150);
    });
  }
  // Screen capture for "export as video": the renderer asks to record, and we
  // hand back the guest page's own frame — so the film is the page itself, at
  // the page's own resolution, with none of our chrome in it and no cropping
  // guesswork. The frame keeps streaming across cross-document navigations, so
  // a journey that moves between pages films as one continuous take.
  try {
    const { session: electronSession, ipcMain: ipc, webContents } = require('electron');
    ipc.removeHandler && ipc.removeHandler('caos:video.source');
    ipc.handle('caos:video.source', (_e, id) => {
      videoSourceId = typeof id === 'number' ? id : null;
      return true;
    });
    electronSession.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // Only ever the page we were told to film, only when the renderer asked
        // for it, never a picker and never the desktop.
        if (videoSourceId == null) { callback({}); return; }
        try {
          const guest = webContents.fromId(videoSourceId);
          if (!guest || guest.isDestroyed()) { callback({}); return; }
          callback({ video: guest.mainFrame });
        } catch (err) {
          console.log('[video] ' + ((err && err.message) || err));
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  } catch (err) {
    console.log('[video] capture handler unavailable: ' + ((err && err.message) || err));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// The <webview>'s preload (the inspector engine) requires sibling modules via
// relative paths. A sandboxed preload can't resolve those, so disable the
// sandbox for attached webviews while keeping contextIsolation on.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.sandbox = false;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.backgroundThrottling = false;
  });
  // Guest pages must not spawn uncontrolled in-app windows. Deny all popups;
  // open vetted http/https links in the OS browser instead.
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
      } catch (_e) { /* ignore malformed URLs */ }
      return { action: 'deny' };
    });
  }
});

app.whenReady().then(() => {
  // Carry a pre-rename (Chrome AI OS) store over on first launch as Braiwser.
  migrateLegacyUserData({ appDataDir: app.getPath('appData'), userDataDir: app.getPath('userData') });

  const repos = createRepositories(app.getPath('userData'));
  const paths = {
    inspector: path.join(__dirname, '..', 'webview', 'inspector.js'),
    welcome: path.join(__dirname, '..', 'renderer', 'welcome.html'),
    audit: path.join(__dirname, '..', 'webview', 'audit.js'),
  };
  registerIpc({ repos, paths, getWindow: () => mainWindow });
  installMenu({
    getWindow: () => mainWindow,
    devices: config.DEVICE_PRESETS,
    themes: config.THEMES,
  });

  const settings = repos.settings.get();
  applyNativeTheme(settings.theme);
  createWindow(settings);

  // Following the OS theme means reacting to it changing while we run.
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('caos:system-theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(repos.settings.get());
  });
});

// Keep Electron's own surfaces (native dialogs, scrollbars) in step with the
// app's theme choice.
function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
