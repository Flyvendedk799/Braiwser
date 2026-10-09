// Deterministic in-memory driver implementing the runtime contract's driver
// interface (docs/AGENT_RUNTIME_CONTRACT.md). Used by the broker tests and
// available to the automation/MCP engineer to exercise the REAL broker offline.
//
//   const { createFakeDriver, DEFAULT_SITE, mulberry32 } = require('.../fake-driver');
//   const fake = createFakeDriver();
//   const broker = createBroker({ dataDir, drivers: { playwright: fake.driver }, featureFlag: true });
//
// Test controls live on `fake.ctl` (delays, hang/late click, crashes, redirects,
// evidence mode). Ground truth lives on `fake.world` (every emitted input in
// `dispatchLog`, every external effect in `submissions`).
'use strict';
const { EventEmitter } = require('node:events');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SITE = {
  'about:blank': { elements: [] },
  'https://app.test/': { elements: [
    { id: 'h1', role: 'heading', name: 'Welcome', text: 'Welcome' },
    { id: 'name', role: 'textbox', name: 'Display name', editable: true, value: '', testId: 'display-name' },
    { id: 'pw', role: 'textbox', name: 'Password', editable: true, value: '', traits: ['password'] },
    { id: 'cardno', role: 'textbox', name: 'Card number', editable: true, value: '', traits: ['payment'] },
    { id: 'status', role: 'status', name: 'Status', text: '' },
    { id: 'next', role: 'button', name: 'Next', testId: 'next', onClick: { navigate: 'https://app.test/two' } },
    { id: 'apply', role: 'button', name: 'Preview', onClick: { setText: { id: 'status', text: 'Previewed' } } },
    { id: 'pay', role: 'button', name: 'Pay now', traits: ['submit'], onClick: [{ submit: true }, { setText: { id: 'status', text: 'Paid' } }] },
    { id: 'dup1', role: 'button', name: 'Same', onClick: { setText: { id: 'status', text: 'dup1' } } },
    { id: 'dup2', role: 'button', name: 'Same', onClick: { setText: { id: 'status', text: 'dup2' } } },
    { id: 'off', role: 'button', name: 'Elsewhere', onClick: { navigate: 'https://evil.test/' } },
    { id: 'disabled', role: 'button', name: 'Disabled', enabled: false },
    { id: 'hidden', role: 'button', name: 'Hidden', visible: false },
  ] },
  'https://app.test/two': { elements: [
    { id: 'h2', role: 'heading', name: 'Page two', text: 'Page two' },
    { id: 'back', role: 'button', name: 'Back', onClick: { navigate: 'https://app.test/' } },
    { id: 'status', role: 'status', name: 'Status', text: 'arrived' },
  ] },
  'https://evil.test/': { elements: [{ id: 'x', role: 'heading', name: 'Elsewhere', text: 'Elsewhere' }] },
};

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function createFakeDriver({ name = 'playwright', modes = ['headless', 'visible'], humanHandoff = 'native', requestInterception = false, site = DEFAULT_SITE, seed = 1 } = {}) {
  const world = { dispatchLog: [], inputLog: [], submissions: [], badges: [], pagesCreated: 0, sessionsOpened: 0, sessionsClosed: 0, inputsAfterClose: 0 };
  const rng = mulberry32(seed);
  const ctl = {
    delays: { observe: 0, resolve: 0, act: 0, navigate: 0, assertion: 0 },
    jitter: false, // when true every delay is multiplied by rng()
    evidenceMode: 'verified', // verified | none (dispatched only) | garbage (unaccepted kind)
    hang: null, // promise: after dispatch, the action does not complete until it resolves (late click)
    crashNextAct: null, // 'beforeDispatch' | 'afterDispatch'
    failResolve: null, // 'stale' | 'ambiguous'
    redirects: {}, // url -> url
    failNavigation: false,
    onEmit: null, // (entry) => void, called synchronously at the moment input is emitted
    snapshotOwner: null, // () => any, recorded with each dispatch
  };
  const wait = async (ms) => {
    const d = ctl.jitter ? Math.round(ms * rng()) : ms;
    if (d > 0) await new Promise((r) => setTimeout(r, d)); else await Promise.resolve();
  };

  class FakePage {
    constructor(sessionState, opener = null) {
      this.pageId = `fp${++world.pagesCreated}`;
      this.sessionState = sessionState;
      this.opener = opener;
      this.events = new EventEmitter();
      this.events.setMaxListeners(50);
      this.documentEpoch = 0;
      this._url = 'about:blank';
      this.doc = { elements: [] };
      this.closed = false;
      this.crashed = false;
      this._load('about:blank');
    }
    url() { return this._url; }
    _load(url) {
      const def = site[url] || { elements: [] };
      this.doc = { elements: JSON.parse(JSON.stringify(def.elements)) };
      this._url = url;
      this.documentEpoch += 1;
    }
    async navigate(url, { signal, timeoutMs = 15000, operationId, sessionId, pageId } = {}) {
      if (this.closed) throw Object.assign(new Error('closed'), { code: 'PAGE_CLOSED' });
      if (operationId) {
        // Broker-issued navigations are inputs too: log them like clicks.
        const entry = { operationId, kind: 'navigate', elementId: null, url, pageId, sessionId, fakePageId: this.pageId, runId: null, owner: ctl.snapshotOwner ? ctl.snapshotOwner({ sessionId, pageId }) : null, at: Date.now(), epoch: this.documentEpoch };
        world.inputLog.push(entry);
        if (ctl.onEmit) ctl.onEmit(entry);
      }
      const target = ctl.redirects[url] || url;
      const t0 = Date.now();
      const need = ctl.delays.navigate;
      if (need > timeoutMs) { await wait(timeoutMs); return { outcome: 'timeout', url: this._url }; }
      await wait(need);
      if (signal && signal.aborted) return { outcome: 'cancelled', url: this._url };
      if (ctl.failNavigation) return { outcome: 'failed', url: this._url };
      void t0;
      this._load(target);
      this.events.emit('navigated', { url: this._url });
      return { outcome: 'ready', url: this._url };
    }
    _visible() { return this.doc.elements.filter((e) => e.visible !== false); }
    async observe({ maxNodes = 200, focus, cursor } = {}) {
      await wait(ctl.delays.observe);
      if (this.crashed) throw Object.assign(new Error('crashed'), { code: 'PAGE_CRASHED' });
      const all = this._visible();
      const start = cursor ? Number(String(cursor).replace(/^o/, '')) || 0 : 0;
      const slice = all.slice(start, start + maxNodes);
      const end = start + slice.length;
      return {
        nodes: slice.map((e) => ({ refId: `${this.documentEpoch}:${e.id}`, role: e.role, name: e.name, enabled: e.enabled !== false, editable: e.editable === true, testId: e.testId, frameId: null, traits: e.traits || [] })),
        coverage: { framesSeen: 1, framesUnavailable: 0, nodesReturned: slice.length },
        truncated: end < all.length, nextCursor: end < all.length ? `o${end}` : null,
      };
    }
    resolve(refId) {
      const [epoch, id] = String(refId).split(':');
      if (Number(epoch) !== this.documentEpoch) throw Object.assign(new Error('stale'), { code: 'STALE_REF' });
      const el = this.doc.elements.find((e) => e.id === id && e.visible !== false);
      if (!el) throw Object.assign(new Error('gone'), { code: 'STALE_REF' });
      return { fingerprint: `${el.role}|${el.name}`, scope: { frameId: null } };
    }
    _effect(effect) {
      for (const e of Array.isArray(effect) ? effect : [effect]) {
        if (!e) continue;
        if (e.setText) { const t = this.doc.elements.find((x) => x.id === e.setText.id); if (t) { t.text = e.setText.text; t.visible = true; } }
        if (e.reveal) { const t = this.doc.elements.find((x) => x.id === e.reveal); if (t) t.visible = true; }
        if (e.submit) world.submissions.push({ url: this._url, at: Date.now() });
        if (e.navigate) { const target = ctl.redirects[e.navigate] || e.navigate; this._load(target); this.events.emit('navigated', { url: this._url }); }
      }
    }
    async act(cmd, control) {
      if (this.closed) { world.inputsAfterClose++; throw Object.assign(new Error('closed'), { code: 'PAGE_CLOSED' }); }
      await wait(ctl.delays.resolve);
      if (control.signal && control.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'CANCELLED' });
      const mode = ctl.failResolve;
      if (mode === 'stale') throw Object.assign(new Error('stale'), { code: 'STALE_REF' });
      if (mode === 'ambiguous') throw Object.assign(new Error('ambiguous'), { code: 'AMBIGUOUS_TARGET' });
      const fp = this.resolve(cmd.action.refId); // throws STALE_REF
      const el = this.doc.elements.find((e) => `${this.documentEpoch}:${e.id}` === cmd.action.refId);
      if (el.enabled === false) throw Object.assign(new Error('disabled'), { code: 'NOT_ACTIONABLE' });
      if (cmd.action.kind === 'fill' && (el.traits || []).some((t) => ['password', 'otp', 'payment'].includes(t))) throw Object.assign(new Error('secret'), { code: 'SECRET_FIELD' });
      if (ctl.crashNextAct === 'beforeDispatch') { ctl.crashNextAct = null; this.crashed = true; this.events.emit('crashed', {}); throw Object.assign(new Error('crash'), { code: 'PAGE_CRASHED' }); }
      control.beforeDispatch(); // the broker commits dispatch_started here
      const entry = { operationId: cmd.operationId, kind: cmd.action.kind, elementId: el.id, url: this._url, pageId: cmd.pageId, sessionId: cmd.sessionId, fakePageId: this.pageId, runId: cmd.runId || null, owner: ctl.snapshotOwner ? ctl.snapshotOwner({ sessionId: cmd.sessionId, pageId: cmd.pageId }) : null, at: Date.now(), epoch: this.documentEpoch };
      world.dispatchLog.push(entry); world.inputLog.push(entry);
      if (ctl.onEmit) ctl.onEmit(entry);
      if (ctl.crashNextAct === 'afterDispatch') { ctl.crashNextAct = null; this.crashed = true; this.events.emit('crashed', {}); throw Object.assign(new Error('crash'), { code: 'PAGE_CRASHED' }); }
      const apply = () => {
        const k = cmd.action.kind;
        if (k === 'click') this._effect(el.onClick);
        else if (k === 'fill') el.value = cmd.action.text;
        else if (k === 'check') el.checked = cmd.action.checked;
        else if (k === 'select') el.value = cmd.action.value;
        else if (k === 'press') { if (cmd.action.key === 'Enter') this._effect(el.onEnter || el.onClick); }
      };
      if (ctl.hang) {
        // Late click: the effect lands only when the test releases it, long after any deadline.
        await ctl.hang;
        apply();
      } else {
        await wait(ctl.delays.act);
        apply();
      }
      void fp;
      if (ctl.evidenceMode === 'none') return { status: 'dispatched', evidence: [] };
      if (ctl.evidenceMode === 'garbage') return { status: 'verified', evidence: [{ kind: 'trust-me', observed: true }] };
      const evidence = [{ kind: 'clicked', observed: true }];
      if (cmd.action.kind === 'fill') evidence.push({ kind: 'value', observed: true });
      if (cmd.documentEpoch !== undefined && this._url) evidence.push({ kind: 'url', observed: true, url: this._url });
      if (this.documentEpoch !== Number(String(cmd.action.refId).split(':')[0])) evidence.push({ kind: 'navigation', observed: true, url: this._url });
      return { status: 'verified', evidence };
    }
    _find(target) {
      if (!target) return [];
      const els = this.doc.elements;
      if (target.by === 'role') return els.filter((e) => e.role === target.role && norm(e.name) === norm(target.name));
      if (target.by === 'testId') return els.filter((e) => e.testId === target.value);
      if (target.by === 'label') return els.filter((e) => norm(e.name) === norm(target.value));
      return [];
    }
    async evaluateAssertion(a) {
      await wait(ctl.delays.assertion);
      if (this.crashed) throw Object.assign(new Error('crashed'), { code: 'PAGE_CRASHED' });
      const make = (ok, actual) => ({ status: ok ? 'passed' : 'failed', actual, evidence: [{ kind: a.kind, observed: true }] });
      if (a.kind === 'url') return make(a.op === 'equals' ? this._url === a.expected : this._url.toLowerCase().includes(String(a.expected).toLowerCase()), this._url);
      const matches = this._find(a.target);
      if (a.kind === 'count') return make(a.op === 'contains' ? matches.length >= Number(a.expected) : matches.length === Number(a.expected), matches.length);
      if (a.kind === 'exists') return make(matches.length > 0, matches.length);
      if (a.kind === 'visible') return make(matches.length > 0 && matches[0].visible !== false, matches.length ? matches[0].visible !== false : 'absent');
      if (a.kind === 'text') {
        if (!matches.length) return make(false, 'absent');
        const t = norm(matches[0].text !== undefined ? matches[0].text : matches[0].name);
        return make(a.op === 'equals' ? t === norm(a.expected) : t.toLowerCase().includes(norm(a.expected).toLowerCase()), t);
      }
      return make(false, 'unsupported-assertion');
    }
    async screenshot() { return { bytes: Buffer.from('fake-png'), meta: { url: this._url, viewport: { width: 800, height: 600 }, scale: 1, scroll: { x: 0, y: 0 }, capturedAt: Date.now(), transformed: false } }; }
    setOwnerBadge(owner) { world.badges.push({ pageId: this.pageId, owner }); }
    openPopup(url) {
      const p = new FakePage(this.sessionState, this);
      this.sessionState.pages.set(p.pageId, p);
      p._load(url);
      this.events.emit('popup', { page: p });
      if (this.sessionState.onPageEvent) this.sessionState.onPageEvent({ type: 'popup', page: p, opener: this });
      return p;
    }
    crash() { this.crashed = true; this.events.emit('crashed', {}); }
    closePage() { this.closed = true; this.events.emit('closed', {}); }
    dispose() { this.closed = true; }
  }

  const driver = {
    name,
    capabilities() {
      return { driver: name, version: 'fake-1', dom: true, frames: false, shadowDom: false, canvas: false, popups: true, downloads: false, uploads: false, dialogs: false,
        permissions: false, screenshots: true, humanHandoff, liveModeSwitch: false, modes: [...modes], requestInterception };
    },
    async open(opts = {}) {
      if (ctl.failOpen) throw new Error('driver failed to launch');
      world.sessionsOpened++;
      const state = { pages: new Map(), onPageEvent: opts.onPageEvent, opts, closed: false };
      const first = new FakePage(state);
      state.pages.set(first.pageId, first);
      const session = {
        capabilities: driver.capabilities(), pages: state.pages, state,
        async newPage() { const p = new FakePage(state); state.pages.set(p.pageId, p); return p; },
        async close() { state.closed = true; world.sessionsClosed++; for (const p of state.pages.values()) p.closed = true; },
      };
      fake.sessions.push(session);
      return session;
    },
  };
  const fake = { driver, ctl, world, sessions: [], rng, site, FakePage,
    get lastSession() { return this.sessions[this.sessions.length - 1]; },
    get firstPage() { return [...this.lastSession.pages.values()][0]; },
    // Control the page the broker registered, e.g. to inject a navigation or crash.
    pages() { return [...this.lastSession.pages.values()]; } };
  return fake;
}

module.exports = { createFakeDriver, DEFAULT_SITE, mulberry32 };
