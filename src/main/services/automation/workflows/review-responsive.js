'use strict';
// review-responsive 1.0.0 — fixed viewport checks. For every viewport: set it,
// load the page, assert the declared landmarks are visible, then capture the
// full page and one crop per landmark as EVIDENCE. Captures never make a run
// pass; the assertions do. Each failed assertion maps back to a reproducible
// target + viewport + URL through workflow-core.locateStep().
const { z } = require('zod');
const wf = require('../workflow-core');
const { RegistryError } = require('./_shared');

const manifest = Object.freeze({
  id: 'review-responsive',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Responsive review',
  description: 'Check that declared landmarks are visible at fixed viewports and attach full-page and per-landmark captures as evidence.',
  executor: 'broker-plan',
  requires: ['navigate', 'viewport', 'screenshots', 'assert'],
  maxDurationMs: 300000,
});

const DEFAULT_VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 },
]);

const viewport = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
});
const landmark = z.strictObject({ role: z.string().min(1).max(80), name: z.string().min(1).max(200) });

const inputSchema = z.strictObject({
  url: z.string().max(2000).url(),
  landmarks: z.array(landmark).min(1).max(10),
  viewports: z.array(viewport).min(1).max(6).optional(),
  capture: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const names = (v.viewports || []).map((x) => x.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate viewport name', path: ['viewports'] });
});

function compile(inputs, ctx = {}) {
  const parsed = inputSchema.parse(inputs);
  const viewports = parsed.viewports || DEFAULT_VIEWPORTS;
  const capture = parsed.capture !== false;
  const steps = [];
  const landmarks = parsed.landmarks;
  for (const vp of viewports) {
    steps.push({ id: `${vp.name}-viewport`, type: 'setViewport', width: vp.width, height: vp.height });
    steps.push({ id: `${vp.name}-navigate`, type: 'navigate', url: parsed.url });
    landmarks.forEach((l, i) => {
      steps.push({ id: `${vp.name}-landmark-${i + 1}`, type: 'assert',
        target: { by: 'role', role: l.role, name: l.name }, kind: 'visible', op: 'equals', expected: 'visible' });
    });
    if (capture) {
      steps.push({ id: `${vp.name}-capture-page`, type: 'capture', label: `${vp.name} ${vp.width}x${vp.height}` });
      landmarks.forEach((l, i) => {
        steps.push({ id: `${vp.name}-capture-landmark-${i + 1}`, type: 'capture',
          label: `${vp.name}: ${l.name}`.slice(0, 200), target: { by: 'role', role: l.role, name: l.name } });
      });
    }
  }
  let plan;
  try {
    plan = wf.validateWorkflow({
      schemaVersion: wf.SCHEMA_VERSION, skillId: manifest.id, version: manifest.version,
      inputKeys: [],
      maxDurationMs: Math.min(ctx.maxDurationMs || 180000, manifest.maxDurationMs), steps,
    });
  } catch (error) {
    throw new RegistryError('PLAN_INVALID', 'The responsive plan failed workflow validation.',
      { issues: (error.issues || []).slice(0, 10).map((i) => i.message) });
  }
  return { plan, planDigest: wf.digestOf(plan), inputs: {}, dropped: [], warnings: [] };
}

// Pair each failed assertion with a reproducible locator: target, viewport, URL.
// `results` are the broker's [{ stepId, status }] for the finished run.
function defects(plan, results) {
  const out = [];
  for (const r of results || []) {
    if (r.status !== 'failed') continue;
    const where = wf.locateStep(plan, r.stepId);
    if (!where || where.step.type !== 'assert') continue;
    out.push({
      stepId: r.stepId,
      target: where.step.target || null,
      expected: where.step.expected,
      viewport: where.viewport,
      url: where.url,
      reproduce: where.precedingStepIds.concat(r.stepId),
    });
  }
  return out;
}

module.exports = { manifest, inputSchema, compile, defects, DEFAULT_VIEWPORTS, sourceFile: __filename };
