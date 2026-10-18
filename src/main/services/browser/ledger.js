// Durable, single-writer operation journal for the agent browser runtime.
//
//   - Append-only JSONL, fsync after every record, strictly increasing sequence.
//   - Each record carries prev/hash: sha256(prev + canonical(record body)). The
//     chain detects torn writes and accidental corruption. It is NOT tamper-proof:
//     someone who can rewrite the file can rewrite the chain.
//   - Journal points per operation: accepted -> dispatch_started -> result_recorded.
//     dispatch_started is committed (fsync) BEFORE any browser input is emitted
//     (OwnedPage.beforeDispatch calls it synchronously).
//   - Unique (sessionId, operationId) with an HMAC command hash. The same id with
//     a different command is IDEMPOTENCY_CONFLICT. HMAC key is local-only so
//     short secret inputs cannot be dictionary-attacked from the hash.
//   - Restart: operations without a result become `not_attempted` (never
//     dispatched) or `uncertain` (dispatch_started, no result). They are NEVER
//     replayed. Sessions open at crash time are closed with reason `restart`.
//   - Corrupt tail: the valid prefix is kept, the bad bytes are copied to a
//     `.corrupt-<ts>` file, and the file is truncated. A missing file (ENOENT)
//     is a fresh journal; any other read error is fatal (never treated as empty).
//   - One process writes: an exclusive lock file with pid liveness check.
//   - Bounded retention: compaction re-emits retained records behind a checkpoint.
'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson } = require('../../../shared/browser-contracts');
const { redactText, redactUrl } = require('../../../shared/browser-redact');

const GENESIS = '0'.repeat(64);
const HELD = new Map(); // lock path -> JournalFile (this process)
const lerr = (code, message) => Object.assign(new Error(message || code), { code });

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const chainHash = (prev, body) => crypto.createHash('sha256').update(prev + '\n' + canonicalJson(body)).digest('hex');

