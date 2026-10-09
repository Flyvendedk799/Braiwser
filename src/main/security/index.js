'use strict';
// Main-process security wiring. The policy decisions live in the pure sibling
// modules (ipc-guard, webview-policy, permission-policy, navigation-policy,
// display-media-grant, file-roots) which are unit-tested without Electron; this
// file only connects them to Electron events. Electron is required lazily so the
// module can be loaded under plain node (tests, `npm run check`).
//
//   const security = require('./security');
//   security.install();                    // once, at module load of main.js
//   security.registerShell(win.webContents) // for every shell BrowserWindow
//   security.attachRepos(repos)            // so project folders count as file roots
//
// Needs native Electron confirmation (not exercised by unit tests): the exact
// shape of will-attach-webview's webPreferences.preload (path vs file URL), the
// event.senderFrame URL for loadFile pages, webContents.setBackgroundThrottling,
// request.frame in the display-media handler, and sandboxed guest preload.

const fs = require('fs');
const path = require('path');
const { createIpcGuard } = require('./ipc-guard');
const { DEFAULT_ARG_RULES } = require('./ipc-args');
const { sanitizeWebviewAttach } = require('./webview-policy');
const { createFileRoots } = require('./file-roots');
const { createPermissionPolicy } = require('./permission-policy');
const nav = require('./navigation-policy');

const MAIN_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(MAIN_DIR, '..');
const SHELL_PAGE = path.join(SRC_DIR, 'renderer', 'index.html');
const INSPECTOR_PRELOAD = path.join(SRC_DIR, 'webview', 'inspector.js');
const GUEST_BUNDLE = path.join(SRC_DIR, 'webview', 'dist', 'guest-preload.bundle.js');

const shellIds = new Set();
let repos = null;
let installed = false;

const log = (m) => { try { console.log(m); } catch (_e) { /* ignore */ } };
const isE2E = () => process.env.BRAIWSER_E2E === '1' || process.env.CAOS_E2E === '1';

function readSettings() {
  try { return (repos && repos.settings && repos.settings.get()) || {}; } catch (_e) { return {}; }
}

// ---- shell registry ---------------------------------------------------------
function registerShell(webContents) {
  if (!webContents) return;
  shellIds.add(webContents.id);
  try { webContents.once('destroyed', () => shellIds.delete(webContents.id)); } catch (_e) { /* ignore */ }
}
function isShellWebContents(wc) {
  return !!wc && shellIds.has(wc.id);
}

// ---- feature flags ----------------------------------------------------------
function agentRuntimeEnabled() {
  if (process.env.BRAIWSER_AGENT_RUNTIME === '1' || isE2E()) return true;
  const flags = readSettings().featureFlags;
  return !!(flags && flags.agentRuntime === true);
}
// Extra argv for the shell window's renderer process; read by the shell preload.
function shellAdditionalArguments() {
  return agentRuntimeEnabled() ? ['--braiwser-agent-runtime=1'] : [];
}

function sandboxGuestEnabled() {
  if (process.env.BRAIWSER_SANDBOX_GUEST === '1') return true;
  return readSettings().sandboxGuest === true;
}
function bundledPreloadPath() {
  return fs.existsSync(GUEST_BUNDLE) ? GUEST_BUNDLE : null;
}

// ---- file roots -------------------------------------------------------------
const fileRoots = createFileRoots({
  getDynamicRoots: () => {
    if (!repos || !repos.projects) return [];
    try {
      return repos.projects.list().filter((p) => p && p.kind === 'local' && p.path).map((p) => p.path);
    } catch (_e) { return []; }
  },
});
fileRoots.addRoot(path.join(SRC_DIR, 'renderer'));

// A path the user picked in a native dialog this session becomes a root.
function allowFileRoot(p) { return fileRoots.addRoot(p); }

// ---- IPC guard --------------------------------------------------------------
const guard = createIpcGuard({
  isShellWebContents,
  shellPagePath: SHELL_PAGE,
  argRules: DEFAULT_ARG_RULES,
  log,
});

// Register a guarded ipcMain.handle. `fn(...args)`; pass { withEvent: true }
// for `fn(event, ...args)`.
function handle(ipcMain, channel, fn, opts) {
  if (ipcMain.removeHandler) ipcMain.removeHandler(channel);
  ipcMain.handle(channel, guard.wrap(channel, fn, opts));
}

