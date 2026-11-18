'use strict';
// The review source: what an agent may read and report about a review.
//
// ONE interface, two backends, so the same tools work wherever the runtime runs:
//
//   createStoreSource({ repos })           desktop app - the live project store
//   createFileSource({ dir, stateFile })   standalone / online / container - a
//                                          directory of exported .braiwser.json
//                                          bundles, read-only, plus a small state
//                                          file for what agents reported
//
//   source.listNotes({ status, sessionId, limit })   -> public note records
//   source.getNote(noteId)                           -> public note record | null
//   source.loadNote(noteId)                          -> the raw note (for the verify-notes skill)
//   source.listJourneys()                            -> [{ id, name, startUrl, steps, migratable, refused }]
//   source.loadRecording(recordingId)                -> the raw recording (for verify-journey)
//   source.claim(noteId, who)                        -> public note record
//   source.recordVerification(noteId, verification)  -> public note record
//   source.propose(noteId, { message, who })         -> public note record
//
// What an agent can and cannot change:
//   * It can CLAIM a note, attach a VERIFICATION the broker computed from a run,
//     and PROPOSE a note for review with a message.
//   * A note becomes `resolved` here only through recordVerification with verdict
//     'fixed' - i.e. only on proof from a broker-graded run. Nothing an agent
//     types can resolve a note; a person still can, in the app.
//   * Note text, targets and edits are never writable from here.

const fs = require('node:fs');
const path = require('node:path');
const noteChecks = require('../../../shared/note-checks');

const MAX_LIST = 200;
// Would verify-journey accept this recording? Same pure migration the skill runs.
const defaultMigrate = (rec) => require('../automation/workflow-core').recordingToWorkflow(rec, { skillId: 'verify-journey', version: '1.0.0' });
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const STATUSES = ['open', 'resolved'];

function agentState(raw) {
  const a = isObj(raw) ? raw : {};
  const out = {};
  if (typeof a.claimedBy === 'string') { out.claimedBy = clip(a.claimedBy, 120); out.claimedAt = clip(a.claimedAt, 40); }
  if (isObj(a.proposal)) out.proposal = { message: clip(a.proposal.message, 1000), by: clip(a.proposal.by, 120), at: clip(a.proposal.at, 40) };
  if (isObj(a.verification)) {
    const v = a.verification;
    out.verification = { verdict: noteChecks.VERDICTS.includes(v.verdict) ? v.verdict : 'unknown', runId: clip(v.runId, 160), runState: clip(v.runState, 40),
      by: clip(v.by, 120), at: clip(v.at, 40), checks: Number.isInteger(v.checks) ? v.checks : 0 };
  }
  return out;
}

// The record an agent sees. Bounded, no screenshots, no free-form objects.
function publicNote(note) {
  if (!isObj(note) || typeof note.id !== 'string') return null;
  const target = isObj(note.target) ? note.target : {};
  const edit = isObj(note.edit) ? note.edit : null;
  const derived = noteChecks.deriveChecks(note);
  const plan = noteChecks.planAssertions(note);
  const out = {
    id: note.id,
    sessionId: typeof note.sessionId === 'string' ? note.sessionId : '',
    url: clip(note.url, 2000),
    kind: clip(note.kind || 'element', 20),
    action: clip(note.action || 'comment', 40),
    priority: clip(note.priority || 'normal', 20),
    status: STATUSES.includes(note.status) ? note.status : 'open',
    note: clip(note.note, 2000),
    target: {
      selector: clip(target.selector, 500), tag: clip(target.tag, 40), text: clip(target.text, 200),
      ...(noteChecks.locatorOf(note) ? { locator: noteChecks.locatorOf(note) } : {}),
    },
    checks: derived.checks.map((c) => ({ kind: c.kind, expected: clip(c.expected, 300) })),
    // Can a verify-notes run prove this note? If not, why.
    verifiable: plan.ok,
    ...(plan.ok ? {} : { notVerifiable: { code: plan.code, reason: clip(plan.reason, 300) } }),
    agent: agentState(note.agent),
  };
  if (isObj(note.viewport) && Number.isFinite(note.viewport.width) && Number.isFinite(note.viewport.height)) {
    out.viewport = { width: Math.round(note.viewport.width), height: Math.round(note.viewport.height) };
  }
  if (edit) {
    const d = isObj(edit.details) ? edit.details : {};
    out.change = { type: clip(edit.type, 20), css: clip(edit.css, 2000) };
    if (typeof d.before === 'string') out.change.before = clip(d.before, 500);
    if (typeof d.after === 'string') out.change.after = clip(d.after, 500);
    if (d.parentSelector != null) {
      out.change.parentSelector = clip(d.parentSelector, 500);
      if (Number.isInteger(d.fromIndex)) out.change.fromIndex = d.fromIndex;
      if (Number.isInteger(d.toIndex)) out.change.toIndex = d.toIndex;
    }
  }
  return out;
}

