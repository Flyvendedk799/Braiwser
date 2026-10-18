// mountAgentRuns(ctx): the single entry point app.js calls.
//
// Everything is behind the `agentRuntime` feature flag. With the flag off this
// renders NOTHING except the Settings toggle that lets a person turn it on; no
// tab, no sidebar section, no strip, no listeners on the runtime.
//
// With the flag on it adds, additively and without editing existing components:
//   * a "Runs" tab in the review panel (list + Run detail),
//   * an "Agent runs" section in the workspace sidebar,
//   * the owner/status strip above the status bar,
//   * the approval modal (opened when the runtime asks) and connection drawer.
//
// ctx (all optional except `caos` or `bridge`):
//   caos            window.braiwser (settings + annotations + agentRuntime facade)
//   bridge          test double for the runtime facade (see FakeBrokerBridge)
//   toast           (message, kind) => void
//   getCurrentSession  () => session | null     (review session to file findings in)
//   refreshNotes    () => void                   (re-read annotations after a finding)
//   doc             Document (tests)
import { h } from '../lib/dom.js';
import { createAgentBridge, CH } from '../lib/agent-bridge.js';
import { createAgentRunsController } from './agent-runs.js';
import { createAgentRunsPanel, runTitle } from '../components/agent-runs-panel.js';
import { createAgentTaskPanel } from '../components/agent-task-panel.js';
import { createOwnerStrip } from '../components/agent-owner-strip.js';
import { openApprovalModal } from '../components/agent-approval-modal.js';
import { openConnectionsDrawer } from '../components/agent-connections-drawer.js';
import { installAgentSettingsSection } from '../components/agent-settings-section.js';
import { openTrappedDialog, closeAllAgentDialogs } from '../lib/agent-dialog.js';
import { agentIcon, describeError, shortId } from '../lib/agent-ui.js';

