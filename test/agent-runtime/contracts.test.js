'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/shared/browser-contracts');
const { redactText, redactValue, createRedactor } = require('../../src/shared/browser-redact');

test('ids are opaque, prefixed, random and path-safe', () => {
  const seen = new Set();
  for (const kind of ['session', 'page', 'run', 'operation', 'observation', 'ref', 'approval', 'artifact', 'cursor']) {
    const id = C.newId(kind);
    assert.ok(C.isServerId(id), id);
    assert.ok(!seen.has(id)); seen.add(id);
  }
  assert.equal(new Set(Array.from({ length: 2000 }, () => C.newId('ref'))).size, 2000);
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(161), 'a b', 'a\\b']) assert.equal(C.isClientId(bad), false, bad);
  assert.equal(C.isServerId('run_../../etc'), false);
  assert.throws(() => C.newId('nope'));
});

test('action validation is closed: unknown kinds fail closed, extra fields are rejected', () => {
  assert.equal(C.validateAction({ kind: 'click', ref: 'r_1' }).kind, 'click');
  assert.throws(() => C.validateAction({ kind: 'eval', code: '1' }), (e) => e.publicError.code === 'UNSUPPORTED');
  assert.throws(() => C.validateAction({ kind: 'click', ref: 'r_1', force: true }), (e) => e.publicError.code === 'DENIED');
  assert.throws(() => C.validateAction({ kind: 'press', ref: 'r_1', key: 'F12' }));
  assert.throws(() => C.validateAction({ kind: 'fill', ref: 'r_1', text: 'x'.repeat(10001) }));
  assert.throws(() => C.validateAction({ kind: 'click', ref: '../etc/passwd' }));
  assert.throws(() => C.validateAction(null));
});

test('act requires an observation for ref actions but not for navigate', () => {
  const base = { sessionId: 's', pageId: 'p', documentEpoch: 0, operationId: 'o1' };
  assert.throws(() => C.validateAct({ ...base, action: { kind: 'click', ref: 'r_1' } }), /observationId/);
  assert.equal(C.validateAct({ ...base, action: { kind: 'navigate', url: 'https://a.test/' } }).action.kind, 'navigate');
  assert.throws(() => C.validateAct({ ...base, observationId: 'ob_1', action: { kind: 'click', ref: 'r_1' }, approved: true }), /unknown field/);
  assert.throws(() => C.validateAct({ ...base, documentEpoch: -1, action: { kind: 'navigate', url: 'x' } }));
});

test('principal validation rejects malformed identities', () => {
  assert.ok(C.validatePrincipal({ id: 'a', kind: 'mcp', scopes: [] }));
  for (const bad of [null, {}, { id: 'a', kind: 'root', scopes: [] }, { id: '../a', kind: 'mcp', scopes: [] }, { id: 'a', kind: 'mcp' }, { id: 'a', kind: 'mcp', scopes: [1] }]) {
    assert.throws(() => C.validatePrincipal(bad));
  }
});

const goodPlan = () => ({ schemaVersion: 1, skillId: 'verify-journey', version: '1.0.0', inputKeys: ['name'], maxDurationMs: 5000, steps: [
  { id: 'a', type: 'navigate', url: 'https://app.test/' },
  { id: 'b', type: 'fill', target: { by: 'label', value: 'Name' }, inputKey: 'name' },
  { id: 'c', type: 'assert', target: { by: 'role', role: 'status', name: 'S' }, kind: 'text', op: 'contains', expected: 'ok' }] });

test('plan validation mirrors the closed workflow language', () => {
  assert.ok(Object.isFrozen(C.validatePlan(goodPlan())));
  const mutate = (fn) => { const p = goodPlan(); fn(p); return p; };
  for (const bad of [
    mutate((p) => { p.steps[1].inputKey = 'other'; }),
    mutate((p) => { p.steps.pop(); }),
    mutate((p) => { p.steps[1].id = 'a'; }),
    mutate((p) => { p.steps.push({ id: 'z', type: 'eval', code: 'x' }); }),
    mutate((p) => { p.steps[2].kind = 'visible'; }),
    mutate((p) => { p.extra = 1; }),
    mutate((p) => { p.schemaVersion = 2; }),
    mutate((p) => { p.version = 'latest'; }),
  ]) assert.throws(() => C.validatePlan(bad));
});

const grade = (o = {}) => ({ status: 'passed', planned: 3, executed: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, timedOut: 0, pending: 0, unknown: 0, requiredAssertions: 1, passedAssertions: 1, evidenceComplete: true, uncertainEffect: false, ...o });
const dtoOf = (state, g = grade()) => C.buildRunDTO({ runId: 'run_abcdef1', state, grade: g, sequence: 3, events: [{ sequence: 1, kind: 'x', summary: 'y' }], nextSequence: 2, deadlineAt: Date.now(), manifestUri: 'braiwser://runs/run_abcdef1/manifest' });

test('lifecycle state maps to verdict exactly as specified', () => {
  for (const s of ['queued', 'running', 'needsApproval', 'needsHuman']) assert.equal(dtoOf(s).verdict, 'pending', s);
  for (const s of ['uncertain', 'interrupted']) assert.equal(dtoOf(s).verdict, 'unknown', s);
  for (const s of ['failed', 'cancelled', 'timedOut']) assert.equal(dtoOf(s).verdict, s);
  assert.equal(dtoOf('passed').verdict, 'passed');
});

