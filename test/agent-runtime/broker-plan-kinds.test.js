'use strict';
// The closed plan language beyond navigate/click/fill/assert: select, check, press, setViewport, capture and the
// exists / count / url assertions, executed through the REAL broker over the FakeDriver. Also: setViewport as a
// policy-checked, ledgered, epoch-bumping action, capture artifacts, and the broker-side merge of resolved.inputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBroker } = require('../../src/main/services/browser/broker');
const { createFakeDriver } = require('./fake-driver');
const { tmp, until, mcp, ui } = require('./helpers');
const C = require('../../src/shared/browser-contracts');

const SCOPES = ['class:observe', 'class:navigate', 'class:interact', 'origin:https://app.test'];
const GRANT = { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact'] };
const URL0 = 'https://app.test/';

const SITE = {
  'about:blank': { elements: [] },
  [URL0]: { elements: [
    { id: 'h1', role: 'heading', name: 'Home', text: 'Home' },
    { id: 'nav', role: 'navigation', name: 'Primary' },
    { id: 'plan', role: 'combobox', name: 'Plan', value: 'free', onSelect: { setText: { id: 'status', text: 'Plan changed' } } },
    { id: 'terms', role: 'checkbox', name: 'Accept terms', onCheck: { setText: { id: 'status', text: 'Terms accepted' } } },
    { id: 'q', role: 'textbox', name: 'Query', editable: true },
    { id: 'pw', role: 'textbox', name: 'Password', editable: true, traits: ['password'] },
    { id: 'status', role: 'status', name: 'Status', text: '' },
    { id: 'row1', role: 'row', name: 'Row one' }, { id: 'row2', role: 'row', name: 'Row two' },
  ] },
};

const step = {
  nav: (id, url = URL0) => ({ id, type: 'navigate', url }),
  vp: (id, width, height) => ({ id, type: 'setViewport', width, height }),
  cap: (id, label, target) => ({ id, type: 'capture', label, ...(target ? { target } : {}) }),
  assert: (id, kind, expected, target, op = 'equals') => ({ id, type: 'assert', kind, op, expected, ...(target ? { target } : {}) }),
};
const role = (r, name) => ({ by: 'role', role: r, name });
const plan = (steps, extra = {}) => ({ schemaVersion: 1, skillId: 'kinds', version: '1.0.0', inputKeys: [], maxDurationMs: 30000, steps, ...extra });

function rig({ fakeOptions = {}, resolve, limits } = {}) {
  const fake = createFakeDriver({ site: SITE, ...fakeOptions });
  const plans = new Map();
  const skills = {
    resolve: (req) => (resolve ? resolve(req, plans) : (plans.has(req.skillId) ? { plan: plans.get(req.skillId) } : null)),
    catalog: () => [],
  };
  const dataDir = tmp();
  const broker = createBroker({ dataDir, drivers: { playwright: fake.driver }, featureFlag: true, skills, limits, appVersion: 'test' });
  const agent = mcp('agent', SCOPES);
  const a = broker.forPrincipal(agent);
  const open = (grant = GRANT) => a.openSession({ driver: 'playwright', mode: 'headless', grant });
  const run = async (s, p, inputs = {}, extra = {}) => {
    plans.set('kinds', p);
    const started = await a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: `rk-${Math.random()}`, skillId: 'kinds', skillVersion: '1.0.0', inputs, ...extra });
    let last;
    await until(async () => { last = await a.getRun({ runId: started.runId, maxEvents: 100 }); return !['queued', 'running', 'needsApproval', 'needsHuman'].includes(last.state); }, { timeoutMs: 8000 });
    assert.deepEqual(C.validateRunDTO(last), []);
    return last;
  };
  return { fake, broker, a, open, run, plans, dataDir };
}
const elementOf = (fake, id) => fake.firstPage.doc.elements.find((e) => e.id === id);
let ops = 0;
const op = () => `kop-${++ops}`;

