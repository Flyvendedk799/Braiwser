// Braiwser — Electron main process.
// Boots the store, registers IPC, installs the native menu, and creates the
// shell window. The guest web project loads inside a <webview> in the renderer;
// all persistence and AI calls flow through IPC to this process.
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const { createRepositories } = require('./store/repositories');
const { migrateLegacyUserData } = require('./migrate');
const { installMenu } = require('./menu');
const config = require('./config');
const registerIpc = require('./ipc');
const { isE2E } = require('./env');
const { getE2EFinalizer } = require('./e2e-finalizer');

const security = require('./security');

let mainWindow = null;

// One process owns the JSON store (audit MB-03). A second launch hands over to the
// running window and exits; db.js additionally revision-checks every write.
const gotInstanceLock = isE2E() ? true : app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// A replay we are filming must keep painting even if the user clicks away to
// another window. Chromium otherwise throttles occluded/background renderers to
// a crawl, which turns an export into a few frozen frames. That is only needed
// WHILE filming, so throttling is switched off at runtime for the shell and the
// filmed guest (see the throttle-scope note below) instead of for the whole app lifetime. The
// process-wide switches remain only for the unattended E2E run.
const KEEP_AWAKE = isE2E() || process.env.BRAIWSER_KEEP_AWAKE === '1';
if (KEEP_AWAKE) {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}
// On Windows the occlusion detector alone will park the compositor the moment
// another window covers ours, which empties the capture stream mid-take.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// The per-run throttling toggle lives with the display-media grant
// (security/display-media.js + services/browser/throttle-scope.js): arming a
// video export lifts throttling for the shell and the filmed guest only, and
// ending the run (or a timeout / destroyed webContents) restores it.

// Window chrome must not flash the wrong colour before the renderer paints.
function shellBackground(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0e0f13' : '#f6f7f9';
}

