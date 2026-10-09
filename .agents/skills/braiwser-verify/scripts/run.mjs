// Start (or resume) a fixed, registered Braiwser workflow and wait for a
// verdict. It does not evaluate skill text, read paths from the page, or build a
// shell command: it launches the configured bridge entrypoint as
// `node <absolute path>` and speaks MCP to it.
//
//   node scripts/run.mjs <sessionId> <pageId> <recordingId> <requestKey> [resumeRunId]
//   env BRAIWSER_MCP_ENTRY  absolute path of the installed Braiwser MCP sidecar (required)
//       BRAIWSER_BRIDGE_INFO the connection file the sidecar uses (passed through)
//
// Exit codes: 0 proven pass | 2 not passed, error, or inconsistent run |
//             3 needs approval / human input (resume with the printed runId) |
//             4 client wait budget exhausted (the server-side run is NOT cancelled)
//
// Requires @modelcontextprotocol/sdk to be installed explicitly; nothing is
// downloaded at run time.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, isAbsolute, extname } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const [sessionId, pageId, recordingId, requestKey, resumeRunId] = process.argv.slice(2);
const entry = process.env.BRAIWSER_MCP_ENTRY;
const SKILL = { id: 'verify-journey', version: '1.0.0' };

// Trusted local configuration only (never page- or skill-supplied).
const clamp = (raw, fallback, min, max) => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};
const pollMs = clamp(process.env.BRAIWSER_POLL_MS, 750, 10, 10_000);
const waitMs = clamp(process.env.BRAIWSER_WAIT_MS, 5 * 60_000, 100, 30 * 60_000);
const RPC_TIMEOUT_MS = 15_000;

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted']);
const BLOCKED = new Set(['needsApproval', 'needsHuman']);
const STATES = new Set([...TERMINAL, ...BLOCKED, 'queued', 'running']);
const COUNTERS = ['sequence', 'planned', 'executed', 'passed', 'skipped', 'cancelled', 'timedOut', 'requiredAssertions',
  'passedAssertions', 'pending', 'failed', 'unknown', 'nextSequence'];

// Structural check of the run DTO (the shared output schema lives in the
// adapter; this script must stand alone, so it re-checks the fields it relies on).
function validateRun(v) {
  if (!v || typeof v !== 'object') throw new Error('Invalid run: not an object.');
  if (typeof v.runId !== 'string' || !v.runId) throw new Error('Invalid run: runId.');
  if (!STATES.has(v.state)) throw new Error('Invalid run: unknown state.');
  if (typeof v.verdict !== 'string') throw new Error('Invalid run: verdict.');
  for (const k of COUNTERS) if (!Number.isInteger(v[k]) || v[k] < 0) throw new Error(`Invalid run: ${k}.`);
  for (const k of ['evidenceComplete', 'uncertainEffect', 'cancelRequested']) if (typeof v[k] !== 'boolean') throw new Error(`Invalid run: ${k}.`);
  if (!Array.isArray(v.events)) throw new Error('Invalid run: events.');
  if (typeof v.manifestUri !== 'string' || !v.manifestUri.startsWith('braiwser://')) throw new Error('Invalid run: manifestUri.');
  return v;
}

// Lifecycle -> verdict (audit): pending for active/blocked, unknown for
// uncertain/interrupted, otherwise the terminal reason itself.
function verdictMatchesState(s) {
  if (['queued', 'running', 'needsApproval', 'needsHuman'].includes(s.state)) return s.verdict === 'pending';
  if (s.state === 'uncertain' || s.state === 'interrupted') return s.verdict === 'unknown';
  return s.verdict === s.state;
}

function provenPass(s) {
  return s.verdict === 'passed' && s.evidenceComplete === true && s.uncertainEffect === false &&
    s.requiredAssertions > 0 && s.passedAssertions === s.requiredAssertions &&
    s.planned > 0 && s.executed === s.planned && s.passed === s.planned && s.failed === 0 &&
    s.skipped === 0 && s.pending === 0 && s.unknown === 0 && s.cancelled === 0 && s.timedOut === 0;
}

