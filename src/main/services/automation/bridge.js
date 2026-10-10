'use strict';
// Authenticated local IPC between the sidecar/CLI (client) and the owning
// broker's process (server half: bridge-server.js).
//
// Transport: a Windows named pipe or a unix-domain socket with a random name /
// private directory, newline-delimited JSON frames, hard frame-size caps. The
// client authenticates with a random bearer token on the first frame; the
// SERVER maps the token to a principal. The client can never name a principal,
// so possession of an id is never authority. Nothing here listens on TCP, so
// there is no DNS-rebinding or cross-origin surface.
//
// Only a fixed list of read/act/run methods is reachable; `approve` and
// `resume` (trusted-UI-only) are not. No ledger/store is touched from this
// side: the owning broker is the single writer.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 1;
const MAX_FRAME = 2 * 1024 * 1024;
const METHODS = Object.freeze(['openSession', 'closeSession', 'observe', 'act', 'startRun', 'getRun',
  'cancelRun', 'handoff', 'listRuns', 'getManifest', 'readResource']);
const READ_ONLY = new Set(['observe', 'getRun', 'listRuns', 'getManifest', 'readResource']);

class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.publicError = { code, message: String(message).slice(0, 500), dispatched: false, effectUnknown: false, retry: 'never', ...extra };
  }
}

// Split a byte stream into JSON frames; any violation destroys the connection.
function frameParser(onFrame, onViolation, max = MAX_FRAME) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (line.length > max) return onViolation('frame too large');
      let frame;
      try { frame = JSON.parse(line); } catch { return onViolation('invalid json'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return onViolation('invalid frame');
      onFrame(frame);
    }
    if (buffer.length > max) onViolation('frame too large');
  };
}

const write = (socket, frame) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
};

function defaultInfoPaths(env = process.env) {
  if (env.BRAIWSER_BRIDGE_INFO) return [env.BRAIWSER_BRIDGE_INFO];
  const home = os.homedir();
  const base = process.platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return ['braiwser', 'Braiwser'].map((n) => path.join(base, n, 'agent-bridge.json'));
}

function readConnectionInfo(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.version !== 1 || typeof parsed.endpoint !== 'string' || typeof parsed.token !== 'string') {
    throw new BridgeError('UNAVAILABLE', 'Bridge connection file is not valid.');
  }
  return { endpoint: parsed.endpoint, token: parsed.token, pid: parsed.pid, expiresAt: parsed.expiresAt || null };
}

function loadConnectionInfo(env = process.env) {
  let lastError;
  for (const file of defaultInfoPaths(env)) {
    try { return readConnectionInfo(file); } catch (error) { lastError = error; }
  }
  throw new BridgeError('UNAVAILABLE', `Braiwser is not accepting agent connections (no bridge file; set BRAIWSER_BRIDGE_INFO). ${lastError ? String(lastError.code || '') : ''}`.trim());
}

// connectBridge({ endpoint, token }) -> broker-shaped facade bound to the
// principal the server associated with this token.
function connectBridge({ endpoint, token, requestTimeoutMs = 60000, connectTimeoutMs = 5000, abortGraceMs = 5000 }) {
  return new Promise((resolve, reject) => {
    if (typeof endpoint !== 'string' || !endpoint || typeof token !== 'string' || !token) {
      reject(new BridgeError('UNAVAILABLE', 'A bridge endpoint and token are required.'));
      return;
    }
    const socket = net.connect(endpoint);
    const pending = new Map();
    let nextId = 0, ready = false, closed = false;

    const failAll = (code, message) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new BridgeError(code, message, p.readOnly ? { retry: 'safe-read' } : { dispatched: true, effectUnknown: true }));
      }
      pending.clear();
    };
    const connectTimer = setTimeout(() => {
      if (!ready) { socket.destroy(); reject(new BridgeError('UNAVAILABLE', 'Bridge connection timed out.')); }
    }, connectTimeoutMs);

    const parser = frameParser((frame) => {
      if (!ready) {
        clearTimeout(connectTimer);
        if (frame.t === 'hello' && frame.ok === true && frame.v === PROTOCOL) { ready = true; resolve(facade); }
        else { socket.destroy(); reject(new BridgeError('DENIED', 'The bridge rejected the connection.')); }
        return;
      }
      if (frame.t !== 'res' || !pending.has(frame.id)) return; // late/unknown replies are dropped
      const p = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok === true) p.resolve(frame.result);
      else {
        const e = new Error(frame.error && frame.error.message ? String(frame.error.message).slice(0, 500) : 'Request failed');
        e.publicError = frame.error;
        p.reject(e);
      }
    }, (why) => { socket.destroy(); if (!ready) reject(new BridgeError('UNAVAILABLE', `Bridge protocol violation: ${why}`)); });

    socket.on('data', parser);
    socket.on('error', (error) => {
      if (!ready) { clearTimeout(connectTimer); reject(new BridgeError('UNAVAILABLE', `Cannot reach Braiwser: ${error.code || 'connection error'}`)); }
    });
    socket.on('close', () => {
      closed = true;
      failAll('UNAVAILABLE', 'The bridge connection closed.');
    });
    socket.on('connect', () => write(socket, { t: 'hello', v: PROTOCOL, token }));

    function call(method, params, ctx) {
      return new Promise((res, rej) => {
        if (closed) { rej(new BridgeError('UNAVAILABLE', 'The bridge connection is closed.')); return; }
        const id = ++nextId;
        const readOnly = READ_ONLY.has(method);
        const signal = ctx && ctx.signal;
        const entry = { resolve: res, reject: rej, readOnly };
        entry.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          rej(new BridgeError('TIMEOUT', 'The broker did not answer in time. A timeout is not proof that work stopped.',
            readOnly ? { retry: 'safe-read' } : { dispatched: true, effectUnknown: true }));
        }, requestTimeoutMs);
        pending.set(id, entry);
        if (signal) {
          const onAbort = () => {
            write(socket, { t: 'abort', id });
            // The server answers with the broker's real outcome; if it does not,
            // report cancellation honestly (effect unknown for mutations).
            setTimeout(() => {
              if (!pending.delete(id)) return;
              clearTimeout(entry.timer);
              rej(new BridgeError('CANCELLED', 'Cancelled; already-dispatched effects are not rolled back.',
                readOnly ? { retry: 'safe-read' } : { dispatched: true, effectUnknown: true }));
            }, abortGraceMs).unref();
          };
          if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
        }
        write(socket, { t: 'req', id, method, params: params === undefined ? {} : params });
      });
    }

    const facade = { bridge: true, principalBound: true };
    for (const method of METHODS) facade[method] = (params, ctx) => call(method, params, ctx);
    facade.close = () => new Promise((r) => { if (closed) r(); else { socket.once('close', r); socket.end(); setTimeout(() => socket.destroy(), 500).unref(); } });
  });
}

module.exports = {
  PROTOCOL, MAX_FRAME, METHODS, READ_ONLY, BridgeError,
  frameParser, write, connectBridge, defaultInfoPaths, readConnectionInfo, loadConnectionInfo,
};
