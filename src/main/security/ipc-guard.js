'use strict';
// IPC sender / frame validation — pure predicates, no Electron import, so the
// policy is unit-testable with fake event / frame / webContents objects.
//
// Threat: ipcMain.handle() listeners receive calls from ANY frame of ANY
// webContents that loaded our preload (or, with a sloppy preload config, any
// frame at all). The privileged handlers (filesystem, secrets, shell hand-off,
// debugger) must only ever answer the trusted shell: the registered shell
// window's TOP-LEVEL frame, showing the shell page from disk. Never a guest
// <webview> webContents, never a subframe, never a window nobody registered.
//
// Usage (see src/main/ipc/index.js):
//   const guard = createIpcGuard({ isShellWebContents, shellPagePath });
//   ipcMain.handle(channel, guard.wrap(channel, (...args) => handler(...args)));

const path = require('path');
const { fileURLToPath } = require('url');

class IpcRejectedError extends Error {
  constructor(code, message, channel) {
    super(message);
    this.name = 'IpcRejectedError';
    this.code = code;
    this.channel = channel;
  }
}

function normalizePath(p, platform) {
  const resolved = path.resolve(p);
  return (platform || process.platform) === 'win32' ? resolved.toLowerCase() : resolved;
}

// file:// URL -> comparable absolute path, or null when it is not a file URL.
function fileUrlToPath(url, platform) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return null;
    return normalizePath(fileURLToPath(u), platform);
  } catch (_e) {
    return null;
  }
}

// Stable identity for a WebFrameMain / senderFrame. Electron caches frame
// objects, but process+routing id is the contract that survives re-wrapping.
function frameKey(frame) {
  if (!frame) return null;
  const pid = frame.processId;
  const rid = frame.routingId;
  if (pid == null || rid == null) return null;
  return `${pid}:${rid}`;
}

function sameFrame(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = frameKey(a);
  const kb = frameKey(b);
  return ka != null && ka === kb;
}

// Decide whether an IPC event came from the trusted shell.
//   ctx.isShellWebContents(wc) -> true only for webContents we created as shell windows
//   ctx.shellPagePath          -> absolute path of the shell page (renderer/index.html)
//   ctx.platform               -> test hook for path normalisation
// Returns { ok: true } or { ok: false, code, reason }.
function validateSender(event, ctx) {
  const deny = (code, reason) => ({ ok: false, code, reason });
  if (!event || !event.sender) return deny('NO_SENDER', 'IPC call carries no sender');
  const sender = event.sender;
  try {
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      return deny('SENDER_DESTROYED', 'IPC sender is destroyed');
    }
    // A guest <webview> must never reach privileged handlers, even if it somehow
    // obtained a preload that can call invoke().
    if ((typeof sender.getType === 'function' && sender.getType() === 'webview') || sender.hostWebContents) {
      return deny('GUEST_SENDER', 'IPC from a guest webContents is not allowed');
    }
  } catch (_e) {
    return deny('SENDER_UNREADABLE', 'IPC sender state could not be read');
  }
  if (!ctx || typeof ctx.isShellWebContents !== 'function' || !ctx.isShellWebContents(sender)) {
    return deny('UNREGISTERED_SENDER', 'IPC sender is not a registered shell window');
  }
  const frame = event.senderFrame;
  if (!frame) return deny('NO_FRAME', 'IPC call carries no sender frame (frame gone or navigated)');
  if (frame.parent) return deny('SUBFRAME', 'IPC from a subframe is not allowed');
  if (sender.mainFrame && !sameFrame(sender.mainFrame, frame)) {
    return deny('NOT_MAIN_FRAME', 'IPC frame is not the top-level frame of the shell window');
  }
  if (!ctx.shellPagePath) return deny('NO_SHELL_PAGE', 'No shell page configured');
  const framePath = fileUrlToPath(frame.url, ctx.platform);
  if (!framePath || framePath !== normalizePath(ctx.shellPagePath, ctx.platform)) {
    return deny('WRONG_PAGE', 'IPC frame is not showing the shell page');
  }
  return { ok: true };
}

// Wrap an ipcMain.handle listener. `fn(...args)` keeps its existing signature;
// pass { withEvent: true } to receive (event, ...args) instead. Rejections throw
// IpcRejectedError so invoke() surfaces a readable message to the caller.
function createIpcGuard(options) {
  const opts = options || {};
  const argRules = opts.argRules || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  function check(event, channel, args) {
    const verdict = validateSender(event, opts);
    if (!verdict.ok) {
      log(`[ipc-guard] rejected ${channel}: ${verdict.code}`);
      throw new IpcRejectedError(verdict.code, `Blocked IPC ${channel}: ${verdict.reason}`, channel);
    }
    const rule = argRules[channel];
    if (rule) {
      try { rule(args || []); } catch (err) {
        log(`[ipc-guard] rejected ${channel}: bad arguments (${err && err.message})`);
        throw new IpcRejectedError('BAD_ARGS', `Invalid arguments for ${channel}: ${(err && err.message) || err}`, channel);
      }
    }
  }

  function wrap(channel, fn, wrapOpts) {
    const withEvent = !!(wrapOpts && wrapOpts.withEvent);
    return async (event, ...args) => {
      check(event, channel, args);
      return withEvent ? fn(event, ...args) : fn(...args);
    };
  }

  return { check, wrap };
}

module.exports = {
  IpcRejectedError,
  validateSender,
  createIpcGuard,
  fileUrlToPath,
  frameKey,
  sameFrame,
  normalizePath,
};
