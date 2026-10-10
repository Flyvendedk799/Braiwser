// Shared jsdom harness for guest-script tests. The webview scripts read
// `document`, `window`, `getComputedStyle`, … as free globals, so each test
// installs a fresh JSDOM's globals and the real source files are required
// as-is.
'use strict';

const { JSDOM } = require('jsdom');

const GLOBALS = [
  'window', 'document', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
  'getComputedStyle', 'location', 'CSS', 'requestAnimationFrame', 'CSSStyleRule',
  'HTMLInputElement', 'HTMLFormElement', 'MutationObserver', 'InputEvent', 'DocumentFragment',
];

let saved = null;

function install(html, { url = 'https://example.test/page/index.html' } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  if (!saved) {
    saved = {};
    for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  for (const k of GLOBALS) {
    if (k === 'window') globalThis.window = w;
    else if (k === 'getComputedStyle') globalThis.getComputedStyle = w.getComputedStyle.bind(w);
    else if (k === 'requestAnimationFrame') globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    else if (w[k] !== undefined) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
  return dom;
}

function uninstall() {
  if (!saved) return;
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
  saved = null;
}

// jsdom has no layout: give elements a box so geometry-based code can run.
function stubRect(el, rect) {
  const r = { left: 0, top: 0, width: 100, height: 20, ...rect };
  r.right = r.left + r.width;
  r.bottom = r.top + r.height;
  r.x = r.left;
  r.y = r.top;
  el.getBoundingClientRect = () => r;
}

module.exports = { install, uninstall, stubRect };
