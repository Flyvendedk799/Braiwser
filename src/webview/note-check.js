// Braiwser — note-check.js
// Evaluates a note's derived checks (shared/note-checks.js) against the live
// page, for the in-app Verify run. Same check vocabulary and the same style
// engine (probe.js `assertFacts`) the agent runtime uses, so a note that reads
// "fixed" here reads "fixed" in a verified run.
//
// Only an EXACT anchor counts: a guessed element (text or position fallback) is
// good enough to show a pin, never good enough to call something fixed.

'use strict';

const anchor = require('./anchor');
const probe = require('./probe');
const noteChecks = require('../shared/note-checks');
const { normalizeText } = require('../shared/assertions');

function evaluateCheck(check, resolved) {
  const el = resolved && resolved.confidence === 'exact' ? resolved.el : null;
  if (check.kind === 'absent') {
    // Passing needs positive knowledge that nothing matches; an ambiguous or guessed anchor is not that.
    if (!resolved || (resolved.el === null && !resolved.ambiguous && resolved.candidates === 0)) return { status: 'passed', actual: 'absent' };
    if (el) return { status: 'failed', actual: 'present' };
    return { status: 'unknown', actual: 'cannot tell which element this was', missing: true };
  }
  if (!el) return { status: 'failed', actual: '(no element)', missing: true };
  if (check.kind === 'text') {
    const actual = normalizeText(el.innerText || el.textContent || '');
    return { status: actual === check.expected ? 'passed' : 'failed', actual: actual.slice(0, 120) };
  }
  if (check.kind === 'style') {
    const i = check.expected.indexOf(':');
    const style = { property: check.expected.slice(0, i).trim(), value: check.expected.slice(i + 1).trim() };
    let facts = null;
    try { facts = probe.run('assertFacts', { el, style }); } catch (_e) { facts = null; }
    const f = facts && facts.style;
    if (!f || typeof f.actual !== 'string') return { status: 'unknown', actual: '(not computed)' };
    if (f.supported !== true || typeof f.expected !== 'string') return { status: 'failed', actual: f.actual.slice(0, 120), error: 'the browser does not accept this declaration' };
    return { status: f.actual === f.expected ? 'passed' : 'failed', actual: `${style.property}: ${f.actual}`.slice(0, 160) };
  }
  return { status: 'unknown', actual: 'unsupported check' };
}

// notes: [{ id, kind, action, status, target, edit }]
// opts.previewActive: the inspector still has live edits applied to this document,
//   so the page shows the PREVIEW of the fix, not the source. Nothing is graded.
// Returns [{ id, verdict, reason?, checks:[{ kind, expected, status, actual }], skipped }]
function checkNotes(notes, opts) {
  const previewActive = !!(opts && opts.previewActive);
  const out = [];
  for (const note of Array.isArray(notes) ? notes.slice(0, 500) : []) {
    if (!note || typeof note !== 'object') continue;
    const derived = noteChecks.deriveChecks(note);
    if (derived.unverifiable) {
      out.push({ id: note.id, verdict: 'unverifiable', reason: derived.unverifiable, checks: [], skipped: derived.skipped });
      continue;
    }
    if (previewActive) {
      out.push({ id: note.id, verdict: 'unknown', reason: 'a live preview of an edit is still applied to this page; reload it to check the real source',
        checks: derived.checks.map((c) => ({ kind: c.kind, expected: c.expected || '', status: 'unknown', actual: '' })), skipped: derived.skipped });
      continue;
    }
    let resolved = null;
    try { resolved = anchor.resolveDetailed(note.target); } catch (_e) { resolved = null; }
    const results = derived.checks.map((c) => {
      let r;
      try { r = evaluateCheck(c, resolved); } catch (e) { r = { status: 'unknown', actual: String((e && e.message) || e).slice(0, 120) }; }
      return { kind: c.kind, expected: c.expected || '', ...r };
    });
    const verdict = noteChecks.verdictFor(note, noteChecks.gradeNote(results));
    const item = { id: note.id, verdict, checks: results, skipped: derived.skipped };
    if (verdict === 'unknown') item.reason = results.some((r) => r.missing) ? 'the note\'s element could not be found exactly on this page' : 'a check could not be evaluated';
    out.push(item);
  }
  return out;
}

module.exports = { checkNotes, evaluateCheck };
