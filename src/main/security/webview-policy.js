'use strict';
// <webview> attachment policy — pure (no Electron import).
//
// Electron's `will-attach-webview` hands the main process the guest's
// webPreferences and tag params, both derived from attributes the renderer set
// (so, transitively, from anything that can influence renderer DOM). This module
// rewrites them to a known-safe shape:
//
//   * preload   — forced to the one inspector preload we ship (or its bundled,
//                 sandbox-compatible build); a renderer-supplied path is dropped;
//   * isolation — contextIsolation:true, nodeIntegration:false (+subframes/
//                 workers), webSecurity:true, no insecure content, no remote;
//   * sandbox   — false (current sibling-module preload) or true (bundled
//                 preload, opt-in via BRAIWSER_SANDBOX_GUEST=1);
//   * partition — default session, or a vetted `braiwser-guest*` name;
//   * src       — only http(s), about:blank, or file: inside an allowed root;
//                 anything else is rewritten to about:blank.
//
// Returns a description of what was changed so callers can log it.

const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { normalizePath } = require('./ipc-guard');

const PARTITION_RE = /^(persist:)?braiwser-guest(-[a-z0-9_-]{1,40})?$/;

// Keys a renderer-controlled attribute string could use to widen privileges.
const STRIPPED_WEB_PREFERENCES = [
  'preloadURL',
  'additionalArguments',
  'session',
  'affinity',
  'enableBlinkFeatures',
  'disableBlinkFeatures',
  'enableRemoteModule',
  'nodeIntegrationInWorker',
  'nativeWindowOpen',
];
const STRIPPED_PARAMS = [
  'disablewebsecurity',
  'nodeintegration',
  'nodeintegrationinsubframes',
  'enableremotemodule',
  'plugins',
  'webpreferences',
];

function toComparablePath(value, platform) {
  if (typeof value !== 'string' || !value) return null;
  try {
    if (/^file:/i.test(value)) return normalizePath(fileURLToPath(value), platform);
    return normalizePath(value, platform);
  } catch (_e) {
    return null;
  }
}

// 'ok' or a short reason the src is not allowed.
function classifySrc(src, isAllowedFileUrl) {
  if (src == null || src === '') return 'ok';
  let u;
  try { u = new URL(String(src)); } catch (_e) { return 'unparseable'; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'ok';
  if (u.protocol === 'about:') return String(src) === 'about:blank' ? 'ok' : 'about-other';
  if (u.protocol === 'file:') return isAllowedFileUrl && isAllowedFileUrl(String(src)) ? 'ok' : 'file-outside-roots';
  return 'scheme:' + u.protocol;
}

function normalizePartition(partition) {
  if (partition == null || partition === '') return { value: '', ok: true };
  return PARTITION_RE.test(String(partition)) ? { value: String(partition), ok: true } : { value: '', ok: false };
}

// ctx:
//   inspectorPreloadPath  absolute path of src/webview/inspector.js
//   bundledPreloadPath    absolute path of the bundle, or null if unavailable
//   sandboxGuest          true => use the bundle with sandbox:true (only if it exists)
//   isAllowedFileUrl(url) predicate for file: sources
//   platform              test hook
function sanitizeWebviewAttach(webPreferences, params, ctx) {
  const wp = webPreferences || {};
  const p = params || {};
  const c = ctx || {};
  const changes = [];
  const note = (s) => changes.push(s);

  // ---- preload -------------------------------------------------------------
  const useBundle = !!(c.sandboxGuest && c.bundledPreloadPath);
  const wantPath = useBundle ? c.bundledPreloadPath : c.inspectorPreloadPath;
  const incomingRaw = typeof wp.preload === 'string' && wp.preload
    ? wp.preload
    : (typeof p.preload === 'string' ? p.preload : '');
  const incomingCmp = toComparablePath(incomingRaw, c.platform);
  const inspectorCmp = toComparablePath(c.inspectorPreloadPath, c.platform);
  const wantCmp = toComparablePath(wantPath, c.platform);
  if (!wantPath) {
    delete wp.preload;
    note('preload removed (no allowed preload configured)');
  } else if (incomingRaw && incomingCmp === wantCmp) {
    wp.preload = incomingRaw; // already the allowed one — keep the form Electron gave us
  } else if (incomingRaw && useBundle && incomingCmp === inspectorCmp) {
    // Renderer asked for the unbundled inspector; sandbox mode swaps in the bundle,
    // mirroring the form (file URL vs path) it used.
    wp.preload = /^file:/i.test(incomingRaw) ? pathToFileURL(wantPath).href : wantPath;
    note('preload swapped for bundled guest preload');
  } else {
    wp.preload = /^file:/i.test(incomingRaw) ? pathToFileURL(wantPath).href : wantPath;
    note(incomingRaw ? 'renderer-supplied preload replaced' : 'preload forced');
  }
  delete wp.preloadURL;
  // Keep the tag param consistent with the vetted value in case anything re-reads it.
  if ('preload' in p) p.preload = wp.preload;

  // ---- privilege flags -----------------------------------------------------
  for (const key of STRIPPED_WEB_PREFERENCES) {
    if (key in wp) { delete wp[key]; note(`stripped webPreferences.${key}`); }
  }
  const forced = {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    sandbox: useBundle,
  };
  for (const [k, v] of Object.entries(forced)) {
    if (wp[k] !== v && wp[k] !== undefined) note(`webPreferences.${k} forced to ${v}`);
    wp[k] = v;
  }
  // Never override throttling here: the default (on) applies, and video export /
  // replay lift it per webContents at runtime via setBackgroundThrottling.
  delete wp.backgroundThrottling;
  for (const key of STRIPPED_PARAMS) {
    if (key in p) delete p[key];
  }

  // ---- partition -----------------------------------------------------------
  const part = normalizePartition(p.partition);
  if (!part.ok) { note(`partition "${p.partition}" rejected`); delete p.partition; }

  // ---- source --------------------------------------------------------------
  const verdict = classifySrc(p.src, c.isAllowedFileUrl);
  if (verdict !== 'ok') {
    note(`src blocked (${verdict}); using about:blank`);
    p.src = 'about:blank';
  }

  return { changes, sandboxed: useBundle, srcBlocked: verdict !== 'ok' };
}

module.exports = {
  sanitizeWebviewAttach,
  classifySrc,
  normalizePartition,
  PARTITION_RE,
  STRIPPED_WEB_PREFERENCES,
};
