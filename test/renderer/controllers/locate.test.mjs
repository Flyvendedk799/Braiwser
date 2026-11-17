import test from 'node:test';
import assert from 'node:assert/strict';
import { planLocate, createLocator, LOCATE_MESSAGES } from '../../../src/renderer/controllers/locate.js';
import { createOperationContexts } from '../../../src/renderer/controllers/operation-context.js';
import { FakeWv } from './fakes.mjs';

const A = 'http://localhost:3000/';
const B = 'http://localhost:3000/pricing';

// A two-tab shell: enough of app.js for the locator to drive.
function shell({ tabs, active, navOutcome = { outcome: 'ready' }, found = true, busy = null, auditCurrent = true } = {}) {
  const state = {
    tabs: (tabs || [{ id: 't1', url: A }]).map((t) => ({ docGen: 0, ...t, wv: new FakeWv(t.id) })),
    activeTabId: active || 't1',
  };
  const log = { toasts: [], navigated: [], highlighted: [], switched: [] };
  const getTab = (id) => state.tabs.find((t) => t.id === id) || null;
  const ops = createOperationContexts({ getTab, getActiveTabId: () => state.activeTabId, getSession: () => null, getSessionEpoch: () => 0 });
  const locator = createLocator({
    ops,
    getTabs: () => state.tabs.map((t) => ({ id: t.id, url: t.url })),
    setActiveTab: (id) => { log.switched.push(id); if (getTab(id)) state.activeTabId = id; },
    navigate: async (ctx, url) => {
      log.navigated.push([ctx.tabId, url]);
      const out = typeof navOutcome === 'function' ? navOutcome(ctx, url, state) : navOutcome;
      if (out.outcome === 'ready') getTab(ctx.tabId).url = url;
      return out;
    },
    highlight: async (wv, target) => { log.highlighted.push([wv.name, target]); return typeof found === 'function' ? found(wv) : found; },
    busyReason: (tabId) => (busy && busy[tabId]) || null,
    auditIsCurrent: () => auditCurrent,
    toast: (text, tone) => log.toasts.push([text, tone]),
    sleep: async () => {},
  });
  return { state, log, locator, getTab };
}

const note = (url, target = { selector: '#cta' }) => ({ id: 'n1', url, target });

test('planLocate: here / switch / navigate / blocked', () => {
  const tabs = [{ id: 't1', url: A }, { id: 't2', url: B }];
  assert.deepEqual(planLocate({ noteUrl: A, activeTabId: 't1', tabs }), { action: 'here' });
  assert.deepEqual(planLocate({ noteUrl: '', activeTabId: 't1', tabs }), { action: 'here' }, 'a note with no page is located where the user is');
  assert.deepEqual(planLocate({ noteUrl: B, activeTabId: 't1', tabs }), { action: 'switch', tabId: 't2' });
  assert.deepEqual(planLocate({ noteUrl: 'http://x.test/', activeTabId: 't1', tabs }), { action: 'navigate' });
  // A busy front tab is never navigated away, but switching to another tab stays possible.
  const busyReason = (id) => (id === 't1' ? 'replaying' : null);
  assert.deepEqual(planLocate({ noteUrl: 'http://x.test/', activeTabId: 't1', tabs, busyReason }), { action: 'blocked', reason: 'replaying' });
  assert.deepEqual(planLocate({ noteUrl: B, activeTabId: 't1', tabs, busyReason }), { action: 'switch', tabId: 't2' });
  assert.deepEqual(planLocate({ noteUrl: A, activeTabId: 't1', tabs, busyReason }), { action: 'here' });
  // The front tab itself is preferred over a duplicate of the same page.
  assert.deepEqual(planLocate({ noteUrl: A, activeTabId: 't2', tabs: [{ id: 't1', url: A }, { id: 't2', url: A }] }), { action: 'here' });
});

