// Agent Runs UI (jsdom + FakeBrokerBridge): flag-off renders nothing, run list and
// Run detail semantics (text + icon states, uncertain callout, no "Retry
// everything"), approval modal digest binding + focus/Escape isolation, owner
// strip takeover/resume, connection drawer scope-before-enable, settings toggle
// read-back, add-finding provenance, accessibility attributes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAgentDom, load, tick, flush, click, keydown, tid, tids, q, qa } from './agent-dom-env.mjs';
import { FakeBrokerBridge, ev, approvalPayload, ownerPayload } from './fake-broker-bridge.mjs';

const { document, window } = setupAgentDom();
const { mountAgentRuns } = await load('controllers/agent-runs-mount.js');
const { CH } = await load('lib/agent-bridge.js');
const { modal } = await load('lib/dom.js');

const SHELL = `
<div id="root" class="app">
  <div class="body">
    <aside class="sidebar"><div class="side-library">
      <div class="side-section"><div class="side-head"><h3>Projects</h3></div></div>
      <div class="side-section"><div class="side-head"><h3>Sessions</h3></div></div>
      <div class="side-section"><div class="side-head"><h3>Recordings</h3></div></div>
    </div></aside>
    <div class="stage"><div class="wv-host"></div><div class="statusbar"></div></div>
    <aside class="panel">
      <div class="tabs" role="tablist"><button class="tab active" id="tab-notes" role="tab">Notes</button><button class="tab" id="tab-verify" role="tab">Verify</button></div>
      <div class="tab-body active" id="panel-notes"></div>
      <div class="tab-body" id="panel-verify"></div>
      <div class="panel-footer"></div>
    </aside>
  </div>
</div>`;

function freshShell() {
  document.body.innerHTML = SHELL;
}
const snapshotDom = () => document.body.innerHTML;

// Every mounted handle is torn down after each test, even when an assertion
// throws, so a failure cannot leak observers/listeners into the next test.
const live = [];
test.afterEach(() => { live.splice(0).forEach((h) => { try { h.destroy(); } catch (_e) { /* ignore */ } }); });
const track = (h) => { live.push(h); return h; };

function fixture(fake) {
  fake.addRun({ runId: 'r1', title: 'Checkout journey', state: 'uncertain', verdict: 'unknown', planned: 4, executed: 3, passed: 2, unknown: 1, pending: 1, uncertainEffect: true, sessionId: 's1', startedAt: '2026-10-09T10:00:00.000Z' }, [
    ev(1, 'run.started'),
    ev(2, 'step.result', { stepId: 'st1', detail: { intent: 'Open cart', status: 'passed', effect: 'confirmed', outcome: 'Cart page loaded', before: 'braiwser://runs/r1/observations/ob_1', after: 'braiwser://runs/r1/observations/ob_2', target: { role: 'link', name: 'Cart' }, policy: { decision: 'allowed', reason: 'Within granted origin' } } }),
    ev(3, 'step.uncertain', { stepId: 'st2', detail: { intent: 'Submit order', effect: 'dispatched', waitReason: 'Waiting for confirmation page', target: { role: 'button', name: 'Place order' }, pageId: 'p1', documentEpoch: 3, visibility: 'client' } }),
  ]);
  fake.addRun({ runId: 'r2', title: 'Smoke', state: 'running', planned: 2, executed: 1 }, [ev(1, 'run.started')]);
  fake.addRun({ runId: 'r3', title: 'Nav', state: 'passed', verdict: 'passed', planned: 2, executed: 2, passed: 2, requiredAssertions: 1, passedAssertions: 1, evidenceComplete: true }, [ev(1, 'run.started')]);
}

