'use strict';
// Permission request / check policy — pure (no Electron import).
//
// Default DENY for everything, then a small allow-list per class of contents:
//
//   shell window  : clipboard-sanitized-write, clipboard-read, fullscreen;
//                   display-capture / media ONLY while a video-export run is
//                   active (see display-media.js).
//   guest / other : clipboard-sanitized-write and fullscreen (harmless, and
//                   ordinary pages depend on them). Camera, microphone,
//                   geolocation, notifications, midi, hid/serial/usb,
//                   clipboard-read, openExternal (external protocol launches),
//                   persistent-storage, pointer lock, window-management ...: denied.
//
// Allow-path for everything else: TRUSTED UI ONLY. Main-process code that has
// shown the user a prompt in the shell calls
//   policy.grantGuest({ origin, permission, ttlMs })     // time-boxed
//   policy.revokeGuest({ origin, permission })
// The guest page itself can never widen its own permissions. (No IPC channel
// exposes grantGuest yet; the agent/runtime UI owner adds one, validated by the
// ipc-guard, when a permission prompt UI exists.)

const SHELL_ALLOWED = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);
const SHELL_CAPTURE = new Set(['display-capture', 'media']);
const GUEST_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen']);

function originOf(value) {
  try {
    const u = new URL(String(value));
    // file: pages have an opaque origin string; key them by protocol.
    return u.origin && u.origin !== 'null' ? u.origin : u.protocol + '//';
  } catch (_e) {
    return '';
  }
}

function createPermissionPolicy(options) {
  const o = options || {};
  const isShell = typeof o.isShellWebContents === 'function' ? o.isShellWebContents : () => false;
  const isCaptureActive = typeof o.isCaptureActive === 'function' ? o.isCaptureActive : () => false;
  const now = o.now || Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const grants = new Map(); // `${origin}|${permission}` -> expiresAt

  function key(origin, permission) { return `${origin}|${permission}`; }

  function guestGranted(origin, permission) {
    const k = key(origin, permission);
    const exp = grants.get(k);
    if (exp == null) return false;
    if (now() > exp) { grants.delete(k); return false; }
    return true;
  }

  // `requesting` is the requesting URL or origin string from Electron's details.
  function decide(webContents, permission, requesting) {
    if (webContents && isShell(webContents)) {
      if (SHELL_ALLOWED.has(permission)) return true;
      if (SHELL_CAPTURE.has(permission) && isCaptureActive()) return true;
      log(`[permission] denied (shell) ${permission}`);
      return false;
    }
    if (GUEST_ALLOWED.has(permission)) return true;
    if (guestGranted(originOf(requesting), permission)) return true;
    log(`[permission] denied (guest) ${permission} for ${originOf(requesting) || 'unknown origin'}`);
    return false;
  }

  return {
    decide,
    // Electron: session.setPermissionRequestHandler((wc, permission, callback, details) => ...)
    requestHandler(webContents, permission, callback, details) {
      callback(decide(webContents, permission, details && (details.requestingUrl || details.securityOrigin)));
    },
    // Electron: session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => ...)
    checkHandler(webContents, permission, requestingOrigin, details) {
      return decide(webContents, permission, requestingOrigin || (details && details.requestingUrl));
    },
    grantGuest({ origin, permission, ttlMs }) {
      const org = originOf(origin) || String(origin || '');
      if (!org || !permission) throw new Error('grantGuest needs origin and permission');
      grants.set(key(org, permission), now() + (Number.isFinite(ttlMs) ? ttlMs : 60000));
    },
    revokeGuest({ origin, permission }) {
      grants.delete(key(originOf(origin) || String(origin || ''), permission));
    },
    SHELL_ALLOWED,
    GUEST_ALLOWED,
  };
}

module.exports = { createPermissionPolicy, originOf, SHELL_ALLOWED, GUEST_ALLOWED };
