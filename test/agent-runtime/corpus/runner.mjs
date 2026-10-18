// Corpus runner: fixture sites + scripted agent + adapters + metrics.
//
// A scripted agent has NO model: it follows the task's fixed script, resolving
// controls strictly by role/name (never "first match"). That isolates the
// adapter's transport, observation, authorization and honesty behavior from
// model quality. It therefore CANNOT measure token cost of a model's reasoning,
// prompt-injection susceptibility (tasks flagged modelDependent are reported as
// unmeasured) or planning. Nothing here compares adapters or ranks them.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSite, createEvilSite, newWorld } from './sites.mjs';
import { oracles, classify } from './oracles.mjs';
import { loadManifest, corpusDigest, validateManifest } from './index.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ sites

export async function startSites(task) {
  const world = newWorld();
  const worlds = {};
  const urls = {};
  const stops = [];
  const opts = task.siteOptions || {};
  // The hostile origin starts first so the pages can link to it.
  if (task.sites.includes('evil')) {
    const evil = createEvilSite(world);
    urls.evil = await evil.start(); stops.push(evil.stop);
  }
  for (const name of task.sites.filter((n) => n !== 'evil')) {
    const w = name === 'primary' ? world : newWorld();
    worlds[name] = w;
    const site = createSite({ world: w, ...(opts[name] || {}), evil: urls.evil || '' });
    urls[name] = await site.start(); stops.push(site.stop);
  }
  return { urls, worlds, stop: () => Promise.all(stops.map((stop) => stop())) };
}

const fill = (text, urls) => text.replace(/\{(primary|evil|baseline|candidate)\}/g, (_m, k) => urls[k]);

// ------------------------------------------------------------------ scripted agent

class OpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const EDITABLE = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

function matcher(op) {
  return (n) => (!op.role || n.role === op.role)
    && (op.name === undefined || norm(n.name) === norm(op.name))
    && (op.contains === undefined || norm(n.name).toLowerCase().includes(String(op.contains).toLowerCase()))
    && (op.startsWith === undefined || norm(n.name).startsWith(op.startsWith));
}
const byLabel = (label) => (n) => (EDITABLE.has(n.role) || n.editable === true) && norm(n.name) === norm(label);

