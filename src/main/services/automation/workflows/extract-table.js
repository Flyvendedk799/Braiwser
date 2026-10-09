'use strict';
// extract-table 1.0.0 — bounded, paginated table extraction with source refs and
// explicit missing values. ORCHESTRATED over broker.observe / broker.act (a
// closed plan cannot loop). Contract:
//   * never silently "complete": `complete` is true only when every page parsed
//     without structural problems AND the end of pagination was positively
//     observed (the next control is present and disabled, or the caller declared
//     `singlePage`). Any other stop sets `incompleteReason`.
//   * records are typed per requested column (string | number | integer |
//     boolean | date). A value that does not parse as its type is NOT coerced: it
//     becomes a missing-value marker (TYPE_MISMATCH) that keeps the bounded raw text.
//   * a cell that cannot be attributed to a column (misaligned row, unknown
//     column, merged cells, withheld secret, empty cell) is a missing-value
//     marker, never a guess. Every value carries source = { ref, row, col, page,
//     observationId }: the table node it was read from and its position in it.
//   * bounded: maxRows, maxPages, cursor hops per page, string lengths. A page
//     whose rows exceed what one observation carries (50 rows x 12 columns) is
//     reported PAGE_ROWS_TRUNCATED instead of being passed off as the whole page.
//   * no arbitrary evaluation, no selectors: it only reads the observation
//     nodes the broker returned. Values are untrusted page text.
//   * two observation shapes are understood: the bounded `table` payload of
//     table/grid nodes (what the drivers emit), and the older flat
//     table/row/columnheader/cell nodes.
const { z } = require('zod');
const { RegistryError } = require('./_shared');
const wf = require('../workflow-core');

const manifest = Object.freeze({
  id: 'extract-table',
  version: '1.0.0',
  schemaVersion: wf.SCHEMA_VERSION,
  title: 'Extract a table',
  description: 'Read selected columns from an accessible table across pages as typed records with source refs and explicit missing-value markers. Reports incomplete rather than guessing when pagination fails.',
  executor: 'orchestrator',
  requires: ['observe', 'interact'],
  maxDurationMs: 300000,
});

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const COLUMN_TYPES = ['string', 'number', 'integer', 'boolean', 'date'];
const inputSchema = z.strictObject({
  columns: z.array(z.strictObject({ name: key, header: z.string().min(1).max(200), type: z.enum(COLUMN_TYPES).optional() })).min(1).max(20),
  tableName: z.string().min(1).max(200).optional(),
  maxRows: z.number().int().min(1).max(500).default(200),
  maxPages: z.number().int().min(1).max(20).default(5),
  // Omitted: the observation's pagination hint (a single link/button named Next / Next page / Older / ...) is used if there is exactly one.
  nextPage: z.strictObject({ role: z.enum(['button', 'link']), name: z.string().min(1).max(200) }).optional(),
  singlePage: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const names = v.columns.map((c) => c.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Duplicate column name' });
  if (v.singlePage && v.nextPage) ctx.addIssue({ code: 'custom', path: ['singlePage'], message: 'singlePage conflicts with nextPage' });
});

const TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'rowheader']);
const CELL_CHARS = 500;
const SETTLE_ATTEMPTS = 2;
const SETTLE_MS = 200;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pure: raw cell text + declared type -> { ok, value }. Strict on purpose: no locale guessing.
function typedValue(raw, type) {
  switch (type || 'string') {
    case 'number': case 'integer': {
      const integer = type === 'integer';
      const ok = integer ? /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(raw) : /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(raw);
      const n = ok ? Number(raw.replace(/,/g, '')) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean': {
      if (/^(?:true|yes|y|1)$/i.test(raw)) return { ok: true, value: true };
      if (/^(?:false|no|n|0)$/i.test(raw)) return { ok: true, value: false };
      return { ok: false };
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) return { ok: false };
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? { ok: true, value: raw } : { ok: false };
    }
    default: return { ok: true, value: raw };
  }
}

// Pure: nodes (document order) -> { problem?, headers[], rows[], structured? }.
// headers: [{ name, ref, col? }]; rows: [{ cells: [{ name|null, ref, row?, col? }] }].
function parseTable(nodes, tableName) {
  const containers = nodes.map((n, i) => ({ n, i })).filter(({ n }) => TABLE_ROLES.has(n.role));
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
  if (chosen.n.table && typeof chosen.n.table === 'object') return parseStructured(chosen.n);
  return parseFlat(nodes, containers, chosen);
}