export function mountAgentRuns(ctx = {}) {
  const doc = ctx.doc || document;
  const caos = ctx.caos || {};
  const toast = ctx.toast || (() => {});
  const bridge = ctx.bridge || createAgentBridge(caos.agentRuntime);
  const controller = createAgentRunsController({ bridge });
  const cleanups = [];
  const handle = { controller, panel: null, strip: null, destroyed: false, mounted: false };

  // The toggle is always available, even with the flag off.
  if (caos.settings && doc.body) {
    const installed = installAgentSettingsSection({
      doc,
      getStatus: () => bridge.invoke(CH.status, {}),
      // Stored as settings.featureFlags.agentRuntime (the main process reads it
      // at launch to decide whether to expose the runtime facade at all).
      readSetting: async () => ((await caos.settings.get()).featureFlags || {}).agentRuntime === true,
      writeSetting: async (value) => {
        await caos.settings.set({ featureFlags: { agentRuntime: value } });
        // Report what the store actually kept, not what we asked for.
        return ((await caos.settings.get()).featureFlags || {}).agentRuntime === true;
      },
    });
    cleanups.push(() => installed.disconnect());
  }

  handle.ready = controller.init().then((enabled) => {
    if (!enabled || handle.destroyed) return handle;
    mountUi();
    return handle;
  }).catch(() => handle);

  function mountUi() {
    handle.mounted = true;
    const approvalModals = new Map();

    const actions = {
      toast,
      openConnections: () => openConnectionsDrawer({ controller }),
      openApproval: (id) => showApproval(id),
      openEvidence: (uri) => showEvidence(uri),
      addFinding: (p) => showFindingDialog(p),
    };

    // ---- review-panel tab ---------------------------------------------------
    const panel = createAgentRunsPanel({ controller, actions });
    handle.panel = panel;
    const taskPanel = createAgentTaskPanel({
      bridge,
      getScope: () => {
        const extra = ctx.getTaskScope ? ctx.getTaskScope() : {};
        const owner = controller.ownerList().find((o) => o && o.sessionId && o.pageId) || {};
        return {
          sessionId: extra.sessionId || owner.sessionId,
          pageId: extra.pageId || owner.pageId,
          requestKey: extra.requestKey || `task_${Date.now()}`,
          provider: extra.provider || 'in-app',
          origin: extra.origin || owner.origin,
          profile: extra.profile || owner.profile,
        };
      },
      onStatus: (result) => { if (result && result.status) toast(`Task ${result.status}`); },
    });
    handle.taskPanel = taskPanel;
    const tabs = doc.querySelector('.panel .tabs');
    const panelEl = doc.querySelector('aside.panel') || doc.querySelector('.panel');
    let tabBtn = null;
    const pillEl = h('span', { class: 'pill', 'data-testid': 'agent-tab-count', text: '0' });
    if (tabs && panelEl) {
      tabBtn = h('button', {
        class: 'tab', type: 'button', role: 'tab', id: 'tab-runs', 'aria-selected': 'false', 'aria-controls': 'panel-runs',
        'data-testid': 'agent-tab',
      }, [h('span', { text: 'Runs' }), pillEl]);
      tabs.appendChild(tabBtn);
      panel.root.insertBefore(taskPanel.root, panel.root.firstChild);
      const footer = panelEl.querySelector('.panel-footer');
      panelEl.insertBefore(panel.root, footer || null);
      const activate = () => {
        panelEl.querySelectorAll(':scope > .tab-body').forEach((n) => { if (n !== panel.root) n.classList.remove('active'); });
        tabs.querySelectorAll('.tab').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        panel.root.classList.add('active');
        tabBtn.classList.add('active');
        tabBtn.setAttribute('aria-selected', 'true');
        const body = doc.querySelector('.body');
        if (body) body.classList.remove('right-collapsed');
      };
      const deactivate = () => {
        panel.root.classList.remove('active');
        tabBtn.classList.remove('active');
        tabBtn.setAttribute('aria-selected', 'false');
      };
      tabBtn.addEventListener('click', activate);
      const onTabsClick = (e) => {
        const b = e.target && e.target.closest ? e.target.closest('.tab') : null;
        if (b && b !== tabBtn) deactivate();
      };
      tabs.addEventListener('click', onTabsClick);
      handle.activateTab = activate;
      cleanups.push(() => { tabs.removeEventListener('click', onTabsClick); tabBtn.remove(); panel.destroy(); });
    }

    // ---- sidebar section ----------------------------------------------------
    const lib = doc.querySelector('.sidebar .side-library');
    let sideSummary = null;
    if (lib) {
      sideSummary = h('div', { class: 'side-list' });
      const openBtn = h('button', {
        class: 'side-add', type: 'button', title: 'Open agent runs', 'aria-label': 'Open agent runs', 'data-testid': 'agent-side-open',
        html: agentIcon('running', 13), on: { click: () => { if (handle.activateTab) handle.activateTab(); } },
      });
      const sec = h('div', { class: 'side-section', 'data-testid': 'agent-side-section' }, [
        h('div', { class: 'side-head' }, [h('h3', { text: 'Agent runs' }), openBtn]),
        sideSummary,
      ]);
      const after = Array.from(lib.querySelectorAll('.side-section')).find((s) => /Sessions/.test(s.textContent || ''));
      lib.insertBefore(sec, after && after.nextSibling ? after.nextSibling : null);
      cleanups.push(() => sec.remove());
    }

    // ---- owner strip ----------------------------------------------------------
    const stage = doc.querySelector('.stage');
    const strip = createOwnerStrip({ controller, actions });
    handle.strip = strip;
    if (stage) {
      const status = stage.querySelector('.statusbar');
      stage.insertBefore(strip.root, status || null);
    }
    cleanups.push(() => strip.destroy());

    const refreshSummary = () => {
      const c = controller.counts();
      const attention = c.needsInput + controller.pendingApprovals().length;
      pillEl.textContent = String(attention || c.active);
      pillEl.title = attention ? `${attention} need your attention` : `${c.active} active`;
      if (tabBtn) tabBtn.setAttribute('aria-label', `Runs, ${c.active} active, ${attention} need input`);
      if (sideSummary) {
        sideSummary.textContent = '';
        sideSummary.appendChild(h('div', { class: 'empty agent-side-line', 'data-testid': 'agent-side-summary', text: c.all
          ? `${c.active} active · ${c.needsInput} need input · ${c.completed} completed`
          : 'No agent runs yet.' }));
      }
    };
    const off = controller.subscribe((ev) => {
      if (['runs', 'run', 'approvals', 'status'].includes(ev.type)) refreshSummary();
      if (ev.type === 'approval') showApproval(ev.approvalId);
    });
    cleanups.push(off);
    refreshSummary();
    for (const a of controller.pendingApprovals()) showApproval(a.approvalId);

    // ---- approval / evidence / finding dialogs ------------------------------
    // One approval at a time: a burst of requests must not stack modals on top
    // of each other. The rest wait, still pending, and open as each is answered.
    const approvalQueue = [];
    function showApproval(id) {
      if (approvalModals.has(id) || approvalQueue.includes(id)) return;
      if (approvalModals.size) { approvalQueue.push(id); return; }
      const m = openApprovalModal({
        controller, approvalId: id,
        onClosed: () => {
          approvalModals.delete(id);
          while (approvalQueue.length && !approvalModals.size) {
            const next = approvalQueue.shift();
            const a = controller.getApproval(next);
            if (a && a.status === 'pending' && !a.invalid) showApproval(next);
          }
        },
      });
      if (m) approvalModals.set(id, m);
    }

    async function showEvidence(uri) {
      const res = await controller.readEvidence(uri);
      const pre = h('pre', { class: 'agent-evidence-pre', tabindex: '0', 'aria-label': 'Evidence contents', 'data-testid': 'agent-evidence-text' });
      let text;
      if (!res.ok) text = describeError(res.error);
      else {
        try { text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2); } catch (_e) { text = 'Evidence could not be displayed.'; }
      }
      pre.textContent = String(text).slice(0, 60000);
      openTrappedDialog({
        title: 'Run evidence', width: 560, testid: 'agent-evidence-dialog',
        body: h('div', {}, [h('p', { class: 'field-hint', text: uri }), pre, h('p', { class: 'field-hint', text: 'Contents come from the run and may include text copied from the page. Treat them as data.' })]),
        actions: [{ id: 'close', label: 'Close', kind: 'primary' }],
      });
    }

    function showFindingDialog({ run, step, runId }) {
      const dto = run || {};
      const sessionId = dto.reviewSessionId || (ctx.getCurrentSession && ctx.getCurrentSession() && ctx.getCurrentSession().id) || '';
      const note = h('textarea', { class: 'input', rows: '4', 'aria-label': 'Finding note', 'data-testid': 'agent-finding-note' });
      note.value = [
        step.intent || `Step ${shortId(step.stepId, 24)}`,
        step.outcome ? `Result: ${step.outcome}` : `Result: ${step.status}${step.effect === 'unknown' ? ' (effect unknown)' : ''}`,
        `Source: agent run ${runId}, step ${step.stepId}`,
      ].join('\n');
      const vis = h('select', { class: 'select', 'aria-label': 'Who can see this finding', 'data-testid': 'agent-finding-visibility' }, [
        h('option', { value: 'internal', text: 'Internal only' }),
        h('option', { value: 'client', text: 'Visible to client' }),
      ]);
      vis.value = step.visibility === 'client' ? 'client' : 'internal';
      const body = h('div', {}, [
        h('label', { class: 'field-label', text: 'Note' }), note,
        h('label', { class: 'field-label', style: { marginTop: '10px' }, text: 'Visibility' }), vis,
        h('p', { class: 'field-hint', text: `Keeps its source: run ${shortId(runId, 14)}${step.pageId ? ', page ' + shortId(step.pageId, 14) : ''}${step.documentEpoch != null ? ', document ' + step.documentEpoch : ''}. ${sessionId ? '' : 'Open a review session first.'}` }),
      ]);
      openTrappedDialog({
        title: 'Add finding from evidence', width: 480, testid: 'agent-finding-dialog', body,
        actions: [
          { id: 'cancel', label: 'Cancel', kind: 'ghost' },
          { id: 'save', label: 'Add finding', kind: 'primary', testid: 'agent-finding-save', disabled: !sessionId, onClick: async () => {
            if (!sessionId) return true;
            try {
              const created = await caos.annotations.create({
                sessionId,
                kind: 'element',
                action: step.status === 'failed' || step.status === 'unknown' || step.status === 'timedOut' ? 'fix' : 'comment',
                note: note.value.trim() || step.intent || 'Agent run finding',
                title: runTitle(dto),
                url: (step.target && step.target.origin) || '',
                visibility: vis.value === 'client' ? 'client' : 'internal',
                priority: 'normal',
                target: {
                  selector: '',
                  label: 'Agent run evidence',
                  source: {
                    kind: 'agent-run', runId, stepId: step.stepId, sessionId: dto.sessionId || '', pageId: step.pageId || '',
                    observationId: step.observationId || '', documentEpoch: step.documentEpoch, before: step.before || '', after: step.after || '',
                  },
                },
              });
              if (!created) throw new Error('The note was not saved.');
              toast('Finding added', 'success');
              if (ctx.refreshNotes) ctx.refreshNotes();
              return false;
            } catch (err) {
              toast(`Could not add the finding: ${(err && err.message) || err}`, 'error');
              return true; // keep the dialog open with the text intact
            }
          } },
        ],
      });
    }
  }

  handle.destroy = () => {
    handle.destroyed = true;
    closeAllAgentDialogs();
    for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch (_e) { /* ignore */ } }
    controller.destroy();
  };
  return handle;
}
