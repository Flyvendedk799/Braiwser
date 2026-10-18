// RF-06 (panel side): an audit report knows which page it came from; once the
// user is on a different page the findings are marked stale and cannot be
// promoted onto the wrong URL (or are promoted with the REPORT's identity).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click } from './dom-env.mjs';

const { document } = setupDom();
const { createAuditPanel, isStale, reportContext } = await load('components/audit-panel.js');

const finding = (over = {}) => ({ id: 'f1', ruleId: 'image-alt', severity: 'serious', title: 'Image missing alt', selector: '#a-only', target: { selector: '#a-only' }, ...over });
const report = (over = {}) => ({
  total: 1, scanned: 40, counts: { serious: 1 }, findings: [finding()],
  context: { url: 'https://a.test/page#top', viewport: { w: 1280, h: 800, label: 'Desktop' }, tabId: 't1' },
  ...over,
});

function mount(over = {}) {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const panel = createAuditPanel({}, {
    run: rec('run'), locate: rec('locate'), copySelector: rec('copySelector'), addOne: rec('addOne'), addAll: rec('addAll'),
    onCount: () => {}, ...over,
  });
  document.body.appendChild(panel.root);
  return { panel, calls };
}
const btn = (panel, label) => Array.from(panel.root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label);

test('helpers: stale only when both sides are known and differ', () => {
  assert.equal(isStale(null, { url: 'https://b.test' }), false);
  assert.equal(isStale({ url: 'https://a.test' }, null), false);
  assert.equal(isStale({ url: 'https://a.test/x#1' }, { url: 'https://a.test/x#2' }), false, 'fragment is the same page');
  assert.equal(isStale({ url: 'https://a.test/x' }, { url: 'https://b.test/x' }), true);
  assert.equal(isStale({ url: 'https://a.test/x', tabId: 1 }, { url: 'https://a.test/x', tabId: 2 }), true);
  assert.equal(isStale({ url: 'https://a.test/x', documentId: 'd1' }, { url: 'https://a.test/x', documentId: 'd2' }), true);
  assert.deepEqual(reportContext({ url: 'https://x.test', viewport: { w: 1, h: 2 } }), { url: 'https://x.test', viewport: { w: 1, h: 2 } });
  assert.equal(reportContext({ findings: [] }), null);
});

test('shows where the report was taken: url + viewport', () => {
  const { panel } = mount();
  panel.setReport(report());
  const src = panel.root.querySelector('.audit-source').textContent;
  assert.match(src, /a\.test\/page/);
  assert.match(src, /Desktop 1280×800/);
  assert.equal(panel.root.querySelector('.audit-stale').hasAttribute('hidden'), true);
});

test('context can be supplied by the app alongside the report', () => {
  const { panel } = mount();
  panel.setReport({ total: 0, findings: [], counts: {} }, { url: 'https://c.test/', viewport: { w: 390, h: 844, label: 'iPhone' } });
  assert.match(panel.root.querySelector('.audit-source').textContent, /c\.test.*iPhone 390×844/);
});

test('regression: audit A, navigate to B => stale marker, promote + locate blocked', () => {
  const { panel, calls } = mount();
  panel.setReport(report());
  panel.setCurrentContext({ url: 'https://b.invalid/', tabId: 't1' });
  assert.equal(panel.isStale(), true);
  assert.equal(panel.root.querySelector('.audit-stale').hasAttribute('hidden'), false);
  assert.match(panel.root.querySelector('.audit-stale').textContent, /Out of date/);
  assert.ok(panel.root.querySelector('.finding .finding-stale'));
  for (const label of ['Capture as a note', 'Locate on page']) {
    const b = btn(panel, label);
    assert.equal(b.disabled, true, label + ' disabled');
    click(b);
  }
  assert.equal(btn(panel, 'Add all as notes').disabled, true);
  click(btn(panel, 'Add all as notes'));
  assert.deepEqual(calls, [], 'no handler fired for the old page');
});

test('returning to the audited page clears the stale state', () => {
  const { panel, calls } = mount();
  panel.setReport(report());
  panel.setCurrentContext({ url: 'https://b.invalid/' });
  panel.setCurrentContext({ url: 'https://a.test/page#other' });
  assert.equal(panel.isStale(), false);
  const add = btn(panel, 'Capture as a note');
  assert.equal(add.disabled, false);
  click(add);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'addOne');
});

test('fresh report: handlers receive the REPORT context', () => {
  const { panel, calls } = mount();
  panel.setReport(report());
  panel.setCurrentContext({ url: 'https://a.test/page', tabId: 't1' });
  click(btn(panel, 'Capture as a note'));
  click(btn(panel, 'Locate on page'));
  click(btn(panel, 'Add all as notes'));
  const ctx = calls[0][2];
  assert.equal(ctx.url, 'https://a.test/page#top');
  assert.deepEqual(ctx.viewport, { w: 1280, h: 800, label: 'Desktop' });
  assert.deepEqual(calls[0][3], { stale: false });
  assert.deepEqual(calls.map((c) => c[0]), ['addOne', 'locate', 'addAll']);
  assert.equal(calls[2][2].url, ctx.url);
});

test('allowStalePromotion: stays enabled but is bound to the audited page', () => {
  const { panel, calls } = mount({ allowStalePromotion: true });
  panel.setReport(report());
  panel.setCurrentContext({ url: 'https://b.invalid/' });
  const add = btn(panel, 'Capture as a note');
  assert.equal(add.disabled, false);
  click(add);
  assert.equal(calls[0][2].url, 'https://a.test/page#top', 'saved with A identity');
  assert.deepEqual(calls[0][3], { stale: true });
  assert.match(panel.root.querySelector('.audit-stale').textContent, /saved against the audited page/);
});

test('actions.currentContext() is polled on render (no explicit setCurrentContext needed)', () => {
  let cur = { url: 'https://a.test/page' };
  const { panel } = mount({ currentContext: () => cur });
  panel.setReport(report());
  assert.equal(panel.isStale(), false);
  cur = { url: 'https://z.test/' };
  panel.markPromoted([]); // any re-render
  assert.equal(panel.isStale(), true);
  assert.ok(panel.root.querySelector('.audit-stale') && !panel.root.querySelector('.audit-stale').hasAttribute('hidden'));
});

test('a failed audit is an error with retry, never "no issues"', () => {
  const { panel, calls } = mount();
  panel.setReport({ total: 0, counts: {}, findings: [], error: 'Audit timed out' });
  assert.match(panel.root.textContent, /Audit timed out/);
  assert.doesNotMatch(panel.root.textContent, /No issues found|Nothing to flag/);
  click(panel.root.querySelector('.audit-retry'));
  assert.deepEqual(calls, [['run']]);
});

test('existing callers still work: setReport(report) without context, no currentContext', () => {
  const { panel, calls } = mount();
  panel.setReport({ total: 1, counts: { minor: 1 }, scanned: 3, findings: [finding({ severity: 'minor' })] });
  assert.equal(panel.isStale(), false);
  click(btn(panel, 'Capture as a note'));
  assert.equal(calls[0][0], 'addOne');
  assert.equal(calls[0][1].id, 'f1');
});
