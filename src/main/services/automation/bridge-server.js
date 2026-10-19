'use strict';
// Server half of the agent bridge. Started by the main process (the single
// owning broker) ONLY when the agent runtime feature flag is on:
//
//   const { startBridge } = require('./services/automation/bridge-server');
//   const bridge = await startBridge({ broker, infoDir: app.getPath('userData') });
//   bridge.writeClientFile(path, { id: 'mcp:claude-code', kind: 'mcp', scopes: [...] }, { ttlMs });
//
// Security model:
//   * the endpoint name is random (named pipe on Windows, a socket inside a
//     private 0700 directory elsewhere) AND every connection must present a
//     random 256-bit token as its first frame; tokens are stored hashed, compared
//     in constant time via hash lookup, expire, and can be revoked;
//   * a token maps to a principal chosen by the issuing code, never by the
//     client; the principal-bound facade (broker.forPrincipal) enforces
//     ownership of every session/run/resource;
//   * only the methods in bridge.METHODS are reachable; `ui`-kind principals can
//     never be issued a token (approve/resume stay on the trusted IPC path);
//   * requests are frame-capped, in-flight-capped, abortable, and errors cross
//     the wire only as classified public errors (no stacks, no raw messages).
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROTOCOL, MAX_FRAME, METHODS, READ_ONLY, frameParser, write } = require('./bridge');

