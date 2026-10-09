'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLedger, JournalFile, chainHash } = require('../../src/main/services/browser/ledger');
const { OwnedPage } = require('../../src/main/services/browser/owned-page');
const { tmp } = require('./helpers');

const file = (dir) => path.join(dir, 'ledger.jsonl');
const open = (dir, o = {}) => createLedger({ dir, ...o });
const acc = (l, op = 'op1', extra = {}) => l.accept({ sessionId: 's1', operationId: op, pageId: 'p1', runId: 'run_1', principalId: 'u', commandHash: l.commandHash({ op, ...extra }), summary: { kind: 'click' } });

test('journal points are ordered and unique per (sessionId, operationId)', () => {
  const dir = tmp(); const l = open(dir);
  l.sessionOpened({ sessionId: 's1', principalId: 'u', driver: 'playwright', mode: 'headless' });
  assert.deepEqual(acc(l), { duplicate: false });
  assert.throws(() => l.resultRecorded({ sessionId: 's1', operationId: 'nope', receipt: { status: 'verified' } }), /unknown operation/);
  assert.throws(() => l.dispatchStarted({ sessionId: 's1', operationId: 'nope', documentEpoch: 0 }));
  l.dispatchStarted({ sessionId: 's1', operationId: 'op1', documentEpoch: 0 });
  assert.throws(() => l.dispatchStarted({ sessionId: 's1', operationId: 'op1', documentEpoch: 0 }), /accepted operation/);
  l.resultRecorded({ sessionId: 's1', operationId: 'op1', receipt: { status: 'verified', code: 'OK', dispatched: true, evidence: [{}, {}] } });
  assert.equal(l.get('s1', 'op1').state, 'result_recorded');
  assert.equal(l.get('s1', 'op1').receipt.evidenceCount, 2);
  const dup = acc(l);
  assert.equal(dup.duplicate, true); assert.equal(dup.receipt.status, 'verified');
  assert.throws(() => acc(l, 'op1', { different: true }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  l.resultRecorded({ sessionId: 's1', operationId: 'op1', receipt: { status: 'uncertain' } }); // terminal records are immutable
  assert.equal(l.get('s1', 'op1').receipt.status, 'verified');
  // the same operationId in another session is a different operation
  assert.deepEqual(l.accept({ sessionId: 's2', operationId: 'op1', pageId: 'p', principalId: 'u', commandHash: 'x', summary: {} }), { duplicate: false });
  l.close();
});

test('verified cannot be recorded for an operation that never started dispatch', () => {
  const l = open(tmp()); acc(l);
  assert.throws(() => l.resultRecorded({ sessionId: 's1', operationId: 'op1', receipt: { status: 'verified' } }), /without dispatch_started/);
  l.close();
});

test('the hash chain links every record and detects tampering', () => {
  const dir = tmp(); const l = open(dir); acc(l, 'a'); acc(l, 'b'); acc(l, 'c'); l.close();
  const lines = fs.readFileSync(file(dir), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  let prev = '0'.repeat(64);
  lines.forEach((r, i) => { assert.equal(r.seq, i + 1); assert.equal(r.prev, prev); assert.equal(r.hash, chainHash(r.prev, { seq: r.seq, ts: r.ts, type: r.type, data: r.data })); prev = r.hash; });
  // flip data in the middle record: the chain no longer verifies from there on
  const tampered = lines.map((r) => JSON.stringify(r));
  const mid = JSON.parse(tampered[1]); mid.data.operationId = 'evil'; tampered[1] = JSON.stringify(mid);
  fs.writeFileSync(file(dir), tampered.join('\n') + '\n');
  const l2 = open(dir);
  assert.equal(l2.recovery.reason, 'chain_mismatch'); assert.equal(l2.recovery.kind, 'mid');
  assert.equal(l2.get('s1', 'evil'), null); assert.equal(l2.get('s1', 'b'), null);
  l2.close();
});

test('restart: crash between dispatch_started and result => uncertain, never replayed', async () => {
  const dir = tmp(); const l = open(dir);
  l.sessionOpened({ sessionId: 's1', principalId: 'u', driver: 'playwright', mode: 'headless' });
  acc(l, 'sent'); l.dispatchStarted({ sessionId: 's1', operationId: 'sent', documentEpoch: 3 });
  acc(l, 'queued');
  acc(l, 'done'); l.dispatchStarted({ sessionId: 's1', operationId: 'done', documentEpoch: 3 }); l.resultRecorded({ sessionId: 's1', operationId: 'done', receipt: { status: 'verified', dispatched: true } });
  l._crash(); // process death: no close(), lock file left behind
  const r = open(dir);
  assert.deepEqual(r.interrupted.map((x) => [x.operationId, x.status]).sort(), [['queued', 'not_attempted'], ['sent', 'uncertain']]);
  assert.equal(r.get('s1', 'sent').receipt.effectUnknown, true);
  assert.equal(r.get('s1', 'sent').receipt.code, 'INTERRUPTED_EFFECT_UNKNOWN');
  assert.equal(r.get('s1', 'queued').receipt.status, 'not_attempted');
  assert.equal(r.get('s1', 'done').receipt.status, 'verified');
  assert.deepEqual(r.unresolved(), []);
  // The same operation id after restart returns the recorded outcome and the driver is NOT called.
  let drove = 0;
  const page = new OwnedPage({ sessionId: 's1', pageId: 'p1', digest: (c) => c.requestHash, execute: async (_, c) => { drove++; c.beforeDispatch(); return { status: 'verified', evidence: [] }; },
    journal: { accept: (cmd, digest) => { const x = r.accept({ sessionId: 's1', operationId: cmd.operationId, pageId: 'p1', principalId: 'u', commandHash: digest, summary: {} }); return x.duplicate ? { receipt: x.receipt } : null; },
      dispatchStarted: () => {}, result: () => {} } });
  const same = await page.act({ operationId: 'sent', sessionId: 's1', pageId: 'p1', documentEpoch: 0, requestHash: r.get('s1', 'sent').commandHash });
  assert.equal(same.status, 'uncertain'); assert.equal(drove, 0);
  r.close();
});

test('restart closes sessions that were open at crash time', () => {
  const dir = tmp(); const l = open(dir);
  l.sessionOpened({ sessionId: 's1', principalId: 'u', driver: 'playwright', mode: 'headless' }); l._crash();
  const r = open(dir); r.close();
  const types = fs.readFileSync(file(dir), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const closed = types.find((t) => t.type === 'session_closed');
  assert.equal(closed.data.reason, 'restart');
});

test('torn tail (partial last line) is dropped, valid prefix kept, bytes preserved aside', () => {
  const dir = tmp(); const l = open(dir); acc(l, 'a'); acc(l, 'b'); l.close();
  fs.appendFileSync(file(dir), '{"seq":4,"ts":1,"type":"accep');
  const r = open(dir);
  assert.equal(r.recovery.reason, 'torn_tail'); assert.equal(r.recovery.kind, 'tail'); assert.ok(r.recovery.droppedBytes > 0);
  assert.ok(fs.existsSync(path.join(dir, r.recovery.aside)));
  assert.ok(r.get('s1', 'a') && r.get('s1', 'b'));
  acc(r, 'c'); // appends cleanly after truncation
  r.close();
  const r2 = open(dir); assert.equal(r2.recovery, null); assert.ok(r2.get('s1', 'c')); r2.close();
});

test('a corrupt record in the middle keeps only the verified prefix', () => {
  const dir = tmp(); const l = open(dir); for (const x of ['a', 'b', 'c', 'd']) acc(l, x); l.close();
  const lines = fs.readFileSync(file(dir), 'utf8').trim().split('\n');
  lines[2] = lines[2].replace('"c"', '"X"');
  fs.writeFileSync(file(dir), lines.join('\n') + '\n');
  const r = open(dir);
  assert.equal(r.recovery.kind, 'mid');
  assert.ok(r.get('s1', 'a') && r.get('s1', 'b')); assert.equal(r.get('s1', 'd'), null);
  r.close();
});

test('missing file is a fresh journal; any other read failure is fatal, never "empty"', () => {
  const dir = tmp(); const l = open(dir); assert.equal(l.recovery, null); l.close();
  const dir2 = tmp();
  fs.mkdirSync(file(dir2)); // reading a directory fails with EISDIR, not ENOENT
  assert.throws(() => open(dir2), (e) => e.code === 'LEDGER_UNREADABLE');
  const dir3 = tmp(); fs.mkdirSync(path.join(dir3, 'ledger.key'));
  assert.throws(() => open(dir3), (e) => e.code === 'LEDGER_UNREADABLE');
});

test('a failed append poisons the journal; the rejected record never reappears', () => {
  const dir = tmp();
  let failNext = false;
  const faulty = { ...fs, writeSync: (fd, data, ...rest) => { if (failNext && typeof data === 'string' && data.includes('"accepted"') && data.includes('"boom"')) { fs.writeSync(fd, data.slice(0, 20)); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } return fs.writeSync(fd, data, ...rest); } };
  const l = open(dir, { fs: faulty });
  acc(l, 'ok');
  failNext = true;
  assert.throws(() => acc(l, 'boom'), (e) => e.code === 'LEDGER_WRITE_FAILED');
  failNext = false;
  assert.throws(() => acc(l, 'after'), (e) => e.code === 'LEDGER_WRITE_FAILED'); // poisoned until reopened
  l._crash();
  const r = open(dir);
  assert.ok(r.get('s1', 'ok')); assert.equal(r.get('s1', 'boom'), null); assert.equal(r.get('s1', 'after'), null);
  assert.equal(r.recovery.reason, 'torn_tail');
  r.close();
});

test('fsync failure on dispatch_started surfaces as LEDGER_WRITE_FAILED (so no input is emitted)', async () => {
  const dir = tmp(); let fail = false;
  const faulty = { ...fs, fsyncSync: (fd) => { if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.fsyncSync(fd); } };
  const l = open(dir, { fs: faulty });
  acc(l);
  fail = true;
  let emitted = false;
  const page = new OwnedPage({ sessionId: 's1', pageId: 'p1', digest: (c) => c.requestHash,
    journal: { accept: () => null, dispatchStarted: (c) => l.dispatchStarted({ sessionId: 's1', operationId: 'op1', documentEpoch: c.documentEpoch }), result: () => {} },
    execute: async (_, c) => { c.beforeDispatch(); emitted = true; return { status: 'dispatched' }; } });
  const r = await page.act({ operationId: 'op1', sessionId: 's1', pageId: 'p1', documentEpoch: 0, requestHash: 'h' });
  assert.equal(emitted, false); assert.equal(r.status, 'not_attempted'); assert.equal(r.code, 'LEDGER_WRITE_FAILED');
});

test('only one process may write: a live lock blocks a second open, a stale lock is taken over', () => {
  const dir = tmp(); const l = open(dir);
  assert.throws(() => open(dir), (e) => e.code === 'LEDGER_LOCKED');
  l.close();
  const l2 = open(dir); l2._crash(); // stale lock left by "our dead process"
  const l3 = open(dir); l3.close();
  // lock held by some other pid that is not alive
  fs.writeFileSync(path.join(dir, 'ledger.jsonl.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, nonce: 'x' }));
  const l4 = open(dir); l4.close();
});

test('commands are HMAC-hashed with a local key and fill text never reaches the file', () => {
  const dir = tmp(); const l = open(dir);
  const canary = 'CANARY-ledger-secret-9931';
  const cmd = { operationId: 'o', sessionId: 's1', documentEpoch: 1, action: { kind: 'fill', text: canary }, target: { role: 'textbox', name: `Name https://x.test/?token=${canary}` } };
  const summary = l.summarize(cmd);
  assert.equal(summary.textLength, canary.length); assert.ok(!JSON.stringify(summary).includes(canary));
  l.accept({ sessionId: 's1', operationId: 'o', pageId: 'p', principalId: 'u', commandHash: l.commandHash(cmd), summary });
  l.close();
  const raw = fs.readFileSync(file(dir), 'utf8');
  assert.ok(!raw.includes(canary));
  assert.notEqual(l.commandHash(cmd), require('../../src/shared/browser-contracts').sha256(cmd));
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.key')).length, 32);
  const nav = l.summarize({ action: { kind: 'navigate', url: 'https://a.test/p?secret=zzz#frag' }, documentEpoch: 0 });
  assert.ok(!JSON.stringify(nav).includes('zzz'));
});

test('bounded retention: closed sessions past retention are compacted away, the rest stays verifiable', () => {
  const dir = tmp(); let now = 1_000_000;
  const l = open(dir, { clock: { now: () => now }, closedSessionRetentionMs: 1000 });
  for (const s of ['old', 'new']) {
    l.sessionOpened({ sessionId: s, principalId: 'u', driver: 'playwright', mode: 'headless' });
    l.accept({ sessionId: s, operationId: 'op', pageId: 'p', principalId: 'u', commandHash: 'h', summary: {} });
    l.dispatchStarted({ sessionId: s, operationId: 'op', documentEpoch: 0 });
    l.resultRecorded({ sessionId: s, operationId: 'op', receipt: { status: 'verified', dispatched: true } });
  }
  l.sessionClosed({ sessionId: 'old' });
  now += 5000;
  l.sessionClosed({ sessionId: 'new' }); // triggers compaction: 'old' is past retention, 'new' just closed
  assert.equal(l.get('old', 'op'), null);
  assert.equal(l.get('new', 'op').receipt.status, 'verified');
  const seqBefore = l.seq;
  l.close();
  const r = open(dir, { clock: { now: () => now } });
  assert.equal(r.recovery, null); assert.equal(r.get('new', 'op').receipt.status, 'verified'); assert.ok(r.seq >= seqBefore);
  acc(r, 'more'); r.close();
  assert.equal(open(dir).recovery, null);
});

test('operation capacity bounds the journal; unresolved operations are never dropped', () => {
  const dir = tmp();
  const l = open(dir, { maxOperations: 3, compactAtBytes: 1 });
  for (let i = 0; i < 6; i++) {
    const op = `o${i}`;
    l.accept({ sessionId: 's', operationId: op, pageId: 'p', principalId: 'u', commandHash: 'h', summary: {} });
    if (i !== 5) { l.dispatchStarted({ sessionId: 's', operationId: op, documentEpoch: 0 }); l.resultRecorded({ sessionId: 's', operationId: op, receipt: { status: 'verified', dispatched: true } }); }
  }
  l.compact();
  assert.ok(l.stats().operations <= 3);
  assert.ok(l.get('s', 'o5'), 'unresolved op kept');
  l.close();
});

test('JournalFile refuses appends once closed', () => {
  const dir = tmp(); const j = new JournalFile(path.join(dir, 'x.jsonl')); j.open(); j.close();
  assert.throws(() => j.append('t', {}), (e) => e.code === 'LEDGER_CLOSED');
});
