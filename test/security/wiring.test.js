'use strict';
// Exercises src/main/security/index.js against fake Electron objects: the wiring
// between web-contents-created and the pure policies. Native behaviour of the
// real events still needs confirmation in a real Electron run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const security = require('../../src/main/security');

const opened = [];
const fakeElectron = {
  app: new EventEmitter(),
  shell: { openExternal: (u) => opened.push(u) },
};
security.install(fakeElectron);
security.install(fakeElectron); // idempotent

let nextId = 100;
function fakeSession() {
  return {
    permissionRequest: null, permissionCheck: null, displayMedia: null,
    setPermissionRequestHandler(fn) { this.permissionRequest = fn; },
    setPermissionCheckHandler(fn) { this.permissionCheck = fn; },
    setDisplayMediaRequestHandler(fn) { this.displayMedia = fn; },
  };
}
function fakeContents(type, session) {
  const c = new EventEmitter();
  c.id = nextId++;
  c.session = session || fakeSession();
  c.getType = () => type;
  c.getURL = () => c.url || '';
  c.windowOpenHandler = null;
  c.setWindowOpenHandler = (fn) => { c.windowOpenHandler = fn; };
  fakeElectron.app.emit('web-contents-created', {}, c);
  return c;
}
const nav = (contents, name, url) => {
  const ev = { url, prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit(name, ev, url);
  return ev.prevented;
};

test('sessions get default-deny permission handlers and a display-media handler', () => {
  const shell = fakeContents('window');
  security.registerShell(shell);
  const s = shell.session;
  assert.equal(typeof s.permissionRequest, 'function');
  assert.equal(typeof s.displayMedia, 'function');
  const guest = fakeContents('webview', s);
  let answer = null;
  s.permissionRequest(guest, 'media', (v) => { answer = v; }, { requestingUrl: 'https://x.test/' });
  assert.equal(answer, false);
  assert.equal(s.permissionCheck(guest, 'geolocation', 'https://x.test', {}), false);
  assert.equal(s.permissionCheck(shell, 'clipboard-sanitized-write', 'file:///', {}), true);
  // display media with nothing armed is an empty grant
  let dm = null;
  s.displayMedia({ frame: { processId: 1, routingId: 1, parent: null }, videoRequested: true }, (v) => { dm = v; });
  assert.deepEqual(dm, {});
});

test('will-attach-webview: refused unless the embedder is a registered shell, then sanitised', () => {
  const stranger = fakeContents('window');
  const refused = { prevented: false, preventDefault() { this.prevented = true; } };
  stranger.emit('will-attach-webview', refused, {}, { src: 'https://x.test' });
  assert.equal(refused.prevented, true);

  const shell = fakeContents('window');
  security.registerShell(shell);
  const ok = { prevented: false, preventDefault() { this.prevented = true; } };
  const wp = { preload: 'C:\\evil.js', nodeIntegration: true, contextIsolation: false, sandbox: true };
  const params = { src: 'javascript:alert(1)', partition: 'persist:main' };
  shell.emit('will-attach-webview', ok, wp, params);
  assert.equal(ok.prevented, false);
  assert.equal(path.resolve(wp.preload), security.paths.INSPECTOR_PRELOAD);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.sandbox, process.env.BRAIWSER_SANDBOX_GUEST === '1' && require('node:fs').existsSync(security.paths.GUEST_BUNDLE));
  assert.equal(params.src, 'about:blank');
  assert.ok(!('partition' in params));
});

test('shell navigation is locked to the shell page (navigate, redirect, frame-navigate)', () => {
  const shell = fakeContents('window');
  security.registerShell(shell);
  const home = pathToFileURL(security.paths.SHELL_PAGE).href;
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    assert.equal(nav(shell, ev, 'https://evil.test/'), true, ev);
    assert.equal(nav(shell, ev, home), false, ev + ' home');
  }
  // an unregistered window (DevTools, PDF printer) is untouched
  const printer = fakeContents('window');
  assert.equal(nav(printer, 'will-navigate', 'data:text/html,x'), false);
});