// Electron >= 35 reports console levels as strings ('info' | 'warning' | 'error' | 'debug').
const CONSOLE_LEVELS = { info: 'log', warning: 'warn', error: 'error', debug: 'log' };
function consoleLevel(level) { return CONSOLE_LEVELS[level] || level; }

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
      backgroundThrottling: KEEP_AWAKE ? false : true,
      // Feature-flag argv for the shell preload (agentRuntime facade); see security/index.js.
      additionalArguments: security.shellAdditionalArguments(),
    },
  });
  // Only registered shell windows may call privileged IPC / attach webviews.
  security.registerShell(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const e2e = isE2E();
  if (e2e) {
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${consoleLevel(event.level)}] ${event.message}`);
    });
    // Every terminal state (done, crash, hang, load failure, main exception,
    // window closed early, overall timeout) goes through ONE finalizer that
    // prints the report and calls app.exit(1) unless the report is complete and
    // fully passing. See e2e-finalizer.js for the report format.
    const fin = getE2EFinalizer(app);
    fin.arm();
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[render-process-gone] ${JSON.stringify(details)}`);
      fin.finalize('render-process-gone', { reason: `renderer gone: ${(details && details.reason) || 'unknown'}` });
    });
    let hangTimer = null;
    mainWindow.webContents.on('unresponsive', () => {
      if (hangTimer) return;
      hangTimer = setTimeout(() => fin.finalize('unresponsive', { reason: 'renderer unresponsive for 30s' }), 30000);
    });
    mainWindow.webContents.on('responsive', () => { if (hangTimer) { clearTimeout(hangTimer); hangTimer = null; } });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) fin.finalize('load-failed', { reason: `load failed: ${code} ${desc} ${url}` });
    });
    mainWindow.on('closed', () => fin.finalize('incomplete-report', { reason: 'window closed before the suite finished' }));
    process.on('uncaughtException', (err) => {
      console.log('[main-exception] ' + ((err && err.stack) || err));
      fin.finalize('main-exception', { reason: (err && err.message) || String(err) });
    });
  }
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Forward renderer console + load failures to the terminal for debugging.
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${consoleLevel(event.level)}] ${event.message}  (${event.sourceId}:${event.lineNumber})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[render-process-gone] ${JSON.stringify(details)}`);
    });
  }
  // Screen capture for "export as video" is a one-shot, frame-bound grant armed
  // over caos:video.source (ipc/index.js) and redeemed by the display-media handler
  // that security/index.js installs on every session. See security/display-media.js.

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Web-contents policy lives in src/main/security: <webview> attach allow-list
// (preload, isolation flags, partition, src), shell navigation lock, guest
// navigation/popup rules, and default-deny permission handlers. The guest preload
// still runs unsandboxed by default because it require()s sibling modules; set
// BRAIWSER_SANDBOX_GUEST=1 (after `npm run build:guest`) to use the bundled,
// sandboxed build instead.
security.install();

app.whenReady().then(() => {
  if (!gotInstanceLock) return; // a second launch only hands over to the first
  // Carry a pre-rename (Chrome AI OS) store over on first launch as Braiwser.
  migrateLegacyUserData({ appDataDir: app.getPath('appData'), userDataDir: app.getPath('userData') });

  const repos = createRepositories(app.getPath('userData'));
  const storeHealth = repos.health();
  if (!storeHealth.ok) {
    console.log('[store] attention needed: ' + JSON.stringify(storeHealth.problems.concat(storeHealth.maintenance.errors)));
  }
  const paths = {
    inspector: path.join(__dirname, '..', 'webview', 'inspector.js'),
    welcome: path.join(__dirname, '..', 'renderer', 'welcome.html'),
    playground: path.join(__dirname, '..', 'renderer', 'sample', 'playground.html'),
    audit: path.join(__dirname, '..', 'webview', 'audit.js'),
  };
  registerIpc({ repos, paths, getWindow: () => mainWindow });

  // Agent runtime: the single broker shared by the UI, MCP, CLI and skills. Built
  // only when the feature flag is on; see services/browser/bootstrap.js.
  let agentRuntime = null;
  try {
    agentRuntime = require('./services/browser/bootstrap').startAgentRuntime({
      repos,
      userDataDir: app.getPath('userData'),
      getWindow: () => mainWindow,
      enabled: security.agentRuntimeEnabled(),
      isE2E: isE2E(),
      log: (m) => console.log(m),
    });
    registerIpc.agentBroker = agentRuntime.broker;
    if (typeof registerIpc.attachGuestViews === 'function') registerIpc.attachGuestViews(agentRuntime.guestViews);
    app.on('before-quit', () => { agentRuntime.close().catch(() => {}); });
  } catch (err) {
    console.log('[agent-runtime] unavailable: ' + ((err && err.message) || err));
  }

  // Credentials, once the window is on its way up rather than before it. Both of
  // these load the ESM auth library, and neither is worth delaying first paint
  // for: the migration moves any plaintext API key into the encrypted store, and
  // the refresh replaces the built-in model list with the registry's. A failure
  // in either leaves the app working on its compiled-in defaults.
  const authModule = require('./services/ai/auth');
  authModule.migratePlaintextKeys(repos.dir, repos.secrets.legacy).catch(() => {});
  Promise.all(Object.keys(config.MODEL_CHOICES).map(async (provider) => {
    const models = await authModule.modelsFor(provider);
    if (models.length) config.MODEL_CHOICES[provider] = models;
  })).catch(() => {});
  installMenu({
    getWindow: () => mainWindow,
    devices: config.DEVICE_PRESETS,
    themes: config.THEMES,
  });

  const settings = repos.settings.get();
  applyNativeTheme(settings.theme);
  createWindow(settings);
  if (agentRuntime && agentRuntime.enabled && mainWindow) agentRuntime.attachHost(mainWindow.webContents);

  // A damaged or unreadable data file is never overwritten; tell the user
  // instead of silently showing an empty workspace.
  if (!storeHealth.ok && !isE2E()) {
    try {
      const names = storeHealth.problems.map((p) => `${p.name}.json (${p.state})`).join(', ') || 'a data file';
      require('electron').dialog.showMessageBox({
        type: 'warning',
        title: 'Braiwser data needs attention',
        message: 'Some saved data could not be read, so it is open read-only.',
        detail: `${names}\n\nNothing has been deleted or overwritten. Changes to the affected data will not be saved until it is restored or recovered from its backup.`,
      }).catch(() => {});
    } catch (_e) { /* ignore */ }
  }

  try {
    require('./services/analytics').track(repos, 'install', { version: app.getVersion() });
  } catch (_e) { /* ignore */ }

  try {
    require('./services/updater').initUpdater({ getWindow: () => mainWindow, repos });
  } catch (_e) { /* optional */ }

  // Following the OS theme means reacting to it changing while we run.
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('caos:system-theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(repos.settings.get());
      if (agentRuntime && agentRuntime.enabled && mainWindow) agentRuntime.attachHost(mainWindow.webContents);
    }
  });
});

// Keep Electron's own surfaces (native dialogs, scrollbars) in step with the
// app's theme choice.
function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
