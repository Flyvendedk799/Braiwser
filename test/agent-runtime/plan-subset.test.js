'use strict';
// workflow-core.js (zod, what skills compile to) must stay a SUBSET of the broker's validatePlan: a plan the automation
// layer accepts must never be refused by the broker for a reason the automation layer could have caught. The
// reverse is allowed (the broker is the authority and may be wider, e.g. it has no "trailing action" rule).
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/shared/browser-contracts');
const wf = require('../../src/main/services/automation/workflow-core');
const { mulberry32 } = require('./fake-driver');

const long = (n) => 'x'.repeat(n);

function generator(seed) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const chance = (p) => rnd() < p;
  // mostly good values with the occasional boundary / invalid one, so both outcomes are well represented
  const mix = (good, bad, p = 0.06) => (chance(p) ? pick(bad) : pick(good));
  const target = (nameOptional = false) => {
    const by = mix(['role', 'role', 'role', 'testId', 'label'], ['role']);
    if (by === 'role') {
      const t = { by, role: mix(['button', 'row', 'status', 'navigation', long(200)], [long(201), '']) };
      if (!(nameOptional && chance(0.4))) t.name = mix(['Save', 'Primary', long(200)], [long(201), '']);
      return t;
    }
    return { by, value: mix(['x', 'Display name', long(200)], [long(201), '']) };
  };
  const step = (i, inputKeys) => {
    const id = mix([`s${i}`], ['s1', long(80), long(81)], 0.03);
    switch (pick(['navigate', 'click', 'fill', 'select', 'check', 'press', 'setViewport', 'capture', 'assert', 'assert', 'assert'])) {
      case 'navigate': return { id, type: 'navigate', url: mix(['https://app.test/', 'http://127.0.0.1:1/x'], ['file:///etc/passwd', 'https://u:p@app.test/', 'not a url', `https://app.test/${long(2100)}`]) };
      case 'click': return { id, type: 'click', target: target() };
      case 'fill': return { id, type: 'fill', target: target(), inputKey: mix(inputKeys, ['undeclared']) };
      case 'select': return { id, type: 'select', target: target(), inputKey: mix(inputKeys, ['undeclared']) };
      case 'check': return { id, type: 'check', target: target(), checked: mix([true, false], ['yes']) };
      case 'press': return { id, type: 'press', target: target(), key: mix(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'], ['F12', 'a']) };
      case 'setViewport': return { id, type: 'setViewport', width: mix([240, 375, 1280, 4000, 4096], [199, 200, 239, 4097, 375.5], 0.15), height: mix([240, 800, 4096], [199, 239, 4097], 0.15) };
      case 'capture': return { id, type: 'capture', label: mix(['page', long(200)], [long(201), '']), ...(chance(0.5) ? { target: target(true) } : {}) };
      default: {
        const kind = pick(['visible', 'exists', 'text', 'count', 'url']);
        const a = { id, type: 'assert', kind, op: pick(['equals', 'contains']) };
        if (chance(0.03)) a.op = 'matches';
        if (kind === 'visible') { a.expected = mix(['visible'], ['hidden']); a.op = mix(['equals'], ['contains']); }
        else if (kind === 'exists') { a.expected = mix(['exists'], ['gone']); a.op = mix(['equals'], ['contains']); }
        else if (kind === 'count') a.expected = mix(['0', '3', '123456789'], ['1234567890', '-1', 'abc', '']);
        else a.expected = mix(['ok', long(1000)], ['', long(1001)]);
        if (kind === 'url' ? chance(0.05) : chance(0.97)) a.target = target(['visible', 'exists', 'count'].includes(kind));
        return a;
      }
    }
  };
  return () => {
    const inputKeys = pick([[], ['name'], ['name', 'plan']]);
    const steps = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => step(i + 1, inputKeys.length ? inputKeys : ['name']));
    if (chance(0.9)) steps.push({ id: 'final', type: 'assert', kind: 'url', op: 'contains', expected: 'app' });
    return { schemaVersion: 1, skillId: mix(['verify-journey', 'review-responsive'], ['Bad_Id']), version: mix(['1.0.0'], ['1.0', 'x']),
      inputKeys, maxDurationMs: mix([1000, 60000, 300000], [300001, 999]), steps };
  };
}

test('every plan workflow-core accepts is accepted by the broker, and the broker keeps it unchanged', () => {
  const next = generator(20240611);
  let accepted = 0;
  const kinds = new Set();
  for (let i = 0; i < 6000; i += 1) {
    const p = next();
    const mine = wf.safeValidateWorkflow(p);
    if (!mine.ok) continue;
    accepted += 1;
    for (const s of mine.plan.steps) kinds.add(s.type === 'assert' ? `assert:${s.kind}` : s.type);
    let broker;
    try { broker = C.validatePlan(mine.plan); } catch (e) { assert.fail(`broker refused a workflow-core plan: ${e.message}\n${JSON.stringify(mine.plan).slice(0, 600)}`); }
    assert.equal(C.canonicalJson(broker), C.canonicalJson(JSON.parse(JSON.stringify(mine.plan))), 'the broker does not rewrite a plan');
  }
  assert.ok(accepted > 300, `the generator must produce enough valid plans (${accepted})`);
  for (const k of ['navigate', 'click', 'fill', 'select', 'check', 'press', 'setViewport', 'capture', 'assert:visible', 'assert:exists', 'assert:text', 'assert:count', 'assert:url']) {
    assert.ok(kinds.has(k), `the subset check exercised ${k}`);
  }
});

test('the broker stays the authority: what it refuses is refused with INVALID_INPUT or UNSUPPORTED, never accepted silently', () => {
  const next = generator(7);
  let refused = 0;
  for (let i = 0; i < 3000; i += 1) {
    const p = next();
    try { C.validatePlan(p); } catch (e) {
      refused += 1;
      assert.ok(e.publicError && ['DENIED', 'UNSUPPORTED'].includes(e.publicError.code), e.message);
    }
  }
  assert.ok(refused > 1000);
});

test('limits are identical where the two languages share one', () => {
  const plan = (step) => ({ schemaVersion: 1, skillId: 'verify-journey', version: '1.0.0', inputKeys: [], maxDurationMs: 5000, steps: [step, { id: 'z', type: 'assert', kind: 'url', op: 'contains', expected: 'app' }] });
  const accepts = (step) => [wf.safeValidateWorkflow(plan(step)).ok, (() => { try { C.validatePlan(plan(step)); return true; } catch { return false; } })()];
  for (const [w, ok] of [[239, false], [240, true], [4096, true], [4097, false]]) {
    assert.deepEqual(accepts({ id: 'v', type: 'setViewport', width: w, height: 800 }), [ok, ok], `width ${w}`);
  }
  assert.equal(C.VIEWPORT_MIN, 240); assert.equal(C.VIEWPORT_MAX, 4096);
  assert.deepEqual(accepts({ id: 'c', type: 'capture', label: long(200) }), [true, true]);
  assert.deepEqual(accepts({ id: 'c', type: 'capture', label: long(201) }), [false, false]);
  assert.deepEqual(accepts({ id: 'k', type: 'press', target: { by: 'label', value: 'q' }, key: 'F12' }), [false, false]);
});
