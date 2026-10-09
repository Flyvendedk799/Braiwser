'use strict';
// extract-table 1.0.0 — bounded, paginated table extraction with source refs and
// explicit missing values. ORCHESTRATED over broker.observe / broker.act (a
// closed plan cannot loop). Contract:
//   * never silently "complete": `complete` is true only when every page parsed
//     without structural problems AND the end of pagination was positively
//     observed (the configured next control is present and disabled, or the
//     caller declared `singlePage`). Any other stop sets `incompleteReason`.
//   * a cell that cannot be attributed to a column (misaligned row, unknown
//     column, empty accessible name) is a missing-value marker, never a guess.
//   * bounded: maxRows, maxPages, cursor hops per page, string lengths.
//   * no arbitrary evaluation, no selectors: it only reads the observation
//     nodes the broker returned. Values are untrusted page text.
const { z } = require('zod');
const { RegistryError } = require('./_shared');
const wf = require('../workflow-core');

const manifest = Object.freeze({
  id: 'extract-table',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Extract a table',
  description: 'Read selected columns from an accessible table across pages with source refs and explicit missing-value markers. Reports incomplete rather than guessing when pagination fails.',
  executor: 'orchestrator',
  requires: ['observe', 'interact'],
  maxDurationMs: 300000,
});

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const inputSchema = z.strictObject({
  columns: z.array(z.strictObject({ name: key, header: z.string().min(1).max(200) })).min(1).max(20),
  tableName: z.string().min(1).max(200).optional(),
  maxRows: z.number().int().min(1).max(500).default(200),
  maxPages: z.number().int().min(1).max(20).default(5),
  nextPage: z.strictObject({ role: z.enum(['button', 'link']), name: z.string().min(1).max(200) }).optional(),
  singlePage: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const names = v.columns.map((c) => c.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Duplicate column name' });
  if (v.singlePage && v.nextPage) ctx.addIssue({ code: 'custom', path: ['singlePage'], message: 'singlePage conflicts with nextPage' });
});

const CELL_ROLES = new Set(['cell', 'gridcell', 'rowheader']);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

// Pure: nodes (document order) -> { problem?, headers[], rows[] }.
function parseTable(nodes, tableName) {
  const containers = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.role === 'table' || n.role === 'grid' || n.role === 'treegrid');
  if (!containers.length) return { problem: 'NO_TABLE', headers: [], rows: [] };
  let chosen;
  if (tableName) {
    const hits = containers.filter(({ n }) => norm(n.name) === norm(tableName));
    if (hits.length === 0) return { problem: 'TABLE_NOT_FOUND', headers: [], rows: [] };
    if (hits.length > 1) return { problem: 'AMBIGUOUS_TABLE', headers: [], rows: [] };
    chosen = hits[0];
  } else {
    if (containers.length > 1) return { problem: 'AMBIGUOUS_TABLE', headers: [], rows: [] };
    chosen = containers[0];
  }
  const next = containers.find(({ i }) => i > chosen.i);
  const slice = nodes.slice(chosen.i + 1, next ? next.i : nodes.length);
  const headers = [];
  const rows = [];
  let current = null;
  let sawRow = false;
  for (const n of slice) {
    if (n.role === 'row') {
      sawRow = true;
      current = { cells: [], headerRow: false };
      rows.push(current);
    } else if (n.role === 'columnheader') {
      if (!current) { current = { cells: [], headerRow: true }; rows.push(current); }
      current.headerRow = true;
      headers.push({ name: norm(n.name), ref: n.ref });
    } else if (CELL_ROLES.has(n.role)) {
      if (!current) return { problem: 'NO_ROW_STRUCTURE', headers, rows: [] };
      current.cells.push({ name: norm(n.name), ref: n.ref });
    }
  }
  if (!sawRow && !rows.length) return { problem: 'NO_ROW_STRUCTURE', headers, rows: [] };
  return { problem: null, headers, rows: rows.filter((r) => !r.headerRow) };
}

// Pure: apply the requested columns. Returns rows + problems seen.
function project(parsed, columns, pageNumber, startIndex) {
  const problems = new Set();
  const positions = columns.map((c) => {
    const hits = parsed.headers.map((h, i) => ({ h, i })).filter(({ h }) => h.name === norm(c.header));
    if (hits.length !== 1) { problems.add(hits.length ? 'AMBIGUOUS_COLUMN' : 'COLUMN_NOT_FOUND'); return { column: c, index: -1, why: hits.length ? 'AMBIGUOUS_COLUMN' : 'COLUMN_NOT_FOUND' }; }
    return { column: c, index: hits[0].i, why: null };
  });
  const rows = parsed.rows.map((row, r) => {
    const aligned = row.cells.length === parsed.headers.length;
    if (!aligned) problems.add('MISALIGNED_ROWS');
    const cells = {};
    for (const p of positions) {
      if (p.index < 0) cells[p.column.name] = { value: null, missing: true, reason: p.why, source: null };
      else if (!aligned) cells[p.column.name] = { value: null, missing: true, reason: 'MISALIGNED_ROW', source: null };
      else {
        const cell = row.cells[p.index];
        cells[p.column.name] = cell.name === ''
          ? { value: null, missing: true, reason: 'EMPTY_CELL', source: { ref: cell.ref } }
          : { value: cut(cell.name, 500), missing: false, source: { ref: cell.ref } };
      }
    }
    return { page: pageNumber, index: startIndex + r, cells };
  });
  return { rows, problems: [...problems] };
}