async function mounted(fake, extra = {}) {
  freshShell();
  const settingsStore = { featureFlags: {} };
  const caos = {
    agentRuntime: fake.facade,
    settings: {
      get: async () => structuredClone(settingsStore),
      set: async (patch) => { if (extra.rejectSettings) return settingsStore; Object.assign(settingsStore, patch); return structuredClone(settingsStore); },
    },
    annotations: { create: async (a) => { (extra.created = extra.created || []).push(a); return { id: 'n1', ...a }; } },
  };
  const toasts = [];
  const handle = track(mountAgentRuns({ caos, toast: (m, k) => toasts.push([m, k]), getCurrentSession: () => ({ id: 'rev1' }), refreshNotes: () => { extra.refreshed = (extra.refreshed || 0) + 1; }, ...(extra.ctx || {}) }));
  await handle.ready;
  await flush();
  return { handle, caos, toasts, settingsStore };
}

test('flag off: nothing is rendered and no runtime listener exists', async () => {
  const fake = new FakeBrokerBridge({ enabled: false });
  freshShell();
  const before = snapshotDom();
  const handle = track(mountAgentRuns({ caos: { agentRuntime: fake.facade }, toast() {} }));
  await handle.ready;
  await flush();
  assert.equal(snapshotDom(), before, 'DOM unchanged');
  assert.equal(tid('agent-tab'), null);
  assert.equal(tid('agent-strip'), null);
  assert.equal(tid('agent-side-section'), null);
  assert.equal(fake.listenerCount(), 0);
  handle.destroy();
});

test('facade absent (preload did not expose it): nothing is rendered', async () => {
  freshShell();
  const before = snapshotDom();
  const handle = track(mountAgentRuns({ caos: {}, toast() {} }));
  await handle.ready;
  assert.equal(snapshotDom(), before);
  handle.destroy();
});

test('flag on: Runs tab, sidebar summary and strip are added; owner strip hidden until an agent session exists', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  const tab = tid('agent-tab');
  assert.ok(tab);
  assert.equal(tab.getAttribute('role'), 'tab');
  assert.equal(tab.getAttribute('aria-controls'), 'panel-runs');
  assert.equal(tab.getAttribute('aria-selected'), 'false');
  assert.match(tab.getAttribute('aria-label'), /Runs, 1 active, 1 need input/);
  const panel = tid('agent-runs-panel');
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), 'tab-runs');
  assert.ok(tid('agent-side-section'));
  assert.match(tid('agent-side-summary').textContent, /1 active · 1 need input · 1 completed/);
  assert.equal(tid('agent-strip').hasAttribute('hidden'), true);
  // sidebar section sits after Sessions
  const heads = qa('.side-library .side-section h3').map((n) => n.textContent);
  assert.deepEqual(heads, ['Projects', 'Sessions', 'Agent runs', 'Recordings']);
  handle.destroy();
  assert.equal(tid('agent-tab'), null, 'destroy removes injected DOM');
  assert.equal(fake.listenerCount(), 0);
});

test('tab switching: Runs shows alone; selecting another tab hides it again', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  click(tid('agent-tab'));
  assert.ok(tid('agent-runs-panel').classList.contains('active'));
  assert.equal(q('#panel-notes').classList.contains('active'), false);
  assert.equal(tid('agent-tab').getAttribute('aria-selected'), 'true');
  assert.equal(q('#tab-notes').getAttribute('aria-selected') !== 'true', true);
  click(q('#tab-verify'));
  assert.equal(tid('agent-runs-panel').classList.contains('active'), false);
  assert.equal(tid('agent-tab').getAttribute('aria-selected'), 'false');
  handle.destroy();
});

test('run list: filters with counts, state shown as text AND icon, aria-pressed', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  const rows = tids('agent-run-row');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const state = row.querySelector('.agent-state');
    assert.ok(state.querySelector('svg'), 'icon');
    assert.ok(state.textContent.trim().length > 2, 'text label');
  }
  assert.ok(rows.some((r) => /Outcome uncertain/.test(r.textContent)));
  assert.equal(tid('agent-filter-all').getAttribute('aria-pressed'), 'true');
  assert.match(tid('agent-filter-needsInput').textContent, /Needs input\s*1/);
  click(tid('agent-filter-needsInput'));
  await flush();
  assert.equal(tid('agent-filter-needsInput').getAttribute('aria-pressed'), 'true');
  assert.equal(tids('agent-run-row').length, 1);
  assert.equal(tids('agent-run-row')[0].dataset.runId, 'r1');
  handle.destroy();
});