function publicJourney(rec, migrate) {
  if (!isObj(rec) || typeof rec.id !== 'string') return null;
  let migratable = false;
  let refused = [];
  try {
    const m = migrate(rec);
    migratable = m.ok === true;
    refused = (m.refused || []).slice(0, 10).map((r) => ({ stepIndex: r.stepIndex, code: clip(r.code, 60) }));
  } catch (_e) { migratable = false; }
  return { id: rec.id, name: clip(rec.name, 200), startUrl: clip(rec.startUrl, 2000), steps: Array.isArray(rec.steps) ? rec.steps.length : 0, migratable, refused };
}

function filterNotes(all, { status, sessionId, limit } = {}) {
  let list = all;
  if (STATUSES.includes(status)) list = list.filter((n) => (STATUSES.includes(n.status) ? n.status : 'open') === status);
  if (typeof sessionId === 'string' && sessionId) list = list.filter((n) => n.sessionId === sessionId);
  const max = Math.max(1, Math.min(MAX_LIST, Number.isInteger(limit) ? limit : 50));
  return { notes: list.slice(0, max).map(publicNote).filter(Boolean), total: list.length, truncated: list.length > max };
}

// The mutations, expressed over two primitives so both backends share the rules.
function mutations({ read, writeAgent, resolve, now }) {
  const need = (noteId) => {
    const note = read(noteId);
    if (!note) { const e = new Error('unknown note'); e.code = 'NOTE_NOT_FOUND'; throw e; }
    return note;
  };
  return {
    claim(noteId, who) {
      const note = need(noteId);
      const agent = { ...(isObj(note.agent) ? note.agent : {}), claimedBy: clip(who, 120), claimedAt: now() };
      writeAgent(noteId, agent);
      return publicNote(read(noteId));
    },
    propose(noteId, { message, who } = {}) {
      const note = need(noteId);
      const agent = { ...(isObj(note.agent) ? note.agent : {}), proposal: { message: clip(message, 1000), by: clip(who, 120), at: now() } };
      writeAgent(noteId, agent);
      return publicNote(read(noteId));
    },
    // `verification` is computed by the broker from a run it graded; never client-supplied.
    recordVerification(noteId, verification) {
      const note = need(noteId);
      const v = isObj(verification) ? verification : {};
      const verdict = noteChecks.VERDICTS.includes(v.verdict) ? v.verdict : 'unknown';
      const agent = { ...(isObj(note.agent) ? note.agent : {}),
        verification: { verdict, runId: clip(v.runId, 160), runState: clip(v.runState, 40), by: clip(v.by, 120), at: now(), checks: Number.isInteger(v.checks) ? v.checks : 0 } };
      writeAgent(noteId, agent);
      // Proof resolves; a failed proof re-opens a note that claimed to be done.
      if (verdict === 'fixed') resolve(noteId, 'resolved');
      else if (verdict === 'regressed' || verdict === 'not-fixed') resolve(noteId, 'open');
      return publicNote(read(noteId));
    },
  };
}

// ---------------------------------------------------------------- desktop store
function createStoreSource({ repos, migrate = defaultMigrate, now = () => new Date().toISOString() } = {}) {
  if (!repos || !repos.annotations || !repos.recordings) throw new TypeError('createStoreSource: repos are required');
  const all = () => (typeof repos.annotations.all === 'function' ? repos.annotations.all() : []);
  const read = (noteId) => repos.annotations.get(noteId) || null;
  return {
    kind: 'store',
    listNotes: (filter) => filterNotes(all(), filter),
    getNote: (noteId) => publicNote(read(noteId)),
    loadNote: read,
    listJourneys: () => repos.recordings.list().slice(0, MAX_LIST).map((r) => publicJourney(r, migrate)).filter(Boolean),
    loadRecording: (recordingId) => repos.recordings.get(recordingId) || null,
    ...mutations({
      read, now,
      writeAgent: (noteId, agent) => { repos.annotations.update(noteId, { agent }); },
      resolve: (noteId, status) => { repos.annotations.update(noteId, { status }); },
    }),
  };
}

