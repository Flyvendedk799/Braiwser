'use strict';
// The standalone executor (run.executePlan, no broker) with the extended plan language: against the FakeDriver for the
// failure matrix and against REAL headless Chromium (local fixtures) for the end-to-end case.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../src/main/services/browser/run');
const { createFakeDriver } = require('./fake-driver');
const { browserAvailable, openFixtureSession } = require('./drivers/_env');

const SITE = {
  'about:blank': { elements: [] },
  'https://app.test/': { elements: [
    { id: 'nav', role: 'navigation', name: 'Primary' },
    { id: 'plan', role: 'combobox', name: 'Plan', value: 'free', onSelect: { setText: { id: 'status', text: 'Plan changed' } } },
    { id: 'terms', role: 'checkbox', name: 'Accept terms', onCheck: { setText: { id: 'status', text: 'Terms accepted' } } },
    { id: 'q', role: 'textbox', name: 'Query', editable: true },
    { id: 'status', role: 'status', name: 'Status', text: '' },
    { id: 'r1', role: 'row', name: 'One' }, { id: 'r2', role: 'row', name: 'Two' },
  ] },
};
const plan = (steps, extra = {}) => ({ schemaVersion: 1, skillId: 'verify-journey', version: '1.0.0', inputKeys: [], maxDurationMs: 20000, steps, ...extra });
const nav = { id: 'n', type: 'navigate', url: 'https://app.test/' };
const url = { id: 'u', type: 'assert', kind: 'url', op: 'contains', expected: 'app.test' };
async function pageOf(options = {}) {
  const fake = createFakeDriver({ site: SITE, ...options });
  const session = await fake.driver.open({});
  return { fake, page: [...session.pages.values()][0] };
}

test('executePlan: select / check / press / setViewport / capture / exists / count / url run and are graded', async () => {
  const { fake, page } = await pageOf();
  const p = plan([nav,
    { id: 'v', type: 'setViewport', width: 400, height: 700 },
    { id: 'c1', type: 'capture', label: 'page' },
    { id: 's', type: 'select', target: { by: 'label', value: 'Plan' }, inputKey: 'plan' },
    { id: 'a1', type: 'assert', kind: 'text', op: 'equals', expected: 'Plan changed', target: { by: 'role', role: 'status', name: 'Status' } },
    { id: 'k', type: 'check', target: { by: 'role', role: 'checkbox', name: 'Accept terms' }, checked: true },
    { id: 'a2', type: 'assert', kind: 'text', op: 'equals', expected: 'Terms accepted', target: { by: 'role', role: 'status', name: 'Status' } },
    { id: 'pr', type: 'press', target: { by: 'label', value: 'Query' }, key: 'Tab' },
    { id: 'c2', type: 'capture', label: 'nav', target: { by: 'role', role: 'navigation', name: 'Primary' } },
    { id: 'a3', type: 'assert', kind: 'exists', op: 'equals', expected: 'exists', target: { by: 'role', role: 'navigation', name: 'Primary' } },
    { id: 'a4', type: 'assert', kind: 'count', op: 'equals', expected: '2', target: { by: 'role', role: 'row' } },
    url], { inputKeys: ['plan'] });
  const r = await R.executePlan(p, page, { inputs: { plan: 'pro' } });
  assert.equal(r.terminal, 'completed');
  assert.equal(r.verdict.status, 'passed', JSON.stringify(r.verdict));
  assert.deepEqual([r.verdict.planned, r.verdict.requiredAssertions, r.verdict.passedAssertions], [12, 5, 5]);
  assert.deepEqual(fake.world.dispatchLog.map((e) => e.kind), ['setViewport', 'select', 'check', 'press']);
  assert.equal(fake.world.captures.length, 2);
  const caps = [...r.evidence.values()].filter((e) => e.kind === 'capture');
  assert.equal(caps.length, 2); assert.ok(caps.every((e) => e.data.transformed === false && /^[0-9a-f]{64}$/.test(e.data.sha256)));
  assert.ok(![...r.evidence.values()].some((e) => JSON.stringify(e).includes('fake-png')), 'pixels are not kept in the evidence record');
});

