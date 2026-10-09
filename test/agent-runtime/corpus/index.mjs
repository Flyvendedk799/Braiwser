// Corpus loader + validator. The corpus is DATA: tasks.mjs is the authoring
// source, manifest.json the published artifact (its digest identifies the exact
// corpus a result was measured on).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CORPUS_VERSION, tasks, RECORDINGS, REPRO_INPUT } from './tasks.mjs';
import { oracles } from './oracles.mjs';

export const SCHEMA = 1;
export const CATEGORIES = ['navigation', 'forms', 'dynamic', 'authorization', 'extraction', 'audit-to-note', 'repair', 'export', 'adversarial'];
export const OPS = ['goto', 'click', 'fill', 'press', 'check', 'select', 'read', 'readName', 'readAll', 'readNumber', 'countRole', 'waitFor', 'wait', 'viewport',
  'remember', 'clickRemembered', 'reobserveIfStale', 'extractTable', 'findUnnamed', 'presence', 'finding375', 'saveCheck', 'compareRepair',
  'switchToNewPage', 'runSkill', 'claimFromRun', 'reproPackage', 'claimIfValue', 'claimIfComplete', 'claim'];
export const REQUIRES = ['dom', 'frames', 'popups', 'viewport', 'durable-run', 'repro-package'];
export const SITES = ['primary', 'evil', 'baseline', 'candidate'];

export function buildManifest() {
  return { schemaVersion: SCHEMA, corpusVersion: CORPUS_VERSION, seed: 20261009, taskCount: tasks.length,
    description: 'Synthetic, local, deterministic tasks for a scripted agent. No model in the loop; see README.md.',
    tasks, recordings: RECORDINGS, reproInput: REPRO_INPUT };
}

export function loadManifest() {
  return JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
}

export function corpusDigest(manifest = loadManifest()) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return `sha256:${createHash('sha256').update(JSON.stringify(canon(manifest))).digest('hex')}`;
}

// Returns a list of problems (empty = valid).
export function validateManifest(m) {
  const problems = [];
  if (!m || m.schemaVersion !== SCHEMA) problems.push('schemaVersion');
  if (!/^\d+\.\d+\.\d+$/.test(m && m.corpusVersion)) problems.push('corpusVersion');
  if (!Array.isArray(m && m.tasks) || m.tasks.length !== 30) problems.push(`expected exactly 30 tasks, found ${m && m.tasks && m.tasks.length}`);
  const ids = new Set();
  for (const t of (m && m.tasks) || []) {
    const where = `task ${t && t.id}`;
    if (!t || !/^[a-z]+-\d\d-[a-z0-9-]+$/.test(t.id)) problems.push(`${where}: id format`);
    if (ids.has(t.id)) problems.push(`${where}: duplicate id`);
    ids.add(t.id);
    if (!CATEGORIES.includes(t.category)) problems.push(`${where}: category`);
    if (!t.title || !t.goal) problems.push(`${where}: title/goal`);
    if (!Array.isArray(t.sites) || !t.sites.length || t.sites.some((s) => !SITES.includes(s))) problems.push(`${where}: sites`);
    if (!Array.isArray(t.requires) || t.requires.some((r) => !REQUIRES.includes(r))) problems.push(`${where}: requires`);
    if (!t.oracle || !Object.prototype.hasOwnProperty.call(oracles, t.oracle.name)) problems.push(`${where}: unknown oracle ${t.oracle && t.oracle.name}`);
    if (!Array.isArray(t.script) || !t.script.length) problems.push(`${where}: script`);
    else {
      for (const op of t.script) if (!OPS.includes(op.op)) problems.push(`${where}: unknown op ${op.op}`);
      if (!['claim', 'claimIfValue', 'claimIfComplete', 'claimFromRun'].includes(t.script[t.script.length - 1].op)) problems.push(`${where}: script must end with a claim`);
    }
    for (const s of t.script || []) {
      if (s.recording && !(m.recordings && m.recordings[s.recording])) problems.push(`${where}: unknown recording ${s.recording}`);
      if (typeof s.url === 'string' && !/^\{(primary|evil|baseline|candidate)\}\//.test(s.url)) problems.push(`${where}: urls must use a {site} placeholder`);
      if (typeof s.url === 'string') {
        const site = /^\{(\w+)\}/.exec(s.url)[1];
        if (!t.sites.includes(site)) problems.push(`${where}: url uses undeclared site ${site}`);
      }
    }
    if (typeof t.adversarial !== 'boolean' && t.adversarial !== undefined) problems.push(`${where}: adversarial flag`);
  }
  const perCategory = {};
  for (const t of (m && m.tasks) || []) perCategory[t.category] = (perCategory[t.category] || 0) + 1;
  for (const c of CATEGORIES) if (!perCategory[c]) problems.push(`category ${c} has no tasks`);
  return problems;
}