// Run a task script against a session (adapter primitives). Returns { claim, values, trace }.
export async function runScript(task, session, urls, recordings, reproInput) {
  const values = {};
  const trace = [];
  const memory = {};
  let claim = null;
  let uncertain = 0;

  const find = async (pred, { allowMissing = false } = {}) => {
    const obs = await session.observe();
    const hits = obs.nodes.filter(pred);
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      if (allowMissing) return null;
      throw new OpError('NOT_FOUND', obs.truncated ? 'not found (observation truncated)' : 'not found');
    }
    throw new OpError('AMBIGUOUS_TARGET', 'several controls match; refusing to guess');
  };
  const run = async (op) => {
    switch (op.op) {
      case 'goto': await session.goto(fill(op.url, urls)); return;
      case 'click': await session.click((await find(matcher(op))).ref); return;
      case 'fill': await session.fill((await find(op.label ? byLabel(op.label) : matcher(op))).ref, op.text); return;
      case 'press': await session.press((await find(op.label ? byLabel(op.label) : matcher(op))).ref, op.key); return;
      case 'check': await session.check((await find(matcher(op))).ref, op.checked); return;
      case 'select': await session.select((await find(op.label ? byLabel(op.label) : matcher(op))).ref, op.value); return;
      case 'read': case 'readName': { const n = await find(matcher(op)); values[op.as] = n.name; return; }
      case 'readNumber': { const n = await find(matcher(op)); const m = /\d+/.exec(n.name); if (!m) throw new OpError('NOT_FOUND', 'no number'); values[op.as] = Number(m[0]); return; }
      case 'readAll': values[op.as] = (await session.observe()).nodes.filter(matcher(op)).map((n) => n.name); return;
      case 'countRole': values[op.as] = (await session.observe()).nodes.filter((n) => n.role === op.role).length; return;
      case 'waitFor': {
        const t0 = Date.now();
        for (;;) {
          const hits = (await session.observe()).nodes.filter(matcher(op));
          if (hits.length === 1) return;
          if (hits.length > 1) throw new OpError('AMBIGUOUS_TARGET', 'several controls match');
          if (Date.now() - t0 > (op.timeoutMs || 3000)) throw new OpError('TIMEOUT', 'condition not met in time');
          await delay(100);
        }
      }
      case 'wait': await delay(op.ms); return;
      case 'viewport': await session.setViewport(op.width, op.height); return;
      case 'remember': { const n = await find(matcher(op)); memory[op.as] = n.ref; return; }
      case 'clickRemembered': await session.click(memory[op.as]); return;
      case 'reobserveIfStale': return; // marker: the next op always takes a fresh observation
      case 'switchToNewPage': await session.switchToNewPage(); return;
      case 'findUnnamed': {
        const hits = (await session.observe()).nodes.filter((n) => n.role === op.role && norm(n.name) === '');
        values[op.as] = { role: op.role, reason: 'missing-accessible-name', count: hits.length };
        return;
      }
      case 'presence': values[op.as] = !!(await find(matcher(op), { allowMissing: true })); return;
      case 'finding375':
        values.finding = values.at375 === false && values.at1280 === true ? { viewport: 375, missing: 'navigation:Primary' } : null;
        return;
      case 'extractTable': {
        const extractTable = require('../../../src/main/services/automation/workflows/extract-table.js');
        const facade = {
          observe: async () => { const o = await session.observe(); return { observationId: o.observationId, documentEpoch: o.documentEpoch, truncated: o.truncated, nextCursor: null, nodes: o.nodes }; },
          act: async (a) => { await session.click(a.action.ref); return { status: 'dispatched' }; },
        };
        const r = await extractTable.run(facade, { columns: op.columns, nextPage: { role: 'button', name: op.nextName }, maxPages: op.maxPages }, { sessionId: 's', pageId: 'p', operationPrefix: 'bench' });
        // Normalised shape for oracles
        values[op.as] = { complete: r.complete, incompleteReason: r.incompleteReason,
          rows: r.rows.map((row) => Object.fromEntries(Object.entries(row.cells).map(([k, c]) => [k, c]))) };
        return;
      }
      case 'saveCheck': {
        const base = urls[op.site];
        const result = { saved: false, revision: null, error: null };
        try {
          await session.goto(`${base}/profile`);
          await session.fill((await find(byLabel('Display name'))).ref, 'Ada Lovelace');
          await session.click((await find(matcher({ role: 'button', name: 'Save' }))).ref);
          await delay(400);
          await session.goto(`${base}/profile`);
          await delay(300);
          const persisted = await find(matcher({ role: 'status', startsWith: 'name:' }));
          result.saved = norm(persisted.name) === 'name: Ada Lovelace';
          const rev = await find(matcher({ role: 'status', startsWith: 'rev ' }));
          result.revision = norm(rev.name).slice(4);
        } catch (e) {
          result.error = e.code || 'ERROR';
          try { const rev = await find(matcher({ role: 'status', startsWith: 'rev ' }), { allowMissing: true }); if (rev) result.revision = norm(rev.name).slice(4); } catch { /* ignore */ }
        }
        values[op.as] = result;
        return;
      }
      case 'compareRepair': {
        const b = values.baselineResult, c = values.candidateResult;
        let verdict;
        if (b.revision !== op.expectedBaseline || c.revision !== op.expectedCandidate) verdict = 'unavailable';
        else if (!b.saved && c.saved) verdict = 'fixed';
        else if (b.saved && !c.saved) verdict = 'regressed';
        else if (b.saved && c.saved) verdict = 'not-reproduced';
        else verdict = 'not-fixed';
        values.verdict = verdict;
        return;
      }
      case 'runSkill': values[op.as] = await session.runSkill({ recording: recordings[op.recording], cancelAfterMs: op.cancelAfterMs, urls }); return;
      case 'claimFromRun': {
        const r = values[op.key];
        claim = { status: r.state === 'passed' ? 'done' : (r.state === 'cancelled' ? 'cancelled' : (r.state === 'uncertain' || r.state === 'interrupted') ? 'unknown' : 'failed') };
        return;
      }
      case 'reproPackage': values[op.as] = await session.reproPackage(reproInput, op.withInternal === true); return;
      case 'claimIfValue': claim = { status: values[op.key] === op.equals ? op.status : op.otherwise }; return;
      case 'claimIfComplete': claim = { status: values[op.key] && values[op.key].complete === true ? 'done' : 'failed' }; return;
      case 'claim': claim = { status: op.status }; return;
      default: throw new OpError('UNSUPPORTED', `unknown op ${op.op}`);
    }
  };

  for (const op of task.script) {
    const t0 = Date.now();
    try {
      await run(op);
      trace.push({ op: op.op, ok: true, ms: Date.now() - t0 });
    } catch (error) {
      const code = error.code || (error.publicError && error.publicError.code) || 'ERROR';
      trace.push({ op: op.op, ok: false, code, ms: Date.now() - t0 });
      if (code === 'UNSUPPORTED') return { claim: { status: 'unsupported' }, values, trace, uncertain };
      if (op.onError === 'record') { values[`${op.as || op.op}Error`] = code; continue; }
      if (op.onError === 'blocked' || ['DENIED', 'AMBIGUOUS_TARGET', 'STALE_REF'].includes(code)) return { claim: { status: 'blocked' }, values, trace, uncertain };
      return { claim: { status: 'failed' }, values, trace, uncertain };
    }
  }
  return { claim: claim || { status: 'failed' }, values, trace, uncertain };
}

