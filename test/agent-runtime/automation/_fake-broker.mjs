// In-test fake broker implementing docs/AGENT_RUNTIME_CONTRACT.md closely enough
// to exercise the MCP/CLI/bridge adapters: per-principal ownership, STALE_REF /
// AMBIGUOUS_TARGET / DENIED classification, operationId + requestKey
// de-duplication, and run DTOs graded by the REAL review/verdict.js runVerdict.
// It is a test double for the ADAPTER layer, not a model of the real broker.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runVerdict } = require('../../../src/main/services/review/verdict.js');

export function err(code, message, extra = {}) {
  const e = new Error(message);
  e.publicError = { code, message, dispatched: false, effectUnknown: false, retry: 'never', ...extra };
  return e;
}

export const PAGE_NODES = [
  { refId: 'r_save', role: 'button', name: 'Save', enabled: true },
  { refId: 'r_name', role: 'textbox', name: 'Display name', editable: true },
  { refId: 'r_pw', role: 'textbox', name: 'Password', editable: true, secret: true },
  { refId: 'r_dup1', role: 'button', name: 'Delete', enabled: true },
  { refId: 'r_dup2', role: 'button', name: 'Delete', enabled: true, ambiguousWith: 'r_dup1' },
  { refId: 'r_maybe', role: 'button', name: 'Pay', enabled: true, outcome: 'uncertain' },
  { refId: 'r_plain', role: 'link', name: 'Docs', enabled: true, outcome: 'dispatched' },
];

