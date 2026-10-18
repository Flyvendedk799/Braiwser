'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPermissionPolicy } = require('../../src/main/security/permission-policy');
const nav = require('../../src/main/security/navigation-policy');

const SHELL = { id: 1, kind: 'shell' };
const GUEST = { id: 2, kind: 'guest' };
const mk = (over) => createPermissionPolicy({ isShellWebContents: (wc) => wc === SHELL, ...over });

test('guests are denied camera, mic, geolocation, notifications, external protocols and more', () => {
  const p = mk();
  for (const perm of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'clipboard-read',
    'hid', 'serial', 'usb', 'pointerLock', 'display-capture', 'idle-detection', 'window-management', 'unknown', 'persistent-storage']) {
    assert.equal(p.decide(GUEST, perm, 'https://example.com/'), false, perm);
  }
  assert.equal(p.decide(null, 'media', 'https://example.com'), false, 'null webContents is treated as a guest');
});

test('guests keep harmless clipboard-write and fullscreen', () => {
  const p = mk();
  assert.equal(p.decide(GUEST, 'clipboard-sanitized-write', 'https://example.com'), true);
  assert.equal(p.decide(GUEST, 'fullscreen', 'https://example.com'), true);
});

test('request and check handlers share the policy', () => {
  const p = mk();
  let answer;
  p.requestHandler(GUEST, 'geolocation', (v) => { answer = v; }, { requestingUrl: 'https://example.com/' });
  assert.equal(answer, false);
  assert.equal(p.checkHandler(GUEST, 'notifications', 'https://example.com', {}), false);
  assert.equal(p.checkHandler(SHELL, 'clipboard-sanitized-write', 'file:///', {}), true);
});

test('shell: capture permissions only while a video run is active', () => {
  let active = false;
  const p = mk({ isCaptureActive: () => active });
  assert.equal(p.decide(SHELL, 'display-capture', 'file:///x'), false);
  assert.equal(p.decide(SHELL, 'media', 'file:///x'), false);
  active = true;
  assert.equal(p.decide(SHELL, 'display-capture', 'file:///x'), true);
  assert.equal(p.decide(SHELL, 'geolocation', 'file:///x'), false, 'still no unrelated permissions');
});

test('trusted-UI allow path is origin- and permission-scoped and expires', () => {
  let t = 0;
  const p = mk({ now: () => t });
  p.grantGuest({ origin: 'https://meet.example.com/room', permission: 'media', ttlMs: 1000 });
  assert.equal(p.decide(GUEST, 'media', 'https://meet.example.com/other'), true);
  assert.equal(p.decide(GUEST, 'media', 'https://evil.example.com/'), false);
  assert.equal(p.decide(GUEST, 'geolocation', 'https://meet.example.com/'), false);
  t = 1001;
  assert.equal(p.decide(GUEST, 'media', 'https://meet.example.com/'), false, 'expired');
  p.grantGuest({ origin: 'https://a.test', permission: 'notifications' });
  p.revokeGuest({ origin: 'https://a.test', permission: 'notifications' });
  assert.equal(p.decide(GUEST, 'notifications', 'https://a.test'), false);
  assert.throws(() => p.grantGuest({ origin: '', permission: 'media' }), /needs origin/);
});

// ---- navigation ---------------------------------------------------------------
const SHELL_PAGE = path.join(__dirname, 'fake-app', 'renderer', 'index.html');

test('shell navigation is locked to the shell page', () => {
  const home = pathToFileURL(SHELL_PAGE).href;
  assert.equal(nav.shellNavigationAllowed(home, SHELL_PAGE), true);
  assert.equal(nav.shellNavigationAllowed(home + '#x', SHELL_PAGE), true);
  assert.equal(nav.shellNavigationAllowed('https://example.com/', SHELL_PAGE), false);
  assert.equal(nav.shellNavigationAllowed(pathToFileURL(path.join(__dirname, 'x.html')).href, SHELL_PAGE), false);
  assert.equal(nav.shellNavigationAllowed('javascript:1', SHELL_PAGE), false);
});

test('guest navigation: http(s) and blank; file only from file/blank; nothing exotic', () => {
  assert.equal(nav.guestNavigationAllowed('https://a.test/', 'https://b.test/'), true);
  assert.equal(nav.guestNavigationAllowed('http://localhost:3000/', ''), true);
  assert.equal(nav.guestNavigationAllowed('about:blank', 'https://b.test/'), true);
  assert.equal(nav.guestNavigationAllowed('file:///C:/proj/page2.html', 'file:///C:/proj/index.html'), true);
  assert.equal(nav.guestNavigationAllowed('file:///C:/proj/page2.html', 'about:blank'), true);
  assert.equal(nav.guestNavigationAllowed('file:///C:/secret.txt', 'https://evil.test/'), false);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'blob:https://a/1', 'mailto:a@b.c', 'slack://open', 'ms-msdt:/id', 'chrome://gpu', 'devtools://x']) {
    assert.equal(nav.guestNavigationAllowed(url, 'https://a.test/'), false, url);
  }
});

test('popups are always denied; only http(s) may reach the OS browser, rate limited', () => {
  let t = 0;
  const limiter = nav.createLaunchLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.deepEqual(nav.windowOpenDecision('https://a.test/', limiter), { action: 'deny', openExternal: true });
  assert.deepEqual(nav.windowOpenDecision('http://a.test/', limiter), { action: 'deny', openExternal: true });
  assert.deepEqual(nav.windowOpenDecision('https://a.test/3', limiter), { action: 'deny', openExternal: false }, 'spam throttled');
  t = 1500;
  assert.equal(nav.windowOpenDecision('https://a.test/4', limiter).openExternal, true);
  for (const url of ['file:///C:/x', 'javascript:1', 'data:text/html,x', 'ms-settings:', 'not a url']) {
    assert.deepEqual(nav.windowOpenDecision(url, limiter), { action: 'deny', openExternal: false }, url);
  }
});