const METHOD_SET = new Set(METHODS);
const ISSUABLE_KINDS = new Set(['mcp', 'cli', 'skill']);
const CODES = new Set(['STALE_REF', 'AMBIGUOUS_TARGET', 'DENIED', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED', 'UNAVAILABLE', 'INTERNAL']);
const RETRY = new Set(['refresh', 'safe-read', 'after-approval', 'never']);

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function classify(caught, method) {
  const p = caught && caught.publicError;
  if (p && CODES.has(p.code) && RETRY.has(p.retry) && typeof p.message === 'string') {
    return { code: p.code, message: p.message.slice(0, 500), dispatched: p.dispatched === true,
      effectUnknown: p.effectUnknown === true, retry: p.retry };
  }
  const ro = READ_ONLY.has(method);
  return { code: 'INTERNAL', message: 'Inspect the run evidence before retrying.',
    dispatched: !ro, effectUnknown: !ro, retry: ro ? 'safe-read' : 'never' };
}

function createBridgeServer({
  broker, endpoint, dir, now = () => Date.now(), helloTimeoutMs = 5000, maxInFlight = 16,
  authFailureDelayMs = 250, maxResponseBytes = 4 * 1024 * 1024,
} = {}) {
  if (!broker || typeof broker.forPrincipal !== 'function') throw new TypeError('A broker with forPrincipal() is required.');
  const tokens = new Map(); // sha256(token) -> { principal, expiresAt, facade, sockets:Set }
  const sockets = new Set();
  let tmpDir = null;
  let ownedDir = false;
  let server = null;
  let resolvedEndpoint = endpoint || null;

  function pickEndpoint() {
    if (resolvedEndpoint) return resolvedEndpoint;
    const rand = crypto.randomBytes(12).toString('hex');
    if (process.platform === 'win32') return `\\\\.\\pipe\\braiwser-agent-${rand}`;
    tmpDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-agent-'));
    ownedDir = !dir;
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(tmpDir, 0o700);
    return path.join(tmpDir, `agent-${rand}.sock`);
  }

  function issueToken(principal, { ttlMs = 8 * 60 * 60 * 1000 } = {}) {
    if (!principal || typeof principal.id !== 'string' || !principal.id || !ISSUABLE_KINDS.has(principal.kind)) {
      throw new TypeError('Bridge tokens can only be issued to mcp, cli or skill principals.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const bound = Object.freeze({ id: principal.id, kind: principal.kind, scopes: Object.freeze([...(principal.scopes || [])]) });
    tokens.set(hashToken(token), { principal: bound, expiresAt: now() + ttlMs, facade: broker.forPrincipal(bound), sockets: new Set() });
    return token;
  }

  function revoke(token) {
    const entry = tokens.get(hashToken(token));
    if (!entry) return false;
    tokens.delete(hashToken(token));
    for (const s of entry.sockets) s.destroy();
    return true;
  }

  function onConnection(socket) {
    sockets.add(socket);
    let entry = null;
    const inFlight = new Map(); // id -> AbortController
    const helloTimer = setTimeout(() => socket.destroy(), helloTimeoutMs);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(socket);
      if (entry) entry.sockets.delete(socket);
      for (const ctl of inFlight.values()) ctl.abort();
      inFlight.clear();
    });
    socket.on('error', () => socket.destroy());

    const parser = frameParser((frame) => {
      if (!entry) {
        const candidate = frame.t === 'hello' && frame.v === PROTOCOL && typeof frame.token === 'string'
          ? tokens.get(hashToken(frame.token)) : null;
        if (!candidate || candidate.expiresAt <= now()) {
          if (candidate) tokens.delete(hashToken(frame.token));
          // Uniform failure, slightly delayed to blunt guessing; no detail leaks.
          setTimeout(() => { write(socket, { t: 'hello', ok: false }); socket.end(); }, authFailureDelayMs).unref();
          clearTimeout(helloTimer);
          return;
        }
        clearTimeout(helloTimer);
        entry = candidate;
        entry.sockets.add(socket);
        write(socket, { t: 'hello', ok: true, v: PROTOCOL });
        return;
      }
      if (entry.expiresAt <= now()) { socket.destroy(); return; }
      if (frame.t === 'abort') {
        const ctl = inFlight.get(frame.id);
        if (ctl) ctl.abort();
        return;
      }
      if (frame.t !== 'req' || !Number.isSafeInteger(frame.id)) { socket.destroy(); return; }
      const id = frame.id;
      const reply = (body) => write(socket, { t: 'res', id, ...body });
      const method = frame.method;
      if (typeof method !== 'string' || !METHOD_SET.has(method) || typeof entry.facade[method] !== 'function') {
        reply({ ok: false, error: { code: 'UNSUPPORTED', message: 'Unknown or unavailable method.', dispatched: false, effectUnknown: false, retry: 'never' } });
        return;
      }
      if (frame.params !== undefined && (frame.params === null || typeof frame.params !== 'object' || Array.isArray(frame.params))) {
        reply({ ok: false, error: { code: 'UNSUPPORTED', message: 'params must be an object.', dispatched: false, effectUnknown: false, retry: 'never' } });
        return;
      }
      if (inFlight.size >= maxInFlight || inFlight.has(id)) {
        reply({ ok: false, error: { code: 'UNAVAILABLE', message: 'Too many requests in flight.', dispatched: false, effectUnknown: false, retry: 'safe-read' } });
        return;
      }
      const ctl = new AbortController();
      inFlight.set(id, ctl);
      Promise.resolve()
        .then(() => entry.facade[method](method === 'readResource' ? frame.params?.uri : (frame.params || {}), { signal: ctl.signal }))
        .then((result) => {
          const text = JSON.stringify(result === undefined ? null : result);
          if (Buffer.byteLength(text) > maxResponseBytes) {
            throw Object.assign(new Error('too large'), { publicError: { code: 'INTERNAL', message: 'Response too large.',
              dispatched: !READ_ONLY.has(method), effectUnknown: !READ_ONLY.has(method), retry: READ_ONLY.has(method) ? 'safe-read' : 'never' } });
          }
          reply({ ok: true, result: JSON.parse(text) });
        })
        .catch((caught) => reply({ ok: false, error: classify(caught, method) }))
        .finally(() => inFlight.delete(id));
    }, () => socket.destroy(), MAX_FRAME);
    socket.on('data', parser);
  }

  function listen() {
    return new Promise((resolve, reject) => {
      resolvedEndpoint = pickEndpoint();
      server = net.createServer(onConnection);
      server.once('error', reject);
      // readableAll/writableAll stay false: no access widening beyond the owner.
      server.listen({ path: resolvedEndpoint, readableAll: false, writableAll: false }, () => {
        server.off('error', reject);
        if (process.platform !== 'win32') { try { fs.chmodSync(resolvedEndpoint, 0o600); } catch { /* best effort */ } }
        resolve(resolvedEndpoint);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      tokens.clear();
      const done = () => {
        if (process.platform !== 'win32' && resolvedEndpoint) { try { fs.rmSync(resolvedEndpoint, { force: true }); } catch { /* ignore */ } }
        if (ownedDir && tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        resolve();
      };
      if (server && server.listening) server.close(done); else done();
    });
  }

  // Writes the credentials one client needs. The file holds a bearer token:
  // mode 0600 (POSIX) / the user-profile ACL (Windows). Anyone who can read it
  // can act as that principal until it expires or is revoked.
  function writeClientFile(file, principal, { ttlMs } = {}) {
    const token = issueToken(principal, ttlMs ? { ttlMs } : undefined);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ version: 1, endpoint: resolvedEndpoint, token, pid: process.pid,
      principalId: principal.id, expiresAt: new Date(now() + (ttlMs || 8 * 60 * 60 * 1000)).toISOString() });
    fs.writeFileSync(file, body, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* not supported on this FS */ }
    return { file, token };
  }

  return {
    listen, close, issueToken, revoke, writeClientFile,
    get endpoint() { return resolvedEndpoint; },
    connectionCount: () => sockets.size,
  };
}

async function startBridge({ broker, infoDir, clientFile = 'agent-bridge.json', defaultClient, ...rest }) {
  const bridge = createBridgeServer({ broker, ...rest });
  await bridge.listen();
  let info = null;
  if (infoDir && defaultClient) {
    info = bridge.writeClientFile(path.join(infoDir, clientFile), defaultClient.principal, { ttlMs: defaultClient.ttlMs });
  }
  return Object.assign(bridge, { info });
}

module.exports = { createBridgeServer, startBridge, METHODS };
