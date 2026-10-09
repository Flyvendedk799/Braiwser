// ai-panel: an unrecognised settings.aiProvider is displayed as TEXT, never markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, press, tick } from './dom-env.mjs';

const { document } = setupDom();
const { createAiPanel } = await load('components/ai-panel.js');

function mount(over = {}) {
  const calls = { settings: 0 };
  const panel = createAiPanel({ aiTasks: { 'clean-up': 'Tidy the notes' } }, {
    currentSessionId: () => 's1',
    openSettings: () => { calls.settings++; },
    run: async () => ({ ok: true, text: 'hello **world**', local: true }),
    save() {},
    ...over,
  });
  document.body.appendChild(panel.root);
  return { panel, calls };
}

test('regression: a hostile aiProvider string does not become DOM', () => {
  const { panel } = mount();
  const evil = '<img src=x onerror="window.__pwned=1"><b id="injected">x</b>';
  panel.setProfile({ aiProvider: evil }, {});
  const btn = panel.root.querySelector('.provider-status');
  assert.equal(btn.querySelector('img'), null);
  assert.equal(btn.querySelector('#injected'), null);
  assert.ok(btn.textContent.includes(evil), 'shown verbatim as text');
  assert.ok(btn.title.includes(evil));
  assert.equal(globalThis.window.__pwned, undefined);
});

test('known providers still render their friendly label + state', () => {
  const { panel } = mount();
  panel.setProfile({ aiProvider: 'claude-code' }, { 'claude-code': { ready: true } });
  const btn = panel.root.querySelector('.provider-status');
  assert.match(btn.textContent, /Claude subscription/);
  assert.match(btn.textContent, /Signed in/);
  assert.ok(btn.classList.contains('ready'));
  assert.ok(btn.querySelector('svg'));
  panel.setProfile({ aiProvider: 'openai' }, {});
  assert.match(btn.textContent, /OpenAI API key.*No key/);
  assert.ok(btn.classList.contains('needs-setup'));
});

test('the local-fallback notice also shows the provider as text', async () => {
  const { panel } = mount();
  panel.setProfile({ aiProvider: '<u id="x">p</u>' }, {});
  panel.root.querySelector('.btn-primary').click();
  await tick(10);
  const notice = panel.root.querySelector('.ai-local-notice');
  assert.ok(notice);
  assert.equal(notice.querySelector('#x'), null);
  assert.match(notice.textContent, /<u id="x">p<\/u> is not connected/);
});

test('"Open Profile" links are keyboard operable', async () => {
  const { panel, calls } = mount();
  panel.setProfile({ aiProvider: 'claude-code' }, {});
  panel.root.querySelector('.btn-primary').click();
  await tick(10);
  const link = panel.root.querySelector('.ai-local-notice a');
  assert.equal(link.tabIndex, 0);
  assert.equal(link.getAttribute('role'), 'button');
  press(link, 'Enter');
  assert.equal(calls.settings, 1);
});

test('an AI error message is escaped', async () => {
  const { panel } = mount({ run: async () => ({ ok: false, error: '<script>alert(1)</script> bad `code`' }) });
  panel.root.querySelector('.btn-primary').click();
  await tick(10);
  const box = panel.root.querySelector('.ai-error');
  assert.equal(box.querySelector('script'), null);
  assert.ok(box.querySelector('code'));
  assert.match(box.textContent, /<script>alert\(1\)<\/script>/);
});

// ---- cancel / local labelling ------------------------------------------------------
function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const runButton = (panel) => panel.root.querySelector('.ai-row button');

test('Run becomes Cancel while in flight, sends a requestId, and cancel settles at once', async () => {
  const d = deferred();
  const seen = { payload: null, cancelled: [] };
  const { panel } = mount({
    run: (task, sid, extra) => { seen.payload = extra; return d.promise; },
    cancel: async (id) => { seen.cancelled.push(id); },
  });
  const btn = runButton(panel);
  assert.equal(btn.textContent, 'Run');
  btn.click();
  await tick(5);
  assert.equal(btn.textContent, 'Cancel');
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.match(seen.payload.requestId, /^ai-/);
  btn.click();
  assert.equal(btn.textContent, 'Run', 'settled immediately');
  assert.deepEqual(seen.cancelled, [seen.payload.requestId]);
  assert.match(panel.root.querySelector('.ai-cancelled').textContent, /Cancelled/);
  // a late reply for the cancelled call is ignored
  d.resolve({ ok: true, text: 'late answer' });
  await tick(5);
  assert.equal(panel.root.querySelector('.ai-result'), null);
  assert.equal(btn.textContent, 'Run');
});

test('cancel works even when the app wires no cancel action; a new run gets a new requestId', async () => {
  const ids = [];
  const { panel } = mount({ run: (t, s, extra) => { ids.push(extra.requestId); return new Promise(() => {}); } });
  const btn = runButton(panel);
  btn.click();
  await tick(5);
  btn.click();
  assert.equal(btn.textContent, 'Run');
  btn.click();
  await tick(5);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('always settles: a rejected call re-enables Run and shows the error', async () => {
  const { panel } = mount({ run: async () => { throw new Error('socket hang up'); } });
  const btn = runButton(panel);
  btn.click();
  await tick(5);
  assert.equal(btn.textContent, 'Run');
  assert.equal(btn.disabled, false);
  assert.match(panel.root.querySelector('.ai-error').textContent, /socket hang up/);
});

test('no-credential local output is labelled "Generated locally"', async () => {
  const { panel } = mount({ run: async () => ({ ok: true, local: true, reason: 'no-credential', text: 'draft' }) });
  runButton(panel).click();
  await tick(5);
  const notice = panel.root.querySelector('.ai-local-notice');
  assert.equal(notice.querySelector('.ai-local-badge').textContent, 'Generated locally');
  assert.match(notice.textContent, /no credential is set, so no AI provider was contacted/);
  assert.match(panel.root.querySelector('.ai-result').textContent, /draft/);
});

test('an expired/invalid credential shows the error and the Profile link, not a result', async () => {
  const { panel } = mount({ run: async () => ({ ok: false, error: 'The sign-in has expired — sign in again.' }) });
  runButton(panel).click();
  await tick(5);
  assert.match(panel.root.querySelector('.ai-error').textContent, /expired/);
  assert.ok(panel.root.querySelector('.ai-error a'));
  assert.equal(panel.root.querySelector('.ai-result'), null);
});

test('runExternal replaces a call still running', async () => {
  const calls = [];
  const { panel } = mount({ run: (t, s, extra) => { calls.push(extra); return new Promise(() => {}); }, cancel: async () => {} });
  runButton(panel).click();
  await tick(5);
  panel.runExternal('clean-up', { annotations: [1] });
  await tick(5);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].annotations, [1]);
  assert.equal(runButton(panel).textContent, 'Cancel');
});
