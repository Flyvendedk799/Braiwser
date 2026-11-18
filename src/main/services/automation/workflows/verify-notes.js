'use strict';
// verify-notes 1.0.0 — prove that review notes carrying an exact change are fixed.
//
// A note made in Edit or Rearrange mode (or a "remove this" note) states the
// change precisely. shared/note-checks.js turns each one into assertions in the
// closed plan language; this skill compiles them into ONE plan per run:
//
//   nav<g>            navigate <page of the notes>   (once per distinct page, in note order)
//   n.<noteId>.c<k>   assert ...                     (check k of that note)
//
// The step ids carry the note id, so the stored run itself says which note each
// result belongs to: `noteVerdict()` reads a verdict back from the run record
// without trusting anything the client says afterwards.
//
// Refuses, with the reason per note, instead of producing a weaker plan: a note
// with nothing exact to check, or whose element has no unique semantic name, is
// not something a run can prove.
const { z } = require('zod');
const wf = require('../workflow-core');
const noteChecks = require('../../../../shared/note-checks');
const { id, RegistryError } = require('./_shared');

const MAX_NOTES = 20;
const STEP_SAFE_ID = /^[A-Za-z0-9_-]{1,60}$/;

const manifest = Object.freeze({
  id: 'verify-notes',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Verify review notes',
  description: 'Check that review notes carrying an exact change (a style, new copy, a removal) now hold on the page. Refuses notes that state nothing checkable or whose element has no unique semantic name.',
  executor: 'broker-plan',
  requires: ['navigate', 'assert'],
  maxDurationMs: 180000,
});

const inputSchema = z.strictObject({ noteIds: z.array(id).min(1).max(MAX_NOTES) }).superRefine((v, ctx) => {
  if (new Set(v.noteIds).size !== v.noteIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate note id', path: ['noteIds'] });
});

const pageOf = (url) => String(url || '').split('#')[0];

// ctx.loadNote(noteId) is a SYNCHRONOUS, owner-scoped lookup supplied by the host
// (desktop store or the standalone review directory).
function compile(inputs, ctx = {}) {
  const parsed = inputSchema.parse(inputs);
  if (typeof ctx.loadNote !== 'function') {
    throw new RegistryError('UNAVAILABLE', 'No review source is configured for verify-notes.');
  }
  const refused = [];
  const prepared = [];
  parsed.noteIds.forEach((noteId) => {
    const note = ctx.loadNote(noteId);
    if (note && typeof note.then === 'function') throw new RegistryError('UNAVAILABLE', 'The note loader must be synchronous.');
    if (!STEP_SAFE_ID.test(noteId)) { refused.push({ noteId, code: 'NOTE_ID_UNSUPPORTED', reason: 'The note id cannot be carried in a step id.' }); return; }
    if (!note) { refused.push({ noteId, code: 'NOTE_NOT_FOUND', reason: 'The note does not exist or is not visible to this principal.' }); return; }
    const plan = noteChecks.planAssertions(note);
    if (!plan.ok) { refused.push({ noteId, code: plan.code, reason: plan.reason }); return; }
    if (!pageOf(note.url)) { refused.push({ noteId, code: 'NOTE_NO_PAGE', reason: 'The note has no page address.' }); return; }
    prepared.push({ noteId, page: pageOf(note.url), assertions: plan.assertions });
  });
  if (refused.length) {
    throw new RegistryError('NOTES_NOT_VERIFIABLE', 'Some notes cannot be proven by a run.', { refused: refused.slice(0, MAX_NOTES) });
  }

  const steps = [];
  let page = null;
  let nav = 0;
  for (const p of prepared) {
    if (p.page !== page) { page = p.page; nav += 1; steps.push({ id: `nav${nav}`, type: 'navigate', url: p.page }); }
    p.assertions.forEach((a, k) => {
      steps.push({ id: `n.${p.noteId}.c${k + 1}`, type: 'assert', target: a.target, kind: a.kind, op: a.op, expected: a.expected });
    });
  }
  let plan;
  try {
    plan = wf.validateWorkflow({
      schemaVersion: wf.SCHEMA_VERSION, skillId: manifest.id, version: manifest.version, inputKeys: [],
      maxDurationMs: Math.min(ctx.maxDurationMs || 120000, manifest.maxDurationMs), steps,
    });
  } catch (error) {
    throw new RegistryError('PLAN_INVALID', 'The note plan failed workflow validation (a note page must be an http(s) address).',
      { issues: (error.issues || []).slice(0, 10).map((i) => i.message) });
  }
  return { plan, planDigest: wf.digestOf(plan), inputs: {}, dropped: [], warnings: [] };
}

// The verdict for ONE note from a stored run of this skill, or null when the run
// has no step for that note. `results` are the run's [{ stepId, status, code }].
//   graded: 'fixed' | 'not-fixed' | 'unknown'  (shared/note-checks.js gradeNote)
// A run that did not end in a graded state proves nothing about a note, even
// when the steps it did reach were green.
function noteVerdict(noteId, results, runState) {
  if (!STEP_SAFE_ID.test(String(noteId))) return null;
  const prefix = `n.${noteId}.c`;
  const mine = (results || []).filter((r) => r && typeof r.stepId === 'string' && r.stepId.startsWith(prefix) && /^\d{1,2}$/.test(r.stepId.slice(prefix.length)));
  if (!mine.length) return null;
  const checks = mine.map((r) => ({ stepId: r.stepId, status: r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'unknown',
    missing: r.status === 'failed' && r.code === 'TARGET_MISSING' }));
  let graded = noteChecks.gradeNote(checks);
  if (!['passed', 'failed'].includes(runState) && graded !== 'not-fixed') graded = 'unknown';
  return { noteId, graded, checks };
}

// Step ids of one note inside a plan of this skill (to tell "not in this run" from "not run yet").
function plannedFor(noteId, plan) {
  const prefix = `n.${noteId}.c`;
  return ((plan && plan.steps) || []).filter((st) => st.type === 'assert' && st.id.startsWith(prefix)).map((st) => st.id);
}

module.exports = { manifest, inputSchema, compile, noteVerdict, plannedFor, MAX_NOTES, sourceFile: __filename };