test('same page: highlights in place, no navigation, no toast', async () => {
  const s = shell();
  assert.equal(await s.locator.locateAnnotation(note(A)), 'located');
  assert.deepEqual(s.log.navigated, []);
  assert.deepEqual(s.log.switched, []);
  assert.deepEqual(s.log.highlighted, [['t1', { selector: '#cta' }]]);
  assert.deepEqual(s.log.toasts, []);
});

test('same page, element gone: says so', async () => {
  const s = shell({ found: false });
  assert.equal(await s.locator.locateAnnotation(note(A)), 'not-found');
  assert.deepEqual(s.log.toasts, [[LOCATE_MESSAGES.notFound, 'warn']]);
});

test('note on a page open in another tab: switches to that tab, leaves this one alone', async () => {
  const s = shell({ tabs: [{ id: 't1', url: A }, { id: 't2', url: B }] });
  assert.equal(await s.locator.locateAnnotation(note(B)), 'located');
  assert.deepEqual(s.log.switched, ['t2']);
  assert.deepEqual(s.log.navigated, [], 'the front tab keeps its page');
  assert.equal(s.getTab('t1').url, A);
  assert.equal(s.state.activeTabId, 't2');
  assert.deepEqual(s.log.highlighted, [['t2', { selector: '#cta' }]], 'the highlight goes to the tab that shows the page');
  assert.deepEqual(s.log.toasts, []);
});

test('note on a page that is not open: navigates the front tab, then highlights', async () => {
  const s = shell();
  assert.equal(await s.locator.locateAnnotation(note(B)), 'located');
  assert.deepEqual(s.log.navigated, [['t1', B]]);
  assert.deepEqual(s.log.highlighted, [['t1', { selector: '#cta' }]]);
  assert.deepEqual(s.log.toasts, []);
});

test('opened the page but the element is not there: a distinct message', async () => {
  const s = shell({ found: false });
  assert.equal(await s.locator.locateAnnotation(note(B)), 'not-found');
  assert.deepEqual(s.log.toasts, [[LOCATE_MESSAGES.notFoundAfterOpen, 'warn']]);
  const viaSwitch = shell({ tabs: [{ id: 't1', url: A }, { id: 't2', url: B }], found: false });
  await viaSwitch.locator.locateAnnotation(note(B));
  assert.deepEqual(viaSwitch.log.toasts, [[LOCATE_MESSAGES.notFoundAfterOpen, 'warn']]);
});

test('the page will not load: a toast with the reason, and no highlight is attempted', async () => {
  const failed = shell({ navOutcome: { outcome: 'failed', error: 'ERR_CONNECTION_REFUSED (-102)' } });
  assert.equal(await failed.locator.locateAnnotation(note(B)), 'open-failed');
  assert.deepEqual(failed.log.toasts, [[`${LOCATE_MESSAGES.noOpen} — ERR_CONNECTION_REFUSED (-102)`, 'warn']]);
  assert.deepEqual(failed.log.highlighted, []);

  const slow = shell({ navOutcome: { outcome: 'timeout' } });
  assert.equal(await slow.locator.locateAnnotation(note(B)), 'open-failed');
  assert.match(slow.log.toasts[0][0], /took too long to load/);

  const cancelled = shell({ navOutcome: { outcome: 'cancelled' } });
  assert.equal(await cancelled.locator.locateAnnotation(note(B)), 'open-failed');
  assert.deepEqual(cancelled.log.toasts, [[LOCATE_MESSAGES.noOpen, 'warn']]);
});

test('front tab is mid-replay: refuses to navigate it and says why', async () => {
  const s = shell({ busy: { t1: 'That note is on another page — finish or cancel the replay to open it' } });
  assert.equal(await s.locator.locateAnnotation(note(B)), 'blocked');
  assert.deepEqual(s.log.navigated, []);
  assert.deepEqual(s.log.highlighted, []);
  assert.deepEqual(s.log.toasts, [['That note is on another page — finish or cancel the replay to open it', 'warn']]);
  // Same-page notes still locate during a replay.
  assert.equal(await s.locator.locateAnnotation(note(A)), 'located');
});

