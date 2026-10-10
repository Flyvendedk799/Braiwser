'use strict';
// Headless vs visible conformance (audit gate 3: "identical local fixture tasks pass headless
// and headed with semantic outcome comparison"). The SAME scenarios run through the Playwright
// driver in both modes against local fixtures; the semantic outcomes must be identical.
// Visible mode needs a display: it is skipped (with the reason) when none is available.

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserAvailable, openFixtureSession, nodeByName, waitFor, displayAvailable, noopControl } = require('./_env');

const MODES = ['headless', 'visible'];
const avail = {};
test.before(async () => {
  for (const m of MODES) avail[m] = await browserAvailable(m);
});

// Strip everything that is allowed to differ between runs / modes (ids, timings, ports).
const semantic = (o) => ({
  nodes: o.nodes.map((n) => ({ kind: n.kind, role: n.role, name: n.name, enabled: n.enabled, editable: n.editable, checked: n.checked, ambiguous: n.ambiguous, secret: n.secret, context: n.context })),
  coverage: { framesSeen: o.coverage.framesSeen, crossOrigin: o.coverage.crossOriginFrames, unavailable: o.coverage.framesUnavailable, total: o.coverage.nodesTotal, shadow: o.coverage.shadowRootsOpen, closedHosts: o.coverage.possibleClosedShadowHosts, limitations: o.coverage.limitations },
  truncated: o.truncated,
});
const errShape = (e) => ({ code: e.code, detail: e.detail, dispatched: e.dispatched });
const attempt = (p) => p.then((r) => ({ ok: true, status: r.status, kinds: r.evidence.map((x) => x.kind) }), (e) => ({ ok: false, ...errShape(e) }));

