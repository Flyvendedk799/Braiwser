#!/usr/bin/env node
// braiwser-agent — the concise CLI over the same broker bridge and the same
// operations as the MCP tools (one validation / projection / error path).
// Output is a single JSON envelope { ok, value, error } on stdout. No shell is
// involved anywhere: this is executable + arguments only, and it has no flag
// that evaluates code, reads a path or runs a command.
//
// Exit codes: 0 ok, 1 usage error, 2 tool/broker error.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import bridge from './bridge.js';
import registryModule from './skill-registry.js';
import { createOperations } from './operations.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const USAGE = `braiwser-agent <command> [flags]   (JSON on stdout)

  open      --driver playwright|electron-embedded --mode headless|visible --origin URL... [--classes observe,navigate,interact,submit]
            [--profile NAME] [--review-session ID] [--project ID] [--expires ISO]
  observe   --session ID --page ID [--max-nodes N] [--focus TEXT] [--cursor C]
  act       --session ID --page ID --observation ID --epoch N --operation ID --action JSON [--run ID] [--approval ID]
  extract   --session ID --page ID --fields JSON [--observation ID] [--epoch N] [--focus TEXT]
  run       --session ID --page ID --request-key KEY --skill ID --skill-version X.Y.Z [--digest sha256:..] [--inputs JSON] [--max-duration-ms N]
  status    --run ID [--after N] [--max-events N]
  cancel    --run ID
  handoff   --session ID --page ID --reason TEXT [--run ID] [--request-key KEY] [--reason-code needsHuman|userRequested|approval|privateInput|other]
  pause     --run ID --request-key KEY --epoch N [--reason TEXT]
  handoff-status --handoff ID [--after N] [--max-events N]
  resume    --handoff ID --request-key KEY --epoch N [--run ID]
  close     --session ID
  skills    (list the pinned skill catalog; no broker needed)
  doctor    (protocol, deployment and viewer readiness; no broker needed)

