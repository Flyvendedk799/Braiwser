'use strict';
// Reusable jsdom harness for the guest (<webview> preload) scripts.
//
//   const { loadInspector } = require('./harness');
//   const h = await loadInspector({ html: '<ul><li>A</li><li>B</li></ul>' });
//   h.ipc.emit('caos:set-mode', 'edit');        // host -> guest
//   h.ipc.sent('caos:annotation');              // guest -> host (array of payloads)
//   h.dispose();
//
// The guest scripts are CommonJS and read browser globals directly, so the
// harness installs the jsdom window's globals on `globalThis`, stubs the
// `electron` module (only `ipcRenderer` is used) and requires the REAL source
// files fresh each time. One harness per test at a time: globals are process
// wide, so run test files in separate processes (node --test already does).

const Module = require('module');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEBVIEW_DIR = path.join(__dirname, '..', '..', 'src', 'webview');

const GLOBAL_KEYS = [
  'window', 'document', 'navigator', 'location', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'Element', 'HTMLElement', 'Node', 'NodeFilter', 'Text', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CSS', 'MutationObserver', 'getSelection',
];

function makeIpc() {
  const handlers = new Map();
  const log = [];
  return {
    // what the guest registers with ipcRenderer.on
    on(channel, fn) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(fn);
    },
    removeListener() {},
    sendToHost(channel, payload) {
      // Structured-clone semantics, like the real IPC: the guest must not be
      // able to share live references with the host.
      let copy = payload;
      try {
        copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
      } catch (_e) {
        copy = payload;
      }
      log.push({ channel, payload: copy });
    },
    // ---- test side ----
    emit(channel, payload) {
      for (const fn of handlers.get(channel) || []) fn({}, payload);
    },
    hasHandler: (channel) => handlers.has(channel),
    channels: () => Array.from(handlers.keys()),
    sent(channel) {
      return log.filter((m) => m.channel === channel).map((m) => m.payload);
    },
    last(channel) {
      const all = this.sent(channel);
      return all[all.length - 1];
    },
    all: () => log.slice(),
    clear() {
      log.length = 0;
    },
  };
}

async function loadInspector(opts = {}) {
  const html = opts.html != null ? opts.html : '<!doctype html><html><head></head><body></body></html>';
  const dom = new JSDOM(/<html|<!doctype/i.test(html) ? html : '<!doctype html><html><body>' + html + '</body></html>', {
    url: opts.url || 'https://example.test/page',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (window.document.readyState !== 'complete') {
    await new Promise((resolve) => window.addEventListener('load', resolve));
  }
  // jsdom has no layout. Stubs the guest touches:
  if (!window.CSS) window.CSS = {};
  if (typeof window.CSS.escape !== 'function') {
    window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\$&');
  }
  if (!window.document.elementsFromPoint) window.document.elementsFromPoint = () => [];
  if (!window.document.elementFromPoint) window.document.elementFromPoint = () => null;
  if (opts.viewport) {
    Object.defineProperty(window, 'innerWidth', { value: opts.viewport.w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: opts.viewport.h, configurable: true });
  }
  if (opts.dpr) Object.defineProperty(window, 'devicePixelRatio', { value: opts.dpr, configurable: true });
  // canvas 2d context is not implemented in jsdom — a no-op context is enough.
  window.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, { get: () => () => {}, set: () => true });
  };

  const saved = {};
  for (const key of GLOBAL_KEYS) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    const value = key === 'getSelection' ? window.getSelection.bind(window) : window[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  const ipc = makeIpc();
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer: ipc };
    return origLoad.call(this, request, parent, isMain);
  };

  // Fresh copies of every webview script so state never leaks between loads.
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(WEBVIEW_DIR)) delete require.cache[key];
    }
  };
  purge();

  const api = {
    window,
    document: window.document,
    dom,
    ipc,
    // Give an element a fake layout box (jsdom reports all zeros).
    setRect(el, r) {
      const left = r.left != null ? r.left : r.x || 0;
      const top = r.top != null ? r.top : r.y || 0;
      const width = r.width != null ? r.width : r.w || 0;
      const height = r.height != null ? r.height : r.h || 0;
      el.getBoundingClientRect = () => ({
        left, top, width, height, x: left, y: top, right: left + width, bottom: top + height,
      });
    },
    // Set the scroll origin the guest sees.
    setScroll(x, y) {
      Object.defineProperty(window, 'scrollX', { value: x, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
      Object.defineProperty(window, 'pageXOffset', { value: x, configurable: true });
      Object.defineProperty(window, 'pageYOffset', { value: y, configurable: true });
    },
    // Require any module from src/webview with the same fresh globals.
    requireWebview: (name) => require(path.join(WEBVIEW_DIR, name)),
    q: (sel) => window.document.querySelector(sel),
    qa: (sel) => Array.from(window.document.querySelectorAll(sel)),
    dispose() {
      Module._load = origLoad;
      purge();
      for (const key of GLOBAL_KEYS) {
        if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
        else delete globalThis[key];
      }
      try { window.close(); } catch (_e) { /* ignore */ }
    },
  };

  if (opts.inspector !== false) {
    require(path.join(WEBVIEW_DIR, 'inspector.js'));
  }
  return api;
}

module.exports = { loadInspector, makeIpc, WEBVIEW_DIR };