test('executePlan: unsupported drivers, bad pixels and unverified resizes never pass', async () => {
  const run = async (options, ctl, steps) => {
    const { fake, page } = await pageOf(options);
    Object.assign(fake.ctl, ctl || {});
    return R.executePlan(plan([nav, ...steps, url]), page);
  };
  const vp = { id: 'v', type: 'setViewport', width: 400, height: 700 };
  const cap = { id: 'c', type: 'capture', label: 'x' };
  const bare = await pageOf();
  bare.page.setViewport = undefined; bare.page.capture = undefined; // a driver page that does not implement them
  const noSetViewport = await R.executePlan(plan([nav, vp, url]), bare.page);
  assert.notEqual(noSetViewport.verdict.status, 'passed'); assert.equal(noSetViewport.results.find((x) => x.stepId === 'v').status, 'failed');
  const noCapture = await R.executePlan(plan([nav, cap, url]), bare.page);
  assert.equal(noCapture.results.find((x) => x.stepId === 'c').code, 'UNSUPPORTED'); assert.equal(noCapture.verdict.status, 'failed');
  assert.equal((await run({}, { failCapture: 'invalid' }, [cap])).results.find((x) => x.stepId === 'c').code, 'CAPTURE_INVALID');
  assert.equal((await run({}, { failCapture: 'empty' }, [cap])).verdict.status, 'failed');
  assert.equal((await run({}, { failCapture: 'throw' }, [cap])).verdict.status, 'failed');
  const unverified = await run({}, { viewportMismatch: true }, [vp]);
  assert.notEqual(unverified.verdict.status, 'passed'); assert.equal(unverified.verdict.status, 'unknown');
});

test('executePlan: an out-of-range viewport is refused by the contract before the page is touched', async () => {
  const { fake, page } = await pageOf();
  await assert.rejects(() => R.executePlan(plan([nav, { id: 'v', type: 'setViewport', width: 100, height: 700 }, url]), page), /INVALID_INPUT/);
  assert.equal(fake.world.inputLog.length, 0);
});

// ---- real Chromium ---------------------------------------------------------------------------------------------
test('executePlan against real Chromium: viewport changes layout, captures are real PNGs, role-only counts work', async (t) => {
  const avail = await browserAvailable('headless');
  if (!avail.ok) { t.skip(avail.reason); return; }
  const env = await openFixtureSession();
  try {
    const target = { by: 'role', role: 'navigation', name: 'Primary' };
    const home = env.url('responsive-buggy.html');
    const p = plan([
      { id: 'n1', type: 'navigate', url: home },
      { id: 'v1', type: 'setViewport', width: 1280, height: 800 },
      { id: 'a1', type: 'assert', kind: 'visible', op: 'equals', expected: 'visible', target },
      { id: 'c1', type: 'capture', label: 'desktop', target },
      { id: 'v2', type: 'setViewport', width: 375, height: 812 },
      { id: 'a2', type: 'assert', kind: 'count', op: 'equals', expected: '3', target: { by: 'role', role: 'link' } },
      { id: 'c2', type: 'capture', label: 'mobile' },
      { id: 'a3', type: 'assert', kind: 'url', op: 'contains', expected: 'responsive-buggy.html' },
    ]);
    const r = await R.executePlan(p, env.page);
    assert.equal(r.verdict.status, 'passed', JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.code])));
    const caps = [...r.evidence.values()].filter((e) => e.kind === 'capture').map((e) => e.data);
    assert.equal(caps.length, 2);
    assert.deepEqual(caps[1].meta.viewport, { width: 375, height: 812 }); assert.equal(caps[1].meta.transformed, false);
    assert.ok(caps[0].meta.clip && caps[0].meta.clip.width > 100, 'the first capture is a crop of the navigation');
    // the same plan with the nav asserted visible at 375px must fail: the layout really changed
    const failing = plan([
      { id: 'n1', type: 'navigate', url: home }, { id: 'v1', type: 'setViewport', width: 375, height: 812 },
      { id: 'a1', type: 'assert', kind: 'visible', op: 'equals', expected: 'visible', target },
    ]);
    const bad = await R.executePlan(failing, env.page);
    assert.equal(bad.verdict.status, 'failed'); assert.equal(bad.verdict.failed, 1);
  } finally { await env.close(); }
});