Connection: BRAIWSER_BRIDGE_INFO=<connection file written by Braiwser>.`;

const FLAGS = {
  driver: { type: 'string' }, mode: { type: 'string' }, profile: { type: 'string' },
  'review-session': { type: 'string' }, origin: { type: 'string', multiple: true }, classes: { type: 'string' },
  project: { type: 'string' }, expires: { type: 'string' },
  session: { type: 'string' }, page: { type: 'string' }, 'max-nodes': { type: 'string' },
  focus: { type: 'string' }, cursor: { type: 'string' },
  observation: { type: 'string' }, epoch: { type: 'string' }, operation: { type: 'string' },
  action: { type: 'string' }, run: { type: 'string' }, approval: { type: 'string' },
  fields: { type: 'string' }, 'request-key': { type: 'string' }, skill: { type: 'string' },
  'skill-version': { type: 'string' }, digest: { type: 'string' }, inputs: { type: 'string' },
  'max-duration-ms': { type: 'string' }, after: { type: 'string' }, 'max-events': { type: 'string' },
  reason: { type: 'string' }, handoff: { type: 'string' }, 'reason-code': { type: 'string' },
  help: { type: 'boolean' },
};

class Usage extends Error {}

const num = (flags, name) => {
  if (flags[name] === undefined) return undefined;
  if (!/^\d+$/.test(flags[name])) throw new Usage(`--${name} must be a non-negative integer`);
  return Number(flags[name]);
};
const json = (flags, name) => {
  if (flags[name] === undefined) return undefined;
  try { return JSON.parse(flags[name]); } catch { throw new Usage(`--${name} must be valid JSON`); }
};
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const COMMANDS = {
  open: (f) => ['browser_session_open', drop({ driver: f.driver, mode: f.mode, profile: f.profile,
    reviewSessionId: f['review-session'],
    grant: drop({ allowedOrigins: f.origin, toolClasses: f.classes ? f.classes.split(',').map((x) => x.trim()) : undefined,
      projectId: f.project, expiresAt: f.expires }) })],
  observe: (f) => ['browser_observe', drop({ sessionId: f.session, pageId: f.page, maxNodes: num(f, 'max-nodes'),
    focus: f.focus, cursor: f.cursor })],
  act: (f) => ['browser_act', drop({ sessionId: f.session, pageId: f.page, runId: f.run, observationId: f.observation,
    documentEpoch: num(f, 'epoch'), operationId: f.operation, approvalId: f.approval, action: json(f, 'action') })],
  extract: (f) => ['browser_extract', drop({ sessionId: f.session, pageId: f.page, observationId: f.observation,
    documentEpoch: num(f, 'epoch'), focus: f.focus, fields: json(f, 'fields') })],
  run: (f) => ['browser_run', drop({ sessionId: f.session, pageId: f.page, requestKey: f['request-key'], skillId: f.skill,
    skillVersion: f['skill-version'], skillDigest: f.digest, maxDurationMs: num(f, 'max-duration-ms'),
    inputs: json(f, 'inputs') || {} })],
  status: (f) => ['browser_run_status', drop({ runId: f.run, afterSequence: num(f, 'after'), maxEvents: num(f, 'max-events') })],
  cancel: (f) => ['browser_run_cancel', drop({ runId: f.run })],
  handoff: (f) => ['browser_handoff', drop({ sessionId: f.session, pageId: f.page, runId: f.run, reason: f.reason,
    requestKey: f['request-key'], reasonCode: f['reason-code'] })],
  pause: (f) => ['browser_run_pause', drop({ runId: f.run, requestKey: f['request-key'], expectedControlEpoch: num(f, 'epoch'), reason: f.reason })],
  'handoff-status': (f) => ['browser_handoff_status', drop({ handoffId: f.handoff, afterSequence: num(f, 'after'), maxEvents: num(f, 'max-events') })],
  resume: (f) => ['browser_run_resume', drop({ runId: f.run, handoffId: f.handoff, requestKey: f['request-key'], expectedControlEpoch: num(f, 'epoch') })],
};

// io: { env, stdout(text), stderr(text), connect() -> facade }
export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || ((t) => process.stdout.write(t));
  const err = io.stderr || ((t) => process.stderr.write(t));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, allowPositionals: true, strict: true });
  } catch (error) {
    err(`${error.message}\n\n${USAGE}\n`);
    return 1;
  }
  const [command, ...extra] = parsed.positionals;
  if (!command) {
    if (parsed.values.help) { out(`${USAGE}\n`); return 0; }
    err(`${USAGE}\n`);
    return 1;
  }
  if (parsed.values.help || command === 'help') { out(`${USAGE}\n`); return 0; }
  if (extra.length) { err(`Unexpected argument: ${extra[0]}\n`); return 1; }

  if (command === 'skills') {
    out(`${JSON.stringify({ ok: true, value: { skills: registryModule.catalog() }, error: null })}\n`);
    return 0;
  }
  if (command === 'doctor') {
    const { doctorReport } = require('./doctor.js');
    out(`${JSON.stringify({ ok: true, value: doctorReport({ env }), error: null })}\n`);
    return 0;
  }

  let facade = null;
  try {
    let name, args;
    if (command === 'close') {
      args = drop({ sessionId: parsed.values.session });
      if (!args.sessionId) throw new Usage('--session is required');
    } else if (COMMANDS[command]) {
      [name, args] = COMMANDS[command](parsed.values);
    } else {
      throw new Usage(`Unknown command: ${command}`);
    }
    facade = io.connect ? await io.connect() : await bridge.connectBridge(bridge.loadConnectionInfo(env));
    if (command === 'close') {
      try {
        await facade.closeSession(args, {});
        out(`${JSON.stringify({ ok: true, value: { closed: true }, error: null })}\n`);
        return 0;
      } catch (caught) {
        const e = caught && caught.publicError;
        out(`${JSON.stringify({ ok: false, value: null, error: { code: (e && e.code) || 'INTERNAL', message: String((e && e.message) || 'Close failed').slice(0, 500),
          dispatched: false, effectUnknown: false, retry: 'never' } })}\n`);
        return 2;
      }
    }
    const ops = createOperations(facade, {});
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once('SIGINT', onSignal);
    const result = await ops.execute(name, args, { signal: controller.signal });
    process.removeListener('SIGINT', onSignal);
    out(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 2;
  } catch (error) {
    if (error instanceof Usage) { err(`${error.message}\n\n${USAGE}\n`); return 1; }
    const e = error && error.publicError;
    out(`${JSON.stringify({ ok: false, value: null, error: { code: (e && e.code) || 'UNAVAILABLE',
      message: String((e && e.message) || 'Cannot reach Braiwser.').slice(0, 500), dispatched: false, effectUnknown: false, retry: 'never' } })}\n`);
    return 2;
  } finally {
    if (facade && typeof facade.close === 'function') await facade.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
