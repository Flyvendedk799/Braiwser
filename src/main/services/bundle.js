// Project bundles — a portable, self-contained snapshot of a review.
//
// A bundle carries one project with every session, annotation, and recording
// that belongs to it, so a review can be handed to a teammate, archived next to
// the code, or moved between machines. Import always creates NEW ids: importing
// a bundle twice yields two independent copies rather than silently merging
// into (or corrupting) whatever already exists.
//
// Wire format (schema/braiwser-bundle.v1.json):
//   { format: 'braiwser-bundle', kind: 'braiwser.project-bundle', version: 1,
//     exportedAt, project, sessions[], annotations[], recordings[] }
// Exports carry BOTH `format` (the published schema's discriminator) and `kind`
// (what earlier builds wrote and required). Import accepts either one, so files
// written by any earlier build, and files generated from the published schema,
// both import.
//
// A bundle is untrusted input (CE-03/04/19). Import is two-phase:
//   1. validateBundle() walks the ENTIRE bounded object graph and produces a
//      sanitised plan (closed field whitelists, enums, finite bounded numbers,
//      bounded strings/arrays, reference checks). Nothing is written.
//      Structural problems reject the whole import; a malformed annotation or
//      recording is dropped and listed in the result - never silently.
//   2. commitPlan() writes the plan as one unit. If anything fails after the
//      first write, the whole project (sessions, annotations and recordings all
//      hang off it) is removed again, so a failed import changes nothing.
// Imported projects are marked `imported: true` with `path` cleared: the original
// machine's directory means nothing here, and hand-off must not run against a
// directory the user never chose.

const crypto = require('crypto');
const { redactRecording, recordingHasSecrets } = require('../../shared/redact');
const { scrubRecording } = require('./export/scrub');
const { STEP_TYPES, CONTROLS, normalizeAssertion } = require('../../shared/assertions');

const BUNDLE_KIND = 'braiwser.project-bundle';
const BUNDLE_FORMAT = 'braiwser-bundle';
const BUNDLE_VERSION = 1;

const LIMITS = Object.freeze({
  textChars: 64 * 1024 * 1024,
  sessions: 1000,
  annotations: 50000,
  recordings: 500,
  steps: 5000,
  name: 200,
  title: 300,
  url: 8000,
  note: 20000,
  selector: 2000,
  stepText: 500,
  value: 100000,
  jsonBytes: 100000, // per free-form object (annotation target / edit)
  jsonDepth: 8,
  dimension: 20000,
  droppedListed: 100,
});

const KINDS = ['element', 'region', 'edit'];
const STATUSES = ['open', 'resolved'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const VISIBILITIES = ['internal', 'client'];
const PROJECT_KINDS = ['local', 'url'];
const URL_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class BundleError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'BundleError';
    this.errors = errors;
  }
}

function slug(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
}

// Collect a project and everything hanging off it.
function exportBundle(repos, projectId) {
  const project = repos.projects.get(projectId);
  if (!project) throw new Error('Project not found');

  const sessions = repos.sessions.list(projectId);
  const annotations = [];
  for (const s of sessions) annotations.push(...repos.annotations.bySession(s.id));
  // CE-01: second redaction boundary - no recording leaves with a credential in it.
  const recordings = repos.recordings.list(projectId).map(scrubRecording);

  const bundle = {
    format: BUNDLE_FORMAT,
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project,
    sessions,
    annotations,
    recordings,
  };

  return {
    defaultName: `${slug(project.name)}.braiwser.json`,
    content: JSON.stringify(bundle, null, 2),
    counts: { sessions: sessions.length, annotations: annotations.length, recordings: recordings.length },
  };
}

// ---- parsing / header ------------------------------------------------------------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function parseBundle(text) {
  if (typeof text !== 'string') throw new Error('That file is not valid JSON.');
  if (text.length > LIMITS.textChars) throw new Error('That file is too large to be a Braiwser bundle.');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('That file is not valid JSON.');
  }
  if (!isObj(data)) throw new Error('That file is not a Braiwser project bundle.');
  const okFormat = data.format === BUNDLE_FORMAT;
  const okKind = data.kind === BUNDLE_KIND;
  // Either discriminator is enough; a present-but-wrong one is a different document type.
  const wrongFormat = data.format !== undefined && !okFormat;
  const wrongKind = data.kind !== undefined && !okKind;
  if ((!okFormat && !okKind) || wrongFormat || wrongKind) {
    throw new Error('That file is not a Braiwser project bundle.');
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    throw new Error('The bundle has a missing or invalid version number.');
  }
  if (data.version > BUNDLE_VERSION) {
    throw new Error(`This bundle was written by a newer Braiwser (v${data.version}).`);
  }
  if (!isObj(data.project) || typeof data.project.name !== 'string' || !data.project.name.trim()) {
    throw new Error('The bundle has no project in it.');
  }
  return data;
}