const signature = (rows) => rows.map((r) => Object.values(r.cells).map((c) => (c.missing ? `?${c.reason}` : c.value)).join('␟')).join('␞');

async function observeWholePage(facade, base, signal, maxHops = 10) {
  const nodes = [];
  let cursor, hops = 0, last = null, truncated = false;
  for (;;) {
    const obs = await facade.observe({ ...base, maxNodes: 200, ...(cursor ? { cursor } : {}) }, { signal });
    last = obs;
    nodes.push(...(obs.nodes || []).map((n) => ({ ...n, ref: n.ref || n.refId })));
    if (obs.nextCursor) {
      if (++hops > maxHops) { truncated = true; break; }
      cursor = obs.nextCursor;
      continue;
    }
    truncated = obs.truncated === true;
    break;
  }
  return { observation: last, nodes, truncated };
}

// opts: { sessionId, pageId, runId?, operationPrefix, signal }
async function run(facade, rawInputs, opts) {
  const input = inputSchema.parse(rawInputs);
  if (!opts || !opts.sessionId || !opts.pageId) throw new RegistryError('INVALID_INPUT', 'sessionId and pageId are required.');
  const base = { sessionId: opts.sessionId, pageId: opts.pageId };
  const out = { complete: false, incompleteReason: null, pages: 0, rows: [], columns: input.columns.map((c) => c.name),
    trust: 'untrusted-page', observationIds: [], missing: { count: 0, reasons: {} }, problems: [] };
  const stop = (reason) => { if (!out.incompleteReason) out.incompleteReason = reason; return finish(); };
  const finish = () => {
    for (const r of out.rows) for (const c of Object.values(r.cells)) {
      if (c.missing) { out.missing.count += 1; out.missing.reasons[c.reason] = (out.missing.reasons[c.reason] || 0) + 1; }
    }
    return out;
  };
  const seen = new Set();
  let previous = null;

  for (let page = 1; page <= input.maxPages; page += 1) {
    if (opts.signal && opts.signal.aborted) return stop('CANCELLED');
    let snap;
    try { snap = await observeWholePage(facade, base, opts.signal); }
    catch (error) { out.problems.push((error.publicError && error.publicError.code) || 'OBSERVE_FAILED'); return stop('OBSERVE_FAILED'); }
    out.pages = page;
    out.observationIds.push(snap.observation.observationId);
    if (snap.truncated) { out.problems.push('OBSERVATION_TRUNCATED'); }

    const parsed = parseTable(snap.nodes, input.tableName);
    if (parsed.problem) { out.problems.push(parsed.problem); return stop(parsed.problem); }
    const projected = project(parsed, input.columns, page, out.rows.length);
    for (const p of projected.problems) if (!out.problems.includes(p)) out.problems.push(p);
    const sig = signature(projected.rows);
    if (previous !== null && sig === previous) { out.problems.push('PAGINATION_NO_PROGRESS'); return stop('PAGINATION_NO_PROGRESS'); }
    const dupe = projected.rows.length && seen.has(sig);
    if (dupe) { out.problems.push('DUPLICATE_PAGE'); return stop('DUPLICATE_PAGE'); }
    seen.add(sig); previous = sig;

    const room = input.maxRows - out.rows.length;
    if (projected.rows.length > room) {
      out.rows.push(...projected.rows.slice(0, room));
      return stop('MAX_ROWS_REACHED');
    }
    out.rows.push(...projected.rows);
    if (snap.truncated) return stop('OBSERVATION_TRUNCATED');
    if (projected.problems.length) return stop(projected.problems[0]);

    if (input.singlePage) { out.complete = true; return finish(); }
    if (!input.nextPage) return stop('PAGINATION_NOT_CONFIGURED');

    const controls = snap.nodes.filter((n) => n.role === input.nextPage.role && norm(n.name) === norm(input.nextPage.name));
    if (controls.length === 0) return stop('NEXT_CONTROL_NOT_FOUND');
    if (controls.length > 1) return stop('AMBIGUOUS_NEXT_CONTROL');
    const control = controls[0];
    if (control.enabled === false) { out.complete = true; return finish(); } // positively observed end of data
    if (page === input.maxPages) return stop('MAX_PAGES_REACHED');

    let receipt;
    try {
      receipt = await facade.act({
        ...base, ...(opts.runId ? { runId: opts.runId } : {}),
        observationId: snap.observation.observationId, documentEpoch: snap.observation.documentEpoch,
        operationId: `${opts.operationPrefix || 'extract'}-p${page}`,
        action: { kind: 'click', ref: control.ref },
      }, { signal: opts.signal });
    } catch (error) {
      out.problems.push((error.publicError && error.publicError.code) || 'PAGINATION_FAILED');
      return stop('PAGINATION_FAILED');
    }
    if (!receipt || receipt.status === 'not_attempted') return stop('PAGINATION_FAILED');
    // An uncertain click is never repeated: stop and let a human reconcile.
    if (receipt.status === 'uncertain') return stop('PAGINATION_UNCERTAIN');
  }
  return stop('MAX_PAGES_REACHED');
}

module.exports = { manifest, inputSchema, run, parseTable, project, sourceFile: __filename };
