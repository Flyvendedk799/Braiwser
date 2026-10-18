// Operation context: the identity an async operation captured when it STARTED.
//
// Every long-running renderer operation (replay, record, audit, verify,
// screenshot, restore pins, note capture) used to read the mutable "active tab /
// current session" globals after each await, so a tab or session switch in the
// middle sent work to — or saved evidence into — the wrong place. An operation
// instead captures a context once and asks isCurrent()/staleReason() before it
// applies any result.
//
// Pure ESM, no DOM: the host (app.js) supplies lookups, tests supply fakes.
//
//   ctx = { runId, kind, tabId, wv, docGen, url, sessionId, sessionEpoch, startedAt }
//
// `docGen` is the tab's document generation (bumped by the host on every new
// document), `sessionEpoch` is bumped by the host whenever the current session
// or project changes (open/close/delete/switch), so "same session id, but
// reopened" is also detected where it matters.

let runSeq = 0;
export const nextRunId = (kind = 'op') => `${kind}-${++runSeq}-${Date.now().toString(36)}`;

export function createOperationContexts({ getTab, getActiveTabId, getSession, getSessionEpoch, now = Date.now }) {
  const sessionEpoch = () => (typeof getSessionEpoch === 'function' ? getSessionEpoch() : 0);

  // Capture the context of the ACTIVE tab (or an explicit one) right now.
  function capture(kind, { tabId, includeSession = true } = {}) {
    const id = tabId || getActiveTabId();
    const tab = id ? getTab(id) : null;
    const session = includeSession ? getSession() : null;
    return Object.freeze({
      runId: nextRunId(kind),
      kind,
      tabId: tab ? tab.id : null,
      wv: tab ? tab.wv : null,
      docGen: tab ? tab.docGen || 0 : 0,
      documentId: tab ? tab.documentId || '' : '', // guest-reported identity (caos:ready); '' until known
      url: tab ? tab.url || '' : '',
      title: tab ? tab.title || '' : '',
      sessionId: session ? session.id : null,
      sessionEpoch: includeSession ? sessionEpoch() : null,
      startedAt: now(),
    });
  }

  // Returns null when the context still holds, or a short reason string.
  //   tab:      the tab must still exist (default true)
  //   doc:      the tab must still show the same document (default false)
  //   session:  the current session must still be the captured one (default false)
  //   active:   the tab must still be the visible tab (default false)
  function staleReason(ctx, { tab = true, doc = false, session = false, active = false } = {}) {
    if (!ctx) return 'no context';
    if (tab || doc || active) {
      const t = ctx.tabId ? getTab(ctx.tabId) : null;
      if (!t || t.wv !== ctx.wv || t.closed) return 'the tab was closed';
      if (doc && (t.docGen || 0) !== ctx.docGen) return 'the page navigated';
      // The guest's own document id wins when both sides know it.
      if (doc && ctx.documentId && t.documentId && t.documentId !== ctx.documentId) return 'the page navigated';
      if (active && getActiveTabId() !== ctx.tabId) return 'the tab is no longer in front';
    }
    if (session) {
      const cur = getSession();
      if ((cur ? cur.id : null) !== ctx.sessionId) return 'the session changed';
      if (sessionEpoch() !== ctx.sessionEpoch) return 'the session was reopened';
    }
    return null;
  }

  const isCurrent = (ctx, opts) => staleReason(ctx, opts) === null;

  return { capture, staleReason, isCurrent };
}

// Latest-wins guard for a repeatable request (loading a session's notes,
// restoring pins, syncing a title): `begin()` returns a token; `valid(token)` is
// true only for the newest token. Starting a new request invalidates the old.
export function createGeneration() {
  let n = 0;
  return {
    begin: () => ++n,
    valid: (token) => token === n,
    invalidate: () => { n += 1; },
    current: () => n,
  };
}

// Run `fn`, but exactly one at a time per key; later callers get the same
// promise (a single-flight guard, e.g. one Verify at a time).
export function createSingleFlight() {
  const inflight = new Map();
  return {
    run(key, fn) {
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
      inflight.set(key, p);
      return p;
    },
    active: (key) => inflight.has(key),
  };
}

// Per-owner cache for results that belong to a session or a tab (notes of
// session A must never be shown for session B). Keys are owner ids.
export function createOwnerCache() {
  const map = new Map();
  return {
    get: (owner) => map.get(owner),
    set: (owner, value) => { map.set(owner, value); return value; },
    has: (owner) => map.has(owner),
    delete: (owner) => map.delete(owner),
    clear: () => map.clear(),
    update: (owner, fn) => { const v = fn(map.get(owner)); map.set(owner, v); return v; },
  };
}
