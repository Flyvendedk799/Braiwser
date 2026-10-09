'use strict';
// verify-journey 1.0.0 — validate a stored journey, execute approved steps, check
// postconditions, produce a run report. A TEMPLATE skill: the plan is compiled
// from a saved recording by the pure migration in workflow-core.js, then frozen
// (plan digest + input digest) into the run snapshot by the broker.
const { z } = require('zod');
const wf = require('../workflow-core');
const { id, RegistryError } = require('./_shared');

const manifest = Object.freeze({
  id: 'verify-journey',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Verify a recorded journey',
  description: 'Replay a saved Braiwser journey against an owned browser session and prove its assertions. Refuses recordings with secret or non-semantic steps.',
  executor: 'broker-plan',
  requires: ['navigate', 'interact', 'assert'],
  maxDurationMs: 300000,
});

const inputSchema = z.strictObject({ recordingId: id });

// ctx.loadRecording(recordingId) is a SYNCHRONOUS, owner-scoped lookup supplied by
// the main process (the broker resolves skills synchronously). The compiled plan
// declares `recordingId` as an input key so the broker accepts the client's
// {recordingId} input; recorded literal values are returned as derived inputs and
// are never part of the plan bytes.
function compile(inputs, ctx = {}) {
  const parsed = inputSchema.parse(inputs);
  if (typeof ctx.loadRecording !== 'function') {
    throw new RegistryError('UNAVAILABLE', 'No recording loader is configured for verify-journey.');
  }
  const recording = ctx.loadRecording(parsed.recordingId);
  if (recording && typeof recording.then === 'function') throw new RegistryError('UNAVAILABLE', 'The recording loader must be synchronous.');
  if (!recording) throw new RegistryError('RECORDING_NOT_FOUND', 'The recording does not exist or is not visible to this principal.');
  const migrated = wf.recordingToWorkflow(recording, {
    skillId: manifest.id, version: manifest.version,
    maxDurationMs: Math.min(ctx.maxDurationMs || 120000, manifest.maxDurationMs),
  });
  if (!migrated.ok) {
    throw new RegistryError('RECORDING_NOT_MIGRATABLE',
      'The recording contains steps the closed workflow language refuses.', { refused: migrated.refused.slice(0, 50) });
  }
  const plan = wf.validateWorkflow({ ...migrated.plan, inputKeys: ['recordingId', ...migrated.plan.inputKeys] });
  return { plan, planDigest: wf.digestOf(plan), inputs: { recordingId: parsed.recordingId, ...migrated.suggestedInputs },
    dropped: migrated.dropped, warnings: migrated.warnings };
}

module.exports = { manifest, inputSchema, compile, sourceFile: __filename };
