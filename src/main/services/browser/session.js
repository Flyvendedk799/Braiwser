// BrowserSession: one browser context/profile. Owns the single-writer lease,
// the registered pages (each an OwnedPage lane + DriverPage), and the
// SERVER-SIDE reference registry. Refs are opaque ids that resolve ONLY here to
// {sessionId, pageId, documentEpoch, observationId, frameId, nodeIdentity}; they
// are never resolved globally and never accepted from another session/page.
'use strict';
const C = require('../../../shared/browser-contracts');
const { OwnedPage, SessionLease } = require('./owned-page');

const MAX_OBSERVATIONS_PER_PAGE = 8;
const MAX_REFS_PER_PAGE = 5000;
const MAX_CURSORS_PER_PAGE = 50;

class PageRecord {
  constructor({ session, pageId, driverPage, ownedOptions, opener = null }) {
    this.session = session;
    this.pageId = pageId;
    this.driverPage = driverPage;
    this.opener = opener;
    this.closed = false;
    this.refs = new Map();
    this.observations = new Map();
    this.cursors = new Map();
    this.currentUrl = null;
    this.owned = new OwnedPage({ sessionId: session.sessionId, pageId, lease: session.lease, ...ownedOptions });
  }

  get documentEpoch() { return this.owned.documentEpoch; }

  // Navigation, takeover, resume, crash: every outstanding ref/cursor dies.
  invalidate() {
    this.refs.clear();
    this.cursors.clear();
    for (const o of this.observations.values()) { o.nodes = null; o.stale = true; }
  }

  addObservation({ observationId, documentEpoch, nodes, driverNextCursor, now }) {
    const refIds = [];
    for (const n of nodes) {
      if (this.refs.size >= MAX_REFS_PER_PAGE) { const first = this.refs.keys().next().value; this.refs.delete(first); }
      const ref = C.newId('ref');
      this.refs.set(ref, {
        ref, sessionId: this.session.sessionId, pageId: this.pageId, documentEpoch, observationId,
        frameId: n.frameId || null, driverRefId: n.refId, role: n.role, name: n.name, traits: Array.isArray(n.traits) ? n.traits.slice(0, 12) : [],
        nodeIdentity: C.sha256({ f: n.frameId || null, r: n.role, n: n.name, d: n.refId }).slice(0, 24), createdAt: now,
      });
      refIds.push(ref);
    }
    this.observations.set(observationId, { observationId, documentEpoch, refIds, nodes: null, driverNextCursor: driverNextCursor || null, createdAt: now, stale: false });
    while (this.observations.size > MAX_OBSERVATIONS_PER_PAGE) {
      const [oldId, old] = this.observations.entries().next().value;
      this.observations.delete(oldId);
      for (const r of old.refIds) this.refs.delete(r);
    }
    return refIds;
  }

  // Throws STALE_REF for anything that is not exactly the current, unexpired,
  // same-session/page/epoch/observation reference.
  resolveRef(ref, { observationId, documentEpoch, now, ttlMs }) {
    const stale = (why) => C.brokerError('STALE_REF', `reference is no longer valid (${why}); observe again`, { retry: 'refresh', detail: 'STALE_REF' });
    const rec = this.refs.get(ref);
    if (!rec) throw stale('unknown');
    if (rec.sessionId !== this.session.sessionId || rec.pageId !== this.pageId) throw stale('scope');
    if (rec.documentEpoch !== this.owned.documentEpoch || rec.documentEpoch !== documentEpoch) throw stale('document changed');
    if (observationId && rec.observationId !== observationId) throw stale('observation');
    if (now - rec.createdAt > ttlMs) throw stale('expired');
    return rec;
  }

  mintCursor(spec, now, ttlMs) {
    if (this.cursors.size >= MAX_CURSORS_PER_PAGE) this.cursors.delete(this.cursors.keys().next().value);
    const id = C.newId('cursor');
    this.cursors.set(id, { ...spec, documentEpoch: this.owned.documentEpoch, expiresAt: now + ttlMs });
    return id;
  }
  takeCursor(id, now) {
    const c = this.cursors.get(id);
    if (!c || now > c.expiresAt || c.documentEpoch !== this.owned.documentEpoch) throw C.brokerError('STALE_REF', 'cursor is no longer valid; observe again', { retry: 'refresh', detail: 'STALE_CURSOR' });
    return c;
  }
}

class BrowserSession {
  constructor({ sessionId, ownerId, driverName, mode, grant, reviewSessionId = null, capabilities, driverSession, adhocRunId }) {
    this.sessionId = sessionId;
    this.ownerId = ownerId;
    this.driverName = driverName;
    this.mode = mode;
    this.grant = grant;
    this.reviewSessionId = reviewSessionId;
    this.capabilities = capabilities;
    this.driverSession = driverSession;
    this.adhocRunId = adhocRunId; // evidence container for operations outside a run
    this.lease = new SessionLease({ sessionId });
    this.pages = new Map();
    this.runs = new Set();
    this.closed = false;
    this.createdAt = Date.now();
    this.handoffLog = [];
  }

  addPage({ pageId, driverPage, ownedOptions, opener }) {
    const rec = new PageRecord({ session: this, pageId, driverPage, ownedOptions, opener });
    this.pages.set(pageId, rec);
    return rec;
  }
  page(pageId) {
    const p = this.pages.get(pageId);
    if (!p || p.closed) throw C.brokerError('DENIED', 'unknown page', { detail: 'UNKNOWN_PAGE' });
    return p;
  }
  removePage(pageId) {
    const p = this.pages.get(pageId);
    if (!p) return;
    p.closed = true;
    p.invalidate();
    this.lease.unregister(pageId);
    this.pages.delete(pageId);
  }
  invalidateAll() { for (const p of this.pages.values()) p.invalidate(); }
}

module.exports = { BrowserSession, PageRecord, MAX_OBSERVATIONS_PER_PAGE };
