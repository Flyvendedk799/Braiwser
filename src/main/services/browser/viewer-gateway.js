// Standalone viewer transport. Binds loopback unless a remote deployment names
// an https origin. The broker remains the authority for control and input.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createViewerAuth } = require('./viewer-auth');
const { FRAME_STALE_MS } = require('./handoff-coordinator');

const VIEWER_ROOT = path.resolve(__dirname, '../../../viewer');

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { v2Code: 'ACCESS_REVOKED' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('INVALID_INPUT: body must be JSON'), { v2Code: 'ACCESS_REVOKED' })); }
    });
    req.on('error', reject);
  });
}

function createViewerGateway({ broker, auth, host = '127.0.0.1', port = 0, clock = { now: () => Date.now() }, frameStaleMs = FRAME_STALE_MS } = {}) {
  if (!broker) throw new TypeError('viewer gateway requires the owning broker');
  const tokens = auth || createViewerAuth({ clock });
  const secure = false;
  let server = null;
  let baseUrl = null;
  const frames = new Map();
  const inputSeq = new Map();

  function coord() { return broker._internals && broker._internals.handoffs; }

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(text);
  }
  function fail(res, err) {
    const code = err.v2Code || 'INTERNAL';
    const status = code === 'CONTROL_BUSY' ? 409 : code === 'VIEWER_UNREACHABLE' ? 503 : code === 'ACCESS_EXPIRED' || code === 'ACCESS_REVOKED' ? 401 : 400;
    send(res, status, { ok: false, error: { code, message: String(err.message || code).slice(0, 300) } });
  }

  async function frameFor(rec, session, viewer) {
    const page = session.page(rec.pageId);
    let image = null;
    let meta = { width: 0, height: 0, scale: 1 };
    const withheld = rec.privateInput === true && (!viewer || viewer.mode !== 'control' || viewer.instanceId !== rec.viewerInstance);
    if (!withheld && page.driverPage && typeof page.driverPage.screenshot === 'function') {
      try {
        const shot = await page.driverPage.screenshot({});
        if (shot && Buffer.isBuffer(shot.bytes)) image = shot.bytes.toString('base64');
        if (shot && shot.meta) meta = { width: shot.meta.viewport && shot.meta.viewport.width || 0, height: shot.meta.viewport && shot.meta.viewport.height || 0, scale: shot.meta.scale || 1 };
      } catch { /* a missing frame is reported stale, not invented */ }
    }
    const prev = frames.get(rec.handoffId) || { sequence: 0 };
    const next = {
      sequence: prev.sequence + 1,
      capturedAt: new Date(clock.now()).toISOString(),
      controlEpoch: rec.controlEpoch,
      documentEpoch: page.documentEpoch,
      fresh: true,
      withheld,
      image: withheld ? null : image,
      ...meta,
    };
    frames.set(rec.handoffId, { ...next, at: clock.now() });
    return next;
  }

  async function handle(req, res) {
    const url = new URL(req.url, baseUrl || 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/viewer.js' || pathname.startsWith('/handoff/'))) {
        if (pathname === '/viewer.js') {
          const js = fs.readFileSync(path.join(VIEWER_ROOT, 'viewer.js'));
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" });
          res.end(js);
          return;
        }
        const html = fs.readFileSync(path.join(VIEWER_ROOT, 'index.html'));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
        });
        res.end(html);
        return;
      }
      const m = pathname.match(/^\/v1\/handoffs\/([A-Za-z0-9_-]{1,80})(?:\/([a-z]+))?$/);
      if (!m) { send(res, 404, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'not found' } }); return; }
      const handoffId = m[1];
      const action = m[2] || '';
      const c = coord();
      if (!c) throw Object.assign(new Error('VIEWER_UNREACHABLE: handoff coordinator is not running'), { v2Code: 'VIEWER_UNREACHABLE' });

      if (req.method === 'POST' && action === 'redeem') {
        if (tokens.blocked(handoffId)) throw Object.assign(new Error('ACCESS_REVOKED: too many attempts'), { v2Code: 'ACCESS_REVOKED' });
        const body = await readBody(req);
        try {
          c.redeem(handoffId, body.code);
        } catch (err) {
          if (tokens.noteFailure(handoffId)) err = Object.assign(new Error('ACCESS_REVOKED: too many attempts'), { v2Code: 'ACCESS_REVOKED' });
          throw err;
        }
        tokens.clearFailures(handoffId);
        const rec = tokens.issue(handoffId, { mode: 'observe' });
        send(res, 200, { ok: true, value: { handoffId, mode: 'observe' } }, { 'set-cookie': tokens.setCookieHeader(rec, { secure }) });
        return;
      }

      if (req.method === 'GET' && !action) {
        const view = tokens.read(req);
        if (!view || view.handoffId !== handoffId) throw Object.assign(new Error('ACCESS_REVOKED: sign in required'), { v2Code: 'ACCESS_REVOKED' });
        send(res, 200, { ok: true, value: c.status(handoffId, {}) });
        return;
      }

      if (req.method === 'GET' && action === 'frame') {
        const view = tokens.read(req);
        if (!view || view.handoffId !== handoffId) throw Object.assign(new Error('ACCESS_REVOKED: sign in required'), { v2Code: 'ACCESS_REVOKED' });
        const framed = c.get(handoffId);
        if (!framed) throw Object.assign(new Error('ACCESS_REVOKED: unknown handoff'), { v2Code: 'ACCESS_REVOKED' });
        const framedSession = broker._internals.sessions.get(framed.sessionId);
        if (!framedSession || framedSession.closed) throw Object.assign(new Error('VIEWER_UNREACHABLE: browser session is gone'), { v2Code: 'VIEWER_UNREACHABLE' });
        send(res, 200, { ok: true, value: await frameFor(framed, framedSession, { mode: view.mode, instanceId: view.id }) });
        return;
      }

      const sessionAuth = tokens.assertWrite(req, baseUrl);
      if (sessionAuth.handoffId !== handoffId) throw Object.assign(new Error('ACCESS_REVOKED: session is for a different handoff'), { v2Code: 'ACCESS_REVOKED' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const rec = c.get(handoffId);
      const session = broker._internals.sessions.get(rec.sessionId);
      if (!session || session.closed) throw Object.assign(new Error('VIEWER_UNREACHABLE: browser session is gone'), { v2Code: 'VIEWER_UNREACHABLE' });

      if (req.method !== 'POST') { send(res, 405, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'method not allowed' } }); return; }

      const value = await c.withLock(session.sessionId, async () => {
        if (action === 'acquire') {
          c.acquire(handoffId, { viewerInstance: sessionAuth.id, expectedControlEpoch: body.expectedControlEpoch });
          sessionAuth.mode = 'control';
          sessionAuth.instanceId = sessionAuth.id;
          return c.markAcquired(c.get(handoffId), session, sessionAuth.id);
        }
        if (action === 'release') return c.release(c.get(handoffId), session);
        if (action === 'resume') {
          if (session.lease.owner === 'human') c.release(c.get(handoffId), session);
          const grant = c.authorizeResume(c.get(handoffId), session, { principalId: 'viewer', runId: rec.runId, expectedControlEpoch: c.get(handoffId).controlEpoch });
          return broker.resumeRun({
            handoffId, runId: rec.runId, expectedControlEpoch: grant.controlEpoch, requestKey: body.requestKey || grant.grantId,
          }, { principal: { id: 'viewer', kind: 'ui', scopes: ['ui'] } });
        }
        if (action === 'private') {
          if (body.enabled === false) return c.endPrivate(c.get(handoffId), session);
          return c.beginPrivate(c.get(handoffId), session);
        }
        if (action === 'cancel') {
          if (rec.runId) await broker.cancelRun({ runId: rec.runId }, { principal: { id: session.ownerId, kind: 'ui', scopes: ['ui'] } });
          return c.release(c.get(handoffId), session);
        }
        if (action === 'input') return acceptInput(rec, session, sessionAuth, body);
        throw Object.assign(new Error('ACCESS_REVOKED: unknown viewer action'), { v2Code: 'ACCESS_REVOKED' });
      });
      send(res, 200, { ok: true, value });
    } catch (err) {
      fail(res, err.v2Code ? err : Object.assign(err, { v2Code: err.v2Code || 'INTERNAL' }));
    }
  }

  function acceptInput(rec, session, viewer, body) {
    if (viewer.mode !== 'control' || rec.viewerInstance !== viewer.id || rec.state !== 'human') {
      throw Object.assign(new Error('ACCESS_REVOKED: this viewer cannot send input'), { v2Code: 'ACCESS_REVOKED' });
    }
    if (body.controlEpoch !== rec.controlEpoch) throw Object.assign(new Error('STALE_CONTROL_EPOCH: frame epoch is stale'), { v2Code: 'STALE_CONTROL_EPOCH' });
    const frame = frames.get(rec.handoffId);
    const age = frame ? clock.now() - frame.at : Infinity;
    if (!frame || body.frameSequence !== frame.sequence || age > frameStaleMs || frame.withheld) {
      throw Object.assign(new Error('STALE_CONTROL_EPOCH: input frozen until a fresh frame is acknowledged'), { v2Code: 'STALE_CONTROL_EPOCH' });
    }
    const seen = inputSeq.get(rec.handoffId) || new Set();
    const key = `${body.frameSequence}:${body.kind}:${body.x}:${body.y}:${body.key || ''}`;
    if (seen.has(key)) return { accepted: true, duplicate: true };
    seen.add(key);
    inputSeq.set(rec.handoffId, seen);
    const page = session.page(rec.pageId);
    if (page.driverPage && typeof page.driverPage.humanInput === 'function') {
      page.driverPage.humanInput({ kind: body.kind, x: body.x, y: body.y, key: body.key, epoch: rec.controlEpoch });
    }
    return { accepted: true, duplicate: false, dispatched: typeof (page.driverPage && page.driverPage.humanInput) === 'function' };
  }

  function listen() {
    server = http.createServer((req, res) => { handle(req, res).catch((err) => fail(res, err)); });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        baseUrl = `http://${host}:${addr.port}`;
        if (typeof broker.attachViewer === 'function') {
          broker.attachViewer({ enabled: true, baseUrl, deployment: 'local' });
        }
        resolve(baseUrl);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  }

  return { listen, close, get baseUrl() { return baseUrl; }, auth: tokens };
}

module.exports = { createViewerGateway };
