// Pure(ish) event reducer for one agent run. The renderer only PROJECTS what the
// broker persisted: this file never decides that a run passed, never fills a gap
// with a guess, and never turns a missing reply into success.
//
// Inputs
//   snapshot  RunDTO  { runId, state, verdict, sequence, planned, executed, passed, ..., events[], nextSequence, manifestUri }
//   events    journal events  { sequence, kind, summary, stepId?, at?, detail? }
//             (the contract only pins sequence/stepId/kind/summary; the richer
//              optional `detail` below is what the Run detail view renders)
//
//   detail (all optional, all treated as plain text — page-derived strings such
//           as target.name are untrusted data and are shown as such):
//     intent, target{role,name,ref,origin,frame}, policy{decision,reason},
//     waitReason, status, effect, outcome, before, after, evidence[], error,
//     visibility ('internal'|'client'), observationId, documentEpoch,
//     pageId, from/to/dropped (for gap / truncated events)
//
// Ordering contract: events are applied strictly in sequence. A duplicate is
// ignored; an event beyond the next expected sequence is buffered and an OPEN
// GAP is shown until the missing events arrive (the controller re-reads the
// journal). If the journal cannot supply them, the hole is recorded as
// UNFILLED and stays visible — the timeline is never presented as complete.

const MAX_EVENTS = 2000;
const MAX_PENDING = 500;
const STEP_STATUSES = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'skipped', 'unknown']);
const EFFECTS = new Set(['notDispatched', 'dispatched', 'confirmed', 'unknown']);

const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));
const isSeq = (n) => Number.isSafeInteger(n) && n >= 0;
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function normalizeKind(kind) {
  return String(kind || '').toLowerCase().replace(/[_\s/-]+/g, '.').slice(0, 80);
}

function normalizeStatus(s) {
  if (typeof s !== 'string') return null;
  const map = { timed_out: 'timedOut', timedout: 'timedOut', timeout: 'timedOut', canceled: 'cancelled', pass: 'passed', fail: 'failed', ok: null };
  const key = map[s.toLowerCase()] !== undefined ? map[s.toLowerCase()] : s;
  return STEP_STATUSES.has(key) ? key : null;
}

export function createRunView(runId) {
  return {
    runId,
    dto: null, // last accepted RunDTO (without events)
    snapshotSequence: -1, // DTO.sequence of that snapshot (stale replies are refused)
    hydrated: false,
    lastSequence: null, // highest sequence applied contiguously (null = no base yet)
    pending: new Map(), // sequence -> event, buffered beyond a gap
    holes: [], // [{from,to}] proven-missing, never filled
    events: [],
    droppedLocal: 0, // events trimmed from `events` by the local cap (shown, never silent)
    steps: new Map(),
    stepOrder: [],
    notices: [], // gap / truncated / backpressure markers from the journal
    duplicates: 0,
    sync: 'idle', // idle | loading | ok | unavailable
    syncError: null,
    updatedAt: 0,
    rev: 0,
  };
}

export function normalizeEvent(raw) {
  if (!obj(raw) || !isSeq(raw.sequence)) return null;
  const detail = obj(raw.detail) ? raw.detail : {};
  return {
    sequence: raw.sequence,
    kind: normalizeKind(raw.kind),
    summary: clip(raw.summary, 300),
    stepId: typeof raw.stepId === 'string' && raw.stepId ? clip(raw.stepId, 160) : '',
    at: raw.at || raw.ts || detail.at || '',
    detail,
    raw,
  };
}

// Snapshot of the DTO without the (large) events array.
function stripDto(dto) {
  const { events: _events, ...rest } = dto;
  return rest;
}

export function isRunDto(dto) {
  return obj(dto) && typeof dto.runId === 'string' && dto.runId.length > 0 && typeof dto.state === 'string';
}

// ---- snapshots ---------------------------------------------------------------
// Returns { accepted, view }. A snapshot older than the one already shown is
// refused: a late reply must not roll the run back (or forward) in front of the
// person.
export function applySnapshot(view, dto, opts = {}) {
  if (!isRunDto(dto) || dto.runId !== view.runId) return { accepted: false, reason: 'invalid', view };
  const seq = Number.isSafeInteger(dto.sequence) ? dto.sequence : -1;
  if (view.dto && seq < view.snapshotSequence) return { accepted: false, reason: 'stale', view };
  view.dto = stripDto(dto);
  view.snapshotSequence = seq;
  view.sync = 'ok';
  view.syncError = null;
  view.updatedAt = opts.now || Date.now();
  if (Array.isArray(dto.events)) applyEvents(view, dto.events, { fromStart: !!opts.fromStart });
  view.rev++;
  return { accepted: true, view };
}

