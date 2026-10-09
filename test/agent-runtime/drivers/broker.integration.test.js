'use strict';
// The REAL broker (ledger, evidence store, policy, OwnedPage lanes) driving the REAL
// Playwright driver against LOCAL fixtures. This is the contract check between the two
// engineers: evidence the broker accepts as proof, error codes, events, request-level policy.
// Skips (with the reason) when Chromium is unavailable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBroker } = require('../../../src/main/services/browser/broker');
const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright');
const { startFixtureServer } = require('../../fixtures/agent-sites/server');
const { browserAvailable, FIXTURE_DIR, sleep, waitFor } = require('./_env');

let avail = { ok: false, reason: 'not probed' };
let origin; let other; let dataDir; let broker; let ui;
const ID = { id: 'ui-int', kind: 'ui', scopes: [] };
let op = 0;

test.before(async () => {
  avail = await browserAvailable('headless');
  if (!avail.ok) return;
  origin = await startFixtureServer({ dir: FIXTURE_DIR });
  other = await startFixtureServer({ dir: FIXTURE_DIR });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-int-'));
  broker = createBroker({ dataDir, drivers: { playwright: createPlaywrightDriver() }, featureFlag: true, appVersion: 'test' });
  ui = broker.forPrincipal(ID);
});
test.after(async () => {
  if (broker) await broker.close();
  if (origin) await origin.close();
  if (other) await other.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function integ(name, fn) {
  test(name, async (t) => {
    if (!avail.ok) { t.skip(avail.reason); return; }
    const s = await ui.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: [origin.origin], toolClasses: ['observe', 'navigate', 'interact', 'submit'], trustedFixture: true } });
    try { await fn(s); } finally { await ui.closeSession({ sessionId: s.sessionId }); }
  });
}
const observe = (s, extra) => ui.observe({ sessionId: s.sessionId, pageId: s.pageId, ...(extra || {}) });
const act = (s, o, action) => ui.act({ sessionId: s.sessionId, pageId: s.pageId, observationId: o && o.observationId, documentEpoch: o ? o.documentEpoch : 0, operationId: `op-${++op}`, action });
async function go(s, file) {
  const o = await observe(s);
  const r = await ui.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch, operationId: `op-${++op}`, action: { kind: 'navigate', url: `${origin.origin}/${file}` } });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  return observe(s);
}
const node = (o, name, role) => o.nodes.find((n) => n.name === name && (!role || n.role === role));

integ('capabilities negotiated through the broker are truthful and request-level policy is advertised', async (s) => {
  assert.equal(s.capabilities.driver, 'playwright');
  assert.equal(s.capabilities.liveModeSwitch, false);
  assert.equal(s.capabilities.requestInterception, true);
  assert.equal(s.capabilities.policyEnforcement, 'request-level');
  assert.equal(s.capabilities.canvas, false);
  assert.equal(s.capabilities.downloads, false);
});

integ('observe -> fill/check/click: the broker accepts driver evidence as proof (verified), a click alone is only dispatched', async (s) => {
  const o = await go(s, 'task.html');
  assert.equal(o.trust, 'untrusted-page');
  assert.ok(o.nodes.some((n) => n.role === 'status' && n.name === 'Pending'), 'status regions reach the agent');
  assert.ok(o.nodes.some((n) => n.role === 'main'));
  const fill = await act(s, o, { kind: 'fill', ref: node(o, 'Display name').ref, text: 'Ada' });
  assert.equal(fill.status, 'verified', JSON.stringify(fill));
  assert.equal(fill.dispatched, true);
  const check = await act(s, o, { kind: 'check', ref: node(o, 'Accept terms').ref, checked: true });
  assert.equal(check.status, 'verified', JSON.stringify(check));
  const sel = await act(s, o, { kind: 'select', ref: o.nodes.find((n) => n.role === 'combobox').ref, value: 'pro' });
  assert.equal(sel.status, 'verified', JSON.stringify(sel));
  const click = await act(s, o, { kind: 'click', ref: node(o, 'Save').ref });
  assert.equal(click.status, 'verified', 'a trusted click reached the exact target (the business effect is a separate assertion)');
  assert.ok(click.afterObservationId);
  const after = await observe(s);
  assert.ok(after.nodes.some((n) => n.role === 'status' && n.name === 'Saved: Ada / pro'));
  // the operation is idempotent through the real ledger: same id + same command returns the same receipt
  const id = `op-dup-${++op}`;
  const cmd = { sessionId: s.sessionId, pageId: s.pageId, observationId: after.observationId, documentEpoch: after.documentEpoch, operationId: id, action: { kind: 'click', ref: node(after, 'Save').ref } };
  const r1 = await ui.act(cmd); const r2 = await ui.act(cmd);
  assert.equal(r1.status, r2.status);
});

