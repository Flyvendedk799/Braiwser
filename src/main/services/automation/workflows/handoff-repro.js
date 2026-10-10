'use strict';
// handoff-repro 1.0.0 — build a redacted issue/repro package from selected
// annotations, a workflow plan and committed evidence. PURE: it performs no I/O
// and no network. Sending the package to another service is a separate approved
// operation that this module neither implements nor can trigger; the result says
// so (`send.performed === false`).
//
// Rules:
//   * evidence appears as braiwser:// URIs + hashes only — never bytes, never
//     file paths;
//   * internal/private notes are excluded unless the caller explicitly opts in;
//   * typed input VALUES never appear (steps name input keys only);
//   * free text goes through redactText(): credential-looking URL queries,
//     bearer tokens, JWTs, long opaque tokens, emails;
//   * the package states the run's actual verdict and uncertainty, and never
//     claims a defect is fixed.
const { z } = require('zod');
const wf = require('../workflow-core');
const { id, RegistryError } = require('./_shared');

const manifest = Object.freeze({
  id: 'handoff-repro',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Prepare a redacted repro package',
  description: 'Generate a redacted issue/repro package from selected annotations and evidence. Sending it elsewhere requires a separate approval.',
  executor: 'orchestrator',
  requires: [],
  maxDurationMs: 60000,
});

const inputSchema = z.strictObject({
  reviewSessionId: id.optional(),
  annotationIds: z.array(id).max(50).optional(),
  runId: id.optional(),
  includeInternal: z.boolean().optional(),
});

const SENSITIVE_QUERY = /(^|[_-])(token|key|secret|password|passwd|pwd|auth|session|sid|code|otp|jwt|sig|signature|credential|apikey)([_-]|$)/i;

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = ''; u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, '[redacted]');
    }
    if (/^(?:#|\/)?(?:access_token|id_token|token)=/.test(u.hash.slice(1))) u.hash = '#[redacted]';
    return u.toString();
  } catch (_e) { return null; }
}