// ---- sanitising helpers ----------------------------------------------------------

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function finiteIn(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

// Bounded JSON-ish clone: plain data only, no prototype keys, depth/size limited.
// Returns undefined when the value can't be represented within the limits.
function safeJson(value, depth = 0, budget = { n: LIMITS.jsonBytes }) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    budget.n -= value.length;
    return budget.n < 0 ? undefined : value;
  }
  if (depth >= LIMITS.jsonDepth) return undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const c = safeJson(item, depth + 1, budget);
      if (c === undefined) return undefined;
      out.push(c);
      budget.n -= 2;
      if (budget.n < 0) return undefined;
    }
    return out;
  }
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) continue;
      const c = safeJson(v, depth + 1, budget);
      if (c === undefined) return undefined;
      out[k] = c;
      budget.n -= k.length + 4;
      if (budget.n < 0) return undefined;
    }
    return out;
  }
  return undefined;
}

// '' for "none"; null when the value is present but not an acceptable URL.
function cleanUrl(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > LIMITS.url) return null;
  try {
    const u = new URL(v);
    return URL_PROTOCOLS.has(u.protocol) ? v : null;
  } catch (_e) {
    return null;
  }
}

// Viewport: finite, bounded, positive dimensions or nothing (CE-04).
function cleanViewport(v) {
  if (!isObj(v)) return null;
  if (!finiteIn(v.w, 1, LIMITS.dimension) || !finiteIn(v.h, 1, LIMITS.dimension)) return null;
  const out = { w: Math.round(v.w), h: Math.round(v.h) };
  if (typeof v.label === 'string') out.label = v.label.slice(0, 40);
  if (finiteIn(v.dpr, 0.1, 16)) out.dpr = v.dpr;
  return out;
}

function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

// ---- validation (phase 1: nothing is written) --------------------------------------

function validateSessions(raw, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push('sessions must be an array'); return []; }
  if (raw.length > LIMITS.sessions) { errors.push(`too many sessions (${raw.length}; the limit is ${LIMITS.sessions})`); return []; }
  const out = [];
  const seen = new Set();
  raw.forEach((s, i) => {
    if (!isObj(s)) { errors.push(`sessions[${i}] is not an object`); return; }
    if (typeof s.id !== 'string' || !s.id || s.id.length > 200) { errors.push(`sessions[${i}] has no valid id`); return; }
    if (seen.has(s.id)) { errors.push(`duplicate session id at sessions[${i}]`); return; }
    seen.add(s.id);
    if (s.name != null && typeof s.name !== 'string') { errors.push(`sessions[${i}].name is not text`); return; }
    const url = cleanUrl(s.url);
    out.push({ oldId: s.id, name: str(s.name, LIMITS.name) || 'Review', url: url || '', title: str(s.title, LIMITS.title), _badUrl: url === null });
  });
  return out;
}

function validateAnnotation(a, i, sessionIds, dropped, warnings) {
  const drop = (reason) => { dropped.push({ type: 'annotation', index: i, reason }); return null; };
  if (!isObj(a)) return drop('not an object');
  if (typeof a.sessionId !== 'string' || !sessionIds.has(a.sessionId)) return drop('orphaned: its session is not in the bundle');
  if (a.note != null && typeof a.note !== 'string') return drop('note is not text');
  if (a.target != null && !isObj(a.target)) return drop('target is not an object');
  const target = a.target == null ? {} : safeJson(a.target);
  if (target === undefined) return drop('target is too large or too deeply nested');
  const out = {
    sessionOld: a.sessionId,
    kind: pick(a.kind, KINDS, 'element'),
    action: str(a.action, 40) || 'comment',
    note: str(a.note, LIMITS.note),
    target,
    title: str(a.title, LIMITS.title),
    status: pick(a.status, STATUSES, 'open'),
    priority: pick(a.priority, PRIORITIES, 'normal'),
    visibility: pick(a.visibility, VISIBILITIES, 'internal'),
  };
  const url = cleanUrl(a.url);
  out.url = url || '';
  if (url === null) warnings.push(`annotation ${i + 1}: unusable page URL removed`);
  if (finiteIn(a.sortOrder, -1e9, 1e9)) out.sortOrder = a.sortOrder;
  if (a.viewport != null) {
    const vp = cleanViewport(a.viewport);
    if (vp) out.viewport = vp;
    else warnings.push(`annotation ${i + 1}: invalid viewport removed`);
  }
  if (a.edit != null) {
    const edit = isObj(a.edit) ? safeJson(a.edit) : undefined;
    if (edit === undefined) warnings.push(`annotation ${i + 1}: invalid edit data removed`);
    else out.edit = edit;
  }
  return out;
}