test('run detail: uncertain step gets Re-observe + safe choices, never "Retry"; counts, evidence, policy shown', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  click(tids('agent-run-row').find((r) => r.dataset.runId === 'r1'));
  await tick(20);
  await flush();
  const detail = tid('agent-run-detail');
  assert.equal(detail.hasAttribute('hidden'), false);
  assert.match(tid('agent-run-state').textContent, /Outcome uncertain/);
  assert.match(tid('agent-run-verdict').textContent, /Result: Unknown/);
  assert.match(tid('agent-count-planned').textContent, /4\s*Planned/);
  assert.match(tid('agent-count-unknown').textContent, /1\s*Unknown/);
  // timeline
  const steps = tids('agent-step');
  assert.equal(steps.length, 2);
  assert.match(steps[0].textContent, /Open cart/);
  assert.match(steps[0].textContent, /Passed/);
  assert.match(tids('agent-step-policy')[0].textContent, /allowed.*Within granted origin/);
  assert.match(tids('agent-step-target')[0].textContent, /text from the page/);
  assert.ok(steps[0].querySelector('[data-testid="agent-evidence-before"]'));
  assert.ok(steps[0].querySelector('[data-testid="agent-evidence-after"]'));
  assert.match(tids('agent-step-wait')[0].textContent, /Waiting for confirmation page/);
  assert.match(tids('agent-step-effect')[0].textContent, /Confirmed/);
  assert.match(tids('agent-step-effect')[1].textContent, /Unknown — it may have happened/);
  // recovery
  const rec = tid('agent-run-recovery');
  assert.ok(rec);
  assert.match(rec.textContent, /Last proven result: Open cart/);
  assert.match(rec.textContent, /Submit order/);
  assert.match(rec.textContent, /will not repeat this step on its own/);
  assert.ok(tid('agent-recover-reobserve'));
  const wholeText = detail.textContent.toLowerCase();
  assert.equal(/retry/.test(wholeText), false, 'no retry affordance anywhere');
  assert.equal(/try another selector/.test(wholeText), false);
  handle.destroy();
});

test('Re-observe asks the runtime for a read-only observation and reports it as a snapshot', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  // an owner exists for session s1
  fake.emit(CH.evOwner, ownerPayload());
  await flush();
  click(tids('agent-run-row').find((r) => r.dataset.runId === 'r1'));
  await tick(20); await flush();
  click(tid('agent-recover-reobserve'));
  await tick(10);
  assert.equal(fake.callsTo(CH.observe).length, 1);
  assert.deepEqual(Object.keys(fake.callsTo(CH.observe)[0].payload).sort(), ['maxNodes', 'pageId', 'sessionId']);
  assert.match(tid('agent-recovery-result').textContent, /3 elements/);
  assert.equal(fake.callsTo(CH.handoff).length + fake.callsTo(CH.runCancel).length, 0, 'nothing else was sent');
  handle.destroy();
});

test('a passed run whose report does not prove it is shown as Unknown with an explanation', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'rx', title: 'Weak pass', state: 'passed', verdict: 'passed', planned: 3, executed: 3, passed: 3, requiredAssertions: 1, passedAssertions: 1, evidenceComplete: false }, [ev(1, 'run.started')]);
  const { handle } = await mounted(fake);
  assert.match(tids('agent-run-row')[0].textContent, /Unverified/);
  click(tids('agent-run-row')[0]);
  await tick(20); await flush();
  assert.match(tid('agent-run-verdict').textContent, /Unknown/);
  assert.ok(tid('agent-run-inconsistent'));
  assert.equal(/Result: Passed/.test(tid('agent-run-detail').textContent), false);
  handle.destroy();
});

