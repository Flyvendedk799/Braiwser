#!/usr/bin/env node
'use strict';
// Headless worker entry for the agent browser runtime. Runs WITHOUT Electron:
// it requires the broker and the Playwright driver only (never `electron`), so it can run in CI or
// on a machine with no desktop.
//
//   node src/main/services/browser/cli.js run-fixture <fixture> [--mode headless|visible] [--input k=v ...]
//        Opens a Playwright session through the broker, then runs the fixture's closed plan
//        (test/fixtures/agent-sites/<fixture>.plan.json): open -> observe -> act -> verify, against a
//        LOCAL fixture server on 127.0.0.1. Prints ONE receipt JSON on stdout.
//
//   node src/main/services/browser/cli.js serve [--origin URL ...] [--classes observe,navigate,interact] [--fixtures]
//        Minimal JSON-lines command mode on stdin/stdout. One request per line:
//          {"id":1,"method":"openSession","params":{...}}   ->   {"id":1,"ok":true,"result":{...}}
//        errors:  {"id":1,"ok":false,"error":{"code","message","dispatched","effectUnknown","retry"}}
//        The first line is {"event":"ready",...}. stdout carries protocol ONLY; logs go to stderr.
//
//   node src/main/services/browser/cli.js capabilities
//
// Exit codes (honest):
//   0 the run's verdict is `passed` (or the command succeeded)
//   1 the run finished but did not pass: failed | cancelled | timedOut | unknown (never rounded up)
//   2 usage error
//   3 environment unavailable (no Chromium, fixtures missing)
//   4 internal error
//
// Security: the worker is its own broker owner (single writer). The principal is kind 'cli' with
// scopes derived from --origin/--classes; it can never approve or resume (trusted UI only). The CLI
// opts the feature flag in explicitly (featureFlag:true): running this command IS the opt-in.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, UNAVAILABLE: 3, INTERNAL: 4 });
const PROTOCOL = 'braiwser.cli.jsonl/1';
const RECEIPT_SCHEMA = 'braiwser.cli.receipt/1';
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'agent-sites');
const MAX_LINE_BYTES = 1024 * 1024;
const SERVE_METHODS = Object.freeze(['capabilities', 'openSession', 'closeSession', 'observe', 'act', 'startRun', 'getRun', 'cancelRun',
  'listRuns', 'getManifest', 'readResource', 'handoff']);
const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'interrupted']);
const CLASS_NAMES = ['observe', 'navigate', 'interact', 'submit'];

const err = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CliError extends Error {
  constructor(exit, message) { super(message); this.exit = exit; }
}