const STEP_STRING_FIELDS = { selector: LIMITS.selector, tag: 40, text: LIMITS.stepText, key: 40, title: LIMITS.name, label: LIMITS.name, name: LIMITS.name };

function validateStep(step) {
  if (!isObj(step)) return { error: 'not an object' };
  if (typeof step.type !== 'string' || !STEP_TYPES.includes(step.type)) return { error: 'unsupported step type' };
  const out = { type: step.type };
  for (const [k, max] of Object.entries(STEP_STRING_FIELDS)) {
    if (typeof step[k] === 'string') out[k] = step[k].slice(0, max);
  }
  if (typeof step.control === 'string' && CONTROLS.includes(step.control)) out.control = step.control;
  if (typeof step.secret === 'boolean') out.secret = step.secret;
  if (typeof step.placeholder === 'string') out.placeholder = step.placeholder.slice(0, 40);
  if (typeof step.ts === 'string') out.ts = step.ts.slice(0, 40);
  else if (finiteIn(step.ts, 0, 1e15)) out.ts = step.ts;
  if (finiteIn(step.x, -1e7, 1e7)) out.x = step.x;
  if (finiteIn(step.y, -1e7, 1e7)) out.y = step.y;
  if (isObj(step.position) && finiteIn(step.position.x, -1e7, 1e7) && finiteIn(step.position.y, -1e7, 1e7)) {
    out.position = { x: step.position.x, y: step.position.y };
  }
  if (typeof step.url === 'string') {
    const url = cleanUrl(step.url);
    if (url) out.url = url;
  }
  const v = step.value;
  if (typeof v === 'string') out.value = v.slice(0, LIMITS.value);
  else if (typeof v === 'boolean' || finiteIn(v, -1e15, 1e15)) out.value = v;
  else if (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 2000)) out.value = v.slice();

  if (step.type === 'assert') {
    for (const k of ['kind', 'op']) if (typeof step[k] === 'string') out[k] = step[k].slice(0, 40);
    if (typeof step.expected === 'string') out.expected = step.expected.slice(0, 4000);
    else if (finiteIn(step.expected, -1e15, 1e15)) out.expected = step.expected;
    const n = normalizeAssertion(out);
    if (!n.ok) return { error: `invalid assertion (${n.error})` };
  }
  return { step: out };
}

function validateRecording(r, i, dropped, warnings) {
  const drop = (reason) => { dropped.push({ type: 'recording', index: i, reason }); return null; };
  if (!isObj(r)) return drop('not an object');
  if (r.name != null && typeof r.name !== 'string') return drop('name is not text');
  if (r.steps != null && !Array.isArray(r.steps)) return drop('steps is not an array');
  const rawSteps = r.steps || [];
  if (rawSteps.length > LIMITS.steps) return drop(`too many steps (${rawSteps.length}; the limit is ${LIMITS.steps})`);
  const steps = [];
  for (let n = 0; n < rawSteps.length; n++) {
    const res = validateStep(rawSteps[n]);
    if (res.error) return drop(`step ${n + 1}: ${res.error}`);
    steps.push(res.step);
  }
  const startUrl = cleanUrl(r.startUrl);
  if (startUrl === null) warnings.push(`recording ${i + 1}: unusable start URL removed`);
  const rec = { name: str(r.name, LIMITS.name) || 'Journey', startUrl: startUrl || '', steps };
  // CE-01: a bundle may carry a plaintext secret with secret:true - never import it.
  if (recordingHasSecrets(rec)) {
    warnings.push(`recording "${rec.name}": secret values were removed`);
    return redactRecording(rec);
  }
  return rec;
}

// Walks the whole graph. Throws BundleError (nothing written) when the bundle is
// structurally unusable; otherwise returns the sanitised plan plus what was dropped.
function validateBundle(data) {
  const errors = [];
  const dropped = [];
  const warnings = [];
  if (!isObj(data) || !isObj(data.project)) throw new BundleError('The bundle has no project in it.', ['project is missing']);

  const name = typeof data.project.name === 'string' ? data.project.name.trim().slice(0, LIMITS.name) : '';
  if (!name) errors.push('project has no name');
  const kind = pick(data.project.kind, PROJECT_KINDS, 'url');

  const sessions = validateSessions(data.sessions, errors);
  for (const s of sessions) if (s._badUrl) warnings.push(`session "${s.name}": unusable URL removed`);

  const annotations = [];
  if (data.annotations !== undefined && !Array.isArray(data.annotations)) errors.push('annotations must be an array');
  else if ((data.annotations || []).length > LIMITS.annotations) errors.push(`too many annotations (${data.annotations.length}; the limit is ${LIMITS.annotations})`);
  const recordings = [];
  if (data.recordings !== undefined && !Array.isArray(data.recordings)) errors.push('recordings must be an array');
  else if ((data.recordings || []).length > LIMITS.recordings) errors.push(`too many recordings (${data.recordings.length}; the limit is ${LIMITS.recordings})`);

  if (errors.length) {
    throw new BundleError(`This bundle is malformed and was not imported: ${errors.slice(0, 5).join('; ')}`, errors);
  }

  const sessionIds = new Set(sessions.map((s) => s.oldId));
  (data.annotations || []).forEach((a, i) => {
    const v = validateAnnotation(a, i, sessionIds, dropped, warnings);
    if (v) annotations.push(v);
  });
  (data.recordings || []).forEach((r, i) => {
    const v = validateRecording(r, i, dropped, warnings);
    if (v) recordings.push(v);
  });

  return {
    plan: { project: { name, kind }, sessions, annotations, recordings },
    dropped,
    warnings,
  };
}