test('the tab closes while its page is loading: nothing is highlighted', async () => {
  const s = shell({ navOutcome: (ctx, _url, state) => { state.tabs = state.tabs.filter((t) => t.id !== ctx.tabId); return { outcome: 'failed', error: 'gone' }; } });
  assert.equal(await s.locator.locateAnnotation(note(B)), 'open-failed');
  const s2 = shell();
  // Loaded fine, but the tab was closed during the settle delay.
  const loc = createLocator({
    ops: createOperationContexts({ getTab: (id) => s2.state.tabs.find((t) => t.id === id) || null, getActiveTabId: () => s2.state.activeTabId, getSession: () => null }),
    getTabs: () => s2.state.tabs.map((t) => ({ id: t.id, url: t.url })),
    setActiveTab: () => {},
    navigate: async () => ({ outcome: 'ready' }),
    highlight: async () => { throw new Error('must not highlight a closed tab'); },
    toast: (t) => s2.log.toasts.push(t),
    sleep: async () => { s2.state.tabs = []; },
  });
  assert.equal(await loc.locateAnnotation(note(B)), 'stale');
  assert.deepEqual(s2.log.toasts, []);
});

test('a switch that does not take effect is reported, not ignored', async () => {
  const s = shell({ tabs: [{ id: 't1', url: A }, { id: 't2', url: B }] });
  const loc = createLocator({
    ops: createOperationContexts({ getTab: s.getTab, getActiveTabId: () => s.state.activeTabId, getSession: () => null }),
    getTabs: () => s.state.tabs.map((t) => ({ id: t.id, url: t.url })),
    setActiveTab: () => {}, // refuses
    navigate: async () => ({ outcome: 'ready' }),
    highlight: async () => true,
    toast: (text, tone) => s.log.toasts.push([text, tone]),
  });
  assert.equal(await loc.locateAnnotation(note(B)), 'switch-failed');
  assert.deepEqual(s.log.toasts, [[LOCATE_MESSAGES.noSwitch, 'warn']]);
});

test('notes without a target and a shell without a tab do nothing', async () => {
  const s = shell();
  assert.equal(await s.locator.locateAnnotation(null), 'no-target');
  assert.equal(await s.locator.locateAnnotation({ url: B }), 'no-target');
  s.state.activeTabId = 'nope';
  assert.equal(await s.locator.locateAnnotation(note(B)), 'no-tab');
  assert.deepEqual(s.log.navigated, []);
  assert.deepEqual(s.log.toasts, []);
});

test('audit findings: only located on the page they were found on, never navigated', async () => {
  const ok = shell();
  assert.equal(await ok.locator.locateTarget({ selector: 'img' }, { audit: true }), 'located');
  assert.deepEqual(ok.log.highlighted, [['t1', { selector: 'img' }]]);

  const stale = shell({ auditCurrent: false });
  assert.equal(await stale.locator.locateTarget({ selector: 'img' }, { audit: true }), 'stale');
  assert.deepEqual(stale.log.toasts, [[LOCATE_MESSAGES.staleAudit, 'warn']]);
  assert.deepEqual(stale.log.highlighted, []);
  // Not an audit finding: the audit check does not apply.
  assert.equal(await stale.locator.locateTarget({ selector: 'img' }), 'located');

  const none = shell();
  assert.equal(await none.locator.locateTarget(null, { audit: true }), 'no-target');
  assert.deepEqual(none.log.toasts, [[LOCATE_MESSAGES.noFindingTarget, 'warn']]);

  const gone = shell({ found: false });
  assert.equal(await gone.locator.locateTarget({ selector: 'img' }, { audit: true }), 'not-found');
  assert.deepEqual(gone.log.toasts, [[LOCATE_MESSAGES.notFound, 'warn']]);
  assert.deepEqual(gone.log.navigated, []);
});
