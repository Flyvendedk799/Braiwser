// jsdom harness for the renderer's ESM components. The components read the
// globals `document` / `window` at call time, so one window per test file is
// enough: call setupDom() once at the top, then dynamic-import the module under
// test with load('components/sidebar.js').
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'src', 'renderer');

const GLOBALS = [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent',
  'CustomEvent', 'FocusEvent', 'InputEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'MutationObserver',
];

export function setupDom(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  for (const key of GLOBALS) {
    if (window[key] === undefined) continue;
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
  }
  if (typeof window.PointerEvent === 'function') {
    Object.defineProperty(globalThis, 'PointerEvent', { value: window.PointerEvent, configurable: true, writable: true });
  } else {
    // jsdom without PointerEvent: a MouseEvent is close enough for these tests.
    Object.defineProperty(globalThis, 'PointerEvent', { value: window.MouseEvent, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  // Layout does not exist in jsdom; components that measure get zero rects.
  return { dom, window, document: window.document };
}

export function load(rel) {
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Two animation frames + a macrotask: enough for modal() to focus / show.
export async function settle() {
  await tick(30);
}

export function key(el, k, opts = {}) {
  const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  el.dispatchEvent(ev);
  return ev;
}

// A disabled control receives no click from a real user: mirror that.
export function click(el) {
  if (el.disabled) return;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

// Press a key the way a browser does: keydown first; if nobody called
// preventDefault, Enter/Space on a button fires its native click.
export function press(el, k, opts = {}) {
  const ev = key(el, k, opts);
  if (!ev.defaultPrevented && (k === 'Enter' || k === ' ') && el.tagName === 'BUTTON' && !el.disabled) click(el);
  return ev;
}
