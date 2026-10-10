'use strict';
// Randomised event-order tests (audit "Release acceptance": at least 1,000
// seeded cases per ownership/cancellation scenario with zero false passes,
// cross-session effects, duplicate dispatches or synthetic-secret leaks).
//
// Every case is reproducible from its seed: failures print `seed=<n>`.
// BRAIWSER_FUZZ_CASES overrides the case count (default 1000 per scenario);
// BRAIWSER_FUZZ_SEED shifts the seed space.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBroker } = require('../../src/main/services/browser/broker');
const { createFakeDriver, mulberry32 } = require('./fake-driver');
const { tmp, delay, ui } = require('./helpers');
const H = require('./harness');
const C = require('../../src/shared/browser-contracts');

const CASES = Number(process.env.BRAIWSER_FUZZ_CASES || 1000);
const SEED0 = Number(process.env.BRAIWSER_FUZZ_SEED || 20261009);
const BATCH = 40;
const CANARY = 'FUZZCANARY-7f3a91c2-never-on-disk';
const noSyncFs = { ...fs, fsyncSync: () => {} }; // durability is covered elsewhere; keep thousands of cases fast

function makeEnv(extraLimits = {}) {
  const dataDir = tmp('braiwser-fuzz-');
  const router = { current: null, driver: null };
  router.driver = { name: 'playwright', capabilities: () => router.current.driver.capabilities(), open: (o) => router.current.driver.open(o) };
  const plans = new Map([['verify-journey', H.journey()]]);
  const skills = { resolve: ({ skillId }) => (plans.has(skillId) ? { plan: plans.get(skillId) } : null) };
  const broker = createBroker({ dataDir, drivers: { playwright: router.driver }, featureFlag: true, skills, fs: noSyncFs,
    limits: { maxSessions: 1000, maxSessionsPerPrincipal: 1000, stepTimeoutMs: 80, humanWaitMs: 300, approvalWaitMs: 300, drainTimeoutMs: 150, observeTimeoutMs: 500, ...extraLimits } });
  return { dataDir, router, broker, u: broker.forPrincipal(ui), plans };
}
const GRANT = { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact', 'submit'], trustedFixture: true };
async function openOn(env, fake, extra = {}) {
  env.router.current = fake; // consumed synchronously by openSession
  return env.u.openSession({ driver: 'playwright', mode: 'headless', grant: GRANT, ...extra });
}
const everythingOnDisk = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const stats = { receipts: {}, codes: {}, runs: {}, uncertainRuns: 0, takeovers: 0 };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
let opSeq = 0;
const newOp = (seed) => `f${seed}-${++opSeq}`;

async function runBatches(total, fn) {
  const violations = [];
  for (let i = 0; i < total; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(total, i + BATCH); j++) batch.push(fn(SEED0 + j).catch((e) => [`seed=${SEED0 + j} case threw: ${e && e.stack || e}`]));
    for (const v of await Promise.all(batch)) violations.push(...v);
    if (violations.length > 5) break;
  }
  return violations;
}