function parseStructured(node) {
  const t = node.table;
  const headers = (Array.isArray(t.headers) ? t.headers : []).map((h, col) => ({ name: norm(h), ref: node.ref, col }));
  const cells = Array.isArray(t.cells) ? t.cells : [];
  const structured = {
    rowCount: Number.isInteger(t.rowCount) ? t.rowCount : cells.length,
    rowsExact: t.rowsExact !== false,
    omitted: Math.max(0, (Number.isInteger(t.rowCount) ? t.rowCount : cells.length) - cells.length),
    truncatedRows: !!(t.truncated && t.truncated.rows),
    truncatedColumns: !!(t.truncated && t.truncated.columns),
    withheld: new Set(Array.isArray(t.withheld) ? t.withheld : []),
  };
  if (!t.hasHeader || !headers.length) return { problem: 'NO_HEADER', headers, rows: [], structured };
  // With merged cells a cell's position is not its column: refuse to attribute values.
  if (t.merged) return { problem: 'MERGED_CELLS', headers, rows: [], structured };
  const rows = cells.map((row, r) => ({ cells: (Array.isArray(row) ? row : []).map((v, c) => ({ name: v === null ? null : norm(v), ref: node.ref, row: r, col: c })) }));
  return { problem: null, headers, rows, structured };
}

