'use strict';
// Skill catalog + resolution. Three layers stay separate (see docs):
//   instruction skill  — readable guidance, no privilege (SKILL.md);
//   workflow plan      — closed, validated broker operations (workflow-core.js);
//   trusted extension  — NOT supported here.
//
// Built-in skills are pinned to an immutable digest computed over their manifest
// and the source bytes of the module that defines them (plus the shared
// workflow core). `skill-lock.json` records the expected digests; a built-in
// whose bytes changed without a version bump is BLOCKED (SKILL_BUILD_MISMATCH).
// Regenerate the lock with:
//   node src/main/services/automation/skill-registry.js --write-lock
// Imported third-party packages are inert until a UI principal approves a pin.
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const wf = require('./workflow-core');
const pkg = require('./skill-package');
const { RegistryError } = require('./workflows/_shared');

const BUILTINS = [
  require('./workflows/verify-journey'),
  require('./workflows/review-responsive'),
  require('./workflows/compare-fix'),
  require('./workflows/extract-table'),
  require('./workflows/handoff-repro'),
];
const LOCK_FILE = path.join(__dirname, 'skill-lock.json');
const SUPPORTED_SCHEMA_MAJOR = wf.SCHEMA_VERSION;

const readNormalized = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function builtinDigest(def) {
  return wf.digestOf({
    manifest: def.manifest,
    sources: [def.sourceFile, path.join(__dirname, 'workflow-core.js')]
      .map((file) => ({ file: path.basename(file), sha256: wf.sha256(readNormalized(file)) })),
  });
}

function jsonSchema(schema) {
  try { return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }); }
  catch (_e) { return null; }
}

function readLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (parsed && parsed.lockVersion === 1 && parsed.skills && typeof parsed.skills === 'object') return parsed.skills;
  } catch (_e) { /* missing/invalid lock => every built-in is unlocked => blocked */ }
  return {};
}