async function runTask(env) {
  const { page } = env;
  const out = {};
  await page.navigate(env.url('task.html'));
  const o = await page.observe();
  out.task = semantic(o);
  const cmd = (node, action) => ({ driverDocumentEpoch: o.documentEpoch, observationId: o.observationId, action: { refId: node.refId, ...action } });
  out.fill = await attempt(page.act(cmd(nodeByName(o, 'Display name'), { kind: 'fill', text: 'Ada' })));
  out.select = await attempt(page.act(cmd(o.nodes.find((n) => n.role === 'combobox'), { kind: 'select', value: 'pro' })));
  out.check = await attempt(page.act(cmd(nodeByName(o, 'Accept terms'), { kind: 'check', checked: true })));
  out.click = await attempt(page.act(cmd(nodeByName(o, 'Save'), { kind: 'click', expect: { kind: 'text', op: 'equals', selector: '#status', expected: 'Saved: Ada / pro' } })));
  out.assertions = [];
  for (const a of [{ kind: 'text', op: 'equals', selector: '#status', expected: 'Saved: Ada / pro' }, { kind: 'visible', selector: '#save' },
    { kind: 'count', selector: 'option', expected: 2 }, { kind: 'url', op: 'contains', expected: '/task.html' }, { kind: 'exists', selector: '.nope' }]) {
    out.assertions.push((await page.evaluateAssertion(a)).status);
  }
  out.after = semantic(await page.observe());

  await page.navigate(env.url('duplicates.html'));
  const d = await page.observe();
  out.duplicates = { nodes: semantic(d).nodes.filter((n) => /Delete|Remove|Unique/.test(n.name)) };
  out.ambiguous = await attempt(page.act({ driverDocumentEpoch: d.documentEpoch, action: { kind: 'click', refId: d.nodes.find((n) => n.name === 'Delete').refId } }));

  await page.navigate(env.url('buttons.html'));
  const b = await page.observe();
  out.disabled = await attempt(page.act({ action: { kind: 'click', refId: nodeByName(b, 'Disabled action').refId } }));
  out.covered = await attempt(page.act({ action: { kind: 'click', refId: nodeByName(b, 'Covered action').refId } }));
  out.log = await page.evaluateAssertion({ kind: 'text', op: 'equals', selector: '#log', expected: 'idle' }).then((r) => r.status);

  await page.navigate(env.url('forms.html'));
  const f = await page.observe();
  out.secret = await attempt(page.act({ action: { kind: 'fill', refId: nodeByName(f, 'Password').refId, text: 'x' } }));

  await page.navigate(env.url('replace.html'));
  const r = await page.observe();
  const save = nodeByName(r, 'Save');
  await page.act({ action: { kind: 'click', refId: nodeByName(r, 'Re-render').refId } });
  out.stale = await attempt(page.act({ action: { kind: 'click', refId: save.refId } }));

  await page.navigate(`${env.url('frames.html')}?x=${env.other.port}`);
  const fr = await page.observe();
  out.frames = semantic(fr);
  const inner = fr.nodes.filter((n) => n.name === 'Inner action');
  out.frameClicks = [];
  for (const n of inner) out.frameClicks.push((await attempt(page.act({ action: { kind: 'click', refId: n.refId } }))).status);

  await page.navigate(env.url('shadow.html'));
  const sh = await page.observe();
  out.shadow = semantic(sh);
  out.shadowClick = await attempt(page.act({ action: { kind: 'click', refId: nodeByName(sh, 'Shadow action').refId } }));

  await page.navigate(env.url('spa.html'));
  const spa = await page.observe();
  const e0 = page.documentEpoch;
  out.spa = await attempt(page.act({ action: { kind: 'click', refId: nodeByName(spa, 'Go to settings').refId } }));
  out.spaEpochBumped = page.documentEpoch > e0;
  out.spaStale = await attempt(page.act({ driverDocumentEpoch: spa.documentEpoch, action: { kind: 'click', refId: nodeByName(spa, 'Home only action').refId } }));

  await page.navigate(env.url('dialogs.html'));
  const dl = await page.observe();
  await page.act({ action: { kind: 'click', refId: nodeByName(dl, 'Delete account').refId } });
  await waitFor(() => page.dialogs().some((x) => x.state === 'closed'));
  out.dialog = page.dialogs().map((x) => ({ type: x.type, decision: x.decision, handledBy: x.handledBy }));
  out.dialogResult = await waitFor(async () => (await page.evaluateAssertion({ kind: 'text', op: 'equals', selector: '#log', expected: 'confirm=false' })).status === 'passed');

  await page.navigate(env.url('downloads.html'));
  const dw = await page.observe();
  const seen = [];
  page.on('download', (x) => seen.push(x));
  await page.act({ action: { kind: 'click', refId: nodeByName(dw, 'Download report').refId } });
  await waitFor(() => seen.some((x) => x.state === 'rejected'));
  out.download = seen.filter((x) => x.state === 'rejected').map((x) => x.reason);

  // viewport, capture and table / list / pagination observation are identical headless and headed
  await page.navigate(env.url('responsive-buggy.html'));
  const navVisible = async () => (await page.evaluateAssertion({ kind: 'visible', target: { by: 'role', role: 'navigation', name: 'Primary' } })).status;
  const resized = await attempt(page.setViewport({ width: 375, height: 700 }, noopControl()));
  const navAt375 = await navVisible();
  const shot = await page.capture({});
  out.viewport = { resized, navAt375, shot: { w: shot.bytes.readUInt32BE(16), h: shot.bytes.readUInt32BE(20), viewport: shot.meta.viewport, transformed: shot.meta.transformed } };
  await page.setViewport({ width: 1280, height: 800 }, noopControl());
  out.viewport.navAt1280 = await navVisible();
  await page.navigate(env.url('tables.html'));
  const tb = await page.observe();
  out.tables = { nodes: tb.nodes.filter((n) => n.table || n.list).map((n) => ({ role: n.role, name: n.name, table: n.table, list: n.list })), pagination: Object.keys(tb.pagination || {}).sort() };
  await page.navigate(env.url('popup.html'));
  const pp = await page.observe();
  const popups = [];
  page.on('popup', (x) => popups.push(x));
  await page.act({ action: { kind: 'click', refId: nodeByName(pp, 'Open in new tab').refId } });
  await waitFor(() => popups.length === 1);
  const child = env.session.pages.get(popups[0].pageId);
  out.popup = { opener: child.openerPageId === page.pageId, pages: env.session.pages.size };
  await child.close();
  await waitFor(() => env.session.pages.size === 1);
  return out;
}