function redactText(input, redactions) {
  let text = String(input == null ? '' : input);
  const mark = (re, label) => {
    text = text.replace(re, () => { redactions.push(label); return `[redacted:${label}]`; });
  };
  mark(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer');
  mark(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, 'jwt');
  mark(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'aws-key');
  mark(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, 'api-key');
  mark(/\b[A-Fa-f0-9]{32,}\b/g, 'hex-token');
  mark(/\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/g, 'opaque-token');
  mark(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email');
  text = text.replace(/https?:\/\/[^\s)>"']+/g, (match) => {
    const cleaned = redactUrl(match);
    if (cleaned && cleaned !== match && cleaned !== new URL(match).toString()) redactions.push('url-query');
    return cleaned || '[redacted:url]';
  });
  return text;
}

function describeStep(s) {
  const t = (x) => {
    if (!x) return '';
    if (x.by === 'role') return `${x.role}${x.name ? ` “${x.name}”` : ''}`;
    if (x.by === 'testId') return `test id ${x.value}`;
    return `label “${x.value}”`;
  };
  switch (s.type) {
    case 'navigate': return `Navigate to ${s.url}`;
    case 'click': return `Click ${t(s.target)}`;
    case 'fill': return `Fill ${t(s.target)} with input \`${s.inputKey}\` (value not included)`;
    case 'select': return `Select an option in ${t(s.target)} from input \`${s.inputKey}\``;
    case 'check': return `${s.checked ? 'Check' : 'Uncheck'} ${t(s.target)}`;
    case 'press': return `Press ${s.key} in ${t(s.target)}`;
    case 'setViewport': return `Set viewport ${s.width}×${s.height}`;
    case 'capture': return `Capture evidence “${s.label}”`;
    case 'assert': return s.kind === 'url'
      ? `Expect URL ${s.op} “${s.expected}”`
      : `Expect ${t(s.target)} ${s.kind}${['visible', 'exists'].includes(s.kind) ? '' : ` ${s.op} “${s.expected}”`}`;
    default: return s.type;
  }
}

// input: { review?:{id,name,url?}, annotations?:[{id,text,visibility,severity?,selector?}], plan?, run?:{runId,state,verdict,
//   planned,executed,passed,failed,skipped,pending,unknown,uncertainEffect,evidenceComplete,manifestUri}, evidence?:[{uri,sha256?,kind?}],
//   appRevision?, viewport?, includeInternal? }
function buildReproPackage(input) {
  const redactions = [];
  const excluded = [];
  const src = input || {};
  const include = src.includeInternal === true;

  const notes = [];
  for (const a of Array.isArray(src.annotations) ? src.annotations : []) {
    if (!a || typeof a.id !== 'string') continue;
    if (a.visibility !== 'client' && !include) { excluded.push({ id: a.id, reason: 'internal-visibility' }); continue; }
    notes.push({
      id: a.id,
      severity: typeof a.severity === 'string' ? a.severity.slice(0, 20) : null,
      text: redactText(a.text, redactions).slice(0, 2000),
    });
  }

  let steps = [];
  let plan = null;
  if (src.plan) {
    const checked = wf.safeValidateWorkflow(src.plan);
    if (!checked.ok) throw new RegistryError('PLAN_INVALID', 'The supplied plan failed workflow validation.', { issues: checked.issues.slice(0, 10) });
    plan = checked.plan;
    steps = plan.steps.map((s, i) => ({ n: i + 1, id: s.id, text: redactText(describeStep(s), redactions) }));
  }

  const evidence = [];
  for (const e of Array.isArray(src.evidence) ? src.evidence : []) {
    if (!e || typeof e.uri !== 'string' || !e.uri.startsWith('braiwser://')) {
      excluded.push({ id: String(e && e.uri).slice(0, 80), reason: 'not-an-evidence-uri' });
      continue;
    }
    evidence.push({ uri: e.uri.slice(0, 300), kind: typeof e.kind === 'string' ? e.kind.slice(0, 30) : 'artifact',
      sha256: typeof e.sha256 === 'string' && /^[a-f0-9]{64}$/.test(e.sha256) ? e.sha256 : null });
  }

  const run = src.run && typeof src.run === 'object' ? {
    runId: String(src.run.runId || '').slice(0, 160),
    state: String(src.run.state || 'unknown').slice(0, 30),
    verdict: String(src.run.verdict || 'unknown').slice(0, 30),
    planned: Number(src.run.planned) || 0,
    executed: Number(src.run.executed) || 0,
    passed: Number(src.run.passed) || 0,
    failed: Number(src.run.failed) || 0,
    pending: Number(src.run.pending) || 0,
    unknown: Number(src.run.unknown) || 0,
    uncertainEffect: src.run.uncertainEffect === true,
    evidenceComplete: src.run.evidenceComplete === true,
    manifestUri: typeof src.run.manifestUri === 'string' && src.run.manifestUri.startsWith('braiwser://') ? src.run.manifestUri : null,
  } : null;

  const review = src.review ? {
    id: String(src.review.id || '').slice(0, 160),
    name: redactText(src.review.name, redactions).slice(0, 200),
    url: src.review.url ? redactUrl(String(src.review.url)) : null,
  } : null;

  const data = {
    schemaVersion: 1,
    generatedBy: 'handoff-repro@1.0.0',
    review,
    appRevision: typeof src.appRevision === 'string' ? src.appRevision.slice(0, 120) : null,
    viewport: src.viewport && Number.isInteger(src.viewport.width) && Number.isInteger(src.viewport.height)
      ? { width: src.viewport.width, height: src.viewport.height } : null,
    findings: notes,
    steps,
    planDigest: plan ? wf.digestOf(plan) : null,
    run,
    evidence,
    // The package only reports; it never says a defect is fixed.
    verification: run
      ? (run.verdict === 'passed' && run.evidenceComplete && !run.uncertainEffect
        ? 'The registered assertions passed with a complete evidence manifest.'
        : `Not verified: run verdict is ${run.verdict}${run.uncertainEffect ? ' and at least one effect is unknown' : ''}.`)
      : 'Not verified: no run is attached.',
    redactionCount: redactions.length,
    excluded,
  };

  const md = [];
  md.push(`# Repro: ${review && review.name ? review.name : 'Braiwser review'}`);
  if (review && review.url) md.push(`\nPage: ${review.url}`);
  if (data.appRevision) md.push(`App revision: ${data.appRevision}`);
  if (data.viewport) md.push(`Viewport: ${data.viewport.width}×${data.viewport.height}`);
  if (notes.length) {
    md.push('\n## Findings');
    for (const n of notes) md.push(`- ${n.severity ? `[${n.severity}] ` : ''}${n.text}`);
  }
  if (steps.length) {
    md.push('\n## Steps');
    for (const s of steps) md.push(`${s.n}. ${s.text}`);
  }
  md.push('\n## Verification');
  md.push(data.verification);
  if (run) md.push(`Run ${run.runId}: ${run.state} / ${run.verdict} — planned ${run.planned}, executed ${run.executed}, passed ${run.passed}, failed ${run.failed}, pending ${run.pending}, unknown ${run.unknown}.`);
  if (evidence.length) {
    md.push('\n## Evidence (references only)');
    for (const e of evidence) md.push(`- ${e.uri}${e.sha256 ? ` (sha256 ${e.sha256})` : ''}`);
  }
  if (excluded.length) md.push(`\n_${excluded.length} item(s) were excluded from this package (see JSON)._`);

  return {
    ok: true,
    package: { json: data, markdown: md.join('\n') },
    // Sending is a separate, human-approved operation; this module never does it.
    send: { performed: false, requiresApproval: true },
  };
}

module.exports = { manifest, inputSchema, buildReproPackage, redactText, redactUrl, sourceFile: __filename };