// ---- events ------------------------------------------------------------------
export function applyEvents(view, rawEvents, opts = {}) {
  const list = (Array.isArray(rawEvents) ? rawEvents : []).map(normalizeEvent).filter(Boolean).sort((a, b) => a.sequence - b.sequence);
  if (!list.length) return view;
  if (view.lastSequence === null) {
    if (opts.fromStart) {
      const first = list[0].sequence;
      view.lastSequence = first - 1;
      // A journal that does not begin at 0/1 has dropped its head: say so.
      if (first > 1) view.holes.push({ from: 1, to: first - 1, reason: 'Earlier events are not available from the journal.' });
      view.hydrated = true;
    } else {
      // No base yet: we cannot tell whether this event is contiguous, so buffer
      // it and let the controller hydrate from the journal.
      for (const ev of list) bufferEvent(view, ev);
      view.needsHydrate = true;
      view.rev++;
      return view;
    }
  }
  for (const ev of list) {
    if (ev.sequence <= view.lastSequence || view.pending.has(ev.sequence)) { view.duplicates++; continue; }
    if (ev.sequence === view.lastSequence + 1) {
      applyOne(view, ev);
      view.lastSequence = ev.sequence;
    } else {
      bufferEvent(view, ev);
    }
  }
  flushPending(view);
  view.updatedAt = opts.now || Date.now();
  view.rev++;
  return view;
}

function bufferEvent(view, ev) {
  if (view.pending.size >= MAX_PENDING) return; // bounded; the open gap stays visible
  view.pending.set(ev.sequence, ev);
}

function flushPending(view) {
  if (view.lastSequence === null) return;
  while (view.pending.has(view.lastSequence + 1)) {
    const ev = view.pending.get(view.lastSequence + 1);
    view.pending.delete(ev.sequence);
    applyOne(view, ev);
    view.lastSequence = ev.sequence;
  }
}

// The currently open (unresolved) gap, or null.
export function openGap(view) {
  if (view.lastSequence === null || !view.pending.size) return null;
  const min = Math.min(...view.pending.keys());
  return min > view.lastSequence + 1 ? { from: view.lastSequence + 1, to: min - 1 } : null;
}

// The journal could not supply the missing events. Record the hole — visibly —
// and continue from the buffered events.
export function markGapUnfilled(view, reason = 'These events are not available from the journal.') {
  const gap = openGap(view);
  if (!gap) return null;
  view.holes.push({ ...gap, reason });
  view.lastSequence = gap.to;
  flushPending(view);
  view.rev++;
  return gap;
}

// Everything the UI must disclose about completeness.
export function completeness(view) {
  const gap = openGap(view);
  return {
    complete: !gap && !view.holes.length && !view.droppedLocal && !view.notices.length && view.hydrated && view.sync === 'ok',
    openGap: gap,
    holes: view.holes.slice(),
    notices: view.notices.slice(),
    droppedLocal: view.droppedLocal,
    hydrated: view.hydrated,
    sync: view.sync,
  };
}

function applyOne(view, ev) {
  view.events.push(ev);
  if (view.events.length > MAX_EVENTS) {
    const drop = view.events.length - MAX_EVENTS;
    view.events.splice(0, drop);
    view.droppedLocal += drop;
  }
  const kind = ev.kind;
  if (/(^|\.)(gap|truncated|backpressure|dropped)(\.|$)/.test(kind)) {
    const d = ev.detail;
    view.notices.push({
      sequence: ev.sequence,
      kind,
      from: isSeq(d.from) ? d.from : null,
      to: isSeq(d.to) ? d.to : null,
      dropped: isSeq(d.dropped) ? d.dropped : null,
      summary: ev.summary || 'Events were dropped. This timeline is incomplete.',
    });
  }
  if (ev.stepId) updateStep(view, ev);
}

function stepFor(view, stepId, sequence) {
  let s = view.steps.get(stepId);
  if (!s) {
    s = {
      stepId, order: view.stepOrder.length, firstSequence: sequence, lastSequence: sequence,
      intent: '', target: null, policy: null, waitReason: '', status: 'pending', effect: null,
      outcome: '', before: '', after: '', evidence: [], error: null, visibility: '', pageId: '',
      observationId: '', documentEpoch: null, planned: false, kinds: [],
    };
    view.steps.set(stepId, s);
    view.stepOrder.push(stepId);
  }
  return s;
}

