// Evidence store for the agent browser runtime: redaction at the first
// persistence boundary, an artifact store with opaque ids and hashes, per-run
// manifests (audit "Proof contract"), quotas/retention, permitted-evidence sets
// for public reports, and owner-authorised resource reads.
//
// One process writes this directory (the owning broker). Artifact ids are
// server-minted opaque tokens and are validated before any path is built; a
// client-supplied string is never joined into a path.
'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../../../shared/browser-contracts');
const { createRedactor } = require('../../../shared/browser-redact');

const MiB = 1024 * 1024;
const DEFAULT_QUOTAS = Object.freeze({ maxArtifactsPerRun: 200, maxBytesPerRun: 32 * MiB, maxTotalBytes: 512 * MiB, maxArtifactBytes: 8 * MiB });
const MANIFEST_SCHEMA = 1;
const eerr = (code, message) => Object.assign(new Error(message || code), { code });

function createEvidenceStore({ dir, fs = nodeFs, clock = { now: () => Date.now() }, quotas = {}, retentionMs = 14 * 24 * 3600 * 1000, redactor = createRedactor() } = {}) {
  if (!dir) throw new TypeError('evidence dir required');
  const q = { ...DEFAULT_QUOTAS, ...quotas };
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const containers = new Map();
  const loadErrors = [];
  let totalBytes = 0;

  const containerDir = (runId) => {
    if (!C.isServerId(runId)) throw eerr('BAD_ID', 'invalid run id');
    const d = path.join(root, runId);
    if (path.dirname(d) !== root) throw eerr('BAD_ID', 'path escape');
    return d;
  };
  const artifactPath = (runId, id, ext) => {
    if (!C.isServerId(id)) throw eerr('BAD_ID', 'invalid artifact id');
    return path.join(containerDir(runId), `${id}${ext}`);
  };

  function atomicWrite(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw eerr('EVIDENCE_WRITE_FAILED', `write failed: ${e.code || e.message}`);
    }
  }

  // ---- load existing containers (restart) -------------------------------------
  for (const name of fs.readdirSync(root)) {
    if (!C.isServerId(name)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, name, 'container.json'), 'utf8'));
      const c = { ...info, artifacts: new Map(), errors: info.errors || [], bytes: 0 };
      for (const f of fs.readdirSync(path.join(root, name))) {
        if (!f.endsWith('.meta.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(root, name, f), 'utf8'));
          c.artifacts.set(meta.artifactId, meta); c.bytes += meta.bytes;
        } catch (e) { loadErrors.push({ runId: name, file: f, code: 'META_CORRUPT' }); c.errors.push({ code: 'META_CORRUPT', at: clock.now() }); }
      }
      totalBytes += c.bytes;
      containers.set(name, c);
    } catch (e) { loadErrors.push({ runId: name, code: e.code === 'ENOENT' ? 'NO_CONTAINER' : 'CONTAINER_CORRUPT' }); }
  }

  function container(runId) {
    const c = containers.get(runId);
    if (!c) throw eerr('NOT_FOUND', 'unknown run');
    return c;
  }
  // Possession of an id is not authority: owner (or the trusted UI) only.
  function authorize(runId, principal) {
    const c = containers.get(runId);
    if (!c || !principal || (principal.kind !== 'ui' && principal.id !== c.ownerId)) throw eerr('NOT_FOUND', 'unknown run');
    return c;
  }

  function registerRun(runId, { ownerId, sessionId = null, pageId = null, reviewSessionId = null, kind = 'run', attempt = 1, parentRunId = null }) {
    if (containers.has(runId)) throw eerr('EXISTS', 'run container exists');
    const d = containerDir(runId);
    fs.mkdirSync(d, { recursive: true });
    const info = { runId, ownerId, sessionId, pageId, reviewSessionId, kind, attempt, parentRunId, createdAt: clock.now(), closedAt: null, committed: false };
    atomicWrite(path.join(d, 'container.json'), JSON.stringify(info));
    containers.set(runId, { ...info, artifacts: new Map(), errors: [], bytes: 0 });
    return { runId };
  }

  function recordError(c, code, kind) {
    if (c.errors.length < 50) c.errors.push({ code, kind, at: clock.now() });
    else if (c.errors.length === 50) c.errors.push({ code: 'ERRORS_TRUNCATED', at: clock.now() });
  }

  // data: object | string | Buffer. Objects/strings are redacted BEFORE writing.
  function putArtifact(runId, { id, kind, mime, data, visibility, label } = {}) {
    const c = container(runId);
    if (c.committed) throw eerr('MANIFEST_COMMITTED', 'manifest is immutable');
    const artifactId = id || C.newId('artifact');
    if (!C.isServerId(artifactId)) throw eerr('BAD_ID', 'invalid artifact id');
    const binary = Buffer.isBuffer(data);
    let bytes; let redaction;
    if (binary) { bytes = data; redaction = { applied: false, reason: 'binary' }; } else {
      const clean = typeof data === 'string' ? redactor.text(data, q.maxArtifactBytes) : redactor.value(data);
      bytes = Buffer.from(typeof clean === 'string' ? clean : JSON.stringify(clean), 'utf8');
      redaction = { applied: true, version: 1 };
    }
    const vis = visibility || (binary ? 'internal' : 'public');
    if (vis === 'public' && !redaction.applied) throw eerr('UNREDACTED_PUBLIC', 'binary artifacts cannot be public');
    const fail = (code) => { recordError(c, code, kind); throw eerr(code, `artifact rejected: ${code}`); };
    if (c.artifacts.has(artifactId)) fail('ARTIFACT_EXISTS');
    if (bytes.length > q.maxArtifactBytes) fail('EVIDENCE_QUOTA_ARTIFACT');
    if (c.artifacts.size >= q.maxArtifactsPerRun) fail('EVIDENCE_QUOTA_COUNT');
    if (c.bytes + bytes.length > q.maxBytesPerRun) fail('EVIDENCE_QUOTA_RUN');
    if (totalBytes + bytes.length > q.maxTotalBytes) fail('EVIDENCE_QUOTA_TOTAL');
    const meta = { artifactId, runId, kind: String(kind || 'artifact').slice(0, 40), mime: String(mime || (binary ? 'application/octet-stream' : 'application/json')).slice(0, 80),
      bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), visibility: vis, redaction, createdAt: clock.now(), label: label ? redactor.text(String(label), 120) : undefined };
    try {
      atomicWrite(artifactPath(runId, artifactId, '.bin'), bytes);
      atomicWrite(artifactPath(runId, artifactId, '.meta.json'), JSON.stringify(meta));
    } catch (e) { recordError(c, e.code, kind); throw e; }
    c.artifacts.set(artifactId, meta); c.bytes += bytes.length; totalBytes += bytes.length;
    return { artifactId, uri: C.uris.artifact(runId, artifactId), sha256: meta.sha256, bytes: meta.bytes };
  }
  // Observation artifacts use the observationId as artifact id.
  const putObservation = (runId, observationId, obs) => putArtifact(runId, { id: observationId, kind: 'observation', data: obs, visibility: 'public' });

  function readBytes(runId, artifactId) {
    const c = container(runId);
    const meta = c.artifacts.get(artifactId);
    if (!meta) throw eerr('NOT_FOUND', 'unknown artifact');
    const buf = fs.readFileSync(artifactPath(runId, artifactId, '.bin'));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== meta.sha256) throw eerr('ARTIFACT_CORRUPT', 'hash mismatch');
    return { buf, meta };
  }

  // Is every required evidence id present, intact and error-free? This (and a
  // committed manifest) is the ONLY source of `evidenceComplete`.
  function verify(runId, requiredIds = []) {
    const c = container(runId);
    const missing = []; const corrupt = [];
    for (const id of new Set(requiredIds)) {
      if (!c.artifacts.has(id)) { missing.push(id); continue; }
      try { readBytes(runId, id); } catch { corrupt.push(id); }
    }
    return { complete: !missing.length && !corrupt.length && c.errors.length === 0, missing, corrupt, errors: c.errors.map((e) => ({ ...e })) };
  }

  const artifactsView = (c, filter) => [...c.artifacts.values()].filter(filter || (() => true)).sort((a, b) => a.createdAt - b.createdAt || a.artifactId.localeCompare(b.artifactId))
    .map((m) => ({ artifactId: m.artifactId, kind: m.kind, mime: m.mime, sha256: m.sha256, bytes: m.bytes, visibility: m.visibility, redaction: m.redaction, createdAt: m.createdAt, uri: C.uris.artifact(c.runId, m.artifactId) }));

  // facts come from run.js; everything is redacted again here.
  function commitManifest(runId, facts) {
    const c = container(runId);
    if (c.committed) throw eerr('MANIFEST_COMMITTED', 'manifest already committed');
    const body = {
      schemaVersion: MANIFEST_SCHEMA, runId, attempt: c.attempt, parentRunId: c.parentRunId, reviewSessionId: c.reviewSessionId, sessionId: c.sessionId, pageId: c.pageId,
      ...redactor.value({
        urls: facts.urls || [], versions: facts.versions || {},
        counts: facts.counts || {}, terminal: facts.terminal || {}, steps: facts.steps || [], assertions: facts.assertions || [],
        approvals: facts.approvals || [], policyDecisions: facts.policyDecisions || [],
      }),
      // Broker-computed hashes: exempt from the opaque-token heuristic.
      digests: Object.fromEntries(Object.entries(facts.digests || {}).filter(([, v]) => /^[0-9a-f]{64}$/.test(String(v)))),
    };
    const manifest = { ...body, artifacts: artifactsView(c), artifactErrors: c.errors.map((e) => ({ ...e })), committed: true, committedAt: clock.now() };
    manifest.manifestSha256 = C.sha256(manifest);
    atomicWrite(path.join(containerDir(runId), 'manifest.json'), JSON.stringify(manifest));
    c.committed = true; c.closedAt = clock.now(); c.manifest = manifest;
    try { atomicWrite(path.join(containerDir(runId), 'container.json'), JSON.stringify({ runId, ownerId: c.ownerId, sessionId: c.sessionId, pageId: c.pageId, reviewSessionId: c.reviewSessionId, kind: c.kind, attempt: c.attempt, parentRunId: c.parentRunId, createdAt: c.createdAt, closedAt: c.closedAt, committed: true, errors: c.errors })); } catch { /* manifest is the authority */ }
    return manifest;
  }
  function loadManifest(c) {
    if (c.manifest) return c.manifest;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(containerDir(c.runId), 'manifest.json'), 'utf8'));
      const { manifestSha256, ...rest } = m;
      if (C.sha256(rest) !== manifestSha256) return null;
      c.manifest = m; c.committed = true;
      return m;
    } catch (e) { return null; }
  }
  const isCommitted = (runId) => { const c = containers.get(runId); return !!c && !!loadManifest(c); };

  function getManifest(runId, principal) {
    const c = authorize(runId, principal);
    return loadManifest(c) || { schemaVersion: MANIFEST_SCHEMA, runId, committed: false, artifacts: artifactsView(c), artifactErrors: c.errors.map((e) => ({ ...e })) };
  }
  // Explicit permitted-evidence set: only committed manifests, only artifacts
  // that are public AND went through redaction. Never "everything in the dir".
  function publicReport(runId, principal) {
    const c = authorize(runId, principal);
    const m = loadManifest(c);
    if (!m) throw eerr('NOT_COMMITTED', 'no committed manifest');
    return { ...m, artifacts: m.artifacts.filter((a) => a.visibility === 'public' && a.redaction && a.redaction.applied === true) };
  }

  // ---- resource reads (authorised by owner + run) -----------------------------------
  function read(uri, principal, { cursor = 0, maxBytes = C.DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    const p = C.parseUri(uri);
    if (!p || !p.runId) throw eerr('NOT_FOUND', 'unknown resource');
    const c = authorize(p.runId, principal);
    const offset = Number.isSafeInteger(Number(cursor)) && Number(cursor) >= 0 ? Number(cursor) : 0;
    let mime = 'application/json'; let buf;
    if (p.kind === 'manifest') buf = Buffer.from(JSON.stringify(getManifest(p.runId, principal)));
    else {
      if (p.kind === 'observation' && c.artifacts.get(p.id)?.kind !== 'observation') throw eerr('NOT_FOUND', 'unknown resource');
      const r = readBytes(p.runId, p.id); buf = r.buf; mime = r.meta.mime;
    }
    const binary = !mime.startsWith('application/json') && !mime.startsWith('text/');
    if (binary) {
      // base64 grows 4/3; leave room for the envelope so the whole serialized response stays within maxBytes
      const slice = buf.subarray(offset, offset + Math.max(1, Math.floor((maxBytes - 600) * 0.75)));
      const end = offset + slice.length;
      return { uri, mimeType: mime, encoding: 'base64', data: slice.toString('base64'), truncated: end < buf.length, totalBytes: buf.length, returnedBytes: slice.length, nextCursor: end < buf.length ? String(end) : null };
    }
    const cut = C.capText(buf.toString('utf8'), { maxBytes, offset });
    return { uri, mimeType: mime, encoding: 'utf8', text: cut.text, truncated: cut.truncated, totalBytes: cut.totalBytes, returnedBytes: cut.returnedBytes, nextCursor: cut.nextOffset === null ? null : String(cut.nextOffset) };
  }

  function prune({ now = clock.now() } = {}) {
    let removed = 0;
    for (const [runId, c] of containers) {
      if (!c.closedAt || now - c.closedAt < retentionMs) continue;
      try { fs.rmSync(containerDir(runId), { recursive: true, force: true }); } catch { continue; }
      totalBytes -= c.bytes; containers.delete(runId); removed++;
    }
    return removed;
  }
  const usage = () => ({ totalBytes, runs: containers.size, quotas: { ...q } });

  return { redactor, registerRun, putArtifact, putObservation, verify, commitManifest, getManifest, publicReport, isCommitted, read, prune, usage, authorize,
    hasRun: (id) => containers.has(id), ownerOf: (id) => (containers.get(id) || {}).ownerId, listArtifacts: (runId) => artifactsView(container(runId)), loadErrors,
    markClosed: (runId) => { const c = containers.get(runId); if (c && !c.closedAt) c.closedAt = clock.now(); } };
}

module.exports = { createEvidenceStore, DEFAULT_QUOTAS, MANIFEST_SCHEMA };
