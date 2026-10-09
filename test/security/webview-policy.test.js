'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sanitizeWebviewAttach, classifySrc, normalizePartition } = require('../../src/main/security/webview-policy');
const { createFileRoots } = require('../../src/main/security/file-roots');

const APP = path.resolve(__dirname, 'fake-app');
const INSPECTOR = path.join(APP, 'webview', 'inspector.js');
const BUNDLE = path.join(APP, 'webview', 'dist', 'guest-preload.bundle.js');
const PROJECT = path.join(APP, 'projects', 'site');

const roots = createFileRoots({ isDirectory: (p) => !/\.html?$/.test(p) });
roots.addRoot(path.join(APP, 'renderer'));
roots.addRoot(path.join(PROJECT, 'index.html')); // a file => its folder

const ctx = (over) => ({
  inspectorPreloadPath: INSPECTOR,
  bundledPreloadPath: BUNDLE,
  sandboxGuest: false,
  isAllowedFileUrl: roots.isAllowedFileUrl,
  ...over,
});
const inspectorUrl = pathToFileURL(INSPECTOR).href;

test('keeps the shipped inspector preload (URL form preserved) and forces isolation flags', () => {
  const wp = { preload: inspectorUrl, contextIsolation: true, sandbox: false, nodeIntegration: false };
  const params = { src: 'https://example.com/' };
  const r = sanitizeWebviewAttach(wp, params, ctx());
  assert.equal(wp.preload, inspectorUrl);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, false);
  assert.equal(wp.webSecurity, true);
  assert.ok(!('backgroundThrottling' in wp), 'no throttling override; runtime toggle owns it');
  assert.equal(r.sandboxed, false);
  assert.equal(params.src, 'https://example.com/');
});

test('replaces a renderer-supplied foreign preload and strips every privilege override', () => {
  const wp = {
    preload: 'C:\\evil\\steal.js',
    preloadURL: 'file:///C:/evil/steal.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true,
    contextIsolation: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    enableRemoteModule: true,
    additionalArguments: ['--no-sandbox'],
    session: {},
    sandbox: false,
  };
  const params = { src: 'https://example.com/', disablewebsecurity: '', nodeintegration: '', plugins: '', webpreferences: 'nodeIntegration=yes' };
  const r = sanitizeWebviewAttach(wp, params, ctx());
  assert.equal(path.resolve(wp.preload), INSPECTOR);
  assert.ok(!('preloadURL' in wp));
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.nodeIntegrationInSubFrames, false);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.allowRunningInsecureContent, false);
  for (const k of ['enableRemoteModule', 'additionalArguments', 'session', 'nodeIntegrationInWorker']) assert.ok(!(k in wp), k);
  for (const k of ['disablewebsecurity', 'nodeintegration', 'plugins', 'webpreferences']) assert.ok(!(k in params), k);
  assert.ok(r.changes.some((c) => /preload replaced/.test(c)));
});

test('forces the preload when the renderer supplied none', () => {
  const wp = {};
  sanitizeWebviewAttach(wp, { src: '' }, ctx());
  assert.equal(path.resolve(wp.preload), INSPECTOR);
});

test('sandbox opt-in swaps in the bundle, mirrors URL form and sets sandbox:true', () => {
  const wp = { preload: inspectorUrl, sandbox: false };
  const r = sanitizeWebviewAttach(wp, { src: 'about:blank' }, ctx({ sandboxGuest: true }));
  assert.equal(wp.preload, pathToFileURL(BUNDLE).href);
  assert.equal(wp.sandbox, true);
  assert.equal(r.sandboxed, true);

  const wp2 = { preload: INSPECTOR };
  sanitizeWebviewAttach(wp2, {}, ctx({ sandboxGuest: true }));
  assert.equal(wp2.preload, BUNDLE);
});

test('sandbox opt-in without a built bundle falls back to the unbundled, unsandboxed preload', () => {
  const wp = { preload: INSPECTOR };
  const r = sanitizeWebviewAttach(wp, {}, ctx({ sandboxGuest: true, bundledPreloadPath: null }));
  assert.equal(r.sandboxed, false);
  assert.equal(wp.sandbox, false);
  assert.equal(path.resolve(wp.preload), INSPECTOR);
});

test('a foreign preload can never survive sandbox mode either', () => {
  const wp = { preload: 'C:\\evil.js' };
  sanitizeWebviewAttach(wp, {}, ctx({ sandboxGuest: true }));
  assert.equal(path.resolve(wp.preload), BUNDLE);
});

test('src allow-list: http(s), about:blank, file inside roots; everything else becomes about:blank', () => {
  const ok = [
    'https://example.com/a', 'http://localhost:3000/', 'about:blank', '',
    pathToFileURL(path.join(APP, 'renderer', 'welcome.html')).href,
    pathToFileURL(path.join(PROJECT, 'css', 'site.css')).href,
  ];
  for (const src of ok) {
    const p = { src };
    sanitizeWebviewAttach({}, p, ctx());
    assert.equal(p.src, src, `kept ${src}`);
  }
  const blocked = [
    'javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://x/1', 'chrome://gpu',
    'devtools://devtools/bundled/inspector.html', 'view-source:https://x', 'ftp://x/y', 'about:config', 'not a url',
    pathToFileURL(path.join(APP, 'secrets', 'keys.json')).href,
    pathToFileURL(path.join(APP, 'projects', 'site-evil', 'index.html')).href, // sibling with shared prefix
    'file:///' + path.join(APP, 'renderer', '..', 'secrets', 'x').replace(/\\/g, '/'),
  ];
  for (const src of blocked) {
    const p = { src };
    const r = sanitizeWebviewAttach({}, p, ctx());
    assert.equal(p.src, 'about:blank', `blocked ${src}`);
    assert.equal(r.srcBlocked, true);
  }
});

test('classifySrc reasons', () => {
  assert.equal(classifySrc('https://a.test', null), 'ok');
  assert.equal(classifySrc('file:///x', null), 'file-outside-roots');
  assert.match(classifySrc('data:,x', null), /^scheme:/);
});

test('partition: default or braiwser-guest* only', () => {
  for (const ok of [undefined, '', 'braiwser-guest', 'persist:braiwser-guest', 'persist:braiwser-guest-work_1']) {
    assert.equal(normalizePartition(ok).ok, true, String(ok));
  }
  for (const bad of ['persist:other', 'braiwser-guest/../x', 'main', 'persist:braiwser-guest-' + 'a'.repeat(60)]) {
    assert.equal(normalizePartition(bad).ok, false, bad);
  }
  const params = { partition: 'persist:steal-main', src: 'about:blank' };
  sanitizeWebviewAttach({}, params, ctx());
  assert.ok(!('partition' in params));
});

test('file roots: project folders count, case-insensitive on win32, prefix siblings do not', { skip: process.platform !== 'win32' }, () => {
  const r = createFileRoots({ platform: 'win32', isDirectory: () => true, getDynamicRoots: () => ['C:\\Work\\Site'] });
  assert.equal(r.isAllowedFileUrl('file:///c:/work/site/index.html'), true);
  assert.equal(r.isAllowedFileUrl('file:///C:/Work/Site'), true);
  assert.equal(r.isAllowedFileUrl('file:///C:/Work/SiteEvil/index.html'), false);
  assert.equal(r.isAllowedFileUrl('https://x/'), false);
  assert.equal(r.addRoot('relative/path'), false);
});