test('select, check, press, setViewport, capture and the exists/count/url assertions run end to end and the pass is proven', async () => {
  const r = rig();
  const s = await r.open();
  const p = plan([
    step.nav('s1'),
    step.vp('s2', 375, 812),
    step.cap('s3', 'mobile page'),
    step.assert('s4', 'exists', 'exists', role('navigation', 'Primary')),
    step.assert('s5', 'count', '2', { by: 'role', role: 'row' }), // a role alone means "any name"
    { id: 's6', type: 'select', target: { by: 'label', value: 'Plan' }, inputKey: 'plan' },
    step.assert('s7', 'text', 'Plan changed', role('status', 'Status')),
    { id: 's8', type: 'check', target: role('checkbox', 'Accept terms'), checked: true },
    step.assert('s9', 'text', 'Terms accepted', role('status', 'Status')),
    { id: 's10', type: 'press', target: { by: 'label', value: 'Query' }, key: 'Tab' },
    step.vp('s11', 1280, 800),
    step.cap('s12', 'desktop navigation', role('navigation', 'Primary')),
    step.assert('s13', 'url', 'app.test', undefined, 'contains'),
    step.assert('s14', 'count', '1', role('navigation', 'Primary')),
  ], { inputKeys: ['plan'] });
  const done = await r.run(s, p, { plan: 'pro' });
  assert.equal(done.state, 'passed', JSON.stringify(done.events.slice(-4)));
  assert.equal(done.verdict, 'passed');
  assert.equal(done.evidenceComplete, true);
  assert.equal(done.planned, 14);
  assert.equal(done.requiredAssertions, 6);
  assert.equal(done.passedAssertions, 6, 'captures and viewport changes never count as assertions');
  assert.equal(elementOf(r.fake, 'plan').value, 'pro');
  assert.equal(elementOf(r.fake, 'terms').checked, true);
  const kinds = r.fake.world.dispatchLog.map((d) => d.kind);
  assert.deepEqual(kinds, ['setViewport', 'select', 'check', 'press', 'setViewport'], 'every state change dispatched exactly once');
  assert.deepEqual(r.fake.world.dispatchLog.filter((d) => d.kind === 'setViewport').map((d) => [d.width, d.height]), [[375, 812], [1280, 800]]);
  assert.equal(r.fake.world.captures.length, 2);
  assert.equal(r.fake.world.captures[0].refId, null, 'a page capture needs no ref');
  assert.ok(r.fake.world.captures[1].refId, 'a crop is bound to an observed ref, never a selector');

  const manifest = await r.a.getManifest({ runId: done.runId });
  assert.equal(manifest.committed, true);
  assert.deepEqual(manifest.steps.map((x) => x.type), p.steps.map((x) => x.type));
  const shots = manifest.artifacts.filter((x) => x.kind === 'screenshot');
  const metas = manifest.artifacts.filter((x) => x.kind === 'capture');
  assert.equal(shots.length, 2); assert.equal(metas.length, 2);
  assert.ok(shots.every((x) => x.mime === 'image/png' && x.visibility === 'internal'), 'pixels are internal binary artifacts');
  assert.ok(metas.every((x) => x.visibility === 'public' && x.redaction.applied));
  const meta = JSON.parse((await r.a.readResource(metas[0].uri)).text);
  assert.deepEqual({ transformed: meta.transformed, viewport: meta.viewport, scale: meta.scale, url: meta.url }, { transformed: false, viewport: { width: 375, height: 812 }, scale: 1, url: URL0 });
  assert.deepEqual(Object.keys(meta).sort(), ['capturedAt', 'label', 'scale', 'screenshot', 'scroll', 'stepId', 'transformed', 'url', 'viewport'].sort());
  assert.equal(meta.screenshot.artifactId, shots[0].artifactId);
  assert.equal(meta.screenshot.bytes, shots[0].bytes);
  assert.match(shots[0].sha256, /^[0-9a-f]{64}$/, 'the digest is in the manifest artifact list');
  const crop = JSON.parse((await r.a.readResource(metas[1].uri)).text);
  assert.ok(crop.clip && crop.clip.width > 0, 'a crop records its region'); assert.match(crop.target, /navigation/);
  await r.broker.close();
});

