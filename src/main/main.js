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
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const e2e = process.env.CAOS_E2E === '1';
  if (e2e) {
    const levels = ['log', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${levels[level] || level}] ${message}`);
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
    });
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