test('passed state without a passing grader result degrades to unknown (no false pass)', () => {
  assert.equal(dtoOf('passed', grade({ status: 'unknown' })).verdict, 'unknown');
  assert.equal(dtoOf('passed', grade({ status: 'failed' })).verdict, 'unknown');
  assert.deepEqual(C.validateRunDTO(dtoOf('passed')), []);
  const forged = { ...dtoOf('failed'), verdict: 'passed' };
  assert.ok(C.validateRunDTO(forged).length > 0);
  const noEvidence = dtoOf('passed', grade({ evidenceComplete: false }));
  assert.ok(C.validateRunDTO(noEvidence).some((p) => /without proof/.test(p)));
});

test('RunDTO is exactly the audit schema and bounded', () => {
  const d = dtoOf('running');
  assert.deepEqual(C.validateRunDTO(d), []);
  const many = C.buildRunDTO({ runId: 'run_abcdef1', state: 'running', grade: grade(), sequence: 500, events: Array.from({ length: 300 }, (_, i) => ({ sequence: i + 1, kind: 'k'.repeat(200), summary: 's'.repeat(900) })), nextSequence: 301, deadlineAt: 0, manifestUri: 'braiwser://x' });
  assert.equal(many.events.length, 100);
  assert.ok(many.events.every((e) => e.kind.length <= 80 && e.summary.length <= 300));
});

test('public errors are classified, redacted and never carry stacks', () => {
  const e = C.publicError(Object.assign(new Error('boom C:\\Users\\bob\\secret.txt token=abcdef123456 Bearer abcdefghijklmnop'), { code: 'OWNERSHIP_LOST' }));
  assert.equal(e.code, 'DENIED'); assert.equal(e.retry, 'refresh');
  assert.ok(!/abcdef123456|abcdefghijklmnop/.test(e.message), e.message);
  assert.deepEqual(Object.keys(e).sort(), ['code', 'dispatched', 'effectUnknown', 'message', 'retry']);
  const unknown = C.publicError(new Error('ENOENT /home/alice/.ssh/id_rsa'));
  assert.equal(unknown.code, 'INTERNAL'); assert.ok(!/alice|ssh/.test(unknown.message));
  assert.equal(C.publicError(Object.assign(new Error('x'), { code: 'DEADLINE_EXCEEDED' }), { dispatched: true, effectUnknown: true }).code, 'TIMEOUT');
  assert.ok(C.ERROR_CODES.includes(C.publicError(Object.assign(new Error('x'), { code: 'STALE_DOCUMENT' })).code));
  const be = C.brokerError('NOPE', 'x'.repeat(2000));
  assert.equal(be.publicError.code, 'INTERNAL'); assert.ok(be.publicError.message.length <= 520);
});

test('capText never splits a UTF-8 sequence and reports truncation metadata', () => {
  const text = 'a\u00e9\u20ac\ud83d\ude00'.repeat(50);
  const first = C.capText(text, { maxBytes: 40 });
  assert.equal(first.truncated, true);
  assert.ok(!first.text.includes('\uFFFD'));
  let out = first.text; let next = first.nextOffset;
  while (next !== null) { const c = C.capText(text, { maxBytes: 40, offset: next }); out += c.text; next = c.nextOffset; }
  assert.equal(out, text);
});

test('resource URIs parse strictly', () => {
  const run = C.newId('run'); const ob = C.newId('observation');
  assert.deepEqual(C.parseUri(C.uris.manifest(run)), { kind: 'manifest', runId: run });
  assert.equal(C.parseUri(C.uris.observation(run, ob)).id, ob);
  assert.deepEqual(C.parseUri('braiwser://capabilities'), { kind: 'capabilities' });
  for (const bad of ['braiwser://runs/../manifest', `braiwser://runs/${run}/../x`, 'file:///etc/passwd', `braiwser://runs/${run}/observations/..%2f`, 'braiwser://runs/run_x/manifest', 'braiwser://']) assert.equal(C.parseUri(bad), null, bad);
});

test('redaction removes secrets from text, urls and nested values', () => {
  const canary = 'CANARY-s3cr3t-Value-0042';
  const r = createRedactor({ secrets: [canary] });
  const text = r.text(`visit https://u:p@x.test/a?token=abc123&q=1#frag with ${canary} and ${encodeURIComponent(canary)} and Bearer abcdefghij1234 and 4111 1111 1111 1111`);
  for (const leak of [canary, 'u:p@', 'abc123', 'frag', 'abcdefghij1234', '4111 1111 1111 1111']) assert.ok(!text.includes(leak), `${leak} in ${text}`);
  const v = redactValue({ password: 'hunter2', nested: { apiKey: 'k', ok: 'fine', arr: [{ authorization: 'x' }] }, url: 'https://a.test/p?session=abc' });
  assert.equal(v.password, '[redacted]'); assert.equal(v.nested.apiKey, '[redacted]'); assert.equal(v.nested.ok, 'fine');
  assert.equal(v.nested.arr[0].authorization, '[redacted]'); assert.ok(!JSON.stringify(v).includes('abc'));
  const circular = {}; circular.self = circular;
  assert.equal(redactValue(circular).self, '[circular]');
  assert.ok(redactText('x'.repeat(5000)).length < 2100);
});
