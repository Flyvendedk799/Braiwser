// Ownership / dispatch kernel for one browser page, plus the session-level
// single-writer lease. Ported from the audit's reference kernel (section A) and
// extended with: SessionLease (human takeover revokes agent dispatch on EVERY
// page of the session, with a fencing epoch), journal hooks (durable ledger
// points committed BEFORE input is emitted), bounded handoff drain, and
// ownership recheck helpers. Pure Node; no Electron import.
//
// Guarantees (each has a test in test/agent-runtime/owned-page.test.js):
//   - one action at a time per page (serial lane);
//   - idempotency by operationId + canonical command digest;
//   - a deadline is a RESULT deadline: the lane barrier follows the real driver
//     promise and the page is quarantined, never released early;
//   - evidence is distrusted unless a trusted validator accepts it; navigation
//     completion needs a trusted synchronous transition validator (default deny);
//   - receipts are deep-frozen copies;
//   - handoff drains the lane, bumps the epoch, and refuses uncertainty unless
//     the trusted caller acknowledges it.
'use strict';
const { createHash } = require('node:crypto');

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
};
const freezeDeep = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};
const defaultDigest = (cmd) => createHash('sha256').update(JSON.stringify(canonical(cmd))).digest('hex');

// ---------------------------------------------------------------------------
class SessionLease {
  constructor({ sessionId }) {
    this.sessionId = sessionId;
    this.owner = 'agent'; // agent | handoff-pending | human
    this.fence = 0; // fencing epoch: bumped on every ownership change
    this.pages = new Map();
    this.handoffs = [];
  }

  register(page) {
    this.pages.set(page.pageId, page);
    // A page that appears while a human holds the session is human-owned too.
    if (this.owner !== 'agent' && page.owner === 'agent') page.owner = this.owner === 'human' ? 'human' : 'handoff-pending';
  }

  unregister(pageId) { this.pages.delete(pageId); }

  isAgent() { return this.owner === 'agent'; }

  // Called by pages on every dispatch check. `fence` is the value captured when
  // the command was accepted.
  assertWriter(fence) {
    if (this.owner !== 'agent' || (fence !== undefined && fence !== this.fence)) throw fail('OWNERSHIP_LOST');
  }

  // Revoke agent writes on all pages, drain every lane, then grant the human.
  //   acknowledgeUncertain: trusted-shell only; a quarantined page whose real
  //   driver barrier has settled may be handed to the human (who reconciles).
  //   drainTimeoutMs: a hung driver cannot be drained; refuse rather than give
  //   the human a screen while late agent input may still arrive.
  async takeOver({ acknowledgeUncertain = false, drainTimeoutMs = 5000 } = {}) {
    if (this.owner !== 'agent') throw fail('NOT_HANDOFF_READY');
    this.owner = 'handoff-pending';
    this.fence += 1;
    const pages = [...this.pages.values()];
    const wasAgent = new Set();
    for (const p of pages) {
      if (p.owner === 'agent') { wasAgent.add(p); p.owner = 'handoff-pending'; }
      if (p.active) p.active.abort('HANDOFF_REQUESTED');
    }
    let drainTimer;
    const drained = await Promise.race([
      Promise.all(pages.map((p) => p.tail)).then(() => true),
      new Promise((resolve) => { drainTimer = setTimeout(() => resolve(false), drainTimeoutMs); }),
    ]);
    clearTimeout(drainTimer);
    const quarantined = pages.filter((p) => p.owner === 'quarantined');
    if (!drained || (quarantined.length && !acknowledgeUncertain)) {
      // Refuse. Pages whose lane is hung or holds uncertainty stay quarantined;
      // idle pages that we only paused go back to the agent. The fence moves
      // again so nothing queued during the attempt can slip through.
      for (const p of wasAgent) if (p.owner === 'handoff-pending') p.owner = 'agent';
      this.owner = 'agent';
      this.fence += 1;
      throw fail(drained ? 'RECONCILE_BEFORE_HANDOFF' : 'DRAIN_TIMEOUT');
    }
    const epochs = {};
    for (const p of pages) {
      if (p.owner === 'handoff-pending' || p.owner === 'quarantined') {
        p.uncertainAtHandoff = p.owner === 'quarantined' || p.uncertainAtHandoff;
        p.owner = 'human';
      }
      p.documentEpoch += 1;
      epochs[p.pageId] = p.documentEpoch;
    }
    this.owner = 'human';
    this.fence += 1;
    this.handoffs.push({ at: Date.now(), fence: this.fence });
    return { owner: 'human', fence: this.fence, epochs, uncertain: pages.some((p) => p.uncertainAtHandoff) };
  }

  // Only a verified, authenticated local UI resume request may call this.
  resume() {
    if (this.owner !== 'human') throw fail('NOT_HUMAN_OWNED');
    const epochs = {};
    for (const p of this.pages.values()) {
      if (p.owner === 'human') p.owner = 'agent';
      p.documentEpoch += 1;
      epochs[p.pageId] = p.documentEpoch;
    }
    this.owner = 'agent';
    this.fence += 1;
    return { owner: 'agent', fence: this.fence, epochs, requireFreshObservation: true };
  }
}

