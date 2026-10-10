// ESM facade over the single, CommonJS workflow implementation (workflow-core.js)
// so the MCP adapter, CLI and tests import named bindings while the broker's CJS
// run state machine requires the very same validator.
import core from './workflow-core.js';

export const {
  SCHEMA_VERSION, Workflow, validateWorkflow, safeValidateWorkflow,
  canonicalJson, digestOf, sha256, workflowDigest, inputDigest,
  describeEffects, requiredCapabilities, diffWorkflows, recordingToWorkflow, locateStep,
} = core;
export default core;