test('detail with an unreadable journal says so and shows no outcome', async () => {
  const fake = new FakeBrokerBridge();
  fake.noReply.add(CH.runGet);
  fake.addRun({ runId: 'r1' }, [ev(1, 'run.started')]);
  const { handle } = await mounted(fake);
  fake.runs.delete('r1');
  const { controller } = handle;
  controller._views.clear();
  await controller.openRun('r1');
  await flush();
  assert.ok(tid('agent-run-unavailable'));
  assert.match(tid('agent-run-unavailable').textContent, /nothing here should be read as a pass/);
  handle.destroy();
});

test('gaps and truncation are shown on the timeline', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', state: 'running' }, [ev(1, 'run.started'), ev(2, 'stream.truncated', { summary: 'Backpressure: events dropped', detail: { dropped: 5 } }), ev(6, 'step.started', { stepId: 'a' })]);
  const { handle } = await mounted(fake);
  // the fake journal skips 3..5; the broker cannot supply them
  click(tids('agent-run-row')[0]);
  await tick(30); await flush();
  assert.ok(tid('agent-run-hole'), 'unfilled hole banner');
  assert.match(tid('agent-run-hole').textContent, /3–5/);
  assert.ok(tid('agent-run-truncated'));
  assert.match(tid('agent-run-truncated').textContent, /5 events dropped/);
  handle.destroy();
});

test('cancel: states what it does and does not do', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1', state: 'running', planned: 2 }, [ev(1, 'run.started')]);
  const { handle } = await mounted(fake);
  click(tids('agent-run-row')[0]);
  await tick(20); await flush();
  click(tid('agent-run-cancel'));
  await tick(10); await flush();
  assert.match(tid('agent-run-cancel-requested').textContent, /not undone/);
  assert.equal(tid('agent-run-cancel').disabled, true);
  assert.match(tid('agent-run-state').textContent, /Running/, 'still running until the runtime says otherwise');
  handle.destroy();
});

// ---- approval modal -----------------------------------------------------------------
test('approval modal shows origin, exact action, destination, data, scope, expiry; opens on safe choice', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evApproval, approvalPayload());
  await flush();
  const m = tid('agent-approval-modal');
  assert.ok(m);
  assert.equal(m.getAttribute('role'), 'alertdialog');
  assert.equal(m.getAttribute('aria-modal'), 'true');
  assert.ok(m.getAttribute('aria-labelledby'));
  assert.ok(m.getAttribute('aria-describedby'));
  assert.match(tid('agent-approval-origin').textContent, /shop\.example\.test/);
  assert.match(tid('agent-approval-action').textContent, /click: Place order/);
  assert.match(tid('agent-approval-action').textContent, /text from the page/);
  assert.match(tid('agent-approval-destination').textContent, /checkout/);
  assert.match(tid('agent-approval-data').textContent, /41\.00/);
  assert.match(tid('agent-approval-scope').textContent, /click on shop/);
  assert.match(tid('agent-approval-expiry').textContent, /in \d+s|in \d+ min/);
  assert.equal(document.activeElement, tid('agent-approval-deny'), 'focus starts on Deny, not Allow');
  assert.equal(tid('agent-approval-allow').disabled, false);
  handle.destroy();
});

test('approval modal: a changed action disables Allow until the person reviews the new request', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evApproval, approvalPayload());
  await flush();
  fake.emit(CH.evApproval, approvalPayload({ actionDigest: 'dig_bbbb2222', action: { kind: 'click', label: 'Delete account' } }));
  await flush();
  assert.equal(tid('agent-approval-allow').disabled, true);
  assert.match(tid('agent-approval-banner').textContent, /action changed/i);
  assert.match(tid('agent-approval-action').textContent, /Place order/, 'still displays what was originally shown');
  click(tid('agent-approval-allow'));
  await tick(5);
  assert.equal(fake.callsTo(CH.approvalDecide).length, 0, 'nothing sent');
  click(tid('agent-approval-review'));
  await flush();
  assert.match(tid('agent-approval-action').textContent, /Delete account/);
  assert.equal(tid('agent-approval-allow').disabled, false);
  assert.equal(document.activeElement, tid('agent-approval-deny'));
  click(tid('agent-approval-allow'));
  await tick(10);
  const sent = fake.callsTo(CH.approvalDecide);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.actionDigest, 'dig_bbbb2222');
  assert.equal(tid('agent-approval-modal'), null, 'closed after the runtime confirmed');
  handle.destroy();
});