// ---------------------------------------------------------------------------
class OwnedPage {
  constructor({
    sessionId, pageId, execute, maxOperations = 1000,
    validateEvidence = () => false, acceptTransition = () => false,
    lease = null, journal = null, digest = defaultDigest,
  }) {
    this.sessionId = sessionId;
    this.pageId = pageId;
    this.documentEpoch = 0;
    this.owner = 'agent';
    this.execute = execute;
    this.validateEvidence = validateEvidence;
    this.acceptTransition = acceptTransition;
    this.maxOperations = maxOperations;
    this.digest = digest;
    this.journal = journal; // optional sync hooks: accept / dispatchStarted / result
    this.lease = lease;
    this.operations = new Map();
    this.tail = Promise.resolve();
    this.active = null;
    this.uncertainAtHandoff = false;
    if (lease) lease.register(this);
  }

  navigated() { this.documentEpoch += 1; }

  // Used for a browser crash, debugger loss, or an unresolved external effect.
  quarantine(reason = 'PAGE_QUARANTINED') {
    this.owner = 'quarantined';
    if (this.active) this.active.abort(reason);
  }

  // Ownership recheck helper usable by brokers/drivers between awaits.
  // Returns the failing code or null.
  ownershipProblem(fence) {
    if (this.owner !== 'agent') return 'OWNERSHIP_LOST';
    if (this.lease) {
      try { this.lease.assertWriter(fence); } catch (e) { return e.code; }
    }
    return null;
  }

  assertOwnership(fence) {
    const code = this.ownershipProblem(fence);
    if (code) throw fail(code);
  }

  // Read-only work that must not run while a human (or nobody) holds the page.
  // Does not queue behind the lane (a quarantined lane may never settle) and is
  // not atomic with in-flight input: it reports the epoch it started in, and
  // fails if the document changed meanwhile.
  async read(fn, { allowQuarantined = true } = {}) {
    const fence = this.lease ? this.lease.fence : undefined;
    const ok = this.owner === 'agent' || (allowQuarantined && this.owner === 'quarantined');
    if (!ok || (this.lease && !this.lease.isAgent())) throw fail('OWNERSHIP_LOST');
    const epoch = this.documentEpoch;
    const value = await fn({ documentEpoch: epoch });
    if (this.documentEpoch !== epoch) throw fail('STALE_DOCUMENT');
    if (this.lease && this.lease.fence !== fence) throw fail('OWNERSHIP_LOST');
    return { value, documentEpoch: epoch };
  }

