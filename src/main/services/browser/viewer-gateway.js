// The broker owns all control. This transport is deliberately loopback only.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createViewerAuth } = require('./viewer-auth');
const { FRAME_STALE_MS } = require('./handoff-coordinator');
const H = require('../../../shared/handoff-contracts');
const VIEWER_ROOT = path.resolve(__dirname, '../../../viewer');
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(H.v2Error('ACCESS_REVOKED', 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(H.v2Error('ACCESS_REVOKED', 'invalid JSON')); } });
    req.on('error', reject);
  });
}
function createViewerGateway({ broker, auth, owner = null, host = '127.0.0.1', port = 0,
  clock = { now: () => Date.now() }, frameStaleMs = FRAME_STALE_MS, heartbeatMs = 15000 } = {}) {
  if (!broker || host !== '127.0.0.1') throw new TypeError('owning broker and loopback host required');
  const tokens = auth || createViewerAuth({ clock });
  const frames = new Map();
  let frameSequence = 0;
  let server, baseUrl, timer;
  const coord = () => broker._internals.handoffs;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res, err) => {
    const code = err.v2Code || 'INTERNAL';
    send(res, code === 'CONTROL_BUSY' ? 409 : ['ACCESS_EXPIRED', 'ACCESS_REVOKED'].includes(code) ? 401 : 400,
      { ok: false, error: { code, message: code === 'INTERNAL' ? 'Viewer operation failed; reconcile before retry.' : String(err.message).slice(0, 300) } });
  };
  function live(view, handoffId, { allowClosed = false } = {}) {
    if (!view || view.handoffId !== handoffId) throw H.v2Error('ACCESS_REVOKED', 'sign in required');
    const rec = coord().get(handoffId);
    if (!rec || (owner && (rec.principalId !== owner.principalId || view.ownerId !== owner.id))) throw H.v2Error('ACCESS_REVOKED', 'owner mismatch');
    if (!allowClosed) coord().assertLive(rec);
    const session = broker._internals.sessions.get(rec.sessionId);
    if (!session || session.closed) throw H.v2Error('ACCESS_REVOKED', 'browser context lost');
    broker._internals.policy.assertActive(session.grant, { id: session.ownerId });
    return { rec, session };
  }
  async function frameFor(rec, session, view) {
    coord().assertLive(rec);
    view.lastSeen = clock.now();
    const page = session.page(rec.pageId);
    const epoch = rec.controlEpoch, privacy = session.privacyEpoch || 0;
    const documentEpoch = page.documentEpoch, driverEpoch = page.driverPage.documentEpoch;
    const withheld = (rec.privateInput || session.privateTainted) && rec.viewerInstance !== view.id;
    let shot;
    if (!withheld && typeof page.driverPage.screenshot === 'function') {
      try { shot = await page.driverPage.screenshot({}); } catch { /* report missing, never fresh */ }
    }
    coord().assertLive(rec);
    const changed = epoch !== rec.controlEpoch || privacy !== (session.privacyEpoch || 0)
      || documentEpoch !== page.documentEpoch || driverEpoch !== page.driverPage.documentEpoch;
    const image = !changed && !withheld && Buffer.isBuffer(shot?.bytes) && shot.bytes.length <= 4 * 1024 * 1024 ? shot.bytes.toString('base64') : null;
    const frame = { sequence: ++frameSequence, capturedAt: new Date(clock.now()).toISOString(),
      controlEpoch: epoch, documentEpoch, driverEpoch, privacyEpoch: privacy,
      fresh: !!image, withheld: !!withheld || changed, image,
      width: shot?.meta?.viewport?.width || 0, height: shot?.meta?.viewport?.height || 0, scale: 1, at: clock.now() };
    frames.set(view.id, frame);
    return frame;
  }
  async function input(rec, session, view, body) {
    if (view.mode !== 'control' || rec.viewerInstance !== view.id || rec.state !== 'human') throw H.v2Error('ACCESS_REVOKED', 'control required');
    const frame = frames.get(view.id), page = session.page(rec.pageId);
    if (!frame?.fresh || frame.withheld || frame.sequence !== body.frameSequence || frame.controlEpoch !== rec.controlEpoch
      || frame.documentEpoch !== page.documentEpoch || body.documentEpoch !== page.documentEpoch
      || frame.driverEpoch !== page.driverPage.documentEpoch || frame.privacyEpoch !== (session.privacyEpoch || 0)
      || clock.now() - frame.at > frameStaleMs) throw H.v2Error('STALE_CONTROL_EPOCH', 'fresh frame required');
    if (typeof page.driverPage.humanInput !== 'function') throw H.v2Error('UNSUPPORTED_HANDOFF', 'driver does not implement human input');
    if (['click', 'move'].includes(body.kind) && (![body.x, body.y].every(Number.isFinite)
      || body.x < 0 || body.y < 0 || body.x >= frame.width || body.y >= frame.height)) throw H.v2Error('STALE_CONTROL_EPOCH', 'coordinates outside captured viewport');
    view.lastSeen = clock.now();
    // Await the actual dispatch while holding the session lock. Release/resume cannot overtake it.
    if (rec.privateInput && body.kind === 'text' && typeof body.text === 'string') {
      broker._internals.evidence.redactor.addSecret(body.text);
      session.privateText = (session.privateText || '') + body.text;
      broker._internals.evidence.redactor.addSecret(session.privateText);
      session.privateTainted = true;
    }
    let result;
    const privateBlocked = session.privateReadBlocked === true;
    if (rec.privateInput) session.privateReadBlocked = true;
    try {
      result = await page.driverPage.humanInput({ kind: body.kind, x: body.x, y: body.y,
        key: body.key, text: body.text, deltaX: body.deltaX, deltaY: body.deltaY,
        expectedDocumentEpoch: frame.driverEpoch, privateInput: rec.privateInput === true });
      if (rec.privateInput) {
        for (const value of result?.privateValues || []) broker._internals.evidence.redactor.addSecret(value, { minimumLength: 1 });
        session.privateReadBlocked = privateBlocked || result?.privateCaptureComplete !== true;
      }
    } catch (error) {
      if (error.code !== 'UNSUPPORTED') {
        rec.blocker = 'RECONCILIATION_REQUIRED';
        if (session.lease.owner === 'human') coord().release(rec, session);
      }
      throw error;
    }
    if (result?.dispatched !== true) throw H.v2Error('RECONCILIATION_REQUIRED', 'input outcome unknown', { effectUnknown: true });
    frames.delete(view.id);
    return { accepted: true, dispatched: true };
  }
  async function handle(req, res) {
    try {
      if (req.headers.host !== new URL(baseUrl).host) throw H.v2Error('ACCESS_REVOKED', 'host rejected');
      const pathname = new URL(req.url, baseUrl).pathname;
      if (req.method === 'GET' && (pathname === '/viewer.js' || /^\/handoff\/[A-Za-z0-9_-]{1,80}$/.test(pathname))) {
        const js = pathname === '/viewer.js';
        res.writeHead(200, { 'content-type': js ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
        res.end(fs.readFileSync(path.join(VIEWER_ROOT, js ? 'viewer.js' : 'index.html'))); return;
      }
      const match = pathname.match(/^\/v1\/handoffs\/([A-Za-z0-9_-]{1,80})(?:\/([a-z]+))?$/);
      if (!match) { send(res, 404, { ok: false }); return; }
      const [, handoffId, action = ''] = match, c = coord();
      if (req.method === 'POST' && action === 'redeem') {
        if (req.headers.origin !== baseUrl || !tokens.originAllowed(req, baseUrl)) throw H.v2Error('ACCESS_REVOKED', 'origin rejected');
        if (tokens.blocked(handoffId)) throw H.v2Error('ACCESS_REVOKED', 'too many attempts');
        const body = await readBody(req);
        const rec = c.get(handoffId); c.assertLive(rec);
        if (owner) {
          const supplied = crypto.createHash('sha256').update(String(body.ownerToken || '')).digest();
          const expected = crypto.createHash('sha256').update(owner.token).digest();
          if (rec.principalId !== owner.principalId || !crypto.timingSafeEqual(supplied, expected)) {
            tokens.noteFailure(handoffId); throw H.v2Error('ACCESS_REVOKED', 'owner authentication rejected');
          }
        } else {
          try { c.redeem(handoffId, body.code); } catch (err) { tokens.noteFailure(handoffId); throw err; }
        }
        tokens.clearFailures(handoffId);
        const view = tokens.issue(handoffId, { mode: 'observe' });
        view.ownerId = owner?.id || rec.principalId; view.lastSeen = clock.now();
        send(res, 200, { ok: true, value: { handoffId, mode: 'observe' } }, { 'set-cookie': tokens.setCookieHeader(view) }); return;
      }
      const view = req.method === 'POST' ? tokens.assertWrite(req, baseUrl) : tokens.read(req);
      const { rec, session } = live(view, handoffId, { allowClosed: !action || action === 'resume' });
      if (req.method === 'GET' && !action) {
        send(res, 200, { ok: true, value: c.status(handoffId, {}) }); return;
      }
      if (req.method === 'GET' && action === 'frame') {
        send(res, 200, { ok: true, value: await frameFor(rec, session, view) }); return;
      }
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return; }
      const body = await readBody(req);
      if (owner && (typeof body.viewerInstanceId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(body.viewerInstanceId))) throw H.v2Error('ACCESS_REVOKED', 'viewer instance required');
      const value = await c.withLock(session.sessionId, () => c.writeOnce(rec, {
        principalId: view.id, requestKey: body.requestKey, expectedControlEpoch: body.expectedControlEpoch,
        action, payload: body,
      }, async () => {
        if (action === 'acquire') {
          if (view.clientInstance && view.clientInstance !== body.viewerInstanceId && rec.state === 'human') throw H.v2Error('CONTROL_BUSY', 'another tab holds control');
          c.acquire(handoffId, { viewerInstance: view.id, expectedControlEpoch: body.expectedControlEpoch });
          const acquired = c.markAcquired(rec, session, view.id); view.clientInstance = body.viewerInstanceId; view.mode = 'control'; view.lastSeen = clock.now(); return acquired;
        }
        if (owner && rec.state === 'human' && view.clientInstance !== body.viewerInstanceId) throw H.v2Error('CONTROL_BUSY', 'another tab holds control');
        if (rec.viewerInstance !== view.id && action !== 'resume' && !(owner && action === 'cancel')) throw H.v2Error('ACCESS_REVOKED', 'controlling viewer required');
        if (action === 'release') { view.mode = 'observe'; return c.release(rec, session); }
        if (action === 'private') { frames.clear(); return body.enabled === false ? c.endPrivate(rec, session) : c.beginPrivate(rec, session); }
        if (action === 'input') return input(rec, session, view, body);
        if (action === 'cancel') {
          const principal = { id: session.ownerId, kind: 'mcp', scopes: [] };
          if (rec.runId) await broker.cancelRun({ runId: rec.runId }, { principal });
          if (session.lease.owner === 'human') c.release(rec, session);
          c.revoke(handoffId); tokens.revokeHandoff(handoffId); frames.clear(); return { cancelled: true };
        }
        if (action === 'resume') {
          if (session.privateReadBlocked) throw H.v2Error('RECONCILIATION_REQUIRED', 'Private content could not be tracked safely; close this browser context before continuing.');
          if (rec.blocker === 'RECONCILIATION_REQUIRED') throw H.v2Error('RECONCILIATION_REQUIRED', 'input outcome must be reconciled');
          if (rec.viewerInstance && rec.viewerInstance !== view.id) throw H.v2Error('CONTROL_BUSY', 'another viewer holds control');
          if (session.lease.owner === 'human') c.release(rec, session);
          if (session.privateInput) c.endPrivate(rec, session);
          const page = session.page(rec.pageId);
          // Fresh authoritative read must settle before issuing a grant. No blocked action is replayed here.
          const epoch = page.documentEpoch;
          await page.driverPage.observe({ maxNodes: 1 });
          if (epoch !== page.documentEpoch) throw H.v2Error('RECONCILIATION_REQUIRED', 'document changed during return');
          c.authorizeResume(rec, session, { principalId: view.ownerId, consumerId: session.ownerId,
            runId: rec.runId, expectedControlEpoch: rec.controlEpoch });
          return broker.resumeRun({ handoffId, runId: rec.runId, expectedControlEpoch: rec.controlEpoch, requestKey: body.requestKey },
            { principal: { id: session.ownerId, kind: 'mcp', scopes: [] } });
        }
        throw H.v2Error('ACCESS_REVOKED', 'unsupported action');
      }));
      send(res, 200, { ok: true, value });
    } catch (err) { fail(res, err); }
  }
  function listen() {
    server = http.createServer((req, res) => { handle(req, res).catch((err) => fail(res, err)); });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 30;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        baseUrl = `http://${host}:${server.address().port}`;
        broker.attachViewer({ enabled: true, baseUrl, deployment: 'local' });
        timer = setInterval(() => {
          for (const [id, view] of tokens.entries()) {
            if (!view || clock.now() - view.lastSeen > heartbeatMs) {
              frames.delete(id);
              if (view) {
                const rec = coord().get(view.handoffId), session = broker._internals.sessions.get(rec?.sessionId);
                if (session && rec.state === 'human' && rec.viewerInstance === id) {
                  void coord().withLock(session.sessionId, () => {
                    if (rec.state === 'human' && rec.viewerInstance === id) coord().release(rec, session);
                  });
                }
                tokens.revoke(id);
              }
            }
          }
        }, Math.max(100, heartbeatMs / 3)); timer.unref();
        resolve(baseUrl);
      });
    });
  }
  async function close() { clearInterval(timer); frames.clear(); if (server) await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  return { listen, close, get baseUrl() { return baseUrl; }, auth: tokens };
}
module.exports = { createViewerGateway };
