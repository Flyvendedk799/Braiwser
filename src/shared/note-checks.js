'use strict';
// A review note as a checkable contract.
//
// Edit and Rearrange notes already carry the exact change that was previewed
// (the CSS, the new copy, "remove this"). This module turns that into checks an
// engine can evaluate against a page, so "is this note fixed?" has an answer
// that is not somebody's opinion:
//
//   deriveChecks(note)          -> { checks, skipped, unverifiable }
//   planAssertions(note)        -> { ok, target, assertions } | { ok:false, code, reason }
//   gradeNote(results)          -> 'fixed' | 'not-fixed' | 'unknown'
//   verdictFor(note, graded)    -> adds 'regressed' and 'unverifiable'
//
// Pure data + pure functions, no DOM and no Node-only APIs: it is required from
// main, bundled into the guest preload and used by the agent runtime alike.
//
// Honesty rules:
//   * A note with no derivable check is 'unverifiable'. It is never "fixed" by
//     default; a person (or an assertion somebody writes) has to decide.
//   * A check whose element cannot be found is 'unknown', not 'not-fixed' and
//     never 'fixed' - except an `absent` check, where not finding it IS the pass.
//   * 'regressed' means: the note was marked resolved and its checks now fail.

const { parseStyleDeclaration, normalizeText } = require('./assertions');

const MAX_CHECKS = 24;
const MAX_TEXT = 1000;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function declarationsOf(edit) {
  const out = [];
  const details = isObj(edit.details) ? edit.details : {};
  if (isObj(details.props) && Object.keys(details.props).length) {
    for (const [property, value] of Object.entries(details.props)) out.push([property, value]);
  } else if (typeof edit.css === 'string') {
    for (const part of edit.css.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out.push([part.slice(0, i), part.slice(i + 1)]);
    }
  }
  return out;
}

// What can be checked about this note. `skipped` lists declarations that are
// part of the note but cannot be checked (and why); `unverifiable` is set when
// there is nothing to check at all.
function deriveChecks(note) {
  const checks = [];
  const skipped = [];
  if (!isObj(note)) return { checks, skipped, unverifiable: 'not a note' };
  const edit = isObj(note.edit) ? note.edit : null;
  const type = edit && typeof edit.type === 'string' ? edit.type : '';
  const details = edit && isObj(edit.details) ? edit.details : {};

  if (edit && type === 'text') {
    if (typeof details.after === 'string' && normalizeText(details.after) && normalizeText(details.after).length <= MAX_TEXT) {
      checks.push({ kind: 'text', expected: normalizeText(details.after) });
    } else {
      skipped.push({ what: 'copy', reason: 'the new text is empty or too long to compare' });
    }
  } else if (edit && (type === 'reorder' || type === 'reparent')) {
    return { checks, skipped, unverifiable: 'a reorder or move changes where the element is, which its own address cannot confirm; verify it with a journey assertion' };
  } else if (edit) {
    for (const [rawProperty, rawValue] of declarationsOf(edit)) {
      if (checks.length >= MAX_CHECKS) { skipped.push({ what: String(rawProperty).trim().slice(0, 60), reason: 'too many declarations' }); continue; }
      const value = String(rawValue == null ? '' : rawValue).replace(/!\s*important/i, '').trim();
      const parsed = parseStyleDeclaration(`${String(rawProperty).trim()}: ${value}`);
      if (parsed) checks.push({ kind: 'style', expected: `${parsed.property}: ${parsed.value}` });
      else skipped.push({ what: String(rawProperty).trim().slice(0, 60), reason: 'not a plain declaration that can be compared safely' });
    }
  } else if (note.action === 'remove' && (note.kind === 'element' || note.kind == null)) {
    checks.push({ kind: 'absent' });
  }

  if (!checks.length) {
    return { checks, skipped, unverifiable: skipped.length
      ? 'none of the changes in this note can be compared automatically'
      : 'a written note with no exact change attached; a person or a journey assertion has to confirm it' };
  }
  return { checks, skipped, unverifiable: null };
}

// The closed semantic locator of a note's target, or null (never a CSS path).
function locatorOf(note) {
  const l = isObj(note) && isObj(note.target) ? note.target.locator : null;
  if (!isObj(l)) return null;
  const ok = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200;
  if ((l.by === 'testId' || l.by === 'label') && ok(l.value)) return { by: l.by, value: l.value };
  if (l.by === 'role' && ok(l.role) && ok(l.name)) return { by: 'role', role: l.role, name: l.name };
  return null;
}

// Assertions in the closed plan language (workflow-core / browser-contracts) for
// one note. Refuses with a reason instead of producing a weaker check.
function planAssertions(note) {
  const derived = deriveChecks(note);
  if (derived.unverifiable) return { ok: false, code: 'NOTE_UNVERIFIABLE', reason: derived.unverifiable };
  const target = locatorOf(note);
  if (!target) {
    return { ok: false, code: 'NOTE_NO_SEMANTIC_TARGET',
      reason: 'the note\'s element has no unique test id or role + name, so a run cannot address it without guessing' };
  }
  // A copy edit on an element that is NAMED by its text (a button, a link) changes the
  // very name the locator recorded. After the fix the element answers to the new copy.
  const edit = isObj(note.edit) ? note.edit : null;
  if (edit && edit.type === 'text' && target.by === 'role' && isObj(edit.details)
      && typeof edit.details.before === 'string' && normalizeText(edit.details.before) === normalizeText(target.name)
      && typeof edit.details.after === 'string' && normalizeText(edit.details.after).length <= 200) {
    target.name = normalizeText(edit.details.after);
  }
  const assertions = derived.checks.map((c) => {
    if (c.kind === 'style') return { kind: 'style', op: 'equals', expected: c.expected, target };
    if (c.kind === 'text') return { kind: 'text', op: 'equals', expected: c.expected, target };
    return { kind: 'count', op: 'equals', expected: '0', target };
  });
  return { ok: true, target, assertions, checks: derived.checks, skipped: derived.skipped };
}

// results: [{ status:'passed'|'failed'|'unknown', missing?:boolean }] in check order.
//   every check passed                      -> fixed
//   a check failed on an element we found   -> not-fixed
//   anything else (missing element, engine) -> unknown
function gradeNote(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return 'unknown';
  if (list.every((r) => r && r.status === 'passed')) return 'fixed';
  if (list.some((r) => r && r.status === 'failed' && r.missing !== true)) return 'not-fixed';
  return 'unknown';
}

// Final per-note verdict. `graded` is gradeNote()'s answer, or null when the
// note has no checks.
function verdictFor(note, graded) {
  if (graded == null) return 'unverifiable';
  if (graded === 'not-fixed' && isObj(note) && note.status === 'resolved') return 'regressed';
  return graded;
}

const VERDICTS = Object.freeze(['fixed', 'not-fixed', 'regressed', 'unknown', 'unverifiable']);

// Counts for a list of { verdict }.
function tally(items) {
  const out = { total: 0, fixed: 0, notFixed: 0, regressed: 0, unknown: 0, unverifiable: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    out.total += 1;
    if (it.verdict === 'fixed') out.fixed += 1;
    else if (it.verdict === 'not-fixed') out.notFixed += 1;
    else if (it.verdict === 'regressed') out.regressed += 1;
    else if (it.verdict === 'unverifiable') out.unverifiable += 1;
    else out.unknown += 1;
  }
  return out;
}

module.exports = { deriveChecks, planAssertions, locatorOf, gradeNote, verdictFor, tally, VERDICTS, MAX_CHECKS };