function createRegistry(options = {}) {
  const lock = options.lock || readLock();
  const imported = new Map(); // `${name}@${version}` -> record
  const key = (id, version) => `${id}@${version}`;

  const builtinMap = new Map(BUILTINS.map((def) => [key(def.manifest.id, def.manifest.version), def]));
  const digests = new Map([...builtinMap.entries()].map(([k, def]) => [k, builtinDigest(def)]));

  function verifyLock() {
    const mismatches = [];
    for (const [k, actual] of digests) {
      if (!lock[k]) mismatches.push({ key: k, expected: null, actual });
      else if (lock[k] !== actual) mismatches.push({ key: k, expected: lock[k], actual });
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  function entry(def, digest, kind) {
    const m = def.manifest;
    return {
      id: m.id, version: m.version, digest, kind, schemaVersion: m.schemaVersion,
      title: m.title, description: m.description, executor: m.executor, requires: [...m.requires],
      // Only broker-plan skills can be started through browser_run; orchestrated
      // skills run through the CLI/library orchestrator over the same broker.
      runnableViaBrokerRun: m.executor === 'broker-plan',
      inputSchema: jsonSchema(def.inputSchema),
    };
  }

  function catalog() {
    const rows = [...builtinMap.entries()].map(([k, def]) => entry(def, digests.get(k), 'builtin'));
    for (const rec of imported.values()) rows.push(importedEntry(rec));
    return rows.sort((a, b) => (a.id + a.version < b.id + b.version ? -1 : 1));
  }

  function importedDef(rec) {
    const inputSchema = z.strictObject(Object.fromEntries(((rec.plan && rec.plan.inputKeys) || []).map((k) => [k, z.string().max(10000)])));
    return {
      manifest: { id: rec.name, version: rec.version, schemaVersion: rec.plan ? rec.plan.schemaVersion : 0,
        title: rec.name, description: rec.description || '', executor: rec.plan ? 'broker-plan' : 'instruction-only',
        requires: rec.plan ? wf.requiredCapabilities(rec.plan) : [] },
      inputSchema,
      compile: (inputs) => ({ plan: rec.plan, planDigest: wf.digestOf(rec.plan), inputs: inputSchema.parse(inputs), dropped: [], warnings: [] }),
    };
  }
  function importedEntry(rec) {
    return { ...entry(importedDef(rec), rec.digest, 'imported'), approvedBy: rec.approvedBy, approvedAt: rec.approvedAt,
      // Declared requirements grant nothing; the broker intersects with the owner's grant.
      grants: 'none' };
  }

  // Exact, pinned resolution. Throws RegistryError before anything executes.
  function resolve({ skillId, skillVersion, skillDigest } = {}) {
    if (typeof skillId !== 'string' || typeof skillVersion !== 'string') {
      throw new RegistryError('SKILL_NOT_FOUND', 'skillId and skillVersion are required.');
    }
    const k = key(skillId, skillVersion);
    let def, digest, kind;
    if (builtinMap.has(k)) {
      def = builtinMap.get(k); digest = digests.get(k); kind = 'builtin';
      if (!lock[k] || lock[k] !== digest) {
        throw new RegistryError('SKILL_BUILD_MISMATCH',
          'This built-in skill changed without a version bump or lock update; blocked before execution.');
      }
    } else if (imported.has(k)) {
      const rec = imported.get(k);
      def = importedDef(rec); digest = rec.digest; kind = 'imported';
    } else {
      const known = [...builtinMap.values(), ...[...imported.values()].map(importedDef)].some((d) => d.manifest.id === skillId);
      throw new RegistryError(known ? 'SKILL_VERSION_UNSUPPORTED' : 'SKILL_NOT_FOUND',
        known ? 'That skill version is not installed; versions are pinned exactly.' : 'Unknown skill.');
    }
    if (def.manifest.schemaVersion > SUPPORTED_SCHEMA_MAJOR) {
      throw new RegistryError('SKILL_VERSION_UNSUPPORTED', 'Unsupported workflow schema version.');
    }
    if (skillDigest !== undefined && skillDigest !== digest) {
      throw new RegistryError('SKILL_DIGEST_MISMATCH', 'The pinned digest does not match the installed skill; blocked before execution.');
    }
    return { def, digest, kind, entry: kind === 'builtin' ? entry(def, digest, kind) : importedEntry(imported.get(k)) };
  }

  // For MCP browser_run: resolve + validate inputs + require a broker-plan skill.
  function resolveForRun(req) {
    const resolved = resolve(req);
    if (resolved.def.manifest.executor !== 'broker-plan') {
      throw new RegistryError('SKILL_NOT_EXECUTABLE',
        `Skill ${req.skillId} is ${resolved.def.manifest.executor}; it does not run through browser_run.`);
    }
    const parsed = resolved.def.inputSchema.safeParse(req.inputs === undefined ? {} : req.inputs);
    if (!parsed.success) {
      throw new RegistryError('INVALID_INPUT', 'Skill inputs failed validation.',
        { issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(inputs)'}: ${i.message}`) });
    }
    return { ...resolved, inputs: parsed.data };
  }

  // Compile to the frozen snapshot the broker stores for a run.
  async function prepareRun(req, ctx = {}) {
    const resolved = resolveForRun(req);
    const compiled = await resolved.def.compile(resolved.inputs, ctx);
    return {
      skillId: req.skillId, skillVersion: req.skillVersion, skillDigest: resolved.digest,
      workflowSchemaVersion: wf.SCHEMA_VERSION,
      plan: compiled.plan, planDigest: compiled.planDigest,
      inputs: compiled.inputs, inputDigest: wf.inputDigest(compiled.inputs),
      effects: wf.describeEffects(compiled.plan),
      dropped: compiled.dropped || [], warnings: compiled.warnings || [],
    };
  }

  // Imported packages: inspect (inert) -> preview -> approve (ui only) -> register.
  function inspectPackage(files, opts) { return pkg.inspectSkillPackage(files, opts); }
  function registerImported(inspection, approver, now) {
    if (!inspection || inspection.state !== 'inert') throw new RegistryError('DENIED', 'Only a clean inspection can be registered.');
    const clash = [...builtinMap.values()].some((d) => d.manifest.id === inspection.skill.name);
    if (clash) throw new RegistryError('DENIED', 'An imported skill cannot shadow a built-in skill ID.');
    if (!inspection.skill.version) throw new RegistryError('DENIED', 'An imported skill needs metadata.version to be registered.');
    let record;
    try { record = pkg.approveInspection(inspection, approver, now); }
    catch (error) { throw new RegistryError('DENIED', error.message); }
    const k = key(record.name, record.version);
    if (imported.has(k) && imported.get(k).digest !== record.digest) {
      // Republishing changed bytes requires a new version.
      throw new RegistryError('SKILL_DIGEST_MISMATCH', 'That version is already registered with different bytes; publish a new version.');
    }
    imported.set(k, record);
    return record;
  }
  function verifyImported(files, name, version) {
    const rec = imported.get(key(name, version));
    if (!rec) return { ok: false, code: 'SKILL_NOT_FOUND', message: 'No such imported skill.' };
    return pkg.verifyPin(files, rec);
  }

  return {
    catalog, resolve, resolveForRun, prepareRun, verifyLock, builtinDigests: () => Object.fromEntries(digests),
    inspectPackage, previewUpgrade: pkg.previewUpgrade, registerImported, verifyImported,
    importedRecords: () => [...imported.values()],
  };
}

const DENY_CODES = new Set(['SKILL_DIGEST_MISMATCH', 'SKILL_BUILD_MISMATCH', 'DENIED', 'RECORDING_NOT_FOUND', 'RECORDING_NOT_MIGRATABLE']);

// Classified, redacted error the broker passes through to the client unchanged.
function publicFault(error) {
  const code = error && error.code;
  let message = String((error && error.message) || 'skill resolution failed').slice(0, 300);
  if (code === 'RECORDING_NOT_MIGRATABLE' && error.details && Array.isArray(error.details.refused)) {
    // Reason codes and step positions only: never recorded values.
    message += ` (${error.details.refused.slice(0, 8).map((r) => `${r.code}@${r.stepIndex}`).join(', ')})`;
  }
  const fault = new Error(message);
  fault.publicError = { code: DENY_CODES.has(code) ? 'DENIED' : 'UNSUPPORTED', message: message.slice(0, 500),
    dispatched: false, effectUnknown: false, retry: 'never' };
  return fault;
}

// The `skills` option of createBroker(): { resolve, catalog }. The broker calls
// resolve() SYNCHRONOUSLY with the client's raw inputs and expects { plan }. We
// also return `inputs` (values derived from the recording) and the pinned
// digests so the broker can record them; a broker that ignores these still
// fails closed for plans that need a derived value ("missing input").
// loadRecording(recordingId, principal) must be a synchronous, owner-scoped lookup.
//
// supplementInputs (default true): the broker passes its own `inputs` object to
// resolve() and later runs the plan with it. Recording-derived values (the typed
// text of a journey) have no other way in, so the resolver adds them to that
// object, restricted to keys the compiled plan declares. A broker that copies the
// object first simply does not see them and fails closed ("missing input").
function createBrokerSkills({ registry, loadRecording, maxDurationMs, supplementInputs = true } = {}) {
  const reg = registry || defaultRegistry();
  return {
    resolve({ skillId, skillVersion, inputs, principal } = {}) {
      let resolved;
      try { resolved = reg.resolveForRun({ skillId, skillVersion, inputs }); }
      catch (error) {
        if (error.code === 'SKILL_NOT_FOUND' || error.code === 'SKILL_VERSION_UNSUPPORTED') return null;
        throw publicFault(error);
      }
      try {
        const compiled = resolved.def.compile(resolved.inputs, {
          loadRecording: (recordingId) => (typeof loadRecording === 'function' ? loadRecording(recordingId, principal) : null),
          maxDurationMs,
        });
        if (supplementInputs && inputs && typeof inputs === 'object' && !Object.isFrozen(inputs)) {
          for (const [k, v] of Object.entries(compiled.inputs)) {
            if (compiled.plan.inputKeys.includes(k) && typeof v === 'string' && !(k in inputs)) inputs[k] = v;
          }
        }
        return { plan: compiled.plan, inputs: compiled.inputs, skillDigest: resolved.digest, planDigest: compiled.planDigest,
          dropped: compiled.dropped, warnings: compiled.warnings };
      } catch (error) {
        throw publicFault(error);
      }
    },
    catalog: () => reg.catalog(),
  };
}

let shared = null;
const defaultRegistry = () => (shared || (shared = createRegistry()));

module.exports = {
  createRegistry, defaultRegistry, createBrokerSkills, RegistryError, LOCK_FILE, builtinDigest, BUILTINS,
  catalog: (...a) => defaultRegistry().catalog(...a),
  resolve: (...a) => defaultRegistry().resolve(...a),
  resolveForRun: (...a) => defaultRegistry().resolveForRun(...a),
  prepareRun: (...a) => defaultRegistry().prepareRun(...a),
  verifyLock: (...a) => defaultRegistry().verifyLock(...a),
};

if (require.main === module && process.argv.includes('--write-lock')) {
  const registry = createRegistry({ lock: {} });
  const skills = registry.builtinDigests();
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify({ lockVersion: 1, skills }, null, 2)}\n`);
  process.stderr.write(`wrote ${LOCK_FILE} (${Object.keys(skills).length} skills)\n`);
}
