// The broker-facing parts of the skills: the resolver contract (resolved.inputs / argumentKeys, no mutation of the
// caller's object) and extract-table over structured table observations. Pure: no browser, no broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../../../src/main/services/automation/skill-registry.js');
const reviewResponsive = require('../../../src/main/services/automation/workflows/review-responsive.js');
const extractTable = require('../../../src/main/services/automation/workflows/extract-table.js');

const MCP = { id: 'mcp:x', kind: 'mcp', scopes: [] };
const etOpts = { sessionId: 'bs_1', pageId: 'pg_1', operationPrefix: 'et2' };

// ------------------------------------------------------------------ broker resolver contract (resolved.inputs)

test('createBrokerSkills.resolve never writes into the caller\'s inputs; the broker merges what it returns', () => {
  const rec = { name: 'j', startUrl: 'https://example.test/', steps: [
    { type: 'navigate', url: 'https://example.test/' },
    { type: 'input', selector: 'input[aria-label="Name"]', tag: 'input', value: 'Ada' },
    { type: 'assert', kind: 'url', op: 'contains', expected: 'example' }] };
  const skills = registry.createBrokerSkills({ loadRecording: () => rec });
  const inputs = { recordingId: 'rec_1' };
  const before = JSON.stringify(inputs);
  const r = skills.resolve({ skillId: 'verify-journey', skillVersion: '1.0.0', inputs, principal: MCP });
  assert.equal(JSON.stringify(inputs), before, 'the caller\'s object is untouched');
  assert.deepEqual(r.inputs, { recordingId: 'rec_1', input_1: 'Ada' }, 'derived values are returned for the broker to merge');
  assert.deepEqual(r.argumentKeys, ['recordingId']);
  assert.deepEqual(r.plan.inputKeys, ['recordingId', 'input_1']);
  // a frozen input object works too (it used to be silently skipped)
  assert.equal(skills.resolve({ skillId: 'verify-journey', skillVersion: '1.0.0', inputs: Object.freeze({ recordingId: 'rec_1' }), principal: MCP }).inputs.input_1, 'Ada');
  // structured skill arguments are reported as consumed keys, not as plan inputs
  const rr = skills.resolve({ skillId: 'review-responsive', skillVersion: '1.0.0', inputs: { url: 'https://example.test/', landmarks: [{ role: 'main', name: 'Content' }] }, principal: MCP });
  assert.deepEqual(rr.inputs, {}); assert.deepEqual(rr.plan.inputKeys, []);
  assert.deepEqual([...rr.argumentKeys].sort(), ['landmarks', 'url']);
  assert.equal(skills.resolve({ skillId: 'nope', skillVersion: '1.0.0', inputs: {}, principal: MCP }), null);
});

test('review-responsive bounds viewports to the broker\'s 240..4096 range', () => {
  const base = { url: 'https://example.test/', landmarks: [{ role: 'main', name: 'Content' }] };
  for (const [w, ok] of [[239, false], [240, true], [4096, true], [4097, false]]) {
    assert.equal(reviewResponsive.inputSchema.safeParse({ ...base, viewports: [{ name: 'v', width: w, height: 800 }] }).success, ok, `width ${w}`);
  }
  assert.equal(reviewResponsive.compile({ ...base, viewports: [{ name: 'tiny', width: 240, height: 240 }] }).plan.steps[0].type, 'setViewport');
});

// ------------------------------------------------------------------ extract-table (structured observations)

const tNode = (cells, over = {}) => ({ ref: 'tbl', role: 'table', name: 'Orders', table: { rowCount: cells.length, rowsExact: true, columnCount: 2, hasHeader: true, headers: ['Name', 'Qty'], cells,
  truncated: { rows: false, columns: false, cells: 0 }, merged: false, withheld: [], ...over } });
const link = (name, enabled = true) => ({ ref: `l_${name}`, role: 'link', name, enabled });

function pagedFacade(pages) {
  let i = 0, n = 0;
  const acts = [];
  return {
    acts,
    async observe() { n += 1; const p = pages[i]; return { observationId: `ob_${n}`, documentEpoch: i + 1, truncated: false, nextCursor: null, nodes: p.nodes, ...(p.pagination ? { pagination: p.pagination } : {}) }; },
    async act(a) { acts.push(a); i = Math.min(i + 1, pages.length - 1); return { status: 'verified' }; },
  };
}
const ocols = [{ name: 'name', header: 'Name' }, { name: 'qty', header: 'Qty', type: 'integer' }];

test('extract-table: structured tables give typed records whose values point at table, row and column', async () => {
  const facade = pagedFacade([
    { nodes: [tNode([['A', '1,200'], ['B', 'x']]), link('Next')], pagination: { next: { ref: 'l_Next', name: 'Next', enabled: true } } },
    { nodes: [tNode([['C', '3'], ['D', '']]), link('Next', false)], pagination: { next: { ref: 'l_Next', name: 'Next', enabled: false } } },
  ]);
  const r = await extractTable.run(facade, { columns: ocols }, etOpts);
  assert.equal(r.complete, true, JSON.stringify(r.problems));
  assert.deepEqual(r.rows.map((x) => x.record), [{ name: 'A', qty: 1200 }, { name: 'B', qty: null }, { name: 'C', qty: 3 }, { name: 'D', qty: null }]);
  assert.equal(r.rows[1].cells.qty.reason, 'TYPE_MISMATCH'); assert.equal(r.rows[1].cells.qty.raw, 'x');
  assert.equal(r.rows[3].cells.qty.reason, 'EMPTY_CELL');
  assert.deepEqual(r.rows[2].cells.name.source, { ref: 'tbl', row: 0, col: 0, page: 2, observationId: r.observationIds[1] });
  assert.deepEqual(r.rows.map((x) => x.index), [0, 1, 2, 3]);
  assert.deepEqual(r.missing, { count: 2, reasons: { TYPE_MISMATCH: 1, EMPTY_CELL: 1 } });
  assert.deepEqual(facade.acts.map((a) => a.action), [{ kind: 'click', ref: 'l_Next' }], 'the hint ref was clicked once');
});