// ======================================================================================
// Scenario A: ownership. Two sessions share one fake world; clicks, fills, navigations,
// late (hung) clicks, aborts, SPA navigations, crashes, popups, takeovers and resumes
// happen in a random interleaving.
// ======================================================================================
async function ownershipCase(env, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = (xs) => xs[Math.floor(rng() * xs.length)];
  const v = [];
  const fake = createFakeDriver({ seed });
  fake.ctl.jitter = true;
  fake.ctl.delays = { observe: R(0, 6), resolve: R(0, 8), act: R(0, 12), navigate: R(0, 8), assertion: 0 };
  const sA = await openOn(env, fake); const sB = await openOn(env, fake);
  const sessions = [sA, sB];
  const fakePages = fake.lastSession && [...fake.sessions.map((s) => [...s.pages.values()][0])];
  const pageMap = { [sA.pageId]: fakePages[0].pageId, [sB.pageId]: fakePages[1].pageId };
  fake.ctl.snapshotOwner = ({ sessionId, pageId }) => {
    const s = env.broker._internals.sessions.get(sessionId); const p = s && s.pages.get(pageId);
    return { lease: s && s.lease.owner, page: p && p.owned.owner };
  };
  const receipts = [];
  const note = (r) => { if (r && r.operationId) receipts.push(r); return r; };
  const task = async (fn) => { await delay(R(0, 14)); try { return await fn(); } catch (e) { return e; } };
  const jobs = [];
  const release = [];
  const actOn = async (s, kind, extra = {}) => {
    const o = await env.u.observe({ sessionId: s.sessionId, pageId: s.pageId });
    const names = kind === 'fill' ? ['Display name'] : ['Preview', 'Same', 'Next', 'Back', 'Pay now'];
    const node = o.nodes.find((n) => names.includes(n.name)) || o.nodes[0];
    if (!node) return null;
    const action = kind === 'fill' ? { kind: 'fill', ref: node.ref, text: `${CANARY}-${seed}` } : { kind: 'click', ref: node.ref };
    const input = { sessionId: s.sessionId, pageId: s.pageId, observationId: o.observationId, documentEpoch: o.documentEpoch, operationId: newOp(seed), action, timeoutMs: extra.timeoutMs || 500 };
    const ac = extra.abortAfter !== undefined ? new AbortController() : null;
    if (ac) setTimeout(() => ac.abort(), extra.abortAfter);
    const first = env.u.act(input, ac ? { signal: ac.signal } : undefined);
    if (extra.duplicate) { jobs.push(task(async () => note(await env.u.act(input)))); }
    return note(await first);
  };
  const n = R(10, 18);
  for (let i = 0; i < n; i++) {
    const s = pick(sessions);
    const kind = pick(['click', 'click', 'click', 'click', 'fill', 'fill', 'fill', 'navigate', 'late', 'handoff', 'resume', 'spa', 'crash', 'popup', 'abort', 'dup', 'dup']);
    jobs.push(task(async () => {
      switch (kind) {
        case 'click': return actOn(s, 'click');
        case 'fill': return actOn(s, 'fill');
        case 'dup': return actOn(s, 'click', { duplicate: true });
        case 'abort': return actOn(s, 'click', { abortAfter: R(0, 10) });
        case 'navigate': {
          const o = await env.u.observe({ sessionId: s.sessionId, pageId: s.pageId });
          return note(await env.u.act({ sessionId: s.sessionId, pageId: s.pageId, documentEpoch: o.documentEpoch, operationId: newOp(seed), action: { kind: 'navigate', url: pick(['https://app.test/', 'https://app.test/two']) }, timeoutMs: 500 }));
        }
        case 'late': {
          let rel; fake.ctl.hang = new Promise((r) => { rel = r; }); release.push(rel);
          setTimeout(() => { rel(); fake.ctl.hang = null; }, R(15, 60));
          return actOn(s, 'click', { timeoutMs: R(10, 30) });
        }
        case 'handoff': return env.u.handoff({ sessionId: s.sessionId, pageId: s.pageId, reason: 'fuzz' });
        case 'resume': return env.u.resume({ sessionId: s.sessionId, pageId: s.pageId });
        case 'spa': { const p = fakePages[sessions.indexOf(s)]; p.events.emit('navigated', { url: p.url() }); return null; }
        case 'crash': if (rng() < 0.4) fakePages[sessions.indexOf(s)].crash(); return null;
        case 'popup': { const p = fakePages[sessions.indexOf(s)].openPopup('https://app.test/two'); if (rng() < 0.7) p.closePage(); return null; }
        default: return null;
      }
    }));
  }
  await Promise.all(jobs.map((j) => j.catch(() => {})));
  for (const r of release) r();
  fake.ctl.hang = null;
  await delay(60);
  for (const r of receipts) { bump(stats.receipts, r.status); bump(stats.codes, r.code); }
  const sub = (s) => `seed=${seed} ${s}`;

  const log = fake.world.inputLog;
  const byOp = new Map();
  for (const e of log) byOp.set(e.operationId, (byOp.get(e.operationId) || 0) + 1);
  for (const [opId, c] of byOp) if (c > 1) v.push(sub(`DUPLICATE dispatch of ${opId} x${c}`));
  for (const e of log) {
    if (!e.owner || e.owner.lease !== 'agent' || e.owner.page !== 'agent') v.push(sub(`input emitted while ownership was ${JSON.stringify(e.owner)} (${e.operationId})`));
    if (pageMap[e.pageId] !== e.fakePageId) v.push(sub(`CROSS-PAGE effect: broker page ${e.pageId} drove ${e.fakePageId}`));
    if (![sA.sessionId, sB.sessionId].includes(e.sessionId)) v.push(sub('effect from an unknown session'));
  }
  const ledger = env.broker._internals.ledger;
  const ops = [sA, sB].flatMap((s) => ledger.list({ sessionId: s.sessionId }));
  for (const o of ops) {
    const count = byOp.get(o.operationId) || 0;
    if (!o.receipt) { v.push(sub(`unresolved ledger op ${o.operationId} (${o.state})`)); continue; }
    if (o.receipt.status === 'not_attempted' && count !== 0) v.push(sub(`op ${o.operationId} recorded not_attempted but input was emitted`));
    if (['dispatched', 'verified', 'uncertain'].includes(o.receipt.status) && count !== 1) v.push(sub(`op ${o.operationId} recorded ${o.receipt.status} but emitted ${count} inputs`));
  }
  const known = new Set(ops.map((o) => o.operationId));
  for (const e of log) if (!known.has(e.operationId)) v.push(sub(`input ${e.operationId} was emitted without a ledger record`));
  for (const r of receipts) {
    if (r.status === 'verified') {
      const rec = ledger.get(r.sessionId, r.operationId);
      if (!rec || !rec.receipt || rec.receipt.status !== 'verified' || (byOp.get(r.operationId) || 0) !== 1) v.push(sub(`FALSE PASS: ${r.operationId} reported verified`));
    }
    if (r.status === 'not_attempted' && (byOp.get(r.operationId) || 0) !== 0) v.push(sub(`receipt not_attempted for emitted op ${r.operationId}`));
  }
  await Promise.all([env.u.closeSession({ sessionId: sA.sessionId }), env.u.closeSession({ sessionId: sB.sessionId })]);
  return v;
}

