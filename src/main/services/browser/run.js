// Durable run state machine + closed-plan workflow executor.
//
//   queued -> running -> needsApproval | needsHuman -> running
//          -> passed | failed | cancelled | timedOut | uncertain | interrupted
//
// - Runs are journaled (runs.jsonl, same hash-chained single-writer format as
//   the operation ledger). Restart converts active runs to `interrupted` and
//   marks steps whose dispatch had started as effect-unknown. Nothing replays.
// - (ownerId, requestKey) is unique: an identical request returns the existing
//   run; the same key with different inputs is a conflict.
// - Grading is ONLY review/verdict.js runVerdict. `evidenceComplete` comes from
//   the evidence store (artifacts intact, no artifact errors) AND a committed
//   manifest - never from a caller-supplied boolean.
// - Retries are linked attempts (new runId, parentRunId); old failures are
//   never relabelled.
// - `executePlan(plan, driverPage)` runs the same closed plan against a bare
//   DriverPage (no broker) for CLI/tests.
'use strict';
const path = require('node:path');
const nodeFs = require('node:fs');
const { EventEmitter } = require('node:events');
const C = require('../../../shared/browser-contracts');
const { redactText } = require('../../../shared/browser-redact');
const { runVerdict } = require('../review/verdict');
const { JournalFile } = require('./ledger');