// ---------------------------------------------------------------- bundle directory
// Reads every *.braiwser.json in `dir` through the same validation an import uses.
// Bundle ids are not globally unique, so ids are namespaced by bundle:
// "<bundle>_<index>" for notes and journeys. The directory is never written;
// claims, proposals and verifications live in `stateFile`.
function createFileSource({ dir, stateFile, migrate = defaultMigrate, now = () => new Date().toISOString(), log = () => {} } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('createFileSource: dir is required');
  const bundle = require('../bundle');
  const slug = (name) => name.replace(/\.braiwser\.json$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'bundle';

  let cache = { stamp: '', notes: new Map(), journeys: new Map() };
  function load() {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.braiwser\.json$/i.test(f)).sort().slice(0, 50); } catch (_e) { files = []; }
    const stamp = files.map((f) => { try { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; } catch (_e) { return f; } }).join('|');
    if (stamp === cache.stamp) return cache;
    const notes = new Map();
    const journeys = new Map();
    const used = new Set();
    for (const file of files) {
      let plan;
      try { plan = bundle.validateBundle(bundle.parseBundle(fs.readFileSync(path.join(dir, file), 'utf8'))).plan; }
      catch (e) { log(`[review] ${file}: ${(e && e.message) || e}`); continue; }
      if (!plan) continue;
      let ns = slug(file);
      for (let n = 2; used.has(ns); n += 1) ns = `${slug(file)}-${n}`;
      used.add(ns);
      const sessionUrl = new Map((plan.sessions || []).map((s) => [s.oldId, s.url || '']));
      (plan.annotations || []).forEach((a, i) => {
        const id = `${ns}_${i + 1}`;
        notes.set(id, { ...a, id, sessionId: `${ns}_s_${a.sessionOld || ''}`.slice(0, 160), url: a.url || sessionUrl.get(a.sessionOld) || '' });
      });
      (plan.recordings || []).forEach((r, i) => {
        const id = `${ns}_j${i + 1}`;
        journeys.set(id, { id, name: r.name, startUrl: r.startUrl, steps: r.steps });
      });
    }
    cache = { stamp, notes, journeys };
    return cache;
  }

  function readState() {
    try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return isObj(s) && isObj(s.notes) ? s : { v: 1, notes: {} }; }
    catch (_e) { return { v: 1, notes: {} }; }
  }
  function writeState(state) {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  const read = (noteId) => {
    const base = load().notes.get(noteId);
    if (!base) return null;
    const st = readState().notes[noteId];
    return isObj(st) ? { ...base, ...(isObj(st.agent) ? { agent: st.agent } : {}), ...(STATUSES.includes(st.status) ? { status: st.status } : {}) } : base;
  };
  const patch = (noteId, change) => {
    if (!stateFile) { const e = new Error('this review source is read-only'); e.code = 'REVIEW_READ_ONLY'; throw e; }
    const state = readState();
    state.notes[noteId] = { ...(isObj(state.notes[noteId]) ? state.notes[noteId] : {}), ...change };
    writeState(state);
  };
  return {
    kind: 'files',
    listNotes: (filter) => filterNotes([...load().notes.keys()].map(read).filter(Boolean), filter),
    getNote: (noteId) => publicNote(read(noteId)),
    loadNote: read,
    listJourneys: () => [...load().journeys.values()].slice(0, MAX_LIST).map((r) => publicJourney(r, migrate)).filter(Boolean),
    loadRecording: (recordingId) => load().journeys.get(recordingId) || null,
    ...mutations({
      read, now,
      writeAgent: (noteId, agent) => patch(noteId, { agent }),
      resolve: (noteId, status) => patch(noteId, { status }),
    }),
  };
}

module.exports = { createStoreSource, createFileSource, publicNote, publicJourney };
