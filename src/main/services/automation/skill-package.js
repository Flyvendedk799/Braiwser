'use strict';
// Third-party skill packages (Agent Skills layout: SKILL.md + optional scripts/,
// references/, assets/) are imported INERT. This module only reads bytes it is
// handed and reports on them:
//   * it never executes, requires, imports or installs anything — package files
//     are opaque data (`scripts/` are inventoried and flagged, nothing more);
//   * `allowed-tools` (an experimental field in the open standard) is recorded
//     and IGNORED: a skill cannot grant itself any Braiwser authority;
//   * runnable behavior may only come from a separate, validated workflow
//     manifest (`braiwser.workflow.json`) parsed by the closed workflow schema;
//     even then its `requires` is a declaration the broker intersects with the
//     owner's grant, never an entitlement;
//   * a content digest over every file pins the package; a mismatch blocks use
//     before any execution; upgrades produce a preview/diff and need fresh
//     approval, and only a `ui` principal can approve.
// The digest proves integrity/provenance of the bytes, not that they are safe.
const crypto = require('node:crypto');
const wf = require('./workflow-core');

const LIMITS = Object.freeze({ files: 200, bytes: 5 * 1024 * 1024, path: 200, skillMd: 200 * 1024 });
const WORKFLOW_FILE = 'braiwser.workflow.json';

class PackageError extends Error {
  constructor(code, message) { super(message); this.name = 'PackageError'; this.code = code; }
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const toBuffer = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'));

function normalizeFiles(files) {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files || {});
  if (!entries.length) throw new PackageError('EMPTY_PACKAGE', 'The package has no files.');
  if (entries.length > LIMITS.files) throw new PackageError('TOO_MANY_FILES', 'The package has too many files.');
  const out = new Map();
  let total = 0;
  for (const [rawPath, content] of entries) {
    const p = String(rawPath);
    if (!p || p.length > LIMITS.path || p.includes('\0') || p.includes('\\') || p.startsWith('/')
        || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
      throw new PackageError('UNSAFE_PATH', 'The package contains an unsafe file path.');
    }
    if (out.has(p)) throw new PackageError('DUPLICATE_PATH', 'The package contains a duplicate path.');
    const bytes = toBuffer(content);
    total += bytes.length;
    if (total > LIMITS.bytes) throw new PackageError('TOO_LARGE', 'The package is too large.');
    out.set(p, bytes);
  }
  return out;
}