const rerr = (code, message) => Object.assign(new Error(message || code), { code });
const MAX_EVENTS = 1000;
const MAX_STEP_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------
function createRunStore({ dir, fs = nodeFs, clock = { now: () => Date.now() }, ledgerLookup = () => null, retentionMs = 14 * 24 * 3600 * 1000, compactAtBytes = 8 * 1024 * 1024 } = {}) {
  if (!dir) throw new TypeError('run store dir required');
  const journal = new JournalFile(path.join(dir, 'runs.jsonl'), { fs, now: () => clock.now() });
  const runs = new Map();
  const byKey = new Map(); // `${ownerId}\0${requestKey}` -> runId
  const keyOf = (o, k) => `${o}\u0000${k}`;

  function fresh(d) {
    return { ...d, state: 'queued', terminal: 'unknown', evidenceComplete: false, cancelRequested: false, events: [], sequence: 0, droppedEvents: 0,
      results: new Map(), started: new Map(), terminalReason: null, finalizedAt: null, createdAt: null };
  }
  function apply(rec) {
    const d = rec.data || {};
    if (rec.type === 'run_created') { const r = fresh(d.run); r.createdAt = rec.ts; runs.set(r.runId, r); byKey.set(keyOf(r.ownerId, r.requestKey), r.runId); return; }
    const r = runs.get(d.runId);
    if (!r) return;
    switch (rec.type) {
      case 'run_state':
        r.state = d.state; if (d.terminal) r.terminal = d.terminal; if (d.reason) r.terminalReason = d.reason;
        if (typeof d.evidenceComplete === 'boolean') r.evidenceComplete = d.evidenceComplete;
        if (C.TERMINAL_STATES.includes(d.state)) r.finalizedAt = rec.ts;
        break;
      case 'run_event': {
        r.sequence = d.sequence;
        if (r.events.length >= MAX_EVENTS) { r.events.shift(); r.droppedEvents++; }
        r.events.push({ sequence: d.sequence, kind: d.kind, summary: d.summary, stepId: d.stepId, at: rec.ts });
        break;
      }
      case 'step_started': r.started.set(d.stepId, { operationId: d.operationId, at: rec.ts }); break;
      case 'step_result': r.results.set(d.result.stepId, d.result); break;
      case 'cancel_requested': r.cancelRequested = true; break;
      default: break;
    }
  }
  const append = (type, data) => { const rec = journal.append(type, data); apply(rec); return rec; };
  function emitEvent(runId, { kind, summary, stepId }) {
    const r = runs.get(runId);
    if (!r) throw rerr('NOT_FOUND');
    const rec = { runId, sequence: r.sequence + 1, kind: String(kind).slice(0, 80), summary: redactText(String(summary), 300), ...(stepId ? { stepId } : {}) };
    append('run_event', rec);
    return rec;
  }

  const records = journal.open();
  records.forEach(apply);

  // ---- recovery: active -> interrupted; dispatched steps -> effect unknown -----------
  const recovered = [];
  for (const r of runs.values()) {
    if (!C.ACTIVE_STATES.includes(r.state)) continue;
    for (const [stepId, s] of r.started) {
      if (r.results.has(stepId)) continue;
      const op = ledgerLookup(r.sessionId, s.operationId);
      if (op && (op.state === 'dispatch_started' || (op.receipt && op.receipt.dispatched))) {
        append('step_result', { runId: r.runId, result: { stepId, status: 'unknown', effect: 'unknown', evidenceIds: [], code: 'INTERRUPTED_EFFECT_UNKNOWN' } });
      }
    }
    emitEvent(r.runId, { kind: 'interrupted', summary: 'broker restarted; run interrupted, no step is replayed' });
    append('run_state', { runId: r.runId, state: 'interrupted', terminal: 'unknown', reason: 'APP_RESTART', evidenceComplete: false });
    recovered.push(r.runId);
  }

  function compactIfNeeded() {
    const now = clock.now();
    const expired = [...runs.values()].filter((r) => r.finalizedAt && now - r.finalizedAt > retentionMs);
    if (journal.size < compactAtBytes && !expired.length) return;
    const drop = new Set(expired.map((r) => r.runId));
    const entries = [];
    for (const r of runs.values()) {
      if (drop.has(r.runId)) continue;
      const { state, terminal, evidenceComplete, cancelRequested, events, sequence, droppedEvents, results, started, terminalReason, finalizedAt, createdAt, ...base } = r;
      entries.push({ type: 'run_created', data: { run: base } });
      for (const e of events) entries.push({ type: 'run_event', data: { runId: r.runId, ...e } });
      for (const [stepId, s] of started) entries.push({ type: 'step_started', data: { runId: r.runId, stepId, operationId: s.operationId } });
      for (const res of results.values()) entries.push({ type: 'step_result', data: { runId: r.runId, result: res } });
      if (cancelRequested) entries.push({ type: 'cancel_requested', data: { runId: r.runId } });
      entries.push({ type: 'run_state', data: { runId: r.runId, state, terminal, reason: terminalReason, evidenceComplete } });
    }
    journal.rewrite(entries, { compactedAt: now });
    runs.clear(); byKey.clear();
    for (const line of fs.readFileSync(journal.file, 'utf8').split('\n')) if (line) apply(JSON.parse(line));
    for (const id of drop) runs.delete(id);
  }
  compactIfNeeded();

  const store = {
    recovered, get recovery() { return journal.recovery; },
    // Idempotent by (owner, requestKey). Returns {run, existing}.
    create(meta) {
      const k = keyOf(meta.ownerId, meta.requestKey);
      const prior = byKey.get(k);
      if (prior) {
        const r = runs.get(prior);
        if (r.requestHash !== meta.requestHash) throw C.brokerError('DENIED', 'requestKey was already used with different inputs', { detail: 'REQUEST_KEY_CONFLICT' });
        return { run: r, existing: true };
      }
      append('run_created', { run: meta });
      const r = runs.get(meta.runId);
      emitEvent(meta.runId, { kind: 'queued', summary: 'run accepted' });
      return { run: r, existing: false };
    },
    get: (runId) => runs.get(runId) || null,
    list: ({ ownerId, reviewSessionId } = {}) => [...runs.values()].filter((r) => (!ownerId || r.ownerId === ownerId) && (!reviewSessionId || r.reviewSessionId === reviewSessionId)),
    event: emitEvent,
    transition(runId, state, { terminal, reason, evidenceComplete } = {}) {
      const r = runs.get(runId);
      if (!r) throw rerr('NOT_FOUND');
      if (r.state === state) return r;
      if (!C.canTransition(r.state, state)) throw rerr('ILLEGAL_TRANSITION', `${r.state} -> ${state}`);
      append('run_state', { runId, state, terminal, reason, evidenceComplete });
      return r;
    },
    stepStarted(runId, stepId, operationId) { append('step_started', { runId, stepId, operationId }); },
    stepResult(runId, result) {
      const r = runs.get(runId);
      if (!r || r.results.has(result.stepId)) return; // results are immutable
      append('step_result', { runId, result });
    },
    requestCancel(runId) { const r = runs.get(runId); if (r && !r.cancelRequested) append('cancel_requested', { runId }); },
    compact: compactIfNeeded,
    close() { journal.close(); },
    _crash() { journal._crash(); },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Grading / DTO
// ---------------------------------------------------------------------------
function planIds(plan) {
  return { plannedStepIds: plan.steps.map((s) => s.id), assertionStepIds: plan.steps.filter((s) => s.type === 'assert').map((s) => s.id) };
}
function gradeRun(run, { evidenceComplete = run.evidenceComplete, terminal = run.terminal } = {}) {
  const { plannedStepIds, assertionStepIds } = planIds(run.plan);
  return runVerdict({ plannedStepIds, assertionStepIds, results: [...run.results.values()].map(({ stepId, status, effect, evidenceIds }) => ({ stepId, status, effect, evidenceIds })), terminal, evidenceComplete });
}
function stateFor(terminal, gradeStatus) {
  if (terminal === 'cancelled') return 'cancelled';
  if (terminal === 'timedOut') return 'timedOut';
  if (terminal === 'unknown') return 'uncertain';
  if (terminal === 'failed') return 'failed';
  return { passed: 'passed', failed: 'failed', timedOut: 'timedOut', cancelled: 'cancelled' }[gradeStatus] || 'uncertain';
}
function runToDTO(run, { afterSequence = 0, maxEvents = 50 } = {}) {
  const grade = gradeRun(run);
  const events = run.events.filter((e) => e.sequence > afterSequence).slice(0, Math.min(maxEvents, 100));
  const nextSequence = events.length ? events[events.length - 1].sequence + 1 : Math.max(afterSequence, 0) + 1;
  return C.buildRunDTO({ runId: run.runId, state: run.state, cancelRequested: run.cancelRequested, grade, sequence: run.sequence, events, nextSequence,
    deadlineAt: run.deadlineAt, manifestUri: C.uris.manifest(run.evidenceRunId || run.runId) });
}

// ---------------------------------------------------------------------------
// Step execution (host-agnostic)
// ---------------------------------------------------------------------------
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
function nodeMatches(node, t) {
  if (t.by === 'role') return node.role === t.role && norm(node.name) === norm(t.name);
  if (t.by === 'testId') return node.testId === t.value;
  if (t.by === 'label') return norm(node.name) === norm(t.value);
  return false;
}
async function findTarget(host, target) {
  let cursor; const found = [];
  for (let i = 0; i < 5; i++) {
    const obs = await host.observe({ maxNodes: 200, cursor });
    for (const node of obs.nodes) if (nodeMatches(node, target)) found.push({ node, observation: obs });
    if (found.length > 1) return { error: 'AMBIGUOUS_TARGET' };
    if (!obs.nextCursor) break;
    cursor = obs.nextCursor;
  }
  return found.length === 1 ? { found: found[0] } : { error: 'TARGET_NOT_FOUND' };
}

// Receipt -> {status, effect} for runVerdict. A merely `dispatched` action is
// NOT confirmed: the grader turns it into `unknown`.
function fromReceipt(r) {
  const code = r.code || '';
  if (code === 'DESTINATION_DENIED') return { status: 'failed', effect: r.status === 'not_attempted' ? 'notDispatched' : 'dispatched' };
  if (r.status === 'verified') return { status: 'passed', effect: 'confirmed' };
  if (r.status === 'dispatched') return { status: 'passed', effect: 'dispatched' };
  if (r.status === 'uncertain') {
    if (code === 'DEADLINE_EXCEEDED') return { status: 'timedOut', effect: 'unknown' };
    return { status: 'unknown', effect: 'unknown' };
  }
  if (code === 'CANCELLED' || code === 'HANDOFF_REQUESTED') return { status: 'cancelled', effect: 'notDispatched' };
  if (code === 'DEADLINE_EXCEEDED') return { status: 'timedOut', effect: 'notDispatched' };
  return { status: 'failed', effect: 'notDispatched' };
}

async function executeStep(step, ctx) {
  const { host, inputs, signal } = ctx;
  const result = (status, effect, extra = {}) => ({ stepId: step.id, status, effect, evidenceIds: extra.evidenceIds || [], code: extra.code, summary: extra.summary });
  const record = async (kind, data) => { try { return [await host.record(kind, { stepId: step.id, ...data })]; } catch { return []; } };
  if (signal.aborted) return result('cancelled', 'notDispatched', { code: 'CANCELLED' });

  const RETRY_CODES = ['STALE_DOCUMENT', 'STALE_REF', 'OWNERSHIP_LOST'];
  // Retrying is only ever done for work that provably did not dispatch (or is read-only).
  const mayRetry = async (code) => {
    if (!RETRY_CODES.includes(code)) return false;
    if (code === 'OWNERSHIP_LOST') return (await host.waitForAgent()) === 'resumed';
    return true;
  };
  if (step.type === 'navigate') {
    let r;
    for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
      if (signal.aborted) return result('cancelled', 'notDispatched', { code: 'CANCELLED' });
      r = await host.navigate(step.url, step, attempt);
      if (!(r.status === 'not_attempted' && await mayRetry(r.code))) break;
    }
    const m = fromReceipt(r);
    return result(m.status, m.effect, { code: r.code, evidenceIds: await record('navigation', { receipt: r }), summary: `navigate ${r.status}` });
  }
  if (step.type === 'assert') {
    const assertion = { kind: step.kind, op: step.op, expected: step.expected, target: step.target };
    let a;
    for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
      if (signal.aborted) return result('cancelled', 'notDispatched', { code: 'CANCELLED' });
      a = await host.assert(assertion, step);
      if (!(a.status === 'unknown' && await mayRetry(a.code))) break;
    }
    const ids = await record('assertion', { assertion, status: a.status, actual: a.actual });
    const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'unknown';
    // Read-only: no dispatch. Only counts as proof if its evidence was recorded.
    return result(status, status === 'unknown' ? 'unknown' : 'notDispatched', { evidenceIds: ids, code: a.status === 'passed' ? 'OK' : String(a.code || a.status).toUpperCase(), summary: `assert ${a.status}` });
  }
  // click / fill
  let value;
  if (step.type === 'fill') {
    value = inputs[step.inputKey];
    if (typeof value !== 'string') return result('failed', 'notDispatched', { code: 'MISSING_INPUT', summary: 'declared input was not supplied' });
  }
  let last = null;
  for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
    if (signal.aborted) return result('cancelled', 'notDispatched', { code: 'CANCELLED' });
    let t;
    try { t = await findTarget(host, step.target); } catch (e) {
      // Observation failed BEFORE any dispatch: safe to wait/retry, never effect-unknown.
      const code = (e && e.code) || 'OBSERVE_FAILED';
      if (await mayRetry(code)) continue;
      return result('failed', 'notDispatched', { code, summary: 'target could not be observed' });
    }
    if (t.error) return result('failed', 'notDispatched', { code: t.error, summary: t.error === 'AMBIGUOUS_TARGET' ? 'target is not unique' : 'target not found' });
    const action = step.type === 'click' ? { kind: 'click', ref: t.found.node.ref } : { kind: 'fill', ref: t.found.node.ref, text: value };
    last = await host.act(action, { step, attempt, observation: t.found.observation, node: t.found.node });
    // Provably not dispatched => safe to re-observe and try again.
    if (!(last.status === 'not_attempted' && await mayRetry(last.code))) break;
  }
  if (!last) return result('failed', 'notDispatched', { code: 'RETRIES_EXHAUSTED', summary: 'target never became available' });
  const m = fromReceipt(last);
  return result(m.status, m.effect, { code: last.code, evidenceIds: await record('action', { receipt: last }), summary: `${step.type} ${last.status}` });
}