test('captures are evidence only: never returned inline beyond the size cap, never an assertion', async () => {
  const r = rig();
  r.fake.ctl.captureBytes = 300 * 1024;
  const s = await r.open();
  const done = await r.run(s, plan([step.nav('s1'), step.cap('s2', 'big'), step.assert('s3', 'exists', 'exists', role('navigation', 'Primary'))]));
  assert.equal(done.state, 'passed');
  const json = JSON.stringify(done);
  assert.ok(json.length < 8000, 'the run DTO carries ids and counters, not pixels');
  const shot = (await r.a.getManifest({ runId: done.runId })).artifacts.find((x) => x.kind === 'screenshot');
  assert.equal(shot.bytes, 300 * 1024);
  const page = await r.a.readResource(shot.uri);
  assert.equal(page.encoding, 'base64');
  assert.equal(page.truncated, true);
  assert.ok(page.returnedBytes <= 48 * 1024 && page.totalBytes === 300 * 1024 && page.nextCursor, 'one read never exceeds the 64 KiB response cap');
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= C.DEFAULT_MAX_RESPONSE_BYTES);
  // only the owner can read it
  const other = r.broker.forPrincipal(mcp('other', SCOPES));
  assert.equal(await other.readResource(shot.uri).then(() => null, (e) => e.publicError.code), 'DENIED');
  await r.broker.close();
});

test('a capture the driver cannot take honestly is a failed run, never a pass; transformed pixels are refused', async () => {
  for (const [mode, code] of [['invalid', 'CAPTURE_INVALID'], ['empty', 'CAPTURE_INVALID'], ['throw', 'CAPTURE_FAILED']]) {
    const r = rig();
    r.fake.ctl.failCapture = mode;
    const s = await r.open();
    const done = await r.run(s, plan([step.nav('s1'), step.cap('s2', 'x'), step.assert('s3', 'exists', 'exists', role('navigation', 'Primary'))]));
    assert.equal(done.state, 'failed', mode);
    assert.notEqual(done.verdict, 'passed');
    assert.equal((await r.a.getManifest({ runId: done.runId })).steps.find((x) => x.stepId === 's2').code, code, mode);
    assert.equal(done.passedAssertions, 0, 'fail-fast: the later assertion never ran');
    await r.broker.close();
  }
});

test('a capture target must resolve to exactly one element', async () => {
  const r = rig();
  const s = await r.open();
  const ambiguous = await r.run(s, plan([step.nav('s1'), step.cap('s2', 'rows', { by: 'role', role: 'row' }), step.assert('s3', 'exists', 'exists', role('navigation', 'Primary'))]));
  assert.equal(ambiguous.state, 'failed');
  assert.equal((await r.a.getManifest({ runId: ambiguous.runId })).steps.find((x) => x.stepId === 's2').code, 'AMBIGUOUS_TARGET');
  const missing = await r.run(s, plan([step.nav('s1'), step.cap('s2', 'nothing', role('banner', 'Nope')), step.assert('s3', 'exists', 'exists', role('navigation', 'Primary'))]));
  assert.equal((await r.a.getManifest({ runId: missing.runId })).steps.find((x) => x.stepId === 's2').code, 'TARGET_NOT_FOUND');
  assert.equal(r.fake.world.captures.length, 0);
  await r.broker.close();
});

test('unsupported driver capabilities are discovered before anything dispatches', async () => {
  for (const [fakeOptions, steps, detail] of [
    [{ viewport: false }, [step.nav('s1'), step.vp('s2', 375, 812), step.assert('s3', 'url', 'app.test', undefined, 'contains')], /viewport/],
    [{ screenshots: false }, [step.nav('s1'), step.cap('s2', 'x'), step.assert('s3', 'url', 'app.test', undefined, 'contains')], /screenshots/],
  ]) {
    const r = rig({ fakeOptions });
    const s = await r.open();
    r.plans.set('kinds', plan(steps));
    const err = await r.a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk-cap', skillId: 'kinds', skillVersion: '1.0.0' }).then(() => null, (e) => e);
    assert.equal(err.publicError.code, 'UNSUPPORTED');
    assert.match(err.message, detail);
    assert.equal(r.fake.world.inputLog.length, 0);
    await r.broker.close();
  }
});

