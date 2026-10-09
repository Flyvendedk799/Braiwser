// Shared fakes for controller tests: a webview-like EventTarget and manual timers.
export class FakeWv extends EventTarget {
  constructor(name = 'wv') {
    super();
    this.name = name;
    this.sent = [];
    this.srcSet = [];
    this.onSend = null;
    this.onSrc = null;
    this.url = '';
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
    if (this.onSend) this.onSend(channel, payload);
  }
  set src(v) {
    this.srcSet.push(v);
    this.url = v;
    if (this.onSrc) this.onSrc(v);
  }
  getURL() { return this.url; }
  emit(name, props = {}) {
    const e = new Event(name);
    Object.assign(e, props);
    this.dispatchEvent(e);
  }
  ipc(channel, ...args) { this.emit('ipc-message', { channel, args }); }
  listenerCount() { return this._n || 0; }
  addEventListener(type, fn, opts) { this._n = (this._n || 0) + 1; super.addEventListener(type, fn, opts); }
  removeEventListener(type, fn, opts) { this._n = Math.max(0, (this._n || 0) - 1); super.removeEventListener(type, fn, opts); }
}

// Manual timers: nothing fires until run()/runAll() is called.
export function manualTimers() {
  let id = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { q.set(++id, { fn, ms }); return id; },
    clearTimeout: (t) => { q.delete(t); },
    pending: () => q.size,
    runAll() { const items = [...q.entries()]; q.clear(); for (const [, t] of items) t.fn(); },
  };
}

export const tick = () => new Promise((r) => setImmediate(r));
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A controllable promise.
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