// Runs steps in order, fail-fast (all steps are mandatory in workflow v1).
async function runPlanLoop({ plan, inputs, host, signal, onStepStart, onStepResult }) {
  let uncertain = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (signal.aborted) break;
    if (onStepStart) onStepStart(step, i);
    let r;
    try { r = await executeStep(step, { host, inputs, signal }); } catch (e) {
      r = { stepId: step.id, status: 'unknown', effect: 'unknown', evidenceIds: [], code: (e && e.code) || 'STEP_ERROR', summary: 'step errored; effect not established' };
    }
    if (onStepResult) onStepResult(r, i);
    if (r.effect === 'unknown') uncertain = true;
    if (r.status !== 'passed') break;
  }
  return { uncertain };
}

// Terminal decision from the loop outcome.
function decideTerminal({ run, signal, results }) {
  const reason = signal.aborted ? String(signal.reason || 'CANCELLED') : null;
  if (reason === 'DEADLINE') return 'timedOut';
  if (reason) return 'cancelled';
  const all = [...results.values()];
  if (all.some((r) => r.status === 'unknown' || r.effect === 'unknown')) return 'unknown';
  if (all.some((r) => r.status === 'timedOut')) return 'timedOut';
  if (all.some((r) => r.status === 'cancelled')) return 'cancelled';
  return 'completed';
}