// ---- argument parsing -----------------------------------------------------------------------
function parseArgs(argv) {
  const out = { command: null, positional: [], flags: { origin: [], input: [] } };
  const list = argv.slice();
  const take = (name) => {
    if (!list.length) throw new CliError(EXIT.USAGE, `${name} needs a value`);
    return list.shift();
  };
  while (list.length) {
    const a = list.shift();
    if (a === '-h' || a === '--help') out.flags.help = true;
    else if (a === '--mode') out.flags.mode = take(a);
    else if (a === '--data-dir') out.flags.dataDir = take(a);
    else if (a === '--origin') out.flags.origin.push(take(a));
    else if (a === '--input') out.flags.input.push(take(a));
    else if (a === '--classes') out.flags.classes = take(a);
    else if (a === '--timeout-ms') out.flags.timeoutMs = Number(take(a));
    else if (a === '--fixtures') out.flags.fixtures = true;
    else if (a === '--keep') out.flags.keep = true;
    else if (a.startsWith('--')) throw new CliError(EXIT.USAGE, `unknown option ${a}`);
    else if (!out.command) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

const USAGE = `usage:
  cli.js run-fixture <fixture> [--mode headless|visible] [--input key=value ...] [--timeout-ms N] [--data-dir DIR]
  cli.js serve [--origin URL ...] [--classes observe,navigate,interact[,submit]] [--fixtures] [--mode headless|visible]
  cli.js capabilities
`;

// ---- shared setup -----------------------------------------------------------------------------
function loadModules(env) {
  try {
    const { createBroker } = require('./broker');
    const { createPlaywrightDriver } = require('./drivers/playwright');
    return { createBroker, createPlaywrightDriver, executablePath: env.BRAIWSER_CHROMIUM_PATH || undefined };
  } catch (e) {
    throw new CliError(EXIT.UNAVAILABLE, `agent runtime modules are not available: ${e && e.message}`);
  }
}

function fixtureServer() {
  const file = path.join(FIXTURE_DIR, 'server.js');
  if (!fs.existsSync(file)) throw new CliError(EXIT.UNAVAILABLE, `fixture server not found at ${file}`);
  return require(file);
}

function listPlans() {
  try {
    return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.plan.json')).map((f) => f.replace(/\.plan\.json$/, ''));
  } catch (_e) { return []; }
}

function loadPlan(name, origin, inputs) {
  const file = path.join(FIXTURE_DIR, `${name}.plan.json`);
  const text = fs.readFileSync(file, 'utf8').split('{{origin}}').join(origin);
  const plan = JSON.parse(text);
  // Declared input defaults come from the plan's own fixture docs (name -> "Ada"); the caller overrides with --input.
  return { plan, inputs: { name: 'Ada', ...inputs } };
}

// Is a Chromium binary actually launchable for this mode? Distinguishes "environment" from "bug".
async function probeBrowser(mods, mode) {
  const driver = mods.createPlaywrightDriver({ executablePath: mods.executablePath });
  try {
    const s = await driver.open({ mode });
    await s.close();
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Executable doesn't exist|playwright install|Failed to launch|ENOENT|Cannot find module/i.test(msg)) {
      return `Chromium is not available (${msg.split('\n')[0]}). Run: npx playwright-core install chromium`;
    }
    throw e;
  }
}

function makeBroker(mods, { dataDir, skills }) {
  return mods.createBroker({
    dataDir,
    drivers: { playwright: mods.createPlaywrightDriver({ executablePath: mods.executablePath }) },
    featureFlag: true,
    skills,
    appVersion: 'cli',
  });
}

function scopesFor(origins, classes) {
  return [...classes.map((c) => `class:${c}`), ...origins.map((o) => `origin:${o}`)];
}

function parseClasses(value, dflt) {
  if (value === undefined) return dflt;
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.some((c) => !CLASS_NAMES.includes(c))) throw new CliError(EXIT.USAGE, `--classes must be a comma list of ${CLASS_NAMES.join('|')}`);
  return list;
}

function parseMode(value) {
  const mode = value || 'headless';
  if (mode !== 'headless' && mode !== 'visible') throw new CliError(EXIT.USAGE, '--mode must be headless or visible');
  return mode;
}

const publicErr = (e) => {
  const p = e && e.publicError;
  if (p) return { code: p.code, message: p.message, dispatched: !!p.dispatched, effectUnknown: !!p.effectUnknown, retry: p.retry === undefined ? false : p.retry };
  return { code: 'INTERNAL', message: String((e && e.message) || e).slice(0, 300), dispatched: false, effectUnknown: false, retry: false };
};