test('setViewport is an epoch-bumping, policy-checked, ledgered, idempotent action', async () => {
  const r = rig();
  const s = await r.open();
  const nav = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: nav.documentEpoch, operationId: op(), action: { kind: 'navigate', url: URL0 } });
  const before = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  const query = before.nodes.find((n) => n.name === 'Query');
  const operationId = op();
  const input = { sessionId: s.sessionId, pageId: s.pageId, documentEpoch: before.documentEpoch, operationId, action: { kind: 'setViewport', width: 375, height: 812 } };
  const receipt = await r.a.act(input);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.dispatched, true);
  assert.deepEqual(Object.keys(receipt).sort(), ['afterObservationId', 'code', 'dispatched', 'effectUnknown', 'evidenceUri', 'operationId', 'pageId', 'sessionId', 'status']);
  // the old document is gone: refs, observations and the epoch
  const after = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  assert.ok(after.documentEpoch > before.documentEpoch, 'the epoch moved');
  const stale = await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, observationId: before.observationId, documentEpoch: before.documentEpoch, operationId: op(), action: { kind: 'click', ref: query.ref } }).then(() => null, (e) => e);
  assert.equal(stale.publicError.code, 'STALE_REF');
  const staleEpoch = await r.a.act({ ...input, operationId: op(), documentEpoch: before.documentEpoch }).then(() => null, (e) => e);
  assert.equal(staleEpoch.publicError.code, 'STALE_REF', 'an action against the old epoch is refused');
  // ledgered with the size, not just "something happened"
  const entry = r.broker._internals.ledger.get(s.sessionId, operationId);
  assert.equal(entry.summary.kind, 'setViewport'); assert.equal(entry.summary.width, 375); assert.equal(entry.summary.height, 812);
  assert.equal(entry.state, 'result_recorded'); assert.equal(entry.receipt.status, 'verified');
  // idempotent: a replay returns the recorded receipt and emits no second resize
  const dispatches = r.fake.world.dispatchLog.length;
  const again = await r.a.act(input);
  assert.equal(again.status, 'verified');
  assert.equal(r.fake.world.dispatchLog.length, dispatches);
  assert.equal(await r.a.act({ ...input, action: { kind: 'setViewport', width: 400, height: 812 } }).then(() => null, (e) => e.publicError.code), 'DENIED', 'same operationId, different command');
  await r.broker.close();
});

test('setViewport: bounds, grant class and budgets are enforced before anything is dispatched', async () => {
  const r = rig();
  const s = await r.open();
  const o = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  const base = { sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch };
  for (const action of [
    { kind: 'setViewport', width: 239, height: 800 }, { kind: 'setViewport', width: 800, height: 4097 }, { kind: 'setViewport', width: 800.5, height: 800 },
    { kind: 'setViewport', width: '800', height: 800 }, { kind: 'setViewport', width: 800 }, { kind: 'setViewport', width: 800, height: 800, deviceScaleFactor: 3 },
  ]) {
    const err = await r.a.act({ ...base, operationId: op(), action }).then(() => null, (e) => e);
    assert.equal(err.publicError.code, 'DENIED', JSON.stringify(action));
    assert.match(err.message, /INVALID_INPUT/);
  }
  assert.equal(r.fake.world.dispatchLog.length, 0);
  for (const [w, h] of [[240, 240], [4096, 4096]]) {
    assert.equal((await r.a.act({ ...base, documentEpoch: (await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId })).documentEpoch, operationId: op(), action: { kind: 'setViewport', width: w, height: h } })).status, 'verified');
  }
  // a grant without the interact class cannot resize
  const observeOnly = await r.open({ allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate'] });
  const oo = await r.a.observe({ sessionId: observeOnly.sessionId, pageId: observeOnly.pageId });
  const denied = await r.a.act({ sessionId: observeOnly.sessionId, pageId: observeOnly.pageId, documentEpoch: oo.documentEpoch, operationId: op(), action: { kind: 'setViewport', width: 500, height: 500 } }).then(() => null, (e) => e);
  assert.equal(denied.publicError.code, 'DENIED');
  // the action budget applies
  const tight = await r.open({ ...GRANT, budgets: { maxActions: 1 } });
  const to = await r.a.observe({ sessionId: tight.sessionId, pageId: tight.pageId });
  const one = { sessionId: tight.sessionId, pageId: tight.pageId, documentEpoch: to.documentEpoch, action: { kind: 'setViewport', width: 500, height: 500 } };
  assert.equal((await r.a.act({ ...one, operationId: op() })).status, 'verified');
  const over = await r.a.act({ ...one, documentEpoch: (await r.a.observe({ sessionId: tight.sessionId, pageId: tight.pageId })).documentEpoch, operationId: op() }).then(() => null, (e) => e);
  assert.equal(over.publicError.code, 'DENIED');
  await r.broker.close();
});