class JournalFile {
  constructor(file, { fs = nodeFs, maxBytes = 64 * 1024 * 1024, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.fs = fs;
    this.maxBytes = maxBytes;
    this.lockFile = file + '.lock';
    this.fd = null;
    this.seq = 0;
    this.prev = GENESIS;
    this.poisoned = null;
    this.recovery = null;
    this.size = 0;
  }

  _lock() {
    const fs = this.fs;
    if (HELD.has(this.lockFile)) throw lerr('LEDGER_LOCKED', 'journal is open in this process');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(8).toString('hex') }));
        fs.closeSync(fd);
        HELD.set(this.lockFile, this);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw lerr('LEDGER_UNAVAILABLE', `lock: ${e.code || e.message}`);
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* unreadable lock = stale */ }
        // A live different process owns it. Our own pid but not in HELD = a
        // previous (crashed/abandoned) instance in this process.
        if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) throw lerr('LEDGER_LOCKED', `journal is locked by pid ${holder.pid}`);
        try { fs.unlinkSync(this.lockFile); } catch { /* raced */ }
      }
    }
    throw lerr('LEDGER_LOCKED', 'could not acquire journal lock');
  }

  // Returns records (valid prefix). Sets this.recovery when bytes were dropped.
  open() {
    const fs = this.fs;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._lock();
    try {
      let buf;
      try { buf = fs.readFileSync(this.file); } catch (e) {
        if (e.code !== 'ENOENT') throw lerr('LEDGER_UNREADABLE', `${e.code || e.message}`);
        buf = Buffer.alloc(0); // ENOENT: a brand-new journal
      }
      if (buf.length > this.maxBytes) throw lerr('LEDGER_TOO_LARGE', 'journal exceeds maxBytes; compaction required offline');
      const records = [];
      let offset = 0;
      let goodEnd = 0;
      let prev = GENESIS;
      let seq = 0;
      let bad = null;
      while (offset < buf.length) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl === -1) { bad = 'torn_tail'; break; }
        const line = buf.slice(offset, nl).toString('utf8');
        let rec;
        try { rec = JSON.parse(line); } catch { bad = 'bad_json'; break; }
        const body = rec && typeof rec === 'object' ? { seq: rec.seq, ts: rec.ts, type: rec.type, data: rec.data } : null;
        const first = records.length === 0;
        const okShape = body && Number.isSafeInteger(rec.seq) && typeof rec.type === 'string' && typeof rec.prev === 'string' && typeof rec.hash === 'string';
        const okLink = okShape && (first ? (rec.type === 'checkpoint' || rec.seq === 1) : (rec.seq === seq + 1 && rec.prev === prev));
        if (!okLink || chainHash(rec.prev, body) !== rec.hash) { bad = okShape ? 'chain_mismatch' : 'bad_record'; break; }
        records.push(rec);
        prev = rec.hash; seq = rec.seq; offset = nl + 1; goodEnd = offset;
      }
      if (bad) {
        const dropped = buf.slice(goodEnd);
        const aside = `${this.file}.corrupt-${Date.now()}`;
        try { fs.writeFileSync(aside, dropped); } catch { /* best effort */ }
        fs.truncateSync(this.file, goodEnd);
        const laterNl = dropped.indexOf(0x0a) !== -1 && dropped.indexOf(0x0a) < dropped.length - 1;
        this.recovery = { reason: bad, droppedBytes: dropped.length, kind: laterNl ? 'mid' : 'tail', aside: path.basename(aside), lastGoodSeq: seq };
      }
      this.seq = seq; this.prev = prev; this.size = goodEnd;
      this.fd = fs.openSync(this.file, 'a');
      return records;
    } catch (e) {
      this._release();
      throw e;
    }
  }

  append(type, data) {
    if (this.poisoned) throw lerr('LEDGER_WRITE_FAILED', `journal poisoned: ${this.poisoned}`);
    if (this.fd === null) throw lerr('LEDGER_CLOSED', 'journal is closed');
    const body = { seq: this.seq + 1, ts: this.now(), type, data };
    const rec = { ...body, prev: this.prev, hash: chainHash(this.prev, body) };
    const line = JSON.stringify(rec) + '\n';
    try {
      this.fs.writeSync(this.fd, line);
      this.fs.fsyncSync(this.fd);
    } catch (e) {
      // A partial write may be on disk: never advance, never write again until a
      // reopen has verified and truncated the tail. A rejected mutation must not
      // reappear later.
      this.poisoned = e.code || e.message;
      throw lerr('LEDGER_WRITE_FAILED', `append failed: ${this.poisoned}`);
    }
    this.seq = rec.seq; this.prev = rec.hash; this.size += Buffer.byteLength(line);
    return rec;
  }

  // Atomically replace the journal with `entries` [{type,data}] behind a checkpoint.
  rewrite(entries, meta = {}) {
    const fs = this.fs;
    if (this.poisoned) throw lerr('LEDGER_WRITE_FAILED', 'journal poisoned');
    const tmp = this.file + '.tmp';
    let seq = this.seq; let prev = this.prev;
    const lines = [];
    for (const e of [{ type: 'checkpoint', data: { ...meta, anchorHash: this.prev, anchorSeq: this.seq } }, ...entries]) {
      const body = { seq: ++seq, ts: this.now(), type: e.type, data: e.data };
      const rec = { ...body, prev, hash: chainHash(prev, body) };
      prev = rec.hash;
      lines.push(JSON.stringify(rec) + '\n');
    }
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, lines.join(''));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.closeSync(this.fd); this.fd = null;
      fs.renameSync(tmp, this.file);
      this.fd = fs.openSync(this.file, 'a');
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (this.fd === null) { try { this.fd = fs.openSync(this.file, 'a'); } catch { this.poisoned = 'reopen failed'; } }
      throw lerr('LEDGER_WRITE_FAILED', `compaction failed: ${e.code || e.message}`);
    }
    this.seq = seq; this.prev = prev; this.size = Buffer.byteLength(lines.join(''));
  }

  _release() {
    try { if (this.fd !== null) this.fs.closeSync(this.fd); } catch { /* ignore */ }
    this.fd = null;
    if (HELD.get(this.lockFile) === this) HELD.delete(this.lockFile);
  }

  close() {
    this._release();
    try { this.fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
  }

  // Test hook: behave like a process death — drop handles, leave the lock file.
  _crash() { this._release(); }
}

