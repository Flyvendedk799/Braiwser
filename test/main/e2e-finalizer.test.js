'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createE2EFinalizer } = require('../../src/main/e2e-finalizer');

function make(opts = {}) {
  const exits = [];
  const lines = [];
  const timers = [];
  const fin = createE2EFinalizer({
    app: { exit: (c) => exits.push(c) },
    log: (l) => lines.push(l),
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...opts,
  });
  const flush = () => timers.filter((t) => !t.cleared && t.ms === 100).forEach((t) => t.fn());
  const report = () => {
    const l = lines.find((x) => x.startsWith('BRAIWSER_E2E_REPORT '));
    return l ? JSON.parse(l.slice('BRAIWSER_E2E_REPORT '.length)) : null;
  };
  return { fin, exits, lines, timers, flush, report };
}
const ok = (n) => Array.from({ length: n }, (_, i) => ({ name: 'c' + i, pass: true, detail: '' }));

test('REL-03: a complete, fully passing report exits 0', () => {
  const t = make();
  ok(3).forEach((c) => t.fin.recordCheck(c));
  t.fin.finalize('completed', { report: { ok: true, passed: 3, total: 3, checks: ok(3) } });
  t.flush();
  assert.deepEqual(t.exits, [0]);
  assert.equal(t.report().terminal, 'completed');
  assert.ok(t.lines.some((l) => l.startsWith('CAOS_E2E_REPORT ')), 'legacy alias line is printed');
});

test('REL-03: renderer crash mid-suite exits 1 with the partial report', () => {
  const t = make();
  ok(2).forEach((c) => t.fin.recordCheck(c));
  t.fin.finalize('render-process-gone', { reason: 'renderer gone: crashed' });
  t.flush();
  assert.deepEqual(t.exits, [1]);
  const r = t.report();
  assert.equal(r.ok, false);
  assert.equal(r.crashed, true);
  assert.equal(r.passed, 2);
  assert.equal(r.terminal, 'render-process-gone');
  assert.equal(r.exitCode, 1);
});

test('REL-03: watchdog timeout exits 1', () => {
  const t = make({ timeoutMs: 5000 });
  t.fin.arm();
  const wd = t.timers.find((x) => x.ms === 5000);
  wd.fn();
  t.flush();
  assert.deepEqual(t.exits, [1]);
  assert.equal(t.report().terminal, 'timeout');
});

test('REL-03: failing checks, fatal, empty and inconsistent reports all exit 1', () => {
  const cases = {
    failing: { ok: true, passed: 1, total: 2, checks: [...ok(1), { name: 'bad', pass: false }] },
    fatal: { ok: true, passed: 1, total: 1, checks: ok(1), fatal: 'boom' },
    explicitFalse: { ok: false, passed: 1, total: 1, checks: ok(1) },
    empty: { ok: true, passed: 0, total: 0, checks: [] },
    totalMismatch: { ok: true, passed: 3, total: 5, checks: ok(3) },
  };
  for (const [name, report] of Object.entries(cases)) {
    const t = make();
    t.fin.finalize('completed', { report });
    t.flush();
    assert.deepEqual(t.exits, [1], name);
  }
  const t = make();
  t.fin.finalize('completed', {});
  t.flush();
  assert.deepEqual(t.exits, [1]);
  assert.equal(t.report().terminal, 'incomplete-report');
});

test('REL-03: a report that omits checks that were streamed is incomplete', () => {
  const t = make();
  ok(4).forEach((c) => t.fin.recordCheck(c));
  t.fin.finalize('completed', { report: { ok: true, passed: 2, total: 2, checks: ok(2) } });
  t.flush();
  assert.deepEqual(t.exits, [1]);
});

test('REL-03: first terminal state wins; a late completion cannot turn a crash green', () => {
  const t = make();
  ok(1).forEach((c) => t.fin.recordCheck(c));
  t.fin.finalize('render-process-gone', {});
  t.fin.finalize('completed', { report: { ok: true, passed: 1, total: 1, checks: ok(1) } });
  t.flush();
  assert.deepEqual(t.exits, [1]);
  assert.equal(t.lines.filter((l) => l.startsWith('BRAIWSER_E2E_REPORT ')).length, 1);
});