test('shell window.open is denied; http(s) goes to the OS browser, others are dropped', () => {
  const shell = fakeContents('window');
  security.registerShell(shell);
  opened.length = 0;
  assert.deepEqual(shell.windowOpenHandler({ url: 'https://braiwser.app/docs' }), { action: 'deny' });
  assert.deepEqual(shell.windowOpenHandler({ url: 'file:///C:/Windows/System32/calc.exe' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://braiwser.app/docs']);
  const other = fakeContents('window');
  assert.deepEqual(other.windowOpenHandler({ url: 'https://x.test' }), { action: 'allow' }, 'non-shell windows keep defaults');
});

test('guest popups stay denied (no managed popups) and guest navigation is vetted', () => {
  const guest = fakeContents('webview');
  opened.length = 0;
  assert.deepEqual(guest.windowOpenHandler({ url: 'https://example.com/x' }), { action: 'deny' });
  assert.deepEqual(guest.windowOpenHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/x']);

  guest.url = 'https://example.com/';
  assert.equal(nav(guest, 'will-navigate', 'https://example.org/'), false);
  assert.equal(nav(guest, 'will-navigate', 'slack://open'), true);
  assert.equal(nav(guest, 'will-redirect', 'file:///C:/Users/me/secret.txt'), true);
  assert.equal(nav(guest, 'will-navigate', 'data:text/html,hi'), true);
});

test('shell registry forgets destroyed windows', () => {
  const shell = fakeContents('window');
  security.registerShell(shell);
  assert.equal(security.isShellWebContents(shell), true);
  shell.emit('destroyed');
  assert.equal(security.isShellWebContents(shell), false);
});

test('agent runtime flag and extra shell arguments', () => {
  const prev = process.env.BRAIWSER_AGENT_RUNTIME;
  const e2e = [process.env.BRAIWSER_E2E, process.env.CAOS_E2E];
  delete process.env.BRAIWSER_E2E; delete process.env.CAOS_E2E;
  try {
    delete process.env.BRAIWSER_AGENT_RUNTIME;
    assert.equal(security.agentRuntimeEnabled(), false);
    assert.deepEqual(security.shellAdditionalArguments(), []);
    process.env.BRAIWSER_AGENT_RUNTIME = '1';
    assert.equal(security.agentRuntimeEnabled(), true);
    assert.deepEqual(security.shellAdditionalArguments(), ['--braiwser-agent-runtime=1']);
  } finally {
    if (prev === undefined) delete process.env.BRAIWSER_AGENT_RUNTIME; else process.env.BRAIWSER_AGENT_RUNTIME = prev;
    if (e2e[0] !== undefined) process.env.BRAIWSER_E2E = e2e[0];
    if (e2e[1] !== undefined) process.env.CAOS_E2E = e2e[1];
  }
});

test('security.handle registers a guarded channel that rejects non-shell senders', async () => {
  const handlers = {};
  const ipcMain = { removeHandler() {}, handle(ch, fn) { handlers[ch] = fn; } };
  security.handle(ipcMain, 'caos:test', (a) => a * 2);
  const guestEvent = { sender: { id: 1, isDestroyed: () => false, getType: () => 'webview', hostWebContents: {} }, senderFrame: { processId: 1, routingId: 1, parent: null, url: 'https://x' } };
  await assert.rejects(handlers['caos:test'](guestEvent, 2), /Blocked IPC caos:test/);

  const shell = fakeContents('window');
  security.registerShell(shell);
  const frame = { processId: 5, routingId: 1, parent: null, url: pathToFileURL(security.paths.SHELL_PAGE).href };
  shell.mainFrame = frame;
  shell.isDestroyed = () => false;
  assert.equal(await handlers['caos:test']({ sender: shell, senderFrame: frame }, 21), 42);
});