test('setViewport: refs die even when the driver forgets to announce the resize; an unverified read-back is only "dispatched"', async () => {
  const r = rig({});
  r.fake.ctl.noViewportEpochBump = true;
  const s = await r.open();
  const nav = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: nav.documentEpoch, operationId: op(), action: { kind: 'navigate', url: URL0 } });
  const before = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  const receipt = await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: before.documentEpoch, operationId: op(), action: { kind: 'setViewport', width: 500, height: 500 } });
  assert.equal(receipt.status, 'verified');
  const click = await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, observationId: before.observationId, documentEpoch: before.documentEpoch, operationId: op(), action: { kind: 'check', ref: before.nodes.find((n) => n.name === 'Accept terms').ref, checked: true } }).then(() => null, (e) => e);
  assert.equal(click.publicError.code, 'STALE_REF', 'the broker invalidated the page itself');
  assert.equal(r.fake.world.dispatchLog.filter((d) => d.kind === 'check').length, 0);

  r.fake.ctl.viewportMismatch = true;
  const o2 = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  const unverified = await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o2.documentEpoch, operationId: op(), action: { kind: 'setViewport', width: 600, height: 600 } });
  assert.equal(unverified.status, 'dispatched', 'the size was not read back');
  // inside a run that is an unconfirmed effect: the run cannot pass
  const done = await r.run(s, plan([step.vp('s1', 700, 700), step.assert('s2', 'url', 'app.test', undefined, 'contains')]));
  assert.notEqual(done.verdict, 'passed');
  assert.equal(done.state, 'uncertain');
  await r.broker.close();
});

test('a resize during a run invalidates earlier observations: later steps re-resolve by a fresh observation', async () => {
  const r = rig();
  const s = await r.open();
  const done = await r.run(s, plan([
    step.nav('s1'), step.vp('s2', 400, 700),
    { id: 's3', type: 'check', target: role('checkbox', 'Accept terms'), checked: true },
    step.vp('s4', 900, 700),
    step.assert('s5', 'text', 'Terms accepted', role('status', 'Status')),
  ]));
  assert.equal(done.state, 'passed', JSON.stringify(done.events.slice(-3)));
  await r.broker.close();
});

// ---- resolved.inputs ---------------------------------------------------------------------------------------------
test('the broker merges resolved.inputs itself: only declared string keys, bounded, never into the caller\'s object', async () => {
  let seen = null;
  const r = rig({
    resolve: (req, plans) => {
      seen = req.inputs;
      req.inputs.name = 'MUTATED-BY-RESOLVER'; // a resolver scribbling on its argument must change nothing
      return { plan: plans.get(req.skillId), inputs: { plan: 'pro', name: 'Derived', undeclared: 'x', object: { a: 1 }, huge: 'x'.repeat(20000), n: 5 }, argumentKeys: [] };
    },
  });
  const s = await r.open();
  const p = plan([step.nav('s1'),
    { id: 's2', type: 'fill', target: { by: 'label', value: 'Query' }, inputKey: 'name' },
    { id: 's3', type: 'select', target: { by: 'label', value: 'Plan' }, inputKey: 'plan' },
    step.assert('s4', 'text', 'Plan changed', role('status', 'Status'))], { inputKeys: ['name', 'plan'] });
  const client = { name: 'Bob' };
  const done = await r.run(s, p, client);
  assert.equal(done.state, 'passed', JSON.stringify(done.events.slice(-3)));
  assert.deepEqual(client, { name: 'Bob' }, 'the caller\'s object is untouched');
  assert.equal(elementOf(r.fake, 'plan').value, 'pro', 'a derived input reached the select');
  assert.equal(elementOf(r.fake, 'q').value, 'Derived', 'the resolver is authoritative for the keys it returns');
  assert.ok(seen && seen !== client, 'the resolver got a copy');
  await r.broker.close();
  const all = fs.readdirSync(r.dataDir, { recursive: true }).map((f) => path.join(r.dataDir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!all.includes('Derived') && !all.includes('MUTATED') && !all.includes('"x".repeat'), 'input values are never persisted');
});

test('a derived input that is missing, too long or not a string fails the run before any dispatch', async () => {
  for (const inputs of [{}, { name: 5 }, { name: 'x'.repeat(10001) }, { other: 'x' }]) {
    const r = rig({ resolve: (req, plans) => ({ plan: plans.get(req.skillId), inputs }) });
    const s = await r.open();
    r.plans.set('kinds', plan([step.nav('s1'), { id: 's2', type: 'fill', target: { by: 'label', value: 'Query' }, inputKey: 'name' }, step.assert('s3', 'url', 'app.test', undefined, 'contains')], { inputKeys: ['name'] }));
    const err = await r.a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk-m', skillId: 'kinds', skillVersion: '1.0.0', inputs: {} }).then(() => null, (e) => e);
    assert.equal(err.publicError.code, 'DENIED', JSON.stringify(inputs).slice(0, 40));
    assert.match(err.message, /missing input/);
    assert.equal(r.fake.world.inputLog.length, 0);
    await r.broker.close();
  }
});

test('structured skill arguments are accepted only for keys the resolver consumed; plan inputs must be strings', async () => {
  const r = rig({ resolve: (req, plans) => ({ plan: plans.get(req.skillId), inputs: {}, argumentKeys: ['url', 'landmarks'] }) });
  const s = await r.open();
  const p = plan([step.nav('s1'), step.assert('s2', 'url', 'app.test', undefined, 'contains')]);
  r.plans.set('kinds', p);
  const start = (inputs, key) => r.a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: key, skillId: 'kinds', skillVersion: '1.0.0', inputs });
  const ok = await start({ url: URL0, landmarks: [{ role: 'navigation', name: 'Primary' }] }, 'rk-ok');
  assert.ok(ok.runId);
  assert.equal(await start({ url: URL0, extra: 'x' }, 'rk-extra').then(() => null, (e) => e.publicError.code), 'DENIED', 'unknown keys are refused, not ignored');
  assert.equal(await start({ url: 'x'.repeat(10001) }, 'rk-long').then(() => null, (e) => e.publicError.code), 'DENIED');
  assert.equal(await start({ landmarks: new Array(600).fill(1) }, 'rk-complex').then(() => null, (e) => e.publicError.code), 'DENIED');
  let deep = {}; const root = deep; for (let i = 0; i < 8; i += 1) { deep.a = {}; deep = deep.a; }
  assert.equal(await start({ landmarks: root }, 'rk-deep').then(() => null, (e) => e.publicError.code), 'DENIED');
  // a declared plan input must be a string
  r.plans.set('kinds', plan([step.nav('s1'), step.assert('s2', 'url', 'app.test', undefined, 'contains')], { inputKeys: ['name'] }));
  assert.equal(await start({ name: 5 }, 'rk-num').then(() => null, (e) => e.publicError.code), 'DENIED');
  // retry reuses the original arguments
  const finished = await (async () => { let last; await until(async () => { last = await r.a.getRun({ runId: ok.runId }); return last.state !== 'queued' && last.state !== 'running'; }); return last; })();
  assert.equal(finished.state, 'passed');
  await r.broker.close();
});