test('approval modal: Allow once / Deny send the decision with the shown digest; a failed decision keeps the modal open', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evApproval, approvalPayload());
  await flush();
  fake.throwTransport.add(CH.approvalDecide);
  click(tid('agent-approval-allow'));
  await tick(10);
  assert.ok(tid('agent-approval-modal'), 'still open');
  assert.match(tid('agent-approval-banner').textContent, /No confirmation from the runtime/);
  fake.throwTransport.clear();
  click(tid('agent-approval-deny'));
  await tick(10);
  assert.equal(fake.callsTo(CH.approvalDecide).at(-1).payload.decision, 'deny');
  assert.equal(tid('agent-approval-modal'), null);
  handle.destroy();
});

test('Escape closes only the approval modal (parent modal stays), and leaves the request pending', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  let parentClosed = 0;
  const parentInput = document.createElement('input');
  const parent = modal({ title: 'Edit recording', body: parentInput, onClose: () => parentClosed++ });
  await tick(30);
  fake.emit(CH.evApproval, approvalPayload());
  await flush();
  assert.ok(tid('agent-approval-modal'));
  keydown(document.activeElement, 'Escape');
  assert.equal(tid('agent-approval-modal'), null, 'approval closed');
  assert.equal(parentClosed, 0, 'parent NOT closed by the same key press');
  assert.ok(document.body.contains(parent.card));
  assert.equal(handle.controller.getApproval('ap_1').status, 'pending', 'closing is not denying');
  assert.equal(fake.callsTo(CH.approvalDecide).length, 0);
  // the parent regains Escape handling afterwards
  keydown(parentInput, 'Escape');
  assert.equal(parentClosed, 1);
  handle.destroy();
});

test('approval modal traps Tab inside itself', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  fake.emit(CH.evApproval, approvalPayload());
  await flush();
  const card = tid('agent-approval-modal');
  const focusable = qa('button:not([disabled])', card);
  const first = focusable[0];
  const last = focusable.at(-1);
  last.focus();
  const e1 = keydown(last, 'Tab');
  assert.equal(e1.defaultPrevented, true);
  assert.equal(document.activeElement, first, 'wraps forward');
  const e2 = keydown(first, 'Tab', { shiftKey: true });
  assert.equal(e2.defaultPrevented, true);
  assert.equal(document.activeElement, last, 'wraps backward');
  outside.focus();
  await flush();
  assert.ok(card.contains(document.activeElement), 'focus pulled back from outside');
  handle.destroy();
});

test('a burst of approvals opens one modal at a time', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evApproval, approvalPayload({ approvalId: 'a1' }));
  fake.emit(CH.evApproval, approvalPayload({ approvalId: 'a2', actionDigest: 'dig_2' }));
  await flush();
  assert.equal(tids('agent-approval-modal').length, 1);
  click(tid('agent-approval-deny'));
  await tick(10); await flush();
  assert.equal(tids('agent-approval-modal').length, 1, 'next one opens after the first is answered');
  handle.destroy();
});

