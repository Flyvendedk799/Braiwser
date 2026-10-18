'use strict';
// Allowed local roots for file: guest sources — pure apart from an injectable
// fs.stat. A file: <webview> src is only honoured when it lies inside:
//   * the app's own renderer directory (welcome page, sample playground, e2e fixture),
//   * a local project the user opened (project.path; a file's parent directory), or
//   * a file/folder the user picked in a native open dialog this session.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { normalizePath } = require('./ipc-guard');

function defaultIsDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

function createFileRoots(options) {
  const o = options || {};
  const platform = o.platform;
  const isDirectory = o.isDirectory || defaultIsDirectory;
  const getDynamicRoots = typeof o.getDynamicRoots === 'function' ? o.getDynamicRoots : () => [];
  const roots = new Set();

  function toRoot(p) {
    if (typeof p !== 'string' || !p || p.includes('\0')) return null;
    const abs = path.isAbsolute(p) || path.win32.isAbsolute(p) ? p : null;
    if (!abs) return null;
    // A project entry may be a single html file: allow its folder (siblings: css, js, images).
    return normalizePath(isDirectory(abs) ? abs : path.dirname(abs), platform);
  }

  function contains(root, target) {
    if (target === root) return true;
    const sep = (platform || process.platform) === 'win32' ? '\\' : '/';
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target.startsWith(prefix);
  }

  return {
    addRoot(p) { const r = toRoot(p); if (r) roots.add(r); return !!r; },
    isAllowedFileUrl(url) {
      let target;
      try {
        const u = new URL(String(url));
        if (u.protocol !== 'file:') return false;
        target = normalizePath(fileURLToPath(u), platform);
      } catch (_e) { return false; }
      for (const r of roots) if (contains(r, target)) return true;
      let dyn = [];
      try { dyn = getDynamicRoots() || []; } catch (_e) { dyn = []; }
      for (const p of dyn) {
        const r = toRoot(p);
        if (r && contains(r, target)) return true;
      }
      return false;
    },
    size: () => roots.size,
  };
}

module.exports = { createFileRoots };