// ---- run-fixture -----------------------------------------------------------------------------------
async function runFixture(args, env) {
  const name = String(args.positional[0] || '').replace(/\.html?$/i, '');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new CliError(EXIT.USAGE, `run-fixture needs a fixture name. Available: ${listPlans().join(', ') || '(none)'}`);
  }
  if (!listPlans().includes(name) || !fs.existsSync(path.join(FIXTURE_DIR, `${name}.html`))) {
    throw new CliError(EXIT.USAGE, `unknown fixture "${name}". Available: ${listPlans().join(', ') || '(none)'}`);
  }
  const mode = parseMode(args.flags.mode);
  const inputs = {};
  for (const kv of args.flags.input) {
    const i = kv.indexOf('=');
    if (i < 1) throw new CliError(EXIT.USAGE, '--input expects key=value');
    inputs[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const timeoutMs = Number.isFinite(args.flags.timeoutMs) && args.flags.timeoutMs > 0 ? args.flags.timeoutMs : 45000;

  const mods = loadModules(env);
  const unavailable = await probeBrowser(mods, mode);
  if (unavailable) throw new CliError(EXIT.UNAVAILABLE, unavailable);

  const { startFixtureServer } = fixtureServer();
  const srv = await startFixtureServer({ dir: FIXTURE_DIR });
  const tmp = args.flags.dataDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-cli-'));
  const dataDir = args.flags.dataDir || tmp;
  const started = Date.now();
  let broker;
  try {
    const { plan, inputs: runInputs } = loadPlan(name, srv.origin, inputs);
    const skills = {
      resolve: ({ skillId }) => (skillId === plan.skillId ? { plan } : null),
      catalog: () => [{ skillId: plan.skillId, version: plan.version }],
    };
    broker = makeBroker(mods, { dataDir, skills });
    const principal = { id: 'cli-fixture', kind: 'cli', scopes: scopesFor([srv.origin], ['observe', 'navigate', 'interact']) };
    const b = broker.forPrincipal(principal);
    const session = await b.openSession({ driver: 'playwright', mode,
      grant: { allowedOrigins: [srv.origin], toolClasses: ['observe', 'navigate', 'interact'] } });
    let run = await b.startRun({ sessionId: session.sessionId, pageId: session.pageId, requestKey: `cli-${Date.now().toString(36)}`,
      skillId: plan.skillId, skillVersion: plan.version, maxDurationMs: plan.maxDurationMs, inputs: runInputs });
    const deadline = Date.now() + timeoutMs;
    while (!TERMINAL.has(run.state) && Date.now() < deadline) {
      await sleep(50);
      run = await b.getRun({ runId: run.runId, afterSequence: 0, maxEvents: 100 });
    }
    if (!TERMINAL.has(run.state)) {
      run = await b.cancelRun({ runId: run.runId });
    }
    let observation = null;
    try {
      const o = await b.observe({ sessionId: session.sessionId, pageId: session.pageId, maxNodes: 50 });
      observation = { observationId: o.observationId, url: o.url, nodes: o.nodes.length, truncated: o.truncated, coverage: o.coverage };
    } catch (e) { observation = { error: publicErr(e).code }; }
    let manifest = null;
    try { manifest = await b.getManifest({ runId: run.runId }); } catch (_e) { /* a non-passing run may have none */ }
    await b.closeSession({ sessionId: session.sessionId });
    const ok = run.verdict === 'passed' && run.evidenceComplete === true;
    const receipt = {
      schema: RECEIPT_SCHEMA,
      ok,
      fixture: name,
      driver: 'playwright',
      mode,
      electron: !!process.versions.electron,
      verdict: run.verdict,
      state: run.state,
      run: { runId: run.runId, state: run.state, verdict: run.verdict, planned: run.planned, executed: run.executed, passed: run.passed, failed: run.failed,
        unknown: run.unknown, skipped: run.skipped, requiredAssertions: run.requiredAssertions, passedAssertions: run.passedAssertions,
        evidenceComplete: run.evidenceComplete, uncertainEffect: run.uncertainEffect, events: run.events },
      capabilities: { version: session.capabilities.version, policyEnforcement: session.capabilities.policyEnforcement, humanHandoff: session.capabilities.humanHandoff,
        frames: session.capabilities.frames, shadowDom: session.capabilities.shadowDom, canvas: session.capabilities.canvas },
      observation,
      manifest: manifest ? { present: true, keys: Object.keys(manifest).slice(0, 12) } : { present: false },
      durationMs: Date.now() - started,
    };
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return ok ? EXIT.OK : EXIT.FAILED;
  } finally {
    if (broker) await broker.close().catch(() => {});
    await srv.close();
    if (tmp && !args.flags.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- serve (JSON lines) ------------------------------------------------------------------------------
async function serve(args, env, io) {
  const mode = parseMode(args.flags.mode);
  const classes = parseClasses(args.flags.classes, ['observe', 'navigate', 'interact']);
  const mods = loadModules(env);
  let srv = null;
  const origins = args.flags.origin.slice();
  const skillPlans = new Map();
  if (args.flags.fixtures) {
    const { startFixtureServer } = fixtureServer();
    srv = await startFixtureServer({ dir: FIXTURE_DIR });
    origins.push(srv.origin);
    for (const planName of listPlans()) {
      const { plan } = loadPlan(planName, srv.origin, {});
      skillPlans.set(plan.skillId, plan);
    }
  }
  const tmp = args.flags.dataDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-cli-'));
  const dataDir = args.flags.dataDir || tmp;
  const skills = skillPlans.size ? { resolve: ({ skillId }) => (skillPlans.has(skillId) ? { plan: skillPlans.get(skillId) } : null),
    catalog: () => [...skillPlans.values()].map((p) => ({ skillId: p.skillId, version: p.version })) } : null;
  const broker = makeBroker(mods, { dataDir, skills });
  const principal = { id: 'cli-worker', kind: 'cli', scopes: scopesFor(origins, classes) };
  const facade = broker.forPrincipal(principal);

  const write = (obj) => io.out.write(`${JSON.stringify(obj)}\n`);
  write({ event: 'ready', protocol: PROTOCOL, methods: SERVE_METHODS, mode, grantClasses: classes, origins,
    fixtureOrigin: srv ? srv.origin : null, runtime: { node: process.versions.node, electron: !!process.versions.electron } });

  async function handle(line) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return write({ id: null, ok: false, error: { code: 'INVALID', message: 'request line too large', dispatched: false, effectUnknown: false, retry: false } });
    let req;
    try { req = JSON.parse(line); } catch (_e) {
      return write({ id: null, ok: false, error: { code: 'INVALID', message: 'request is not valid JSON', dispatched: false, effectUnknown: false, retry: false } });
    }
    const id = req && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
    const bad = (code, message) => write({ id, ok: false, error: { code, message, dispatched: false, effectUnknown: false, retry: false } });
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') return bad('INVALID', 'request needs {id, method, params}');
    if (!SERVE_METHODS.includes(req.method)) {
      const trusted = req.method === 'approve' || req.method === 'resume';
      return bad(trusted ? 'DENIED' : 'UNSUPPORTED', trusted ? `${req.method} is a trusted-UI action and is not available here` : `unknown method ${String(req.method).slice(0, 40)}`);
    }
    try {
      if (req.method === 'capabilities') return write({ id, ok: true, result: await facade.readResource('braiwser://capabilities') });
      const result = await facade[req.method](req.params === undefined ? {} : req.params);
      return write({ id, ok: true, result });
    } catch (e) {
      return write({ id, ok: false, error: publicErr(e) });
    }
  }

  let queue = Promise.resolve();
  let buffer = '';
  const onLine = (line) => { if (line.trim()) queue = queue.then(() => handle(line)).catch((e) => err('[cli] handler error', String(e && e.message))); };
  await new Promise((resolve) => {
    io.in.setEncoding('utf8');
    io.in.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
      if (buffer.length > MAX_LINE_BYTES * 2) buffer = ''; // runaway line without a newline: drop it
    });
    io.in.on('end', () => { if (buffer.trim()) onLine(buffer); resolve(); });
    io.in.on('close', resolve);
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await queue;
  await broker.close().catch(() => {});
  if (srv) await srv.close();
  if (tmp && !args.flags.keep) fs.rmSync(tmp, { recursive: true, force: true });
  return EXIT.OK;
}

async function capabilities(env) {
  const mods = loadModules(env);
  const driver = mods.createPlaywrightDriver({ executablePath: mods.executablePath });
  process.stdout.write(`${JSON.stringify({ headless: driver.capabilities({ mode: 'headless' }), visible: driver.capabilities({ mode: 'visible' }) }, null, 2)}\n`);
  return EXIT.OK;
}

async function main(argv = process.argv.slice(2), env = process.env, io = { in: process.stdin, out: process.stdout }) {
  try {
    const args = parseArgs(argv);
    if (args.flags.help || !args.command) {
      process.stdout.write(USAGE);
      return args.command || args.flags.help ? EXIT.OK : EXIT.USAGE;
    }
    if (args.command === 'run-fixture') return await runFixture(args, env);
    if (args.command === 'serve') return await serve(args, env, io);
    if (args.command === 'capabilities') return await capabilities(env);
    throw new CliError(EXIT.USAGE, `unknown command ${String(args.command).slice(0, 40)}`);
  } catch (e) {
    if (e instanceof CliError) {
      err(`error: ${e.message}`);
      if (e.exit === EXIT.USAGE) err(USAGE);
      return e.exit;
    }
    err(`internal error: ${(e && e.stack) || e}`);
    return EXIT.INTERNAL;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { err(String(e && e.stack)); process.exitCode = EXIT.INTERNAL; });
}

module.exports = { main, parseArgs, EXIT, PROTOCOL, RECEIPT_SCHEMA, SERVE_METHODS };
