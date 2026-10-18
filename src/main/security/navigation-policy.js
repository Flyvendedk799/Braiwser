'use strict';
// Navigation / popup policy — pure (no Electron import).
//
//   Shell window : locked to the shell page. will-navigate / will-redirect /
//                  will-frame-navigate to anything else is cancelled; window.open
//                  is denied (http(s) goes to the OS browser, rate limited).
//   Guest        : page-initiated navigation limited to http(s), about:blank and
//                  — only from a file: or blank page — file:. No data:, blob:,
//                  javascript: or custom/external protocol launches. Popups are
//                  denied (NO managed popups); http(s) opens in the OS browser,
//                  rate limited so a page cannot spam the desktop.
// Programmatic loads from the shell (webview.src = url) do not pass through
// these hooks; they are the trusted address-bar path.

const { fileUrlToPath, normalizePath } = require('./ipc-guard');

function protocolOf(url) {
  try { return new URL(String(url)).protocol; } catch (_e) { return null; }
}

function isHttp(url) {
  const p = protocolOf(url);
  return p === 'http:' || p === 'https:';
}

function shellNavigationAllowed(url, shellPagePath, platform) {
  const target = fileUrlToPath(url, platform);
  return !!target && !!shellPagePath && target === normalizePath(shellPagePath, platform);
}

// currentUrl: where the guest is now (to stop http(s) pages reaching file:).
function guestNavigationAllowed(url, currentUrl) {
  const proto = protocolOf(url);
  if (proto === 'http:' || proto === 'https:') return true;
  if (String(url) === 'about:blank') return true;
  if (proto === 'file:') {
    const cur = protocolOf(currentUrl);
    return cur === 'file:' || !currentUrl || String(currentUrl) === 'about:blank';
  }
  return false;
}

// Sliding-window limiter for OS-browser launches triggered by a page.
function createLaunchLimiter(options) {
  const o = options || {};
  const max = Number.isFinite(o.max) ? o.max : 3;
  const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : 10000;
  const now = o.now || Date.now;
  let stamps = [];
  return {
    tryAcquire() {
      const t = now();
      stamps = stamps.filter((s) => t - s < windowMs);
      if (stamps.length >= max) return false;
      stamps.push(t);
      return true;
    },
  };
}

// Decision for setWindowOpenHandler (guest or shell): always deny the window;
// optionally hand an http(s) URL to the OS browser.
function windowOpenDecision(url, limiter) {
  const open = isHttp(url) && (!limiter || limiter.tryAcquire());
  return { action: 'deny', openExternal: open };
}

module.exports = {
  shellNavigationAllowed,
  guestNavigationAllowed,
  windowOpenDecision,
  createLaunchLimiter,
  isHttp,
};
