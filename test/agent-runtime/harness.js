'use strict';
// Shared test harness: a real broker over a FakeDriver in a temp data dir.
const assert = require('node:assert/strict');
const { createBroker } = require('../../src/main/services/browser/broker');
const C = require('../../src/shared/browser-contracts');
const { createFakeDriver } = require('./fake-driver');
const { tmp, delay, until, ui, mcp } = require('./helpers');

const AGENT_SCOPES = ['class:observe', 'class:navigate', 'class:interact', 'class:submit', 'origin:https://app.test'];
const GRANT = { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact', 'submit'] };

const planOf = (steps, extra = {}) => ({ schemaVersion: 1, skillId: 'verify-journey', version: '1.0.0', inputKeys: ['name'], maxDurationMs: 20000, steps, ...extra });
const nav = (id, url = 'https://app.test/') => ({ id, type: 'navigate', url });
const click = (id, name, role = 'button') => ({ id, type: 'click', target: { by: 'role', role, name } });
const fill = (id, label, inputKey = 'name') => ({ id, type: 'fill', target: { by: 'label', value: label }, inputKey });
const assertText = (id, expected, name = 'Status') => ({ id, type: 'assert', target: { by: 'role', role: 'status', name }, kind: 'text', op: 'equals', expected });
const journey = () => planOf([nav('s1'), fill('s2', 'Display name'), click('s3', 'Preview'), assertText('s4', 'Previewed')]);

function boot(opts = {}) {
  const dataDir = opts.dataDir || tmp();
  const fake = opts.fake || createFakeDriver(opts.driverOptions);
  const plans = new Map([['verify-journey', journey()]]);
  const skills = {
    resolve: ({ skillId }) => (plans.has(skillId) ? { plan: plans.get(skillId) } : null),
    catalog: () => [...plans.keys()].map((skillId) => ({ skillId, version: '1.0.0' })),
  };
  const broker = createBroker({ dataDir, drivers: { playwright: fake.driver, ...(opts.drivers || {}) }, featureFlag: opts.featureFlag === undefined ? true : opts.featureFlag,
    skills, limits: opts.limits, clock: opts.clock, policy: opts.policy, appVersion: 'test' });
  const agentP = mcp('agent', AGENT_SCOPES);
  const otherP = mcp('other', AGENT_SCOPES);
  const h = { dataDir, fake, broker, plans, skills, agentP, otherP, uiP: ui, a: broker.forPrincipal(agentP), o: broker.forPrincipal(otherP), u: broker.forPrincipal(ui) };
  h.open = async (who = h.a, extra = {}) => {
    const s = await who.openSession({ driver: 'playwright', mode: 'headless', grant: GRANT, ...extra });
    return s;
  };
  return h;
}
const observe = (who, s, extra = {}) => who.observe({ sessionId: s.sessionId, pageId: s.pageId, ...extra });
const nodeNamed = (obs, name) => obs.nodes.find((n) => n.name === name);
let opCounter = 0;
const op = () => `op-${++opCounter}`;
async function act(who, s, obs, action, extra = {}) {
  return who.act({ sessionId: s.sessionId, pageId: s.pageId, observationId: obs.observationId, documentEpoch: obs.documentEpoch, operationId: op(), action, ...extra });
}
async function go(who, s, url = 'https://app.test/') {
  const o = await observe(who, s);
  const r = await who.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch, operationId: op(), action: { kind: 'navigate', url } });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  return observe(who, s);
}
async function waitRun(who, runId, pred = (r) => !['queued', 'running', 'needsApproval', 'needsHuman'].includes(r.state), timeoutMs = 4000) {
  let last;
  await until(async () => { last = await who.getRun({ runId }); assert.deepEqual(C.validateRunDTO(last), [], JSON.stringify(last)); return pred(last); }, { timeoutMs });
  return last;
}
const start = (who, s, extra = {}) => who.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: `rk-${++opCounter}`, skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { name: 'Bob' }, ...extra });
const codeOf = (promise) => promise.then(() => null, (e) => (e.publicError ? e.publicError.code : `RAW:${e.message}`));
const errOf = (promise) => promise.then(() => null, (e) => e);

module.exports = { boot, observe, nodeNamed, act, go, waitRun, start, codeOf, errOf, journey, planOf, nav, click, fill, assertText, GRANT, AGENT_SCOPES, op, delay, until, tmp, ui, mcp, C };
