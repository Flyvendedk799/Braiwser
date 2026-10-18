// Main-owned guest pages. The shell's own tabs stay <webview>. When the embedded
// driver is asked for a new page, this creates a WebContentsView in the main
// process, adds it to the shell window, and keeps it at zero size until the
// shell reports a rectangle. That rectangle is clamped to the window.
'use strict';
const { clampViewBounds } = require('./drivers/electron');

function fail(code, detail, message) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail;
  return err;
}

function createGuestViews({ getWindow, View, webPreferences, contentBounds } = {}) {
  const views = new Map();
  let seq = 0;

  function windowOrThrow() {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      throw fail('UNAVAILABLE', 'NO_WINDOW', 'The shell window is not available.');
    }
    return win;
  }

  function viewCtor() {
    if (typeof View === 'function') return View;
    let electron;
    try { electron = require('electron'); } catch { electron = null; }
    if (!electron || typeof electron.WebContentsView !== 'function') {
      throw fail('UNSUPPORTED', 'WEBCONTENTS_VIEW_UNAVAILABLE', 'This process has no WebContentsView.');
    }
    return electron.WebContentsView;
  }

  function create() {
    const win = windowOrThrow();
    const content = win.contentView;
    if (!content || typeof content.addChildView !== 'function') {
      throw fail('UNSUPPORTED', 'WEBCONTENTS_VIEW_UNAVAILABLE', 'The shell window cannot host a main-owned view.');
    }
    const Ctor = viewCtor();
    const view = new Ctor({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(webPreferences || {}),
      },
    });
    content.addChildView(view);
    const id = `gv_${++seq}`;
    const rec = { id, view, bounds: { x: 0, y: 0, width: 0, height: 0 } };
    views.set(id, rec);
    view.setBounds(rec.bounds);
    const wc = view.webContents;
    if (wc && typeof wc === 'object') wc.braiwserGuestViewId = id;
    return wc;
  }

  function boundsOf(win) {
    if (typeof contentBounds === 'function') return contentBounds(win);
    if (typeof win.getContentBounds === 'function') return win.getContentBounds();
    return { width: 0, height: 0 };
  }

  function place(rect) {
    const win = windowOrThrow();
    const clamped = clampViewBounds(rect, boundsOf(win));
    for (const rec of views.values()) {
      rec.bounds = clamped;
      rec.view.setBounds(clamped);
    }
    return { placed: views.size, bounds: clamped };
  }

  function closeAll() {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const content = win && win.contentView;
    for (const rec of views.values()) {
      try { if (content && typeof content.removeChildView === 'function') content.removeChildView(rec.view); } catch { /* gone */ }
      try {
        const wc = rec.view.webContents;
        if (wc && typeof wc.close === 'function' && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) wc.close();
      } catch { /* gone */ }
    }
    views.clear();
  }

  return { create, place, closeAll, size: () => views.size };
}

module.exports = { createGuestViews };