// ---- permissions ------------------------------------------------------------
const permissionPolicy = createPermissionPolicy({
  isShellWebContents,
  isCaptureActive: () => {
    try { return require('./display-media').getController().isActive(); } catch (_e) { return false; }
  },
  log,
});

const hookedSessions = new WeakSet();
function hookSession(session) {
  if (!session || hookedSessions.has(session)) return;
  hookedSessions.add(session);
  session.setPermissionRequestHandler((wc, permission, callback, details) =>
    permissionPolicy.requestHandler(wc, permission, callback, details));
  session.setPermissionCheckHandler((wc, permission, origin, details) =>
    permissionPolicy.checkHandler(wc, permission, origin, details));
  try { require('./display-media').installDisplayMediaHandler(session); } catch (err) {
    log('[video] capture handler unavailable: ' + ((err && err.message) || err));
  }
}

// ---- web-contents policy ----------------------------------------------------
function wireContents(contents, electron) {
  const { shell } = electron;
  hookSession(contents.session);

  const openLimiter = nav.createLaunchLimiter();
  const openExternalSafely = (url) => { try { shell.openExternal(url); } catch (_e) { /* ignore */ } };

  // Shell: attach policy + navigation lock. Classified lazily because the shell
  // is registered after the BrowserWindow (and its webContents) exists.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isShellWebContents(contents)) {
      log('[webview] attach refused: embedder is not a registered shell');
      event.preventDefault();
      return;
    }
    const result = sanitizeWebviewAttach(webPreferences, params, {
      inspectorPreloadPath: INSPECTOR_PRELOAD,
      bundledPreloadPath: bundledPreloadPath(),
      sandboxGuest: sandboxGuestEnabled(),
      isAllowedFileUrl: fileRoots.isAllowedFileUrl,
    });
    if (sandboxGuestEnabled() && !result.sandboxed) log('[webview] BRAIWSER_SANDBOX_GUEST set but no bundle found; run `npm run build:guest`. Using the unbundled preload.');
    if (result.changes.length) log('[webview] policy: ' + result.changes.join('; '));
  });

  const lockShell = (event, url) => {
    if (!isShellWebContents(contents)) return;
    const target = url || event.url;
    if (!nav.shellNavigationAllowed(target, SHELL_PAGE)) {
      log('[shell] blocked navigation to ' + String(target).slice(0, 120));
      event.preventDefault();
    }
  };
  contents.on('will-navigate', lockShell);
  contents.on('will-redirect', lockShell);
  contents.on('will-frame-navigate', lockShell);

  const type = contents.getType();
  if (type === 'webview') {
    // Guest popups stay denied (no managed popups). Vetted http(s) goes to the OS browser.
    contents.setWindowOpenHandler(({ url }) => {
      const d = nav.windowOpenDecision(url, openLimiter);
      if (d.openExternal) openExternalSafely(url);
      return { action: 'deny' };
    });
    const guardGuest = (event, url) => {
      const target = url || event.url;
      if (!nav.guestNavigationAllowed(target, contents.getURL())) {
        log('[guest] blocked navigation to ' + String(target).slice(0, 120));
        event.preventDefault();
      }
    };
    contents.on('will-navigate', guardGuest);
    contents.on('will-redirect', guardGuest);
  } else if (type === 'window') {
    // Registered lazily: only the shell is locked down; other windows (DevTools,
    // the offscreen PDF printer) keep Electron's defaults.
    contents.setWindowOpenHandler(({ url }) => {
      if (!isShellWebContents(contents)) return { action: 'allow' };
      const d = nav.windowOpenDecision(url, openLimiter);
      if (d.openExternal) openExternalSafely(url);
      return { action: 'deny' };
    });
  }
}

function install(electronArg) {
  if (installed) return;
  installed = true;
  const electron = electronArg || require('electron');
  electron.app.on('web-contents-created', (_e, contents) => wireContents(contents, electron));
}

module.exports = {
  install,
  registerShell,
  isShellWebContents,
  attachRepos(r) { repos = r; },
  allowFileRoot,
  handle,
  guard,
  permissionPolicy,
  agentRuntimeEnabled,
  shellAdditionalArguments,
  sandboxGuestEnabled,
  paths: { SHELL_PAGE, INSPECTOR_PRELOAD, GUEST_BUNDLE },
};
