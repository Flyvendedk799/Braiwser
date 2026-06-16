// Chrome AI OS — Electron main process.
// Boots the store, registers IPC, and creates the shell window. The guest web
// project loads inside a <webview> in the renderer; all persistence and AI calls
// flow through IPC to this process.
const { app, BrowserWindow, webContents } = require('electron');
const path = require('path');
const { createRepositories } = require('./store/repositories');
const registerIpc = require('./ipc');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    title: 'Chrome AI OS',
    backgroundColor: '#0e0f13',
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
  if (process.argv.includes('--dev') || e2e) {
    if (e2e) {
      const levels = ['log', 'warn', 'error'];
      mainWindow.webContents.on('console-message', (_e, level, message) => {
        console.log(`[renderer:${levels[level] || level}] ${message}`);
      });
    }
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
});

app.whenReady().then(() => {
  const repos = createRepositories(app.getPath('userData'));
  const paths = {
    inspector: path.join(__dirname, '..', 'webview', 'inspector.js'),
    welcome: path.join(__dirname, '..', 'renderer', 'welcome.html'),
  };
  registerIpc({ repos, paths, getWindow: () => mainWindow });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