// ---------------------------------------------------------------------------
// Standalone executor against a bare DriverPage (no ownership / ledger)
// ---------------------------------------------------------------------------
class MemoryEvidence {
  constructor() { this.items = new Map(); this.errors = 0; }
  put(kind, data) {
    try { const id = C.newId('artifact'); this.items.set(id, { kind, data: JSON.parse(JSON.stringify(data)) }); return id; } catch { this.errors++; throw rerr('EVIDENCE_FAILED'); }
  }
}
function driverPageHost(page, { signal, sink, policy, stepTimeoutMs = 15000 }) {
  let n = 0;
  const nodes = new Map();
  const wrap = async (fn) => Promise.race([fn(), new Promise((_, rej) => { const t = setTimeout(() => rej(rerr('DEADLINE_EXCEEDED')), stepTimeoutMs); t.unref?.(); })]);
  return {
    async observe({ maxNodes, cursor }) {
      const o = await page.observe({ maxNodes, cursor });
      const observationId = C.newId('observation');
      const list = o.nodes.map((nd) => { const ref = C.newId('ref'); nodes.set(ref, { ...nd, observationId }); return { ...nd, ref }; });
      return { observationId, documentEpoch: page.documentEpoch, nodes: list, nextCursor: o.nextCursor || null };
    },
    async navigate(url) {
      let dispatched = false;
      try {
        if (policy && !policy(url)) return { status: 'not_attempted', code: 'DESTINATION_DENIED' };
        dispatched = true;
        const r = await wrap(() => page.navigate(url, { signal, timeoutMs: stepTimeoutMs }));
        if (r.outcome === 'ready' && (!policy || policy(r.url))) return { status: 'verified', code: 'OK', evidence: [{ kind: 'navigation', observed: true, url: r.url }] };
        if (r.outcome === 'cancelled') return { status: 'uncertain', code: 'CANCELLED' };
        if (r.outcome === 'timeout') return { status: 'uncertain', code: 'DEADLINE_EXCEEDED' };
        return { status: 'dispatched', code: String(r.outcome).toUpperCase() };
      } catch (e) { return { status: dispatched ? 'uncertain' : 'not_attempted', code: e.code || 'DRIVER_FAILED' }; }
    },
    async act(action) {
      const node = nodes.get(action.ref);
      if (!node) return { status: 'not_attempted', code: 'STALE_REF' };
      if (action.kind === 'fill' && require('./policy').createPolicy().isSecretTarget(node)) return { status: 'not_attempted', code: 'SECRET_FIELD' };
      let dispatched = false;
      const cmd = { operationId: `exec-${++n}`, sessionId: 'local', pageId: page.pageId, documentEpoch: page.documentEpoch, observationId: node.observationId,
        action: { ...action, ref: undefined, refId: node.refId }, target: { refId: node.refId, frameId: node.frameId || null, role: node.role, name: node.name } };
      delete cmd.action.ref;
      const control = { signal, check() { if (signal && signal.aborted) throw rerr('CANCELLED'); }, beforeDispatch() { if (signal && signal.aborted) throw rerr('CANCELLED'); dispatched = true; } };
      try {
        const r = await wrap(() => page.act(cmd, control));
        if (!dispatched) return { status: 'not_attempted', code: 'DRIVER_DID_NOT_DISPATCH' };
        return { status: r.status === 'verified' && Array.isArray(r.evidence) && r.evidence.length ? 'verified' : 'dispatched', code: 'OK' };
      } catch (e) { return { status: dispatched ? 'uncertain' : 'not_attempted', code: e.code || 'DRIVER_FAILED' }; }
    },
    async assert(assertion) {
      try { const r = await wrap(() => page.evaluateAssertion(assertion)); return { status: ['passed', 'failed', 'unknown'].includes(r.status) ? r.status : 'unknown', actual: r.actual }; } catch (e) { return { status: 'unknown', code: e.code }; }
    },
    async record(kind, data) { return sink.put(kind, data); },
    async waitForAgent() { return 'aborted'; },
  };
}

