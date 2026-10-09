'use strict';
// A fake Electron guest: a webContents-like EventEmitter whose `debugger` speaks just
// enough CDP, backed by a jsdom document, to run the REAL probe (src/webview/probe.js)
// and to receive Input.* events. This is NOT Electron: it proves the driver's logic
// (leases, epochs, refs, input sequencing), not Electron's native behaviour.

const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');

function createFakeGuest({ html, url = 'http://guest.test/page', childFrames = [] }) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  Object.defineProperty(win, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 8000, configurable: true });

  // No layout in jsdom: give every rendered element its own row so hit-testing is exact.
  const order = new Map();
  const rowOf = (el) => {
    if (!order.has(el)) order.set(el, order.size);
    return order.get(el);
  };
  const hiddenEl = (el) => !!el.closest('[hidden]') || win.getComputedStyle(el).display === 'none';
  win.Element.prototype.getBoundingClientRect = function box() {
    // index in document order, so rows never overlap
    const all = Array.from(doc.querySelectorAll('*'));
    const idx = all.indexOf(this);
    if (idx < 0 || hiddenEl(this) || this.tagName === 'SCRIPT' || this.tagName === 'STYLE' || this.tagName === 'HEAD'
      || this.tagName === 'TITLE' || this.tagName === 'META') {
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    rowOf(this);
    const top = 20 * idx;
    return { left: 10, top, width: 100, height: 18, right: 110, bottom: top + 18, x: 10, y: top };
  };
  const state = { coverBy: null }; // element that intercepts hit tests (a covering overlay)
  doc.elementFromPoint = (x, y) => {
    if (state.coverBy) return state.coverBy;
    const all = Array.from(doc.querySelectorAll('*'));
    return all.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    }) || null;
  };

  const objects = new Map();
  let nextObject = 1;
  const remember = (value) => { const id = `obj-${nextObject++}`; objects.set(id, value); return id; };

  const dbg = new EventEmitter();
  dbg.attached = false;
  dbg.calls = [];
  dbg.isAttached = () => dbg.attached;
  dbg.attach = () => { dbg.attached = true; };
  dbg.detach = () => { dbg.attached = false; dbg.emit('detach', {}, 'target closed'); };
  dbg.sendCommand = async (method, params = {}) => {
    dbg.calls.push({ method, params });
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'F-main' }, childFrames: childFrames.map((id) => ({ frame: { id }, childFrames: [] })) } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'Runtime.callFunctionOn': {
        const self = params.objectId ? objects.get(params.objectId) : win;
        if (params.objectId && self === undefined) return { exceptionDetails: { text: 'Cannot find object with id' } };
        const args = (params.arguments || []).map((a) => (a.objectId ? objects.get(a.objectId) : a.value));
        try {
          // jsdom cannot mint trusted events: the fake treats clicks produced via Input.dispatchMouseEvent as trusted.
          const declaration = String(params.functionDeclaration).split('e.isTrusted').join('true');
          const fn = win.eval(`(${declaration})`);
          const value = fn.apply(self, args);
          if (params.returnByValue) {
            return { result: { type: 'object', value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
          }
          return { result: { type: 'object', objectId: remember(value) } };
        } catch (err) {
          return { exceptionDetails: { text: String(err && err.message) } };
        }
      }
      case 'Runtime.getProperties': {
        const arr = objects.get(params.objectId) || [];
        return { result: Array.from(arr).map((el, i) => ({ name: String(i), value: { type: 'object', objectId: remember(el) } })) };
      }
      case 'Runtime.releaseObject':
        objects.delete(params.objectId);
        return {};
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased') {
          const target = doc.elementFromPoint(params.x, params.y);
          if (target && state.coverBy !== target) target.click();
          if (target) target.focus();
        } else if (params.type === 'mousePressed') {
          const target = doc.elementFromPoint(params.x, params.y);
          if (target && typeof target.focus === 'function') target.focus();
        }
        return {};
      case 'Input.insertText': {
        const el = doc.activeElement;
        if (el && 'value' in el) el.value = (el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value) ? params.text : el.value + params.text;
        return {};
      }
      case 'Input.dispatchKeyEvent':
        return {};
      default:
        return {};
    }
  };

  const wc = new EventEmitter();
  wc.id = Math.floor(Math.random() * 1e6);
  wc.debugger = dbg;
  wc._destroyed = false;
  wc._url = url;
  wc.isDestroyed = () => wc._destroyed;
  wc.getURL = () => wc._url;
  wc.stopped = 0;
  wc.stop = () => { wc.stopped += 1; };
  wc.loadBehavior = null; // (url) => Promise, set by tests
  wc.loadURL = (target) => {
    if (wc.loadBehavior) return wc.loadBehavior(target);
    wc._url = target;
    wc.emit('did-navigate', {}, target);
    return Promise.resolve();
  };
  wc.captures = [];
  wc.capturePage = async () => {
    const badge = doc.querySelector('[data-caos="agent-badge"]');
    wc.captures.push({ badgeHidden: !badge || badge.style.visibility === 'hidden' });
    return { getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
  };
  wc.destroy = () => { wc._destroyed = true; wc.emit('destroyed'); };

  return { wc, dbg, dom, win, doc, state };
}

module.exports = { createFakeGuest };