// ---- owner strip -----------------------------------------------------------------------
test('owner strip: origin, adapter, agent-control, controls; screenshot is a labelled snapshot, not live', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  fake.emit(CH.evOwner, ownerPayload({ preview: { src: png, capturedAt: '2026-10-09T10:15:30.000Z' } }));
  await flush();
  const strip = tid('agent-strip');
  assert.equal(strip.hasAttribute('hidden'), false);
  assert.equal(strip.getAttribute('role'), 'region');
  assert.ok(strip.getAttribute('aria-label'));
  assert.match(tid('agent-strip-origin').textContent, /shop\.example\.test/);
  assert.match(tid('agent-strip-adapter').textContent, /Headless/);
  assert.match(tid('agent-strip-controller').textContent, /Agent control/);
  assert.ok(tid('agent-strip-controller').querySelector('svg'));
  assert.match(tid('agent-strip-preview-caption').textContent, /Snapshot \d\d:\d\d:\d\d · not live/);
  assert.match(tid('agent-strip-preview').alt, /Not live/);
  assert.equal(/\blive\b/i.test(tid('agent-strip-preview-caption').textContent.replace(/not live/i, '')), false, 'never labelled live');
  assert.equal(tid('agent-strip-take-control').disabled, false);
  assert.equal(tid('agent-strip-observe').disabled, false);
  assert.equal(tid('agent-strip-pause').disabled, true, 'Pause is not claimed to exist');
  assert.equal(tid('agent-strip-resume').hidden, true);
  // an unsafe preview is dropped
  fake.emit(CH.evOwner, ownerPayload({ preview: { src: 'https://evil.test/p.png', capturedAt: '2026-10-09T10:16:00.000Z' } }));
  await flush();
  assert.equal(tid('agent-strip-preview').hasAttribute('hidden'), true);
  handle.destroy();
});

test('takeover disables agent controls and swaps Take control for Resume; Resume re-observes before agent control returns', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evOwner, ownerPayload());
  await flush();
  click(tid('agent-strip-take-control'));
  await tick(10); await flush();
  assert.equal(fake.callsTo(CH.handoff).length, 1);
  assert.match(tid('agent-strip-controller').textContent, /Human control/);
  assert.equal(tid('agent-strip-observe').disabled, true);
  assert.equal(tid('agent-strip-pause').disabled, true);
  assert.equal(tid('agent-strip-take-control').hidden, true);
  assert.equal(tid('agent-strip-resume').hidden, false);
  assert.equal(tid('agent-strip-resume').disabled, false);
  assert.match(tid('agent-strip-resume').title, /re-observes the page/);
  assert.match(tid('agent-strip-note').textContent, /agent cannot act/);
  click(tid('agent-strip-resume'));
  await tick(10); await flush();
  assert.match(tid('agent-strip-controller').textContent, /Agent control/);
  assert.match(tid('agent-strip-note').textContent, /Fresh observation ob_fresh_1/);
  handle.destroy();
});

test('resume that the runtime does not confirm keeps the human in control and says so', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evOwner, ownerPayload({ owner: 'human' }));
  await flush();
  fake.handlers[CH.resume] = () => ({ owner: 'human' });
  click(tid('agent-strip-resume'));
  await tick(10); await flush();
  assert.match(tid('agent-strip-controller').textContent, /Human control/);
  assert.match(tid('agent-strip-note').textContent, /not confirmed/);
  handle.destroy();
});

test('quarantined: Take control is unavailable and explained; unsupported handoff is disabled with a reason', async () => {
  const fake = new FakeBrokerBridge();
  const { handle } = await mounted(fake);
  fake.emit(CH.evOwner, ownerPayload({ owner: 'quarantined' }));
  await flush();
  assert.equal(tid('agent-strip-take-control').disabled, true);
  assert.match(tid('agent-strip-controller').textContent, /Quarantined/);
  fake.emit(CH.evOwner, ownerPayload({ owner: 'agent', humanHandoff: 'unsupported' }));
  await flush();
  assert.equal(tid('agent-strip-take-control').disabled, true);
  assert.match(tid('agent-strip-take-control').title, /cannot hand the page to a person/);
  handle.destroy();
});

test('Stop requests cancellation of the attached run and states its limits', async () => {
  const fake = new FakeBrokerBridge();
  fake.addRun({ runId: 'r1' }, [ev(1, 'run.started')]);
  const { handle } = await mounted(fake);
  fake.emit(CH.evOwner, ownerPayload());
  await flush();
  click(tid('agent-strip-stop'));
  await tick(10); await flush();
  assert.equal(fake.callsTo(CH.runCancel).length, 1);
  assert.match(tid('agent-strip-note').textContent, /not undone/);
  handle.destroy();
});