test('retry reuses the original arguments (structured ones included) and rejects different ones', async () => {
  const r = rig({ resolve: (req, plans) => ({ plan: plans.get(req.skillId), inputs: {}, argumentKeys: ['landmarks'] }) });
  const s = await r.open();
  r.fake.ctl.failNavigation = true; // first attempt fails
  const args = { landmarks: [{ role: 'navigation', name: 'Primary' }] };
  const failed = await r.run(s, plan([step.nav('s1'), step.assert('s2', 'url', 'app.test', undefined, 'contains')]), args);
  assert.notEqual(failed.state, 'passed');
  r.fake.ctl.failNavigation = false;
  const retried = await r.a.retryRun({ runId: failed.runId, requestKey: 'rk-retry' });
  let last;
  await until(async () => { last = await r.a.getRun({ runId: retried.runId }); return !['queued', 'running'].includes(last.state); });
  assert.equal(last.state, 'passed');
  assert.equal(await r.a.retryRun({ runId: failed.runId, requestKey: 'rk-retry2', inputs: { landmarks: [] } }).then(() => null, (e) => e.publicError.code), 'DENIED');
  await r.broker.close();
});

test('unknown action and step kinds still fail closed', async () => {
  const r = rig();
  const s = await r.open();
  const o = await r.a.observe({ sessionId: s.sessionId, pageId: s.pageId });
  assert.equal(await r.a.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch, operationId: op(), action: { kind: 'evaluate', code: '1' } }).then(() => null, (e) => e.publicError.code), 'UNSUPPORTED');
  r.plans.set('kinds', { ...plan([step.nav('s1')]), steps: [{ id: 'z', type: 'screenshotFull', label: 'x' }] });
  assert.equal(await r.a.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: 'rk-u', skillId: 'kinds', skillVersion: '1.0.0' }).then(() => null, (e) => e.publicError.code), 'UNSUPPORTED');
  void ui;
  await r.broker.close();
});