test('extract-table: withheld cells, merged cells, missing headers and omitted rows are explicit, never guessed', async () => {
  const run = (node, input = {}) => extractTable.run(pagedFacade([{ nodes: [node] }]), { columns: ocols, singlePage: true, ...input }, etOpts);
  const withheld = await run(tNode([['A', null]], { withheld: [1] }));
  assert.equal(withheld.rows[0].cells.qty.reason, 'WITHHELD'); assert.equal(withheld.complete, true);
  assert.equal((await run(tNode([['A', '1']], { merged: true }))).incompleteReason, 'MERGED_CELLS');
  assert.equal((await run(tNode([['A', '1']], { hasHeader: false, headers: [] }))).incompleteReason, 'NO_HEADER');
  const omitted = await run(tNode([['A', '1']], { rowCount: 80, truncated: { rows: true, columns: false, cells: 0 } }));
  assert.equal(omitted.incompleteReason, 'PAGE_ROWS_TRUNCATED'); assert.equal(omitted.rows.length, 1, 'rows that were observed are kept');
  assert.equal((await run(tNode([['A', '1']], { rowsExact: false }))).incompleteReason, 'PAGE_ROWS_TRUNCATED');
  const cols = await run(tNode([['A', '1']], { truncated: { rows: false, columns: true, cells: 0 } }), { columns: [{ name: 'z', header: 'Zed' }] });
  assert.equal(cols.incompleteReason, 'COLUMNS_TRUNCATED');
  const clipped = await run(tNode([[`${'A'.repeat(79)}…`, '1']]));
  assert.equal(clipped.rows[0].cells.name.truncated, true);
  assert.equal((await run(tNode([['A']]))).incompleteReason, 'MISALIGNED_ROWS');
});

test('extract-table: hints are only used when no control is configured; ambiguity and absence stop with a reason', async () => {
  const page = (pagination) => ({ nodes: [tNode([['A', '1']])], ...(pagination ? { pagination } : {}) });
  const run = (p, input = {}) => extractTable.run(pagedFacade([p, page()]), { columns: ocols, ...input }, etOpts);
  assert.equal((await run(page({ next: { ref: 'x', name: 'Next', enabled: true }, ambiguous: ['next'] }))).incompleteReason, 'AMBIGUOUS_NEXT_CONTROL');
  assert.equal((await run(page({ prev: { ref: 'p', name: 'Previous', enabled: true } }))).incompleteReason, 'PAGINATION_NOT_CONFIGURED');
  assert.equal((await run(page())).incompleteReason, 'PAGINATION_NOT_CONFIGURED');
  assert.equal((await run(page({ next: { ref: 'x', name: 'Next', enabled: false } }))).complete, true);
  // an explicit control wins over a hint, and is looked up by role and name
  const facade = pagedFacade([{ nodes: [tNode([['A', '1']]), link('More')], pagination: { next: { ref: 'hint', name: 'Next', enabled: true } } }, page()]);
  const r = await extractTable.run(facade, { columns: ocols, nextPage: { role: 'link', name: 'More' } }, etOpts);
  assert.equal(facade.acts[0].action.ref, 'l_More'); assert.equal(r.incompleteReason, 'PAGINATION_NO_PROGRESS');
});

test('extract-table: an in-page update gets a short settle window before "no progress" is declared', async () => {
  let observed = 0;
  const facade = {
    async observe() {
      observed += 1;
      // the click does not navigate (same epoch); the new rows render a moment later
      return { observationId: `ob_${observed}`, documentEpoch: 1, truncated: false, nextCursor: null, nodes: [observed < 3 ? tNode([['A', '1']]) : tNode([['B', '2']]), link('Next', observed < 4)] };
    },
    async act() { return { status: 'verified' }; },
  };
  const r = await extractTable.run(facade, { columns: ocols, maxPages: 2, nextPage: { role: 'link', name: 'Next' } }, etOpts);
  assert.deepEqual(r.rows.map((x) => x.record.name), ['A', 'B'], 'the late render was picked up on a re-observation');
  assert.ok(observed >= 3);
});

test('typedValue is strict: no locale guessing, no coercion', () => {
  const t = extractTable.typedValue;
  assert.deepEqual(t('1,234.50', 'number'), { ok: true, value: 1234.5 });
  assert.deepEqual(t('-3', 'integer'), { ok: true, value: -3 });
  for (const [raw, type] of [['1.5', 'integer'], ['1.234,5', 'number'], ['12,34', 'number'], ['', 'number'], ['$5', 'number'], ['1e3', 'number'], ['NaN', 'number'], ['maybe', 'boolean'], ['2024-02-30', 'date'], ['2024-2-3', 'date'], ['01/02/2024', 'date']]) {
    assert.equal(t(raw, type).ok, false, `${raw} as ${type}`);
  }
  assert.deepEqual(t('Yes', 'boolean'), { ok: true, value: true }); assert.deepEqual(t('0', 'boolean'), { ok: true, value: false });
  assert.deepEqual(t('2024-02-29', 'date'), { ok: true, value: '2024-02-29' });
  assert.deepEqual(t('anything', undefined), { ok: true, value: 'anything' });
  assert.equal(extractTable.inputSchema.safeParse({ columns: [{ name: 'a', header: 'A', type: 'regex' }] }).success, false);
});
