#!/usr/bin/env node
'use strict';
// Runs the versioned agent-browser corpus (test/agent-runtime/corpus) against the
// adapters available in this checkout and prints raw outcomes plus per-adapter
// summaries. It does NOT compare adapters, rank them, or make claims: adapters
// that cannot run here are reported "unmeasured" with the reason, and a scripted
// agent (no model) cannot measure model-dependent behavior or model token cost.
//
//   npm run bench:agent -- --self-check
//   npm run bench:agent -- --adapters braiwser-mcp,braiwser-cli --seed 7 --repeat 3 --out bench.json
//   npm run bench:agent -- --tasks form-01-save-display-name --adapters braiwser-mcp
//
// The model-driven adapter (a Claude model drives the MCP tools itself) only runs
// when it is named, needs ANTHROPIC_API_KEY and is "unmeasured" without it:
//   ANTHROPIC_API_KEY=... npm run bench:agent -- --adapters braiwser-mcp-model --token-budget 2000000 --out model.json
// Model id: BRAIWSER_BENCH_MODEL. Bounds: --max-turns, --task-timeout-ms, --token-budget
// (or BRAIWSER_BENCH_MAX_TURNS / _TASK_TIMEOUT_MS / _TOKEN_BUDGET). The key is never printed.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const corpusDir = path.join(__dirname, '..', 'test', 'agent-runtime', 'corpus');
const load = (name) => import(pathToFileURL(path.join(corpusDir, name)).href);

function parse(argv) {
  const out = { adapters: null, tasks: null, seed: 1, repeat: 1, out: null, selfCheck: false, list: false, model: {} };
  const positive = (flag, text) => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--adapters') out.adapters = next().split(',').filter(Boolean);
    else if (a === '--tasks') out.tasks = next().split(',').filter(Boolean);
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--repeat') out.repeat = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--max-turns') out.model.maxTurns = positive(a, next());
    else if (a === '--task-timeout-ms') out.model.taskTimeoutMs = positive(a, next());
    else if (a === '--token-budget') out.model.tokenBudget = positive(a, next());
    else if (a === '--self-check') out.selfCheck = true;
    else if (a === '--list') out.list = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.seed) || !Number.isInteger(out.repeat) || out.repeat < 1 || out.repeat > 50) throw new Error('--seed and --repeat must be integers (repeat 1..50)');
  return out;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const index = await load('index.mjs');
  const manifest = index.loadManifest();
  const problems = index.validateManifest(manifest);
  if (args.list) {
    for (const t of manifest.tasks) console.log(`${t.id}\t${t.category}\t${(t.requires || []).join(',')}${t.modelDependent ? '\tmodel-dependent' : ''}`);
    return 0;
  }
  if (problems.length || args.selfCheck) {
    const report = { ok: problems.length === 0, corpusVersion: manifest.corpusVersion, digest: index.corpusDigest(manifest), tasks: manifest.tasks.length, problems };
    console.log(JSON.stringify(report, null, 2));
    return problems.length ? 1 : 0;
  }
  const runner = await load('runner.mjs');
  const report = await runner.runCorpus({
    adapterNames: args.adapters, taskIds: args.tasks, seed: args.seed, repeat: args.repeat, modelOptions: args.model,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text); else process.stdout.write(text);
  for (const [name, a] of Object.entries(report.adapters)) {
    if (a.status !== 'measured') process.stderr.write(`${name}: unmeasured - ${a.reason}\n`);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