function packageDigest(files) {
  const map = normalizeFiles(files);
  const listing = [...map.entries()].map(([path, bytes]) => ({ path, sha256: sha(bytes), size: bytes.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return wf.digestOf({ format: 'braiwser-skill-package@1', files: listing });
}

// Deliberately tiny frontmatter reader: flat `key: value` lines plus one nested
// `metadata:` map. Anchors, tags, block scalars, flow collections and duplicate
// keys are rejected rather than interpreted.
function parseFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) throw new PackageError('NO_FRONTMATTER', 'SKILL.md must start with YAML frontmatter.');
  const end = src.indexOf('\n---', 4);
  if (end < 0) throw new PackageError('NO_FRONTMATTER', 'SKILL.md frontmatter is not terminated.');
  const block = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n/, '');
  const data = {};
  let nested = null;
  const scalar = (raw, line) => {
    const v = raw.trim();
    if (v === '') return '';
    const q = v[0];
    if (q === '"' || q === "'") {
      if (v.length < 2 || v[v.length - 1] !== q) throw new PackageError('BAD_FRONTMATTER', `Unterminated quoted value: ${line}`);
      const inner = v.slice(1, -1);
      return q === '"' ? inner.replace(/\\(["\\nt])/g, (_m, c) => ({ n: '\n', t: '\t' }[c] || c)) : inner.replace(/''/g, "'");
    }
    if (/^[&*!|>[{%@`]/.test(v)) throw new PackageError('BAD_FRONTMATTER', `Unsupported YAML construct: ${line.slice(0, 60)}`);
    if (/:\s/.test(v) || /\s#/.test(v)) throw new PackageError('BAD_FRONTMATTER', `Ambiguous plain scalar: ${line.slice(0, 60)}`);
    return v;
  };
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(line);
    const m = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/);
    if (!m) throw new PackageError('BAD_FRONTMATTER', `Cannot parse frontmatter line: ${line.slice(0, 60)}`);
    const [, k, v = ''] = m;
    if (indented) {
      if (!nested) throw new PackageError('BAD_FRONTMATTER', 'Unexpected indentation in frontmatter.');
      if (Object.prototype.hasOwnProperty.call(nested, k)) throw new PackageError('BAD_FRONTMATTER', `Duplicate metadata key: ${k}`);
      nested[k] = scalar(v, line);
      continue;
    }
    nested = null;
    if (Object.prototype.hasOwnProperty.call(data, k)) throw new PackageError('BAD_FRONTMATTER', `Duplicate key: ${k}`);
    if (k === 'metadata' && v.trim() === '') { data.metadata = {}; nested = data.metadata; continue; }
    data[k] = scalar(v, line);
  }
  return { data, body };
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// files: { 'SKILL.md': '...', 'scripts/x.sh': Buffer, ... } (paths relative to the skill directory)
// options: { rootName? } — the directory name, which the standard requires to equal `name`.
function inspectSkillPackage(files, options = {}) {
  const blocked = [];
  const warnings = [];
  let map;
  try { map = normalizeFiles(files); }
  catch (error) { return { state: 'blocked', ok: false, digest: null, blockedReasons: [{ code: error.code || 'INVALID_PACKAGE', message: error.message }], scriptsExecuted: false }; }

  const digest = packageDigest(map);
  const inventory = [...map.entries()].map(([path, bytes]) => {
    let kind = 'other';
    if (path === 'SKILL.md') kind = 'instructions';
    else if (path === WORKFLOW_FILE) kind = 'workflow-manifest';
    else if (path.startsWith('scripts/')) kind = 'script';
    else if (path.startsWith('references/')) kind = 'reference';
    else if (path.startsWith('assets/')) kind = 'asset';
    return { path, kind, size: bytes.length, sha256: sha(bytes) };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  const report = {
    state: 'inert', ok: true, digest, files: inventory,
    hasScripts: inventory.some((f) => f.kind === 'script'),
    // Structural guarantee, asserted by tests: nothing in this module executes package content.
    scriptsExecuted: false, dependenciesInstalled: false,
    skill: null, ignored: [], workflow: { present: false, valid: false, plan: null, planDigest: null, issues: [], effects: null },
    warnings, blockedReasons: blocked, requiresApproval: true,
  };

  const skillMd = map.get('SKILL.md');
  if (!skillMd) blocked.push({ code: 'NO_SKILL_MD', message: 'SKILL.md is missing.' });
  else if (skillMd.length > LIMITS.skillMd) blocked.push({ code: 'SKILL_MD_TOO_LARGE', message: 'SKILL.md is too large.' });
  else {
    try {
      const { data, body } = parseFrontmatter(skillMd.toString('utf8'));
      const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
      if (typeof data.name !== 'string' || !NAME.test(data.name) || data.name.length > 64) {
        blocked.push({ code: 'BAD_NAME', message: 'Frontmatter name must be 1-64 lowercase letters, digits and single hyphens.' });
      }
      if (typeof data.description !== 'string' || !data.description || data.description.length > 1024) {
        blocked.push({ code: 'BAD_DESCRIPTION', message: 'Frontmatter description must be 1-1024 characters.' });
      }
      if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) {
        blocked.push({ code: 'BAD_COMPATIBILITY', message: 'compatibility must be at most 500 characters.' });
      }
      if (Object.keys(meta).length > 50) blocked.push({ code: 'BAD_METADATA', message: 'metadata has too many entries.' });
      if (options.rootName && data.name && options.rootName !== data.name) {
        blocked.push({ code: 'NAME_MISMATCH', message: 'The directory name does not match the skill name.' });
      }
      report.skill = {
        name: typeof data.name === 'string' ? data.name : null,
        description: typeof data.description === 'string' ? data.description.slice(0, 1024) : null,
        version: typeof meta.version === 'string' ? meta.version : null,
        protocol: typeof meta['braiwser-protocol'] === 'string' ? meta['braiwser-protocol'] : null,
        bodyBytes: Buffer.byteLength(body),
      };
      if (report.skill.version !== null && !/^\d+\.\d+\.\d+$/.test(report.skill.version)) {
        blocked.push({ code: 'BAD_VERSION', message: 'metadata.version must be a semantic version.' });
      }
      if (report.skill.version === null) warnings.push('metadata.version is missing; the digest is the only pin.');
      if ('allowed-tools' in data) {
        report.ignored.push({ field: 'allowed-tools', value: String(data['allowed-tools']).slice(0, 200),
          reason: 'Self-declared by the package; never used as Braiwser authorization.' });
      }
      for (const key of Object.keys(data)) {
        if (!['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key)) {
          report.ignored.push({ field: key, reason: 'Unknown field ignored.' });
        }
      }
    } catch (error) {
      blocked.push({ code: error.code || 'BAD_FRONTMATTER', message: error.message });
    }
  }

  if (report.hasScripts) warnings.push('The package contains scripts. They are inventoried only and are never executed by import.');

  const manifestBytes = map.get(WORKFLOW_FILE);
  if (manifestBytes) {
    report.workflow.present = true;
    try {
      const parsed = JSON.parse(manifestBytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || parsed.manifestVersion !== 1) throw new Error('manifestVersion must be 1');
      const checked = wf.safeValidateWorkflow(parsed.plan);
      if (!checked.ok) { report.workflow.issues = checked.issues.slice(0, 20); }
      else {
        report.workflow.valid = true;
        report.workflow.plan = checked.plan;
        report.workflow.planDigest = wf.digestOf(checked.plan);
        report.workflow.effects = wf.describeEffects(checked.plan);
        if (Array.isArray(parsed.requires)) {
          const computed = report.workflow.effects.requires;
          const declared = parsed.requires.map(String).sort();
          if (declared.join(',') !== computed.join(',')) {
            warnings.push('Declared requires differ from the capabilities the plan actually uses; the plan is authoritative and neither grants anything.');
          }
        }
        if (report.skill && report.skill.name && checked.plan.skillId !== report.skill.name) {
          blocked.push({ code: 'SKILL_ID_MISMATCH', message: 'The workflow plan skillId does not match the SKILL.md name.' });
        }
        if (report.skill && report.skill.version && checked.plan.version !== report.skill.version) {
          blocked.push({ code: 'VERSION_MISMATCH', message: 'The workflow plan version does not match metadata.version.' });
        }
      }
    } catch (error) {
      report.workflow.issues = [`Invalid ${WORKFLOW_FILE}: ${String(error.message).slice(0, 120)}`];
    }
    if (!report.workflow.valid) blocked.push({ code: 'WORKFLOW_INVALID', message: `${WORKFLOW_FILE} failed validation.` });
  }

  if (blocked.length) { report.state = 'blocked'; report.ok = false; }
  return report;
}

// Pin = what the human approved. Verified BEFORE any use.
function makePin(inspection) {
  if (!inspection || inspection.state !== 'inert' || !inspection.skill) throw new PackageError('NOT_INSPECTABLE', 'Only a clean inspection can be pinned.');
  return { name: inspection.skill.name, version: inspection.skill.version, digest: inspection.digest };
}

function verifyPin(files, pin) {
  let digest;
  try { digest = packageDigest(files); }
  catch (error) { return { ok: false, code: error.code || 'INVALID_PACKAGE', message: error.message }; }
  if (!pin || typeof pin.digest !== 'string' || digest !== pin.digest) {
    return { ok: false, code: 'SKILL_DIGEST_MISMATCH', message: 'The package bytes differ from the approved pin; blocked before execution.', actual: digest };
  }
  return { ok: true, digest };
}

// Preview for an upgrade. Never approves anything.
function previewUpgrade(before, after) {
  if (!before || !after) throw new PackageError('NOT_INSPECTABLE', 'Both inspections are required.');
  const a = new Map((before.files || []).map((f) => [f.path, f]));
  const b = new Map((after.files || []).map((f) => [f.path, f]));
  const added = [], removed = [], changed = [];
  for (const [p, f] of b) { if (!a.has(p)) added.push(p); else if (a.get(p).sha256 !== f.sha256) changed.push(p); }
  for (const p of a.keys()) if (!b.has(p)) removed.push(p);
  const scripts = (list) => list.filter((p) => p.startsWith('scripts/'));
  let workflow = null;
  if (before.workflow && after.workflow && before.workflow.valid && after.workflow.valid) {
    workflow = wf.diffWorkflows(before.workflow.plan, after.workflow.plan);
  }
  const ignoredBefore = new Set((before.ignored || []).map((i) => i.field));
  const newIgnored = (after.ignored || []).filter((i) => !ignoredBefore.has(i.field)).map((i) => i.field);
  const sameVersion = before.skill && after.skill && before.skill.version === after.skill.version;
  return {
    identical: before.digest === after.digest,
    digest: { from: before.digest, to: after.digest },
    version: { from: before.skill && before.skill.version, to: after.skill && after.skill.version },
    files: { added: added.sort(), removed: removed.sort(), changed: changed.sort() },
    scriptsAdded: scripts(added), scriptsChanged: scripts(changed),
    newIgnoredFields: newIgnored,
    workflow,
    // Changed bytes under an unchanged version cannot be a legitimate republish.
    sameVersionDifferentBytes: !!sameVersion && before.digest !== after.digest,
    requiresReapproval: before.digest !== after.digest,
    expandsScope: !!(workflow && workflow.expandsScope) || (!before.workflow.present && after.workflow.present),
  };
}

// Only the trusted UI can approve; the record is what a registry stores.
function approveInspection(inspection, approver, now = () => new Date()) {
  if (!approver || approver.kind !== 'ui') throw new PackageError('DENIED', 'Only the trusted UI can approve a skill package.');
  const pin = makePin(inspection);
  return Object.freeze({
    ...pin, approvedBy: String(approver.id).slice(0, 160), approvedAt: now().toISOString(),
    plan: inspection.workflow && inspection.workflow.valid ? inspection.workflow.plan : null,
    description: inspection.skill.description,
  });
}

module.exports = {
  PackageError, LIMITS, WORKFLOW_FILE,
  parseFrontmatter, packageDigest, inspectSkillPackage, makePin, verifyPin, previewUpgrade, approveInspection,
};