// ------------------------------------------------------------------ adapters

// Generic primitives on top of a tool caller (MCP in-process or CLI processes).
function toolSession({ call, stats, registry, onApproval }) {
  const refs = new Map(); // ref -> { observationId, documentEpoch }
  let current = null;     // { sessionId, pageId }
  let counter = 0;
  const t = async (name, args) => {
    const t0 = Date.now();
    const envelope = await call(name, args);
    stats.toolCalls += 1;
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    stats.responseBytes += bytes;
    if (name === 'browser_observe') stats.observeBytes += bytes;
    stats.toolMs += Date.now() - t0;
    if (!envelope.ok) {
      const e = new Error(envelope.error.message);
      e.code = envelope.error.code;
      e.publicError = envelope.error;
      throw e;
    }
    return envelope.value;
  };
  const observe = async () => {
    const nodes = [];
    let cursor, first = null, truncated = false, hops = 0;
    for (;;) {
      const o = await t('browser_observe', { ...current, maxNodes: 200, ...(cursor ? { cursor } : {}) });
      first = first || o;
      for (const n of o.nodes) { nodes.push(n); refs.set(n.ref, { observationId: o.observationId, documentEpoch: o.documentEpoch }); }
      if (!o.nextCursor) { truncated = o.truncated; break; }
      cursor = o.nextCursor;
      if (++hops >= 5) { truncated = true; break; }
    }
    return { nodes, truncated, observationId: first.observationId, documentEpoch: first.documentEpoch };
  };
  const act = async (action, ref) => {
    const meta = ref ? refs.get(ref) : null;
    const base = meta || await observe();
    const request = (approvalId) => t('browser_act', { ...current, observationId: base.observationId, documentEpoch: base.documentEpoch,
      operationId: `bench-${++counter}-${Date.now().toString(36)}`, action, ...(approvalId ? { approvalId } : {}) });
    let receipt;
    try {
      receipt = await request();
    } catch (error) {
      // The headless client cannot approve itself. The id travels in the error text; the trusted UI (simulated here) decides.
      const m = error.publicError && error.publicError.retry === 'after-approval' ? /approvalId=(\S+)/.exec(error.message) : null;
      if (!m || !onApproval) throw error;
      stats.humanInterventions += 1;
      if ((await onApproval(m[1])) !== 'allow') throw Object.assign(new Error('approval denied by the user'), { code: 'DENIED' });
      receipt = await request(m[1]);
    }
    if (receipt.status === 'not_attempted') {
      const e = new Error(`not attempted: ${receipt.code}`);
      e.code = /STALE|OWNERSHIP/.test(receipt.code) ? 'STALE_REF' : 'DENIED';
      throw e;
    }
    return receipt;
  };
  return {
    stats,
    async open({ origins, classes }) {
      const s = await t('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: origins, toolClasses: classes } });
      current = { sessionId: s.sessionId, pageId: s.pageId };
      return s;
    },
    observe,
    goto: (url) => act({ kind: 'navigate', url }, null),
    click: (ref) => act({ kind: 'click', ref }, ref),
    fill: (ref, text) => act({ kind: 'fill', ref, text }, ref),
    press: (ref, key) => act({ kind: 'press', ref, key }, ref),
    check: (ref, checked) => act({ kind: 'check', ref, checked }, ref),
    select: (ref, value) => act({ kind: 'select', ref, value }, ref),
    setViewport: (width, height) => act({ kind: 'setViewport', width, height }, null),
    async switchToNewPage() { throw Object.assign(new Error('the tool surface has no page listing'), { code: 'UNSUPPORTED' }); },
    async runSkill({ recording, cancelAfterMs, urls }) {
      void recording; void urls;
      const run = await t('browser_run', { ...current, requestKey: `bench-${Date.now().toString(36)}`, skillId: 'verify-journey', skillVersion: '1.0.0', inputs: { recordingId: 'journey-profile' } });
      if (cancelAfterMs !== undefined) { await delay(cancelAfterMs); await t('browser_run_cancel', { runId: run.runId }); }
      let s = run;
      for (let i = 0; i < 60 && ['queued', 'running'].includes(s.state); i += 1) { await delay(100); s = await t('browser_run_status', { runId: run.runId }); }
      return s;
    },
    async reproPackage(input, withInternal) {
      const r = registry.repro.buildReproPackage({ ...input, includeInternal: withInternal });
      return r.package;
    },
    ids: () => current,
  };
}

function makeStats() { return { toolCalls: 0, responseBytes: 0, observeBytes: 0, toolMs: 0, humanInterventions: 0 }; }

async function buildBraiwserStack(manifest) {
  const { createBroker } = require('../../../src/main/services/browser/broker.js');
  const { createDrivers } = require('../../../src/main/services/browser/drivers/index.js');
  const skillRegistry = require('../../../src/main/services/automation/skill-registry.js');
  const repro = require('../../../src/main/services/automation/workflows/handoff-repro.js');
  let currentUrls = {};
  const skills = skillRegistry.createBrokerSkills({
    loadRecording: (id) => {
      const rec = manifest.recordings[id];
      return rec ? JSON.parse(fill(JSON.stringify(rec), currentUrls)) : null;
    },
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'braiwser-bench-'));
  const drivers = createDrivers({ only: ['playwright'] });
  const broker = createBroker({ dataDir, drivers: { playwright: drivers.playwright }, featureFlag: true, skills, appVersion: 'bench' });
  const uiPrincipal = { id: 'ui-bench', kind: 'ui', scopes: [] };
  return { broker, repro, setUrls: (u) => { currentUrls = u; },
    decide: (approvalId, decision) => broker.forPrincipal(uiPrincipal).approve({ approvalId, decision }).then(() => decision),
    close: async () => { await broker.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

const principalFor = (task, urls) => ({
  id: `bench-${task.id}`.slice(0, 80), kind: 'mcp',
  scopes: ['class:observe', 'class:navigate', 'class:interact', 'class:submit',
    ...['primary', 'baseline', 'candidate'].filter((k) => urls[k]).map((k) => `origin:${urls[k]}`)],
});
const grantFor = (task, urls) => ({
  origins: ['primary', 'baseline', 'candidate'].filter((k) => urls[k]).map((k) => urls[k]),
  classes: ['observe', 'navigate', 'interact', 'submit'],
});

export function createAdapters({ manifest }) {
  const braiwserCaps = { dom: true, frames: true, popups: false, viewport: true, 'durable-run': true, 'repro-package': true };
  let stack = null;
  const ensureStack = async () => stack || (stack = await buildBraiwserStack(manifest));

  const probeBrowser = async () => {
    try {
      const s = await ensureStack();
      const fake = s.broker.forPrincipal({ id: 'probe', kind: 'mcp', scopes: ['class:observe', 'origin:http://127.0.0.1:1'] });
      const opened = await fake.openSession({ driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['http://127.0.0.1:1'], toolClasses: ['observe'] } });
      await fake.closeSession({ sessionId: opened.sessionId });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `Chromium could not be launched through the Playwright driver (${String(error.message).slice(0, 120)})` };
    }
  };

  const adapters = {
    'braiwser-mcp': {
      capabilities: braiwserCaps,
      available: probeBrowser,
      async session(task, urls) {
        const s = await ensureStack();
        s.setUrls(urls);
        const principal = principalFor(task, urls);
        const { createMcpServer } = await import(pathToFileURL(path.join(ROOT, 'src/main/services/automation/mcp.mjs')).href);
        const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const server = createMcpServer(s.broker, { principal });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'bench', version: '1.0.0' });
        await Promise.all([server.connect(b), client.connect(a)]);
        const stats = makeStats();
        const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
        const session = toolSession({ call, stats, registry: { repro: s.repro }, onApproval: (id) => s.decide(id, task.denyApprovals ? 'deny' : 'allow') });
        const g = grantFor(task, urls);
        await session.open({ origins: g.origins, classes: g.classes });
        session.close = async () => {
          const ids = session.ids();
          await client.close(); await server.close();
          if (ids) await s.broker.forPrincipal(principal).closeSession({ sessionId: ids.sessionId }).catch(() => {});
        };
        return session;
      },
    },
    'braiwser-cli': {
      capabilities: braiwserCaps,
      available: probeBrowser,
      async session(task, urls) {
        const s = await ensureStack();
        s.setUrls(urls);
        const principal = principalFor(task, urls);
        const bridgeServer = require('../../../src/main/services/automation/bridge-server.js');
        const server = bridgeServer.createBridgeServer({ broker: s.broker });
        await server.listen();
        const dir = mkdtempSync(path.join(tmpdir(), 'braiwser-bench-cli-'));
        const { file } = server.writeClientFile(path.join(dir, 'info.json'), { ...principal, kind: 'cli' }, { ttlMs: 10 * 60 * 1000 });
        const cli = path.join(ROOT, 'src/main/services/automation/cli.mjs');
        const flags = {
          browser_session_open: (a) => ['open', '--driver', a.driver, '--mode', a.mode, ...a.grant.allowedOrigins.flatMap((o) => ['--origin', o]), '--classes', a.grant.toolClasses.join(',')],
          browser_observe: (a) => ['observe', '--session', a.sessionId, '--page', a.pageId, '--max-nodes', String(a.maxNodes), ...(a.cursor ? ['--cursor', a.cursor] : [])],
          browser_act: (a) => ['act', '--session', a.sessionId, '--page', a.pageId, '--observation', a.observationId, '--epoch', String(a.documentEpoch),
            '--operation', a.operationId, '--action', JSON.stringify(a.action), ...(a.approvalId ? ['--approval', a.approvalId] : [])],
          browser_run: (a) => ['run', '--session', a.sessionId, '--page', a.pageId, '--request-key', a.requestKey, '--skill', a.skillId,
            '--skill-version', a.skillVersion, '--inputs', JSON.stringify(a.inputs)],
          browser_run_status: (a) => ['status', '--run', a.runId],
          browser_run_cancel: (a) => ['cancel', '--run', a.runId],
        };
        const call = (name, args) => new Promise((resolve, reject) => {
          if (!flags[name]) { reject(new Error(`no CLI mapping for ${name}`)); return; }
          // executable + arguments only: no shell
          execFile(process.execPath, [cli, ...flags[name](args)], { env: { ...process.env, BRAIWSER_BRIDGE_INFO: file }, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => {
              try { resolve(JSON.parse(String(stdout).trim().split('\n')[0])); } catch { reject(error || new Error('unparseable CLI output')); }
            });
        });
        const stats = makeStats();
        const session = toolSession({ call, stats, registry: { repro: s.repro }, onApproval: (id) => s.decide(id, task.denyApprovals ? 'deny' : 'allow') });
        const g = grantFor(task, urls);
        await session.open({ origins: g.origins, classes: g.classes });
        session.close = async () => {
          const ids = session.ids();
          if (ids) await s.broker.forPrincipal(principal).closeSession({ sessionId: ids.sessionId }).catch(() => {});
          await server.close(); rmSync(dir, { recursive: true, force: true });
        };
        return session;
      },
    },
    'playwright-mcp': {
      capabilities: {},
      async available() {
        try { require.resolve('@playwright/mcp/package.json'); } catch {
          return { ok: false, reason: 'no pinned @playwright/mcp is installed in this checkout; install an exact version to measure it' };
        }
        return { ok: false, reason: '@playwright/mcp is installed but this harness has no snapshot-format driver for it yet; unmeasured' };
      },
      async session() { throw new Error('unavailable'); },
    },
  };
  return { adapters, close: async () => { if (stack) await stack.close(); stack = null; } };
}

// ------------------------------------------------------------------ run + report

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function summarize(results) {
  const byAdapter = {};
  for (const r of results) (byAdapter[r.adapter] = byAdapter[r.adapter] || []).push(r);
  const out = {};
  for (const [name, rows] of Object.entries(byAdapter)) {
    const attempted = rows.filter((r) => r.outcome !== 'unmeasured');
    const count = (o) => attempted.filter((r) => r.outcome === o).length;
    const ms = attempted.map((r) => r.wallMs).sort((a, b) => a - b);
    const calls = attempted.map((r) => r.toolCalls || 0).sort((a, b) => a - b);
    out[name] = {
      attempted: attempted.length, unmeasuredTasks: rows.length - attempted.length,
      outcomes: Object.fromEntries(['success', 'honest-block', 'failure', 'false-pass', 'unsafe-effect', 'unsupported'].map((o) => [o, count(o)])),
      // Rates are over ALL attempted tasks: failed, blocked and unsupported attempts are never discarded.
      successRate: attempted.length ? count('success') / attempted.length : null,
      falsePassRate: attempted.length ? attempted.filter((r) => r.falsePass).length / attempted.length : null,
      unsafeEffects: attempted.filter((r) => r.unsafe).length,
      humanInterventions: attempted.reduce((a, r) => a + (r.humanInterventions || 0), 0),
      wallMs: { median: percentile(ms, 50), p95: percentile(ms, 95) },
      toolCalls: { total: calls.reduce((a, b) => a + b, 0), median: percentile(calls, 50) },
      responseBytes: attempted.reduce((a, r) => a + (r.responseBytes || 0), 0),
      observeBytes: attempted.reduce((a, r) => a + (r.observeBytes || 0), 0),
      approxTokensFromBytes: Math.ceil(attempted.reduce((a, r) => a + (r.responseBytes || 0), 0) / 4),
    };
  }
  return out;
}

export async function runCorpus({ adapterNames, taskIds, seed = 1, repeat = 1, log = () => {} } = {}) {
  const manifest = loadManifest();
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`invalid corpus: ${problems.slice(0, 3).join('; ')}`);
  const { adapters, close } = createAdapters({ manifest });
  const names = adapterNames && adapterNames.length ? adapterNames : Object.keys(adapters);
  const tasks = manifest.tasks.filter((t) => !taskIds || taskIds.includes(t.id));
  const availability = {};
  for (const n of names) {
    if (!adapters[n]) { availability[n] = { status: 'unmeasured', reason: 'unknown adapter' }; continue; }
    const a = await adapters[n].available();
    availability[n] = a.ok ? { status: 'measured' } : { status: 'unmeasured', reason: a.reason };
  }
  // randomized order, fixed by seed
  const plan = [];
  for (const n of names) for (const t of tasks) for (let i = 0; i < repeat; i += 1) plan.push({ adapter: n, task: t, repeat: i });
  const rnd = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }

  const results = [];
  for (const { adapter, task, repeat: rep } of plan) {
    const base = { adapter, taskId: task.id, category: task.category, repeat: rep, adversarial: !!task.adversarial };
    if (availability[adapter].status !== 'measured') { results.push({ ...base, outcome: 'unmeasured', reason: availability[adapter].reason }); continue; }
    if (task.modelDependent) { results.push({ ...base, outcome: 'unmeasured', reason: 'behavior depends on a model reading page text; a scripted agent cannot measure it' }); continue; }
    const caps = adapters[adapter].capabilities;
    const missing = task.requires.filter((r) => !caps[r]);
    if (missing.length) { results.push({ ...base, outcome: 'unsupported', reason: `adapter lacks: ${missing.join(', ')}`, wallMs: 0, toolCalls: 0, responseBytes: 0, observeBytes: 0 }); continue; }
    const sites = await startSites(task);
    const t0 = Date.now();
    let session = null;
    try {
      session = await adapters[adapter].session(task, sites.urls);
      const run = await runScript(task, session, sites.urls, manifest.recordings, manifest.reproInput);
      const judged = oracles[task.oracle.name]({ params: task.oracle.params, worlds: sites.worlds, values: run.values, claim: run.claim });
      const cls = run.claim.status === 'unsupported' ? { outcome: 'unsupported', falsePass: false, unsafe: !!judged.unsafe } : classify({ oracle: judged, claim: run.claim });
      results.push({ ...base, outcome: cls.outcome, falsePass: cls.falsePass, unsafe: cls.unsafe, claim: run.claim.status, oracleOk: judged.ok,
        wallMs: Date.now() - t0, toolCalls: session.stats.toolCalls, responseBytes: session.stats.responseBytes, observeBytes: session.stats.observeBytes, humanInterventions: session.stats.humanInterventions,
        trace: run.trace.filter((s) => !s.ok).slice(0, 5) });
    } catch (error) {
      results.push({ ...base, outcome: 'failure', falsePass: false, unsafe: false, claim: 'error', error: String(error.message).slice(0, 200), wallMs: Date.now() - t0,
        toolCalls: session ? session.stats.toolCalls : 0, responseBytes: session ? session.stats.responseBytes : 0, observeBytes: session ? session.stats.observeBytes : 0 });
    } finally {
      try { if (session && session.close) await session.close(); } catch { /* ignore */ }
      await sites.stop();
    }
    log(`${adapter} ${task.id} -> ${results[results.length - 1].outcome}`);
  }
  await close();
  return {
    corpus: { version: manifest.corpusVersion, digest: corpusDigest(manifest), tasks: manifest.tasks.length, schemaVersion: manifest.schemaVersion },
    run: { seed, repeat, node: process.version, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() },
    methodology: 'Scripted agent, no model. Local fixtures. Outcomes judged by server-side oracles. Token counts are bytes/4 heuristics, not model tokens. No adapter is compared with another here.',
    adapters: availability,
    results,
    summary: summarize(results),
  };
}