let runId = resumeRunId;
let client;
let exitCode = 0;

try {
  const usable = entry && isAbsolute(entry) && existsSync(entry) && statSync(entry).isFile() &&
    ['.mjs', '.js', '.cjs'].includes(extname(entry));
  if (!usable || (!resumeRunId && (!sessionId || !pageId || !recordingId || !requestKey))) {
    throw new Error('Provide BRAIWSER_MCP_ENTRY (absolute path of the installed sidecar) and: session, page, recording, stable request key (or a runId to resume).');
  }

  client = new Client({ name: 'braiwser-verify-skill', version: '1.0.0' });
  const passEnv = {};
  for (const k of ['BRAIWSER_BRIDGE_INFO', 'BRAIWSER_MCP_DEBUG']) if (process.env[k]) passEnv[k] = process.env[k];
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(entry)], stderr: 'inherit',
    env: { ...getDefaultEnvironment(), ...passEnv },
  });

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: RPC_TIMEOUT_MS });
    const value = result.structuredContent;
    if (!value || typeof value.ok !== 'boolean') {
      const text = Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string' ? result.content[0].text.slice(0, 300) : '';
      throw new Error(`Invalid MCP result envelope. ${text}`.trim());
    }
    if (result.isError || !value.ok) throw new Error(value.error?.message || 'Tool failed; inspect the existing run.');
    return value.value;
  };

  let cancelRequested = false;
  process.on('SIGINT', () => { cancelRequested = true; });
  const deadline = Date.now() + waitMs; // client wait budget; not a run cancellation

  await client.connect(transport);
  let status = validateRun(resumeRunId
    ? await call('browser_run_status', { runId, afterSequence: 0, maxEvents: 30 })
    : await call('browser_run', { sessionId, pageId, requestKey, skillId: SKILL.id, skillVersion: SKILL.version,
      inputs: { recordingId } }));
  runId = status.runId;
  console.log(JSON.stringify({ runId, requestKey, state: status.state }));

  const printed = new Set();
  let sentCancel = false;
  for (;;) {
    if (!verdictMatchesState(status)) throw new Error('Inconsistent run: lifecycle state and verdict disagree.');
    for (const event of status.events) {
      if (!printed.has(event.sequence)) { printed.add(event.sequence); console.log(JSON.stringify(event)); }
    }
    if (TERMINAL.has(status.state)) {
      if (status.state === 'passed' && !provenPass(status)) {
        throw new Error('Inconsistent passed run: verification evidence is incomplete.');
      }
      console.log(JSON.stringify(status));
      exitCode = status.state === 'passed' ? 0 : 2;
      break;
    }
    if (cancelRequested && !sentCancel) {
      // Send once. A transport error is not permission to retry a mutation.
      sentCancel = true;
      status = validateRun(await call('browser_run_cancel', { runId }));
      continue;
    }
    if (BLOCKED.has(status.state)) {
      console.log(JSON.stringify({ runId, state: status.state, manifestUri: status.manifestUri,
        resume: 'Use this runId after the owner resolves the blocker.' }));
      exitCode = 3;
      break;
    }
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ runId, state: status.state,
        next: 'Client wait budget exhausted. Inspect this existing run; no cancellation was inferred.' }));
      exitCode = 4;
      break;
    }
    await delay(pollMs);
    status = validateRun(await call('browser_run_status', { runId, afterSequence: status.nextSequence, maxEvents: 30 }));
  }
} catch (error) {
  console.error(JSON.stringify({ runId, requestKey, error: error.message,
    next: 'Reconnect and inspect this run or recover the same requestKey; do not launch a replacement.' }));
  exitCode = 2;
} finally {
  if (client) await client.close().catch(() => {});
  process.exitCode = exitCode;
}