// ---- connections -----------------------------------------------------------------------
test('connection drawer: scope and expiry are visible BEFORE enabling; enable/revoke ask once; Escape closes only the top dialog', async () => {
  const fake = new FakeBrokerBridge();
  fake.connections = { supported: true, connections: [
    { clientId: 'c1', client: 'Cursor agent', profile: 'review-profile', status: 'pending', scope: ['observe shop.example.test', 'click on shop.example.test'], destinations: ['https://shop.example.test'], expiresAt: Date.now() + 3600000 },
    { clientId: 'c2', client: 'CLI', status: 'active', scope: ['observe localhost:3000'], expiresAt: null },
  ] };
  const { handle } = await mounted(fake);
  click(tid('agent-open-connections'));
  await tick(10); await flush();
  const drawer = tid('agent-connections-drawer');
  assert.ok(drawer);
  const items = tids('agent-conn-item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /click on shop\.example\.test/, 'scope visible while still pending');
  assert.match(items[0].textContent, /Waiting for your approval/);
  assert.match(items[0].textContent, /Expires in/);
  assert.match(items[1].textContent, /No expiry set/);
  assert.equal(fake.callsTo(CH.connectionEnable).length, 0);
  // enabling needs a confirmation that repeats the scope
  click(items[0].querySelector('[data-testid="agent-conn-enable"]'));
  await flush();
  const confirm = tid('agent-conn-confirm');
  assert.ok(confirm);
  assert.match(confirm.textContent, /click on shop\.example\.test/);
  assert.equal(document.activeElement.dataset.action, 'cancel', 'focus on the safe choice');
  keydown(document.activeElement, 'Escape');
  assert.equal(tid('agent-conn-confirm'), null, 'Escape closed the top dialog');
  assert.ok(tid('agent-connections-drawer'), 'the drawer underneath stays open');
  assert.equal(fake.callsTo(CH.connectionEnable).length, 0, 'cancel => nothing enabled');
  click(items[0].querySelector('[data-testid="agent-conn-enable"]'));
  await flush();
  click(tid('agent-conn-confirm-ok'));
  await tick(20); await flush();
  assert.equal(fake.callsTo(CH.connectionEnable).length, 1);
  assert.match(tids('agent-conn-item')[0].textContent, /Enabled/);
  handle.destroy();
});

test('connection drawer: an unsupported registry is not shown as "no clients"', async () => {
  const fake = new FakeBrokerBridge();
  fake.connections = { supported: false, connections: [] };
  const { handle } = await mounted(fake);
  click(tid('agent-open-connections'));
  await tick(10); await flush();
  assert.match(tid('agent-conn-status').textContent, /does not report connected clients/);
  assert.equal(tid('agent-conn-empty'), null);
  handle.destroy();
});

// ---- add finding -------------------------------------------------------------------------
test('Add finding preserves source run/page identity and defaults visibility from the evidence (never to client by default)', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const extra = {};
  const { handle } = await mounted(fake, extra);
  click(tids('agent-run-row').find((r) => r.dataset.runId === 'r1'));
  await tick(20); await flush();
  const btns = tids('agent-add-finding');
  assert.ok(btns.length >= 2);
  click(btns[1]); // the uncertain step, whose evidence is client-visible
  await flush();
  assert.equal(tid('agent-finding-visibility').value, 'client', 'carried from the source step');
  click(tid('agent-finding-save'));
  await tick(10);
  assert.equal(extra.created.length, 1);
  const a = extra.created[0];
  assert.equal(a.sessionId, 'rev1');
  assert.equal(a.visibility, 'client');
  assert.equal(a.target.source.runId, 'r1');
  assert.equal(a.target.source.stepId, 'st2');
  assert.equal(a.target.source.pageId, 'p1');
  assert.equal(a.target.source.documentEpoch, 3);
  assert.match(a.note, /agent run r1, step st2/);
  assert.equal(extra.refreshed, 1);
  // a step with no visibility defaults to internal
  click(tids('agent-add-finding')[0]);
  await flush();
  assert.equal(tid('agent-finding-visibility').value, 'internal');
  keydown(document.activeElement, 'Escape');
  assert.equal(extra.created.length, 1, 'cancel creates nothing');
  handle.destroy();
});

