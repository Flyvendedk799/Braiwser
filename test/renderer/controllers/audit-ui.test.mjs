import test from 'node:test';
import assert from 'node:assert/strict';
import { reportContextFromSource, currentContextFromTab } from '../../../src/renderer/controllers/audit-ui.js';
import { isStale } from '../../../src/renderer/components/audit-panel.js';

test('report context carries tab, url and viewport, never documentId', () => {
  const ctx = reportContextFromSource({ tabId: 3, docGen: 9, url: 'http://a/x', title: 'X', viewport: { w: 1, h: 2 }, at: 't' });
  assert.deepEqual(ctx, { url: 'http://a/x', viewport: { w: 1, h: 2 }, tabId: 3, title: 'X', at: 't' });
  assert.equal(reportContextFromSource(null), null);
});

test('staleness follows tab and url, not hash', () => {
  const rep = reportContextFromSource({ tabId: 1, url: 'http://a/x#one' });
  assert.equal(isStale(rep, currentContextFromTab({ id: 1, url: 'http://a/x#two' })), false);
  assert.equal(isStale(rep, currentContextFromTab({ id: 1, url: 'http://a/y' })), true);
  assert.equal(isStale(rep, currentContextFromTab({ id: 2, url: 'http://a/x' })), true);
  assert.equal(currentContextFromTab(null), null);
});
