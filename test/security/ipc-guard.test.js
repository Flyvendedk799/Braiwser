'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  validateSender, createIpcGuard, IpcRejectedError, frameKey,
} = require('../../src/main/security/ipc-guard');
const { DEFAULT_ARG_RULES } = require('../../src/main/security/ipc-args');

const SHELL_PAGE = path.join(__dirname, 'fake-app', 'renderer', 'index.html');
const SHELL_URL = pathToFileURL(SHELL_PAGE).href;

function fakeFrame(over) {
  return { processId: 7, routingId: 1, parent: null, url: SHELL_URL, ...over };
}
function fakeShell(over) {
  const mainFrame = fakeFrame();
  return {
    id: 1,
    mainFrame,
    isDestroyed: () => false,
    getType: () => 'window',
    ...over,
  };
}
function eventFor(sender, frame) {
  return { sender, senderFrame: frame === undefined ? sender.mainFrame : frame };
}
const ctxFor = (shell) => ({
  isShellWebContents: (wc) => wc === shell,
  shellPagePath: SHELL_PAGE,
});

test('accepts the registered shell top-level frame on the shell page', () => {
  const shell = fakeShell();
  assert.deepEqual(validateSender(eventFor(shell), ctxFor(shell)), { ok: true });
});

test('shell page URL may carry a hash or query', () => {
  const shell = fakeShell();
  const frame = fakeFrame({ url: SHELL_URL + '?x=1#open-file' });
  shell.mainFrame = frame;
  assert.equal(validateSender(eventFor(shell, frame), ctxFor(shell)).ok, true);
});

test('rejects a guest <webview> webContents even if registered by mistake', () => {
  const guest = fakeShell({ getType: () => 'webview', hostWebContents: { id: 1 } });
  const v = validateSender(eventFor(guest), { isShellWebContents: () => true, shellPagePath: SHELL_PAGE });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'GUEST_SENDER');
});

test('rejects a webContents nobody registered as a shell', () => {
  const stranger = fakeShell({ id: 99 });
  const v = validateSender(eventFor(stranger), { isShellWebContents: () => false, shellPagePath: SHELL_PAGE });
  assert.equal(v.code, 'UNREGISTERED_SENDER');
});

test('rejects subframes of the shell', () => {
  const shell = fakeShell();
  const sub = fakeFrame({ routingId: 5, parent: shell.mainFrame });
  const v = validateSender(eventFor(shell, sub), ctxFor(shell));
  assert.equal(v.code, 'SUBFRAME');
});

test('rejects a frame that is not the sender main frame even without parent info', () => {
  const shell = fakeShell();
  const other = fakeFrame({ routingId: 9 });
  assert.equal(validateSender(eventFor(shell, other), ctxFor(shell)).code, 'NOT_MAIN_FRAME');
});

test('rejects when the frame is gone or the shell navigated elsewhere', () => {
  const shell = fakeShell();
  assert.equal(validateSender({ sender: shell, senderFrame: null }, ctxFor(shell)).code, 'NO_FRAME');
  const away = fakeFrame({ url: 'https://evil.example/index.html' });
  shell.mainFrame = away;
  assert.equal(validateSender(eventFor(shell, away), ctxFor(shell)).code, 'WRONG_PAGE');
  const otherFile = fakeFrame({ url: pathToFileURL(path.join(__dirname, 'other.html')).href });
  shell.mainFrame = otherFile;
  assert.equal(validateSender(eventFor(shell, otherFile), ctxFor(shell)).code, 'WRONG_PAGE');
});

test('rejects destroyed senders and missing events', () => {
  const shell = fakeShell({ isDestroyed: () => true });
  assert.equal(validateSender(eventFor(shell), ctxFor(shell)).code, 'SENDER_DESTROYED');
  assert.equal(validateSender(null, ctxFor(shell)).code, 'NO_SENDER');
  assert.equal(validateSender({}, ctxFor(shell)).code, 'NO_SENDER');
});

test('frameKey is stable per frame and null without ids', () => {
  assert.equal(frameKey(fakeFrame()), '7:1');
  assert.equal(frameKey({}), null);
  assert.equal(frameKey(null), null);
});

test('guard.wrap passes args through unchanged and rejects bad senders with a clear error', async () => {
  const shell = fakeShell();
  const guard = createIpcGuard({ ...ctxFor(shell) });
  const calls = [];
  const handler = guard.wrap('caos:projects.get', (...args) => { calls.push(args); return 'ok'; });
  assert.equal(await handler(eventFor(shell), 'p1', { a: 1 }), 'ok');
  assert.deepEqual(calls, [['p1', { a: 1 }]]);

  const guest = fakeShell({ getType: () => 'webview' });
  await assert.rejects(handler(eventFor(guest), 'p1'), (err) => {
    assert.ok(err instanceof IpcRejectedError);
    assert.match(err.message, /Blocked IPC caos:projects\.get/);
    assert.equal(err.code, 'GUEST_SENDER');
    return true;
  });
  assert.equal(calls.length, 1, 'rejected call must not reach the handler');
});

test('guard.wrap withEvent passes the event first', async () => {
  const shell = fakeShell();
  const guard = createIpcGuard({ ...ctxFor(shell) });
  const ev = eventFor(shell);
  const h = guard.wrap('x', (e, a) => [e === ev, a], { withEvent: true });
  assert.deepEqual(await h(ev, 5), [true, 5]);
});

test('argument rules run after sender validation and block bad paths/ids', async () => {
  const shell = fakeShell();
  const guard = createIpcGuard({ ...ctxFor(shell), argRules: DEFAULT_ARG_RULES });
  let ran = 0;
  const reveal = guard.wrap('caos:reveal', () => { ran++; return true; });
  await assert.rejects(reveal(eventFor(shell), '../relative.txt'), /absolute path/);
  await assert.rejects(reveal(eventFor(shell), 'C:\\ok\0evil'), /absolute path/);
  await assert.rejects(reveal(eventFor(shell), { path: '/x' }), /absolute path/);
  assert.equal(ran, 0);
  assert.equal(await reveal(eventFor(shell), path.resolve('/tmp/file.txt')), true);

  const cap = guard.wrap('caos:capture-fullpage', () => 'shot');
  await assert.rejects(cap(eventFor(shell), '12'), /positive integer/);
  await assert.rejects(cap(eventFor(shell), -3), /positive integer/);
  assert.equal(await cap(eventFor(shell), 12), 'shot');

  const vid = guard.wrap('caos:video.source', () => true);
  assert.equal(await vid(eventFor(shell), null), true);
  await assert.rejects(vid(eventFor(shell), 'abc'), /positive integer or null/);

  const ci = guard.wrap('caos:integrations.ciStarter', () => ({ ok: false }));
  assert.deepEqual(await ci(eventFor(shell), ''), { ok: false }); // empty stays a handler-level error
  await assert.rejects(ci(eventFor(shell), 'relative/dir'), /absolute path/);
});

test('log hook records rejections without leaking arguments', async () => {
  const shell = fakeShell();
  const lines = [];
  const guard = createIpcGuard({ ...ctxFor(shell), log: (m) => lines.push(m) });
  const h = guard.wrap('caos:secrets.setKey', () => 'saved');
  await assert.rejects(h({ sender: fakeShell({ id: 5 }), senderFrame: fakeFrame() }, 'openai', 'sk-secret-key'));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('sk-secret-key'));
});