export function createFakeBroker(options = {}) {
  let counter = 0;
  const next = (p) => `${p}_${++counter}`;
  const sessions = new Map();
  const observations = new Map();
  const ops = new Map();
  const runs = new Map();
  const requestKeys = new Map();
  const calls = [];
  const state = { calls, corrupt: null, hold: null };

  const own = (principal, sessionId, pageId) => {
    const s = sessions.get(sessionId);
    // Unknown and foreign are indistinguishable: possession of an id is not authority.
    if (!s || s.owner !== principal.id) throw err('DENIED', 'Not permitted.');
    const p = pageId ? s.pages.get(pageId) : null;
    if (pageId && !p) throw err('DENIED', 'Not permitted.');
    return { s, p };
  };
  const ownRun = (principal, runId) => {
    const r = runs.get(runId);
    if (!r || r.owner !== principal.id) throw err('DENIED', 'Not permitted.');
    return r;
  };

  function runDto(run, afterSequence = 0, maxEvents = 30) {
    const terminalMap = { passed: 'completed', failed: 'completed', cancelled: 'cancelled', timedOut: 'timedOut', uncertain: 'unknown', interrupted: 'unknown' };
    const active = !terminalMap[run.state];
    const v = runVerdict({ plannedStepIds: run.stepIds, assertionStepIds: run.assertionIds, results: run.results,
      terminal: active ? 'unknown' : terminalMap[run.state], evidenceComplete: run.evidenceComplete });
    let verdict;
    if (active) verdict = 'pending';
    else if (run.state === 'uncertain' || run.state === 'interrupted') verdict = 'unknown';
    else verdict = v.status;
    const events = run.events.filter((e) => e.sequence >= afterSequence).slice(0, maxEvents);
    const dto = {
      runId: run.runId, state: run.state, verdict, sequence: run.events.length,
      cancelRequested: run.cancelRequested,
      planned: v.planned, executed: v.executed, passed: v.passed, skipped: v.skipped, cancelled: v.cancelled,
      timedOut: v.timedOut, evidenceComplete: v.evidenceComplete, uncertainEffect: v.uncertainEffect,
      requiredAssertions: v.requiredAssertions, passedAssertions: v.passedAssertions,
      deadlineAt: run.deadlineAt, pending: v.pending, failed: v.failed, unknown: v.unknown,
      events, nextSequence: events.length ? events[events.length - 1].sequence + 1 : afterSequence,
      manifestUri: `braiwser://runs/${run.runId}/manifest`,
    };
    if (state.corrupt === 'passed-without-proof' && run.state !== 'queued') {
      return { ...dto, state: 'passed', verdict: 'passed', evidenceComplete: false };
    }
    if (state.corrupt === 'extra-field') return { ...dto, internalDebug: 'LEAK' };
    return dto;
  }

  const broker = {
    state,
    // ---- test controls
    finish(runId, { state: next, results, evidenceComplete = true }) {
      const run = runs.get(runId);
      run.state = next; run.results = results; run.evidenceComplete = evidenceComplete;
      run.events.push({ sequence: run.events.length, kind: 'terminal', summary: `run ${next}` });
    },
    run(runId) { return runs.get(runId); },
    forPrincipal(principal) {
      const ctxFor = (ctx) => ({ ...(ctx || {}), principal });
      const log = (name, args, ctx) => calls.push({ name, args, principal: principal.id, signal: ctx && ctx.signal });
      return {
        principalBound: true,
        async openSession(args, ctx) {
          log('openSession', args, ctx);
          if (!args.grant || !Array.isArray(args.grant.allowedOrigins) || !args.grant.allowedOrigins.includes('https://app.test')) throw err('DENIED', 'The grant is outside the scope of this client.');
          const sessionId = next('bs'), pageId = next('pg');
          sessions.set(sessionId, { owner: principal.id, epoch: 1, pages: new Map([[pageId, { epoch: 1, nodes: options.nodes || PAGE_NODES, handoff: options.handoff || 'native' }]]) });
          return { sessionId, pageId, capabilities: { driver: args.driver, version: 1, humanHandoff: 'native', password: undefined }, limits: { maxNodes: 200 } };
        },
        async closeSession({ sessionId }, ctx) { log('closeSession', { sessionId }, ctx); own(principal, sessionId); sessions.delete(sessionId); return { closed: true }; },
        async observe(args, ctx) {
          log('observe', args, ctx);
          if (state.hold) await state.hold(ctx);
          const { p } = own(principal, args.sessionId, args.pageId);
          const all = p.nodes;
          const size = Math.min(args.maxNodes || 80, options.pageSize || 200);
          const start = args.cursor ? Number(args.cursor.replace('c', '')) : 0;
          const slice = all.slice(start, start + size);
          const observationId = next('ob');
          const nextCursor = start + size < all.length ? `c${start + size}` : null;
          observations.set(observationId, { sessionId: args.sessionId, pageId: args.pageId, epoch: p.epoch, refs: new Set(slice.map((n) => n.refId)) });
          return {
            sessionId: args.sessionId, pageId: args.pageId, observationId, documentEpoch: p.epoch, url: 'https://example.test/settings?token=PAGE_TOKEN',
            trust: 'untrusted-page',
            nodes: slice.map(({ refId, role, name, enabled, editable }) => ({ refId, role, name, enabled, editable })),
            coverage: { framesSeen: 1, framesUnavailable: 0, nodesReturned: slice.length }, truncated: nextCursor !== null, nextCursor,
            evidenceUri: `braiwser://runs/run_ev/observations/${observationId}`,
          };
        },
        async act(args, ctx) {
          log('act', args, ctx);
          const { p } = own(principal, args.sessionId, args.pageId);
          if (ops.has(args.operationId)) return ops.get(args.operationId);
          const ob = observations.get(args.observationId);
          if (!ob || ob.pageId !== args.pageId || ob.sessionId !== args.sessionId) throw err('STALE_REF', 'Unknown observation.', { retry: 'refresh' });
          if (ob.epoch !== p.epoch || args.documentEpoch !== p.epoch) throw err('STALE_REF', 'Document changed.', { retry: 'refresh' });
          const a = args.action;
          if (a.kind !== 'navigate') {
            if (!ob.refs.has(a.ref)) throw err('STALE_REF', 'Unknown ref.', { retry: 'refresh' });
            const node = p.nodes.find((n) => n.refId === a.ref);
            if (node.ambiguousWith || p.nodes.some((n) => n.ambiguousWith === a.ref)) throw err('AMBIGUOUS_TARGET', 'Several controls match.', { retry: 'refresh' });
            if (a.kind === 'fill' && node.secret) throw err('DENIED', 'Secret fields cannot be filled by an agent.');
          }
          const node = a.kind === 'navigate' ? {} : p.nodes.find((n) => n.refId === a.ref);
          const status = node.outcome || 'verified';
          const receipt = {
            operationId: args.operationId, sessionId: args.sessionId, pageId: args.pageId, status,
            code: status === 'verified' ? 'OK' : status === 'uncertain' ? 'EFFECT_UNKNOWN' : 'OUTCOME_NOT_VERIFIED',
            dispatched: true, effectUnknown: status !== 'verified', afterObservationId: next('ob'),
            evidenceUri: `braiwser://runs/run_ev/operations/${args.operationId}`,
          };
          if (a.kind === 'click' || a.kind === 'navigate') p.epoch += 1;
          ops.set(args.operationId, receipt);
          return receipt;
        },
        async startRun(args, ctx) {
          log('startRun', args, ctx);
          own(principal, args.sessionId, args.pageId);
          const key = `${principal.id}:${args.requestKey}`;
          const digest = JSON.stringify([args.sessionId, args.pageId, args.skillId, args.skillVersion, args.inputs]);
          if (requestKeys.has(key)) {
            const prior = requestKeys.get(key);
            if (prior.digest !== digest) throw err('DENIED', 'requestKey conflicts with different inputs.');
            return runDto(runs.get(prior.runId));
          }
          const runId = next('run');
          const stepIds = ['s1', 's2', 's3'];
          const run = { runId, owner: principal.id, state: 'queued', stepIds, assertionIds: ['s3'], results: [], evidenceComplete: false,
            cancelRequested: false, deadlineAt: '2026-10-09T12:00:00.000Z',
            events: [{ sequence: 0, kind: 'accepted', summary: 'run accepted' }] };
          runs.set(runId, run); requestKeys.set(key, { digest, runId });
          return runDto(run);
        },
        async getRun({ runId, afterSequence = 0, maxEvents = 30 }, ctx) { log('getRun', { runId }, ctx); return runDto(ownRun(principal, runId), afterSequence, maxEvents); },
        async cancelRun({ runId }, ctx) {
          log('cancelRun', { runId }, ctx);
          const run = ownRun(principal, runId);
          run.cancelRequested = true;
          if (run.state === 'queued') { run.state = 'cancelled'; run.events.push({ sequence: run.events.length, kind: 'cancelled', summary: 'cancelled before dispatch' }); }
          return runDto(run);
        },
        async handoff(args, ctx) {
          log('handoff', args, ctx);
          const { p } = own(principal, args.sessionId, args.pageId);
          return { owner: 'human', documentEpoch: p.epoch, method: p.handoff };
        },
        async listRuns(_args, ctx) { log('listRuns', {}, ctx); return [...runs.values()].filter((r) => r.owner === principal.id).map((r) => ({ runId: r.runId })); },
        async getManifest({ runId }) { return { runId, ...ownRun(principal, runId) }; },
        async readResource(uri, ctx) {
          log('readResource', { uri }, ctx);
          let m;
          if (uri === 'braiwser://capabilities') return JSON.stringify({ driver: 'fake', humanHandoff: 'native' });
          if ((m = /^braiwser:\/\/runs\/([^/]+)\/manifest$/.exec(uri))) {
            const run = ownRun(principal, m[1]);
            return JSON.stringify({ runId: run.runId, state: run.state, planned: run.stepIds.length, password: 'CANARY_PW', note: 'ok' });
          }
          if ((m = /^braiwser:\/\/runs\/([^/]+)\/observations\/([^/]+)$/.exec(uri))) {
            ownRun(principal, m[1]);
            return JSON.stringify({ observationId: m[2] });
          }
          throw err('DENIED', 'Not permitted.');
        },
      };
    },
  };
  return broker;
}

export const P = (id, kind = 'mcp') => ({ id, kind, scopes: ['observe', 'act', 'run'] });