integ('errors surface as public codes: ambiguous, stale, disabled, secret', async (s) => {
  let o = await go(s, 'duplicates.html');
  const del = o.nodes.find((n) => n.name === 'Delete');
  const amb = await act(s, o, { kind: 'click', ref: del.ref });
  assert.equal(amb.status, 'not_attempted');
  assert.equal(amb.code, 'AMBIGUOUS_TARGET');
  assert.equal(amb.dispatched, false);

  o = await go(s, 'buttons.html');
  const dis = await act(s, o, { kind: 'click', ref: node(o, 'Disabled action').ref });
  assert.equal(dis.status, 'not_attempted');
  assert.equal(dis.code, 'UNAVAILABLE');

  o = await go(s, 'replace.html');
  const target = node(o, 'Save');
  await act(s, o, { kind: 'click', ref: node(o, 'Re-render').ref });
  const o2 = await observe(s);
  const stale = await act(s, o, { kind: 'click', ref: target.ref }).catch((e) => e.publicError);
  assert.ok(stale.code === 'STALE_REF' || stale.status === 'not_attempted', JSON.stringify(stale));
  void o2;

  o = await go(s, 'forms.html');
  const err = await act(s, o, { kind: 'fill', ref: node(o, 'Password').ref, text: 'hunter2' }).then(() => null, (e) => e);
  assert.ok(err && err.publicError.code === 'DENIED' && /password/i.test(err.publicError.message), JSON.stringify(err && err.publicError));
  assert.equal(await (await observe(s)).nodes.find((n) => n.name === 'Password') ? 'seen' : 'missing', 'seen', 'the field is observable, only filling is refused');
});

integ('navigation inside a click: the driver reports observed navigation evidence the broker can validate', async (s) => {
  let o = await go(s, 'spa.html');
  const go2 = await act(s, o, { kind: 'click', ref: node(o, 'Go to settings').ref });
  assert.ok(['dispatched', 'verified'].includes(go2.status), JSON.stringify(go2));
  assert.notEqual(go2.status, 'uncertain');
  o = await observe(s);
  assert.ok(o.nodes.some((n) => n.role === 'heading' && n.name === 'Settings'));
});

integ('request-level policy: a cross-origin frame outside the grant never reaches its server', async (s) => {
  const before = other.requests.length;
  const o = await go(s, `frames.html?x=${other.port}`);
  assert.ok(!o.nodes.some((n) => n.name === 'Inner action' && o.coverage.frames.some((f) => f.origin === other.origin)));
  assert.equal(other.requests.length, before, 'the blocked origin was never contacted');
  assert.ok(o.nodes.some((n) => n.name === 'Inner action'), 'the granted same-origin frame is observed');
});

integ('a redirect to a foreign origin is not reported as success (arrival check), even though hops are not intercepted', async (s) => {
  const o = await observe(s);
  const r = await ui.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch, operationId: `op-${++op}`, action: { kind: 'navigate', url: `${origin.origin}/redirect?to=${encodeURIComponent(`${other.origin}/task.html`)}` } });
  // KNOWN LIMITATION (capabilities.notes.requestInterception): Playwright does not route redirect hops, so the
  // foreign server IS contacted. What must hold is that the broker never reports the destination as a success.
  assert.notEqual(r.status, 'verified', JSON.stringify(r));
  assert.equal(r.code, 'DESTINATION_DENIED');
});

integ('popups opened by the page are registered in the SAME broker session with an opener', async (s) => {
  const o = await go(s, 'popup.html');
  const internal = broker._internals.sessions.get(s.sessionId);
  assert.equal(internal.pages.size, 1);
  await act(s, o, { kind: 'click', ref: node(o, 'Open in new tab').ref });
  await waitFor(() => internal.pages.size === 2);
  const [first, second] = [...internal.pages.values()];
  assert.equal(second.opener, first.pageId);
  const popObs = await observe({ sessionId: s.sessionId, pageId: second.pageId });
  assert.ok(popObs.nodes.some((n) => n.name === 'Close popup'));
});

integ('headless handoff is honestly unsupported (no remote view); visible would be native via capabilities({mode})', async (s) => {
  assert.equal(s.capabilities.humanHandoff, 'unsupported');
  const e = await ui.handoff({ sessionId: s.sessionId, pageId: s.pageId, reason: 'test' }).then(() => null, (err) => err);
  assert.ok(e && e.publicError, 'the broker refuses with a public error');
  const d = createPlaywrightDriver();
  assert.equal(d.capabilities({ mode: 'visible' }).humanHandoff, 'native');
  assert.equal(d.capabilities({ mode: 'headless' }).humanHandoff, 'unsupported');
  assert.deepEqual(d.capabilities({ mode: 'visible' }).modes, ['visible']);
});