  act(input, { timeoutMs = 15000, signal } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail('INVALID_TIMEOUT');
    // Commands are validated JSON by the API boundary. Clone to prevent a
    // caller mutating a queued command after its hash and authorization check.
    const cmd = JSON.parse(JSON.stringify(input));
    if (!cmd.operationId || cmd.sessionId !== this.sessionId || cmd.pageId !== this.pageId) {
      throw fail('WRONG_SCOPE');
    }
    const digest = this.digest(cmd);
    const prior = this.operations.get(cmd.operationId);
    if (prior) {
      if (prior.digest !== digest) throw fail('IDEMPOTENCY_CONFLICT');
      return prior.promise;
    }
    // Never evict mutation IDs silently. Rotate/close the session or move older
    // receipts to its persistent ledger when capacity is reached.
    if (this.operations.size >= this.maxOperations) throw fail('OPERATION_CAPACITY');

    // Durable idempotency: an operation the ledger already knows (including
    // across a restart) returns its recorded outcome and is NEVER re-run.
    if (this.journal) {
      const known = this.journal.accept(cmd, digest);
      if (known && known.receipt) {
        const done = Promise.resolve(freezeDeep(JSON.parse(JSON.stringify(known.receipt))));
        this.operations.set(cmd.operationId, { digest, promise: done });
        return done;
      }
    }

    const fence = this.lease ? this.lease.fence : undefined;
    let deliver;
    const promise = new Promise((resolve) => { deliver = resolve; });
    let settled = false;
    let dispatched = false;
    let started = false;
    const finish = (receipt) => {
      if (settled) return;
      let immutable;
      try {
        // Copy before freezing: never freeze an object owned by a driver/caller.
        immutable = JSON.parse(JSON.stringify({
          operationId: cmd.operationId, sessionId: this.sessionId, pageId: this.pageId,
          ...receipt, dispatched, effectUnknown: receipt.status === 'uncertain',
        }));
      } catch {
        immutable = { operationId: cmd.operationId, sessionId: this.sessionId, pageId: this.pageId,
          status: dispatched ? 'uncertain' : 'not_attempted', code: 'UNSERIALIZABLE_RESULT',
          dispatched, effectUnknown: dispatched };
      }
      if (this.journal) {
        try { this.journal.result(cmd, immutable); } catch (error) {
          // The outcome could not be made durable: never claim more than we can prove.
          immutable = { operationId: cmd.operationId, sessionId: this.sessionId, pageId: this.pageId,
            status: dispatched ? 'uncertain' : 'not_attempted', code: error.code || 'LEDGER_WRITE_FAILED',
            dispatched, effectUnknown: dispatched };
          if (dispatched) this.owner = 'quarantined';
        }
      }
      settled = true;
      deliver(freezeDeep(immutable));
    };
    const controller = new AbortController();
    const abort = (reason) => {
      if (settled) return;
      controller.abort(reason);
      // Even when dispatch has not happened yet, an asynchronous driver call
      // may be in flight. Reject further work until the supervisor reconciles.
      if (started) this.owner = 'quarantined';
      finish({ status: dispatched ? 'uncertain' : 'not_attempted', code: reason });
    };
    const onAbort = () => abort('CANCELLED');
    const timer = setTimeout(() => abort('DEADLINE_EXCEEDED'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.operations.set(cmd.operationId, { digest, promise });

    const run = async () => {
      if (settled) return;
      started = true;
      this.active = { abort };
      const check = () => {
        if (controller.signal.aborted) throw fail('CANCELLED');
        if (this.owner !== 'agent') throw fail('OWNERSHIP_LOST');
        if (this.lease) this.lease.assertWriter(fence);
        if (cmd.documentEpoch !== this.documentEpoch) throw fail('STALE_DOCUMENT');
      };
      try {
        check();
        const result = await this.execute(cmd, {
          signal: controller.signal,
          check,
          // Call immediately before each actual input/protocol mutation,
          // after all awaited resolution, hit testing and approval checks.
          // The ledger point dispatch_started is committed (fsync) here; if it
          // cannot be, input is NOT emitted.
          beforeDispatch: () => {
            check();
            if (this.journal) this.journal.dispatchStarted(cmd);
            dispatched = true;
          },
        });
        if (!dispatched) throw fail('DRIVER_DID_NOT_DISPATCH');
        if (this.owner !== 'agent') throw fail('OWNERSHIP_LOST');
        if (this.lease) this.lease.assertWriter(fence);
        const currentScope = { sessionId: this.sessionId, pageId: this.pageId, documentEpoch: this.documentEpoch };
        // A navigation action needs a trusted, explicit transition validator.
        // An arbitrary successful reply from a new page is not completion.
        if (cmd.documentEpoch !== this.documentEpoch
          && this.acceptTransition(cmd, result, currentScope) !== true) {
          throw fail('COMPLETION_SCOPE_CHANGED');
        }
        const verified = result?.status === 'verified' && Array.isArray(result.evidence)
          && result.evidence.length > 0
          && this.validateEvidence(cmd, result, currentScope) === true;
        finish({ status: verified ? 'verified' : 'dispatched', evidence: result?.evidence || [],
          ...(!verified && typeof result?.code === 'string' ? { code: result.code.slice(0, 80) } : {}) });
      } catch (error) {
        if (dispatched) this.owner = 'quarantined';
        finish({ status: dispatched ? 'uncertain' : 'not_attempted', code: error.code || 'DRIVER_FAILED' });
      } finally {
        this.active = null;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };
    // The barrier follows the REAL driver promise, not the deadline receipt.
    // A timeout can return quickly, but can never let a late click overlap the
    // next command. All late rejections are consumed by run's catch.
    this.tail = this.tail.then(run, run);
    promise.then(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
    return promise;
  }

  // Single-page handoff. With a session lease the WHOLE session is revoked.
  async handoff(options = {}) {
    if (this.lease) {
      const r = await this.lease.takeOver(options);
      return { owner: this.owner, documentEpoch: this.documentEpoch, fence: r.fence };
    }
    if (this.owner !== 'agent') throw fail('NOT_HANDOFF_READY');
    this.owner = 'handoff-pending';
    if (this.active) this.active.abort('HANDOFF_REQUESTED');
    await this.tail;
    // Any mutation cancelled in flight needs effect reconciliation before
    // granting human control. Handoff cannot silently erase uncertainty.
    if (this.owner === 'quarantined') throw fail('RECONCILE_BEFORE_HANDOFF');
    this.owner = 'human';
    this.documentEpoch += 1;
    return { owner: this.owner, documentEpoch: this.documentEpoch };
  }

  // Only a verified, authenticated local UI resume request may call this.
  resume() {
    if (this.lease) {
      this.lease.resume();
      return { owner: this.owner, documentEpoch: this.documentEpoch, requireFreshObservation: true };
    }
    if (this.owner !== 'human') throw fail('NOT_HUMAN_OWNED');
    this.documentEpoch += 1;
    this.owner = 'agent';
    return { owner: this.owner, documentEpoch: this.documentEpoch, requireFreshObservation: true };
  }
}

module.exports = { OwnedPage, SessionLease, canonical, freezeDeep, defaultDigest };