// Executes a validated closed plan against a DriverPage. Returns the canonical
// verdict. Evidence is in-memory only here, so `evidenceComplete` means "every
// step's evidence was recorded"; the durable broker path commits a manifest.
async function executePlan(plan, page, { inputs = {}, signal, maxDurationMs, stepTimeoutMs, policy } = {}) {
  const validated = C.validatePlan(plan);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || 'CANCELLED');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const limit = Math.min(maxDurationMs || validated.maxDurationMs, validated.maxDurationMs);
  const timer = setTimeout(() => controller.abort('DEADLINE'), limit);
  const sink = new MemoryEvidence();
  const host = driverPageHost(page, { signal: controller.signal, sink, policy, stepTimeoutMs });
  const results = new Map();
  try {
    await runPlanLoop({ plan: validated, inputs, host, signal: controller.signal, onStepResult: (r) => results.set(r.stepId, r) });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  const terminal = decideTerminal({ signal: controller.signal, results });
  const evidenceIds = [...results.values()].flatMap((r) => r.evidenceIds);
  const evidenceComplete = sink.errors === 0 && evidenceIds.every((id) => sink.items.has(id));
  const { plannedStepIds, assertionStepIds } = planIds(validated);
  const verdict = runVerdict({ plannedStepIds, assertionStepIds, terminal, evidenceComplete,
    results: [...results.values()].map(({ stepId, status, effect, evidenceIds: e }) => ({ stepId, status, effect, evidenceIds: e })) });
  return { terminal, verdict, results: [...results.values()], evidence: sink.items };
}

// Wait for an event on `emitter` that satisfies `predicate`; resolves 'event' |
// 'aborted' | 'timeout'. Used for approval / human-takeover waits (idle caps).
function waitForEvent(emitter, name, predicate, { signal, timeoutMs }) {
  return new Promise((resolve) => {
    let timer;
    const done = (v) => { clearTimeout(timer); emitter.off(name, onEvent); signal?.removeEventListener('abort', onAbort); resolve(v); };
    const onEvent = (e) => { if (!predicate || predicate(e)) done('event'); };
    const onAbort = () => done('aborted');
    emitter.on(name, onEvent);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done('timeout'), timeoutMs);
  });
}

module.exports = { createRunStore, gradeRun, stateFor, runToDTO, planIds, runPlanLoop, executeStep, decideTerminal, findTarget, nodeMatches, fromReceipt, executePlan, waitForEvent, MemoryEvidence, EventEmitter, MAX_EVENTS };
