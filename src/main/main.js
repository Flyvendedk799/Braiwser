// Chrome AI OS — Electron main process.
// Boots the store, registers IPC, and creates the shell window. The guest web
// project loads inside a <webview> in the renderer; all persistence and AI calls
// flow through IPC to this process.
const { app, BrowserWindow, webContents, shell } = require('electron');
const path = require('path');
const { createRepositories } = require('./store/repositories');
const registerIpc = require('./ipc');

let mainWindow = null;
let videoSourceId = null; // the webContents the renderer may film

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
  // hand it the guest page's own web contents — so the film is the page itself,
  // with none of our chrome in the frame and no cropping guesswork.
  try {
    const { session: electronSession, ipcMain: ipc } = require('electron');
    ipc.removeHandler && ipc.removeHandler('caos:video.source');
    ipc.handle('caos:video.source', (_e, id) => {
      videoSourceId = typeof id === 'number' ? id : null;
      return true;
    });
    electronSession.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // Only ever our own window, only when the renderer asked for it, never a
        // picker and never the desktop. desktopCapturer does not list the calling
        // app's own windows here, so hand back the window's own media-source id
        // directly — which is exactly what getMediaSourceId() is for.
        if (videoSourceId == null || !mainWindow || mainWindow.isDestroyed()) { callback({}); return; }
        try {
          callback({ video: { id: mainWindow.getMediaSourceId(), name: mainWindow.getTitle() } });
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