function updateStep(view, ev) {
  const s = stepFor(view, ev.stepId, ev.sequence);
  const d = ev.detail;
  s.lastSequence = ev.sequence;
  s.kinds.push(ev.kind);
  const pick = (k) => (d[k] !== undefined ? d[k] : ev.raw[k]);
  const intent = pick('intent');
  if (typeof intent === 'string' && intent) s.intent = clip(intent, 300);
  const target = pick('target');
  if (obj(target)) {
    s.target = {
      role: clip(target.role, 80), name: clip(target.name, 200), ref: clip(target.ref, 80),
      origin: clip(target.origin, 200), frame: clip(target.frame, 120),
    };
  }
  const policy = pick('policy');
  if (obj(policy)) s.policy = { decision: clip(policy.decision, 40), reason: clip(policy.reason, 300) };
  const wait = pick('waitReason');
  if (typeof wait === 'string') s.waitReason = clip(wait, 300);
  const outcome = pick('outcome');
  if (typeof outcome === 'string' && outcome) s.outcome = clip(outcome, 300);
  if (typeof pick('before') === 'string') s.before = clip(pick('before'), 300);
  if (typeof pick('after') === 'string') s.after = clip(pick('after'), 300);
  if (Array.isArray(d.evidence)) s.evidence = d.evidence.filter((x) => typeof x === 'string').slice(0, 20).map((x) => clip(x, 300));
  if (typeof d.visibility === 'string' && (d.visibility === 'client' || d.visibility === 'internal')) s.visibility = d.visibility;
  if (typeof d.pageId === 'string') s.pageId = clip(d.pageId, 160);
  if (typeof d.observationId === 'string') s.observationId = clip(d.observationId, 160);
  if (Number.isSafeInteger(d.documentEpoch)) s.documentEpoch = d.documentEpoch;
  if (obj(d.error)) s.error = { code: clip(d.error.code, 40), message: clip(d.error.message, 300), dispatched: !!d.error.dispatched, effectUnknown: !!d.error.effectUnknown };
  const effect = pick('effect');
  if (typeof effect === 'string' && EFFECTS.has(effect)) s.effect = effect;

  // Status: ONLY from an explicit status, or from an explicit uncertain /
  // started / waiting event kind. A "result" event without a status stays unknown.
  const explicit = normalizeStatus(pick('status'));
  if (/\.planned$|(^|\.)plan$/.test(ev.kind)) s.planned = true;
  if (/uncertain/.test(ev.kind)) {
    s.status = 'unknown';
    s.effect = 'unknown';
  } else if (explicit) {
    s.status = explicit;
  } else if (/(^|\.)(started|running|dispatched)(\.|$)/.test(ev.kind) && s.status === 'pending') {
    s.status = 'running';
  } else if (/(result|completed|finished|verified)$/.test(ev.kind) && !STEP_STATUSES.has(s.status)) {
    s.status = 'unknown';
  }
}

export function stepsOf(view) {
  return view.stepOrder.map((id) => view.steps.get(id));
}

// The step that must be reconciled by a person: dispatched (or maybe dispatched)
// with an unknown effect.
export function uncertainStep(view) {
  const steps = stepsOf(view);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.effect === 'unknown' || (s.status === 'unknown' && /uncertain/.test(s.kinds.join(' ')))) return s;
  }
  return null;
}

// The last step the journal PROVED: status passed + effect confirmed.
export function lastProvenStep(view) {
  const steps = stepsOf(view);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.status === 'passed' && (s.effect === 'confirmed' || s.effect === 'notDispatched')) return s;
  }
  return null;
}

// ---- owners ------------------------------------------------------------------
const CONTROLLER_ALIASES = {
  agent: 'agent', human: 'human', user: 'human',
  'handoff-pending': 'handoff-pending', handoffpending: 'handoff-pending', pending: 'handoff-pending',
  quarantined: 'quarantined',
};

export function normalizeOwner(payload) {
  if (!obj(payload) || typeof payload.sessionId !== 'string' || !payload.sessionId) return null;
  const raw = obj(payload.owner) ? payload.owner : payload;
  const controllerRaw = typeof payload.owner === 'string' ? payload.owner : (raw.controller || raw.owner || payload.controller);
  const controller = CONTROLLER_ALIASES[String(controllerRaw || '').toLowerCase()] || 'unknown';
  const fenceRaw = payload.ownerEpoch !== undefined ? payload.ownerEpoch : payload.generation;
  return {
    sessionId: clip(payload.sessionId, 160),
    pageId: clip(payload.pageId, 160),
    controller,
    mode: clip(payload.mode, 40),
    driver: clip(payload.driver, 40),
    humanHandoff: clip(payload.humanHandoff, 40),
    url: clip(payload.url, 2000),
    runId: clip(payload.runId, 160),
    reason: clip(payload.reason, 300),
    currentAction: clip(payload.currentAction, 300),
    documentEpoch: Number.isSafeInteger(payload.documentEpoch) ? payload.documentEpoch : null,
    fence: Number.isSafeInteger(fenceRaw) ? fenceRaw : null,
    at: payload.at || payload.ts || '',
    preview: obj(payload.preview) ? { src: payload.preview.src || payload.preview.dataUrl || '', capturedAt: payload.preview.capturedAt || '' } : null,
    freshObservation: payload.freshObservation === false ? false : payload.freshObservation === true ? true : null,
  };
}

// Returns the owner record to keep. An update whose fence is older than the one
// already held is a stale (reordered) message and is refused.
export function mergeOwner(current, incoming) {
  if (!incoming) return { owner: current, accepted: false };
  if (current && current.fence !== null && incoming.fence !== null && incoming.fence < current.fence) {
    return { owner: current, accepted: false };
  }
  return { owner: { ...(current && current.sessionId === incoming.sessionId ? current : {}), ...incoming }, accepted: true };
}