// ---- settings toggle ----------------------------------------------------------------------
test('settings toggle is injected into the Settings dialog, even with the flag off, and reads back what the store kept', async () => {
  const fake = new FakeBrokerBridge({ enabled: false });
  freshShell();
  const store = { featureFlags: {} };
  const caos = {
    agentRuntime: fake.facade,
    settings: { get: async () => structuredClone(store), set: async (p) => { Object.assign(store, p); return store; } },
  };
  const handle = track(mountAgentRuns({ caos, toast() {} }));
  await handle.ready;
  const m = modal({ title: 'Profile and Settings', body: (() => { const d = document.createElement('div'); d.innerHTML = '<section class="settings-section"><h3 class="settings-h">General</h3></section>'; return d; })() });
  await tick(30);
  const toggle = tid('agent-flag-toggle');
  assert.ok(toggle, 'section injected');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.ok(document.querySelector('label[for="agent-flag-input"]'));
  assert.equal(toggle.checked, false);
  assert.match(tid('agent-settings-section').textContent, /Takes effect after you restart/);
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(20);
  assert.deepEqual(store.featureFlags, { agentRuntime: true });
  assert.match(tid('agent-flag-result').textContent, /Restart Braiwser to turn the runtime on/);
  m.close();
  await tick(250);
  // it is not injected into other dialogs
  const other = modal({ title: 'About', body: document.createElement('div') });
  await tick(30);
  assert.equal(tids('agent-settings-section').length, 0);
  other.close();
  await tick(250);
  handle.destroy();
});

test('settings toggle reverts and says so when the store does not keep the value', async () => {
  const fake = new FakeBrokerBridge({ enabled: false });
  freshShell();
  const store = { featureFlags: {} };
  const caos = { agentRuntime: fake.facade, settings: { get: async () => structuredClone(store), set: async () => store } }; // drops the patch
  const handle = track(mountAgentRuns({ caos, toast() {} }));
  await handle.ready;
  const m = modal({ title: 'Profile and Settings', body: document.createElement('div') });
  await tick(30);
  const toggle = tid('agent-flag-toggle');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(20);
  assert.equal(toggle.checked, false, 'reverted');
  assert.match(tid('agent-flag-result').textContent, /Could not save/);
  m.close();
  await tick(250);
  handle.destroy();
});

// ---- a11y sweep ----------------------------------------------------------------------------
test('every button in the injected UI has an accessible name; dynamic status regions are live', async () => {
  const fake = new FakeBrokerBridge();
  fixture(fake);
  const { handle } = await mounted(fake);
  fake.emit(CH.evOwner, ownerPayload());
  await flush();
  click(tid('agent-tab'));
  click(tids('agent-run-row')[0]);
  await tick(20); await flush();
  const roots = [tid('agent-runs-panel'), tid('agent-strip')];
  for (const root of roots) {
    for (const b of qa('button', root)) {
      const name = (b.getAttribute('aria-label') || b.textContent || b.title || '').trim();
      assert.ok(name, `unnamed button: ${b.outerHTML.slice(0, 120)}`);
    }
    for (const svg of qa('svg', root)) assert.equal(svg.getAttribute('aria-hidden'), 'true');
  }
  assert.equal(tid('agent-strip-note').getAttribute('aria-live'), 'polite');
  assert.equal(tid('agent-strip-note').getAttribute('role'), 'status');
  for (const l of qa('ul[aria-label], ol[aria-label]', tid('agent-runs-panel'))) assert.ok(l.getAttribute('aria-label'));
  handle.destroy();
});
