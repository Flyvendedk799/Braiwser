// Viewer authentication. A handoff id is not a credential. Redemption exchanges
// a one-time code for an HttpOnly session; later writes also require a CSRF
// header and a matching Origin. Localhost is not authentication.
'use strict';
const crypto = require('node:crypto');

const COOKIE = 'braiwser_session';
const CSRF_COOKIE = 'braiwser_csrf';

function createViewerAuth({ clock = { now: () => Date.now() }, ttlMs = 30 * 60 * 1000, maxFailures = 8 } = {}) {
  const sessions = new Map();
  const failures = new Map();

  function cookie(header, name) {
    const parts = String(header || '').split(';');
    for (const part of parts) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }

  function originAllowed(req, baseUrl) {
    let expected;
    try { expected = new URL(baseUrl).origin; } catch { return false; }
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    if (origin && origin !== expected) return false;
    try {
      const hostUrl = new URL(`${new URL(baseUrl).protocol}//${host}`);
      if (hostUrl.host !== new URL(baseUrl).host) return false;
    } catch { return false; }
    return true;
  }

  function issue(handoffId, { mode = 'observe' } = {}) {
    const id = crypto.randomBytes(24).toString('base64url');
    const csrf = crypto.randomBytes(18).toString('base64url');
    const rec = { id, csrf, handoffId, mode, expiresAt: clock.now() + ttlMs };
    sessions.set(id, rec);
    return rec;
  }

  function read(req) {
    const id = cookie(req.headers.cookie, COOKIE);
    const rec = id && sessions.get(id);
    if (!rec || clock.now() > rec.expiresAt) {
      if (rec) sessions.delete(rec.id);
      return null;
    }
    return rec;
  }

  function revoke(id) { sessions.delete(id); }
  function revokeHandoff(handoffId) {
    for (const [id, rec] of sessions) if (rec.handoffId === handoffId) sessions.delete(id);
  }

  function assertWrite(req, baseUrl) {
    if (!originAllowed(req, baseUrl)) {
      const err = new Error('ACCESS_REVOKED: origin was rejected');
      err.v2Code = 'ACCESS_REVOKED';
      throw err;
    }
    const rec = read(req);
    if (!rec) {
      const err = new Error('ACCESS_REVOKED: viewer session is missing');
      err.v2Code = 'ACCESS_REVOKED';
      throw err;
    }
    const header = String(req.headers['x-braiwser-csrf'] || '');
    const cookieToken = cookie(req.headers.cookie, CSRF_COOKIE);
    if (!header || header !== rec.csrf || header !== cookieToken) {
      const err = new Error('ACCESS_REVOKED: CSRF check failed');
      err.v2Code = 'ACCESS_REVOKED';
      throw err;
    }
    return rec;
  }

  function noteFailure(key) {
    const n = (failures.get(key) || 0) + 1;
    failures.set(key, n);
    return n >= maxFailures;
  }
  function clearFailures(key) { failures.delete(key); }
  function blocked(key) { return (failures.get(key) || 0) >= maxFailures; }

  function setCookieHeader(rec, { secure = false } = {}) {
    const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
    const csrfFlags = `Path=/; SameSite=Strict${secure ? '; Secure' : ''}`;
    return [
      `${COOKIE}=${encodeURIComponent(rec.id)}; ${flags}`,
      `${CSRF_COOKIE}=${encodeURIComponent(rec.csrf)}; ${csrfFlags}`,
    ];
  }

  return { issue, read, revoke, revokeHandoff, assertWrite, originAllowed, noteFailure, clearFailures, blocked, setCookieHeader, COOKIE, CSRF_COOKIE };
}

module.exports = { createViewerAuth };