// ---------------------------------------------------------------------------
// Operation ledger
// ---------------------------------------------------------------------------
function createLedger({ dir, fs = nodeFs, clock = { now: () => Date.now() }, maxOperations = 20000,
  closedSessionRetentionMs = 7 * 24 * 3600 * 1000, compactAtBytes = 8 * 1024 * 1024 } = {}) {
  if (!dir) throw new TypeError('ledger dir required');
  fs.mkdirSync(dir, { recursive: true });

  // HMAC key: ENOENT creates it, any other failure is fatal.
  const keyFile = path.join(dir, 'ledger.key');
  let key;
  try { key = fs.readFileSync(keyFile); } catch (e) {
    if (e.code !== 'ENOENT') throw lerr('LEDGER_UNREADABLE', `key: ${e.code || e.message}`);
    key = crypto.randomBytes(32);
    const fd = fs.openSync(keyFile, 'wx', 0o600);
    fs.writeSync(fd, key); fs.fsyncSync(fd); fs.closeSync(fd);
  }
  if (key.length !== 32) throw lerr('LEDGER_UNREADABLE', 'ledger key is corrupt');

  const journal = new JournalFile(path.join(dir, 'ledger.jsonl'), { fs, now: () => clock.now() });
  const ops = new Map();
  const sessions = new Map();
  const opKey = (s, o) => `${s}\u0000${o}`;

  function apply(rec) {
    const d = rec.data || {};
    switch (rec.type) {
      case 'session_opened': sessions.set(d.sessionId, { ...d, state: 'open', openedAt: rec.ts }); break;
      case 'session_closed': { const s = sessions.get(d.sessionId); if (s) { s.state = 'closed'; s.closedAt = rec.ts; s.reason = d.reason; } break; }
      case 'accepted': ops.set(opKey(d.sessionId, d.operationId), { ...d, state: 'accepted', seq: rec.seq, acceptedAt: rec.ts }); break;
      case 'dispatch_started': { const o = ops.get(opKey(d.sessionId, d.operationId)); if (o) { o.state = 'dispatch_started'; o.documentEpoch = d.documentEpoch; } break; }
      case 'result_recorded': case 'recovered': {
        const o = ops.get(opKey(d.sessionId, d.operationId));
        if (o) { o.state = rec.type === 'recovered' ? 'recovered' : 'result_recorded'; o.receipt = d.receipt; o.resolvedAt = rec.ts; }
        break;
      }
      default: break; // checkpoint
    }
  }

  const records = journal.open();
  records.forEach(apply);

  // ---- crash recovery: never replay, only resolve to the truth we can prove ----
  const interrupted = [];
  for (const o of ops.values()) {
    if (o.state === 'accepted' || o.state === 'dispatch_started') {
      const dispatched = o.state === 'dispatch_started';
      const receipt = { operationId: o.operationId, sessionId: o.sessionId, pageId: o.pageId,
        status: dispatched ? 'uncertain' : 'not_attempted', code: dispatched ? 'INTERRUPTED_EFFECT_UNKNOWN' : 'INTERRUPTED',
        dispatched, effectUnknown: dispatched, evidence: [] };
      const rec = journal.append('recovered', { sessionId: o.sessionId, operationId: o.operationId, receipt, reason: 'restart' });
      apply(rec);
      interrupted.push({ sessionId: o.sessionId, operationId: o.operationId, runId: o.runId, status: receipt.status });
    }
  }
  for (const s of sessions.values()) {
    if (s.state === 'open') apply(journal.append('session_closed', { sessionId: s.sessionId, reason: 'restart' }));
  }

  function maybeCompact() {
    const now = clock.now();
    const tooBig = journal.size > compactAtBytes || ops.size > maxOperations;
    const stale = [...sessions.values()].some((s) => s.state === 'closed' && now - s.closedAt > closedSessionRetentionMs);
    if (!tooBig && !stale) return false;
    const keepSession = new Set();
    for (const s of sessions.values()) {
      if (s.state === 'open' || now - (s.closedAt || now) <= closedSessionRetentionMs) keepSession.add(s.sessionId);
    }
    // Operations whose session record is unknown are kept, never silently dropped.
    let kept = [...ops.values()].filter((o) => keepSession.has(o.sessionId) || !sessions.has(o.sessionId));
    // Over capacity: drop the oldest RESOLVED operations first; unresolved ones are never dropped.
    if (kept.length > maxOperations) {
      const resolved = kept.filter((o) => o.receipt).sort((a, b) => a.seq - b.seq);
      const drop = new Set(resolved.slice(0, kept.length - maxOperations));
      kept = kept.filter((o) => !drop.has(o));
    }
    const entries = [];
    for (const s of sessions.values()) {
      if (!keepSession.has(s.sessionId)) continue;
      const { state, openedAt, closedAt, reason, ...open } = s;
      entries.push({ type: 'session_opened', data: open });
      if (state === 'closed') entries.push({ type: 'session_closed', data: { sessionId: s.sessionId, reason } });
    }
    for (const o of kept) {
      const { state, seq, acceptedAt, resolvedAt, receipt, documentEpoch, ...acc } = o;
      entries.push({ type: 'accepted', data: acc });
      if (state !== 'accepted') entries.push({ type: 'dispatch_started', data: { sessionId: o.sessionId, operationId: o.operationId, documentEpoch } });
      if (receipt) entries.push({ type: state === 'recovered' ? 'recovered' : 'result_recorded', data: { sessionId: o.sessionId, operationId: o.operationId, receipt } });
    }
    journal.rewrite(entries, { compactedAt: now });
    ops.clear(); sessions.clear();
    for (const rec of readBack()) apply(rec);
    return true;
  }
  // Re-read our own file after compaction to rebuild indexes from durable state.
  function readBack() {
    const out = [];
    const text = fs.readFileSync(journal.file, 'utf8');
    for (const line of text.split('\n')) if (line) out.push(JSON.parse(line));
    return out;
  }
  maybeCompact();

  const commandHash = (cmd) => crypto.createHmac('sha256', key).update(canonicalJson(cmd)).digest('hex');

  // Sanitised, secret-free action summary (fill text is reduced to its length).
  function summarize(cmd) {
    const a = cmd.action || {};
    const s = { kind: String(a.kind || '').slice(0, 20) };
    if (a.kind === 'fill') s.textLength = typeof a.text === 'string' ? a.text.length : 0;
    else if (a.kind === 'navigate') s.url = redactUrl(a.url) || '[invalid]';
    else if (a.kind === 'setViewport') { s.width = Number(a.width) || 0; s.height = Number(a.height) || 0; }
    else if (a.kind === 'press') s.key = String(a.key).slice(0, 20);
    else if (a.kind === 'check') s.checked = !!a.checked;
    else if (a.kind === 'select') s.valueLength = typeof a.value === 'string' ? a.value.length : 0;
    if (cmd.target) s.target = { role: String(cmd.target.role || '').slice(0, 40), name: redactText(String(cmd.target.name || ''), 80) };
    s.documentEpoch = cmd.documentEpoch;
    return s;
  }

  const api = {
    commandHash, summarize,
    get recovery() { return journal.recovery; },
    get interrupted() { return interrupted.slice(); },
    get seq() { return journal.seq; },
    get size() { return journal.size; },
    stats() { return { operations: ops.size, sessions: sessions.size, seq: journal.seq, bytes: journal.size }; },

    sessionOpened({ sessionId, principalId, driver, mode, reviewSessionId }) {
      apply(journal.append('session_opened', { sessionId, principalId, driver, mode, reviewSessionId: reviewSessionId || null }));
    },
    sessionClosed({ sessionId, reason = 'closed' }) {
      apply(journal.append('session_closed', { sessionId, reason }));
      maybeCompact();
    },

    // Journal point 1. Returns {duplicate:false} or {duplicate:true, state, receipt?}.
    accept({ sessionId, operationId, pageId, runId = null, principalId, commandHash: hash, summary }) {
      const existing = ops.get(opKey(sessionId, operationId));
      if (existing) {
        if (existing.commandHash !== hash) throw lerr('IDEMPOTENCY_CONFLICT', 'operationId reused with a different command');
        return { duplicate: true, state: existing.state, receipt: existing.receipt ? JSON.parse(JSON.stringify(existing.receipt)) : undefined };
      }
      apply(journal.append('accepted', { sessionId, operationId, pageId, runId, principalId, commandHash: hash, summary }));
      return { duplicate: false };
    },
    // Journal point 2: must be durable BEFORE input is emitted.
    dispatchStarted({ sessionId, operationId, documentEpoch }) {
      const o = ops.get(opKey(sessionId, operationId));
      if (!o || o.state !== 'accepted') throw lerr('LEDGER_STATE', 'dispatch_started requires an accepted operation');
      apply(journal.append('dispatch_started', { sessionId, operationId, documentEpoch }));
    },
    // Journal point 3. Evidence bodies are not stored here, only their count.
    resultRecorded({ sessionId, operationId, receipt }) {
      const o = ops.get(opKey(sessionId, operationId));
      if (!o) throw lerr('LEDGER_STATE', 'unknown operation');
      if (o.receipt) return; // first result wins; terminal records are immutable
      const stored = { operationId, sessionId, pageId: receipt.pageId, status: receipt.status, code: String(receipt.code || '').slice(0, 80),
        dispatched: !!receipt.dispatched, effectUnknown: !!receipt.effectUnknown, evidence: [], evidenceCount: Array.isArray(receipt.evidence) ? receipt.evidence.length : 0 };
      if (stored.status === 'verified' && o.state !== 'dispatch_started') throw lerr('LEDGER_STATE', 'verified result without dispatch_started');
      apply(journal.append('result_recorded', { sessionId, operationId, receipt: stored }));
    },
    get(sessionId, operationId) {
      const o = ops.get(opKey(sessionId, operationId));
      return o ? JSON.parse(JSON.stringify(o)) : null;
    },
    list({ sessionId, runId } = {}) {
      return [...ops.values()].filter((o) => (!sessionId || o.sessionId === sessionId) && (!runId || o.runId === runId)).map((o) => JSON.parse(JSON.stringify(o)));
    },
    unresolved() { return [...ops.values()].filter((o) => !o.receipt).map((o) => ({ sessionId: o.sessionId, operationId: o.operationId, state: o.state })); },
    compact() { return maybeCompact(); },
    close() { journal.close(); },
    _crash() { journal._crash(); },
    _journal: journal,
  };
  return api;
}

module.exports = { createLedger, JournalFile, GENESIS, chainHash };