// ---- commit (phase 2) ----------------------------------------------------------------

function commitPlan(repos, plan) {
  // Preferred: the store's own all-or-nothing bulk import (one write per file, staged
  // and rolled back by the store). It marks the project imported and clears nothing
  // else we need; we still pass path '' so no foreign directory is ever recorded.
  if (repos.bulk && typeof repos.bulk.importProject === 'function') {
    try {
      const res = repos.bulk.importProject({
        project: { name: plan.project.name, path: '', kind: plan.project.kind, imported: true },
        sessions: plan.sessions.map((s) => ({ sourceId: s.oldId, name: s.name, url: s.url, title: s.title })),
        annotations: plan.annotations.map(({ sessionOld, ...fields }) => ({ ...fields, sessionSourceId: sessionOld })),
        recordings: plan.recordings.map((r) => ({ name: r.name, startUrl: r.startUrl, steps: r.steps })),
      });
      return { project: res.project, counts: res.counts };
    } catch (err) {
      const e = new Error(`Import failed and nothing was changed: ${err && err.message ? err.message : err}`);
      e.rolledBack = true;
      throw e;
    }
  }

  let project = null;
  const sessionIdMap = new Map();
  const counts = { sessions: 0, annotations: 0, recordings: 0 };

  const write = () => {
    project = repos.projects.create({ name: plan.project.name, path: '', kind: plan.project.kind });
    // imported: the original path is gone and hand-off must wait for a local directory.
    const marked = repos.projects.update(project.id, { imported: true, path: '', importedAt: new Date().toISOString() });
    if (marked) project = marked;

    for (const s of plan.sessions) {
      const created = repos.sessions.create({ projectId: project.id, name: s.name, url: s.url, title: s.title });
      sessionIdMap.set(s.oldId, created.id);
      counts.sessions += 1;
    }
    for (const a of plan.annotations) {
      const { sessionOld, ...fields } = a;
      repos.annotations.create({ ...fields, id: crypto.randomUUID(), sessionId: sessionIdMap.get(sessionOld) });
      counts.annotations += 1;
    }
    for (const r of plan.recordings) {
      repos.recordings.create({ projectId: project.id, name: r.name, startUrl: r.startUrl, steps: r.steps });
      counts.recordings += 1;
    }
  };

  try {
    // A repository-level transaction, when the store provides one, makes this atomic by
    // construction; the compensating cleanup below is the fallback and the belt.
    if (typeof repos.transaction === 'function') repos.transaction(write);
    else write();
  } catch (err) {
    let rolledBack = true;
    if (project && project.id) {
      try {
        repos.projects.remove(project.id); // cascades: sessions, their annotations, recordings
      } catch (_rollbackErr) {
        rolledBack = false;
      }
    }
    const e = new Error(
      `Import failed${rolledBack ? ' and nothing was changed' : ' and could not be fully undone - delete the partially imported project'}: ${err && err.message ? err.message : err}`
    );
    e.rolledBack = rolledBack;
    throw e;
  }
  return { project, counts };
}

function importBundle(repos, text) {
  const data = parseBundle(text);
  const { plan, dropped, warnings } = validateBundle(data);
  const { project, counts } = commitPlan(repos, plan);
  const shown = dropped.slice(0, LIMITS.droppedListed);
  return {
    ok: true,
    project,
    counts,
    imported: true,
    // Anything not imported is reported, never hidden behind an unqualified success.
    partial: dropped.length > 0,
    dropped: shown,
    droppedCount: dropped.length,
    warnings: warnings.slice(0, LIMITS.droppedListed),
  };
}

module.exports = {
  exportBundle, importBundle, parseBundle, validateBundle,
  BUNDLE_KIND, BUNDLE_FORMAT, BUNDLE_VERSION, BundleError, LIMITS,
};