function parseFlat(nodes, containers, chosen) {
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
function project(parsed, columns, pageNumber, startIndex, observationId) {
  const problems = new Set();
  const st = parsed.structured || null;
  const positions = columns.map((c) => {
    const hits = parsed.headers.map((h, i) => ({ h, i })).filter(({ h }) => h.name === norm(c.header));
    if (hits.length !== 1) {
      const why = hits.length ? 'AMBIGUOUS_COLUMN' : (st && st.truncatedColumns ? 'COLUMNS_TRUNCATED' : 'COLUMN_NOT_FOUND');
      problems.add(why);
      return { column: c, index: -1, why };
    }
    return { column: c, index: hits[0].i, why: null };
  });
  const rows = parsed.rows.map((row, r) => {
    const aligned = row.cells.length === parsed.headers.length;
    if (!aligned) problems.add('MISALIGNED_ROWS');
    const cells = {};
    const record = {};
    const missing = [];
    for (const p of positions) {
      const name = p.column.name;
      let out;
      if (p.index < 0) out = { value: null, missing: true, reason: p.why, source: null };
      else if (!aligned) out = { value: null, missing: true, reason: 'MISALIGNED_ROW', source: null };
      else {
        const cell = row.cells[p.index];
        const source = { ref: cell.ref, ...(cell.row !== undefined ? { row: cell.row, col: cell.col } : {}), page: pageNumber, observationId };
        if (cell.name === null || (st && st.withheld.has(p.index))) out = { value: null, missing: true, reason: 'WITHHELD', source };
        else if (cell.name === '') out = { value: null, missing: true, reason: 'EMPTY_CELL', source };
        else {
          const raw = cut(cell.name, CELL_CHARS);
          const typed = typedValue(raw, p.column.type);
          out = typed.ok
            ? { value: typed.value, missing: false, source, ...(/…$/.test(raw) ? { truncated: true } : {}) }
            : { value: null, missing: true, reason: 'TYPE_MISMATCH', raw: cut(raw, 80), source };
        }
      }
      cells[name] = out;
      record[name] = out.value;
      if (out.missing) missing.push(name);
    }
    return { page: pageNumber, index: startIndex + r, record, cells, missing };
  });
  return { rows, problems: [...problems] };
}

const signature = (rows) => rows.map((r) => Object.values(r.cells).map((c) => (c.missing ? `?${c.reason}` : c.value)).join('␟')).join('␞');

async function observeWholePage(facade, base, signal, maxHops = 10) {
  const nodes = [];
  let cursor, hops = 0, last = null, truncated = false, pagination = null;
  for (;;) {
    const obs = await facade.observe({ ...base, maxNodes: 200, ...(cursor ? { cursor } : {}) }, { signal });
    last = obs;
    nodes.push(...(obs.nodes || []).map((n) => ({ ...n, ref: n.ref || n.refId })));
    if (obs.pagination && typeof obs.pagination === 'object') pagination = obs.pagination;
    if (obs.nextCursor) {
      if (++hops > maxHops) { truncated = true; break; }
      cursor = obs.nextCursor;
      continue;
    }
    truncated = obs.truncated === true;
    break;
  }
  return { observation: last, nodes, truncated, pagination };
}

// The configured next control, or the observation's own hint when none is configured.
function findNext(snap, configured) {
  if (configured) {
    const controls = snap.nodes.filter((n) => n.role === configured.role && norm(n.name) === norm(configured.name));
    if (controls.length === 0) return { problem: 'NEXT_CONTROL_NOT_FOUND' };
    if (controls.length > 1) return { problem: 'AMBIGUOUS_NEXT_CONTROL' };
    return { control: controls[0] };
  }
  const hint = snap.pagination;
  if (!hint) return { problem: 'PAGINATION_NOT_CONFIGURED' };
  if (Array.isArray(hint.ambiguous) && hint.ambiguous.includes('next')) return { problem: 'AMBIGUOUS_NEXT_CONTROL' };
  if (!hint.next || !hint.next.ref) return { problem: 'PAGINATION_NOT_CONFIGURED' };
  return { control: { ref: hint.next.ref, name: hint.next.name, enabled: hint.next.enabled } };
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
  let previousEpoch = null;

  for (let page = 1; page <= input.maxPages; page += 1) {
    if (opts.signal && opts.signal.aborted) return stop('CANCELLED');
    let snap;
    let parsed;
    let projected;
    let sig;
    // After a click that did not navigate (an in-page update), give the page a moment to render before calling it "no progress".
    for (let settle = 0; ; settle += 1) {
      try { snap = await observeWholePage(facade, base, opts.signal); }
      catch (error) { out.problems.push((error.publicError && error.publicError.code) || 'OBSERVE_FAILED'); return stop('OBSERVE_FAILED'); }
      parsed = parseTable(snap.nodes, input.tableName);
      if (parsed.problem) break;
      projected = project(parsed, input.columns, page, out.rows.length, snap.observation.observationId);
      sig = signature(projected.rows);
      const samePage = previous !== null && sig === previous;
      const sameDocument = previousEpoch !== null && snap.observation.documentEpoch === previousEpoch;
      if (samePage && sameDocument && settle < SETTLE_ATTEMPTS) { await sleep(SETTLE_MS); continue; }
      break;
    }
    out.pages = page;
    out.observationIds.push(snap.observation.observationId);
    if (snap.truncated) { out.problems.push('OBSERVATION_TRUNCATED'); }

    if (parsed.problem) { out.problems.push(parsed.problem); return stop(parsed.problem); }
    for (const p of projected.problems) if (!out.problems.includes(p)) out.problems.push(p);
    if (previous !== null && sig === previous) { out.problems.push('PAGINATION_NO_PROGRESS'); return stop('PAGINATION_NO_PROGRESS'); }
    const dupe = projected.rows.length && seen.has(sig);
    if (dupe) { out.problems.push('DUPLICATE_PAGE'); return stop('DUPLICATE_PAGE'); }
    seen.add(sig); previous = sig; previousEpoch = snap.observation.documentEpoch;

    const room = input.maxRows - out.rows.length;
    if (projected.rows.length > room) {
      out.rows.push(...projected.rows.slice(0, room));
      return stop('MAX_ROWS_REACHED');
    }
    out.rows.push(...projected.rows);
    if (projected.problems.length) return stop(projected.problems[0]);
    if (parsed.structured && (parsed.structured.omitted > 0 || parsed.structured.truncatedRows || !parsed.structured.rowsExact)) {
      out.problems.push('PAGE_ROWS_TRUNCATED');
      return stop('PAGE_ROWS_TRUNCATED');
    }
    if (snap.truncated) return stop('OBSERVATION_TRUNCATED');

    if (input.singlePage) { out.complete = true; return finish(); }
    const next = findNext(snap, input.nextPage);
    if (next.problem) return stop(next.problem);
    const control = next.control;
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

module.exports = { manifest, inputSchema, run, parseTable, project, typedValue, sourceFile: __filename };