const results = {};
for (const mode of MODES) {
  test(`conformance task runs in ${mode} mode`, async (t) => {
    if (!avail[mode].ok) { t.skip(avail[mode].reason); return; }
    const env = await openFixtureSession({ mode, open: { dialogDeadlineMs: 300 } });
    try {
      results[mode] = await runTask(env);
      const r = results[mode];
      // absolute expectations (not only "same in both modes")
      assert.deepEqual([r.fill.status, r.select.status, r.check.status, r.click.status], ['verified', 'verified', 'verified', 'verified']);
      assert.deepEqual(r.assertions, ['passed', 'passed', 'passed', 'passed', 'failed']);
      assert.equal(r.ambiguous.code, 'AMBIGUOUS_TARGET');
      assert.equal(r.disabled.code, 'UNAVAILABLE');
      assert.equal(r.covered.code, 'UNAVAILABLE');
      assert.equal(r.log, 'passed', 'neither the disabled nor the covered button ran its handler');
      assert.equal(r.secret.code, 'DENIED');
      assert.equal(r.stale.code, 'STALE_REF');
      assert.deepEqual(r.frameClicks, ['verified', 'verified']);
      assert.equal(r.shadowClick.status, 'verified');
      assert.equal(r.spaEpochBumped, true);
      assert.equal(r.spaStale.code, 'STALE_REF');
      assert.deepEqual(r.dialog, [{ type: 'confirm', decision: 'dismiss', handledBy: 'policy-deadline' }]);
      assert.deepEqual(r.download, ['not-granted']);
      assert.deepEqual(r.popup, { opener: true, pages: 2 });
      assert.deepEqual(r.viewport, { resized: { ok: true, status: 'verified', kinds: ['state-change'] }, navAt375: 'failed', navAt1280: 'passed', shot: { w: 375, h: 700, viewport: { width: 375, height: 700 }, transformed: false } });
      assert.deepEqual(r.tables.pagination, ['next', 'prev']);
      assert.deepEqual(r.tables.nodes.map((n) => n.name), ['Accounts', 'Merged', 'Grid', '', 'Steps', 'Big']);
    } finally { await env.close(); }
  });
}

test('semantic outcomes are identical between headless and visible', (t) => {
  if (!results.headless || !results.visible) {
    t.skip(!displayAvailable() ? 'no display available: visible mode skipped' : 'a mode did not run (see its own test)');
    return;
  }
  assert.deepEqual(results.visible, results.headless);
});

test('visible mode: owner badge is a human-visible cue, never page content and never in screenshots', async (t) => {
  if (!avail.visible.ok) { t.skip(avail.visible.reason); return; }
  const env = await openFixtureSession({ mode: 'visible' });
  try {
    const { page } = env;
    assert.equal(env.session.capabilities.humanHandoff, 'native');
    await page.navigate(env.url('task.html'));
    await page.setOwnerBadge('agent');
    const state = await page.badgeState();
    assert.equal(state.owner, 'agent');
    assert.match(state.text, /agent/i);
    assert.equal(await page._raw.locator('[data-caos="agent-badge"]').count(), 1);

    // observations and assertions ignore it
    const o = await page.observe();
    assert.ok(!o.nodes.some((n) => /agent is controlling/i.test(n.name)));
    assert.equal((await page.evaluateAssertion({ kind: 'count', selector: '[data-caos]', expected: 0 })).status, 'passed');

    // the cue follows ownership
    for (const [owner, re] of [['human', /in control/i], ['quarantined', /paused/i]]) {
      await page.setOwnerBadge(owner);
      assert.match((await page.badgeState()).text, re);
    }
    // it survives navigation (re-applied on domcontentloaded)
    await page.setOwnerBadge('agent');
    await page.navigate(env.url('buttons.html'));
    await waitFor(async () => (await page.badgeState()).owner === 'agent');

    // pixels are captured WITHOUT the badge, and it comes back afterwards
    let visibilityDuringCapture = null;
    const raw = page._raw;
    const original = raw.screenshot.bind(raw);
    raw.screenshot = async (opts) => {
      visibilityDuringCapture = await raw.evaluate(() => getComputedStyle(document.querySelector('[data-caos="agent-badge"]')).visibility);
      return original(opts);
    };
    const shot = await page.screenshot();
    raw.screenshot = original;
    assert.equal(visibilityDuringCapture, 'hidden');
    assert.equal(shot.meta.transformed, false);
    assert.equal(await raw.evaluate(() => getComputedStyle(document.querySelector('[data-caos="agent-badge"]')).visibility), 'visible');

    await page.setOwnerBadge('none');
    assert.equal((await page.badgeState()).owner, 'none');
    // the badge is pointer-transparent: it never steals a human's click
    await page.setOwnerBadge('agent');
    assert.equal(await raw.evaluate(() => getComputedStyle(document.querySelector('[data-caos="agent-badge"]')).pointerEvents), 'none');
  } finally { await env.close(); }
});

test('visible mode capability document differs from headless only where it must', async (t) => {
  const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright');
  const d = createPlaywrightDriver();
  const v = d.capabilities({ mode: 'visible' });
  const h = d.capabilities({ mode: 'headless' });
  const strip = ({ humanHandoff, modes, notes, ...rest }) => rest;
  assert.deepEqual(strip(v), strip(h));
  assert.equal(v.liveModeSwitch, false);
  assert.equal(h.liveModeSwitch, false);
  assert.equal(typeof d.setHeadless, 'undefined', 'mode is fixed at launch');
  void t;
});