test(`ownership: ${CASES} seeded random event orders - zero duplicate dispatches, zero input without the lease, zero cross-session effects, zero false passes`, { timeout: 240000 }, async (t) => {
  const env = makeEnv();
  const violations = await runBatches(CASES, (seed) => ownershipCase(env, seed));
  assert.deepEqual(violations.slice(0, 5), []);
  t.diagnostic(`receipts ${JSON.stringify(stats.receipts)} codes ${JSON.stringify(stats.codes)}`);
  await env.broker.close();
  assert.ok(!everythingOnDisk(env.dataDir).includes(CANARY), 'synthetic secret leaked into the ledger/evidence');
});

// ======================================================================================
// Scenario B: cancellation / takeover / crash against durable runs.
// ======================================================================================
async function cancellationCase(env, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const v = []; const sub = (s) => `seed=${seed} ${s}`;
  const fake = createFakeDriver({ seed });
  fake.ctl.jitter = true;
  fake.ctl.delays = { observe: R(0, 6), resolve: R(0, 6), act: R(0, 12), navigate: R(0, 8), assertion: R(0, 8) };
  if (rng() < 0.05) fake.ctl.evidenceMode = 'none';
  const s = await openOn(env, fake);
  fake.ctl.snapshotOwner = ({ sessionId, pageId }) => { const ss = env.broker._internals.sessions.get(sessionId); const p = ss && ss.pages.get(pageId); return { lease: ss && ss.lease.owner, page: p && p.owned.owner }; };
  const page = fake.firstPage;
  const run = await env.u.startRun({ sessionId: s.sessionId, pageId: s.pageId, requestKey: `fz-${seed}`, skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { name: `${CANARY}-${seed}` } });
  const actors = [];
  let fence = null; let cancelled = false;
  const at = (ms, fn) => actors.push(delay(ms).then(fn).catch(() => {}));
  if (rng() < 0.6) at(R(0, 110), async () => { const p = env.u.cancelRun({ runId: run.runId }); fence = fake.world.inputLog.length; const r = await p; if (r.cancelRequested) cancelled = true; else fence = null; });
  if (rng() < 0.35) { const t = R(0, 50); at(t, () => env.u.handoff({ sessionId: s.sessionId, pageId: s.pageId, runId: run.runId, reason: 'fuzz' })); if (rng() < 0.8) at(t + R(5, 40), () => env.u.resume({ sessionId: s.sessionId, pageId: s.pageId })); }
  if (rng() < 0.15) at(R(0, 50), () => { page.events.emit('navigated', { url: page.url() }); });
  if (rng() < 0.05) at(R(0, 50), () => page.crash());
  if (rng() < 0.1) { let rel; fake.ctl.hang = new Promise((r) => { rel = r; }); at(R(20, 90), () => { rel(); fake.ctl.hang = null; }); }
  await Promise.all(actors);
  let last;
  const t0 = Date.now();
  for (;;) {
    last = await env.u.getRun({ runId: run.runId });
    if (!['queued', 'running', 'needsApproval', 'needsHuman'].includes(last.state)) break;
    if (Date.now() - t0 > 4000) { v.push(sub(`run stuck in ${last.state}`)); break; }
    await delay(5);
  }
  await delay(30); // let any late driver work land before judging
  const dto = await env.u.getRun({ runId: run.runId });
  bump(stats.runs, dto.state); if (dto.uncertainEffect) stats.uncertainRuns++;
  const problems = C.validateRunDTO(dto); if (problems.length) v.push(sub(`invalid DTO: ${problems.join(',')}`));
  const log = fake.world.inputLog;
  const byOp = new Map(); for (const e of log) byOp.set(e.operationId, (byOp.get(e.operationId) || 0) + 1);
  for (const [o, c] of byOp) if (c > 1) v.push(sub(`DUPLICATE dispatch of ${o}`));
  const kinds = log.map((e) => e.kind);
  if (kinds.filter((k) => k === 'fill').length > 1 || kinds.filter((k) => k === 'click').length > 1) v.push(sub(`a planned step was dispatched twice: ${kinds}`));
  for (const e of log) if (!e.owner || e.owner.lease !== 'agent' || e.owner.page !== 'agent') v.push(sub(`input while ownership was ${JSON.stringify(e.owner)}`));
  if (fence !== null && log.length > fence) v.push(sub(`dispatch after the cancellation fence (${log.length} > ${fence})`));
  if (dto.verdict === 'passed') {
    const statusText = (page.doc.elements.find((e) => e.id === 'status') || {}).text;
    if (dto.state !== 'passed') v.push(sub('verdict passed but state not passed'));
    if (dto.cancelRequested || cancelled) v.push(sub(`FALSE PASS after cancellation (requested=${dto.cancelRequested}, cancelled=${cancelled})`));
    if (dto.uncertainEffect) v.push(sub('FALSE PASS with an uncertain effect'));
    if (!dto.evidenceComplete) v.push(sub('FALSE PASS without complete evidence'));
    if (statusText !== 'Previewed') v.push(sub(`FALSE PASS: oracle says the page status is ${JSON.stringify(statusText)}`));
    if (kinds.join() !== 'navigate,fill,click') v.push(sub(`FALSE PASS: inputs were ${kinds}`));
    const m = await env.u.getManifest({ runId: run.runId });
    if (!m.committed || m.terminal.verdict !== 'passed') v.push(sub('FALSE PASS without a committed manifest'));
  }
  if (cancelled && dto.state === 'passed') v.push(sub('cancelled run reported passed'));
  if (!['queued', 'running', 'needsApproval', 'needsHuman'].includes(dto.state) && dto.verdict === 'pending') v.push(sub('terminal state with pending verdict'));
  for (const o of env.broker._internals.ledger.list({ sessionId: s.sessionId })) if (!o.receipt) v.push(sub(`unresolved ledger op ${o.operationId}`));
  await env.u.closeSession({ sessionId: s.sessionId });
  return v;
}

test(`cancellation/takeover: ${CASES} seeded random orders - no dispatch after the fence, no duplicate dispatch, no false pass`, { timeout: 280000 }, async (t) => {
  const env = makeEnv();
  const violations = await runBatches(CASES, (seed) => cancellationCase(env, seed));
  assert.deepEqual(violations.slice(0, 5), []);
  t.diagnostic(`run states ${JSON.stringify(stats.runs)} uncertain-effect runs ${stats.uncertainRuns}`);
  await env.broker.close();
  assert.ok(!everythingOnDisk(env.dataDir).includes(CANARY), 'run input leaked to disk');
});
