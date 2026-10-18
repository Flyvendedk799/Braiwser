// jsdom harness for the Agent Runs UI tests (own file: no collisions with dom-env.mjs).
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'src', 'renderer');
const GLOBALS = [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent',
  'FocusEvent', 'getComputedStyle', 'MutationObserver', 'HTMLInputElement', 'HTMLSelectElement',
];

export function setupAgentDom(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  for (const key of GLOBALS) {
    if (window[key] === undefined) continue;
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (cb) => setTimeout(() => cb(Date.now()), 0), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  return { dom, window, document: window.document };
}

export const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// Let queued microtasks (panel re-render coalescing) and a macrotask run.
export async function flush(n = 3) { for (let i = 0; i < n; i++) await tick(0); }

export function keydown(el, k, opts = {}) {
  const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  el.dispatchEvent(ev);
  return ev;
}
export function click(el) {
  if (!el || el.disabled) return false;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}
export const q = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const tids = (id, root = document) => Array.from(root.querySelectorAll(`[data-testid="${id}"]`));
