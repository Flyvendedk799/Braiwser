// Agent Runs panel: run list (active / completed / needs input) and Run detail.
//
// Run detail answers, for every action: what was intended, which target, what
// policy said, what it waited for, what happened, and the before/after evidence.
// It shows planned vs completed counts and states with text AND icon. A run whose
// effect is uncertain is called out with safe next choices; there is deliberately
// no "Retry everything".
import { h, clear } from '../lib/dom.js';
import {
  agentIcon, outcomeMeta, runStateMeta, displayVerdict, FILTERS, clockTime, shortId, plural, describeError,
} from '../lib/agent-ui.js';

export function runTitle(dto) {
  if (!dto) return 'Run';
  const name = dto.title || (dto.skillId ? `${dto.skillId}${dto.skillVersion ? ' ' + dto.skillVersion : ''}` : '');
  return name ? `${name}` : `Run ${shortId(dto.runId, 12)}`;
}

function stateBadge(meta, testid) {
  return h('span', { class: `agent-state agent-tone-${meta.tone}`, 'data-testid': testid || null, html: `${agentIcon(meta.icon, 13)}<span>${meta.label}</span>` });
}

export function createAgentRunsPanel({ controller, actions = {} }) {
  const listWrap = h('div', { class: 'agent-list-wrap', 'data-testid': 'agent-runs-list-view' });
  const detailWrap = h('div', { class: 'agent-detail-wrap', 'data-testid': 'agent-run-detail', hidden: '' });
  const root = h('div', {
    class: 'tab-body agent-runs-panel', id: 'panel-runs', role: 'tabpanel', 'aria-labelledby': 'tab-runs',
    dataset: { tab: 'runs' }, 'data-testid': 'agent-runs-panel',
  }, [listWrap, detailWrap]);

  let scheduled = false;
  let destroyed = false;

  function schedule() {
    if (scheduled || destroyed) return;
    scheduled = true;
    Promise.resolve().then(() => { scheduled = false; if (!destroyed) render(); });
  }
  const unsub = controller.subscribe((ev) => {
    if (['runs', 'run', 'filter', 'select', 'status', 'approvals'].includes(ev.type)) schedule();
  });

  // Keep keyboard focus where it was across re-renders.
  function withFocus(fn) {
    const el = document.activeElement;
    const key = el && root.contains(el) ? el.getAttribute('data-focus-key') : null;
    fn();
    if (key) {
      const again = Array.from(root.querySelectorAll('[data-focus-key]')).find((n) => n.getAttribute('data-focus-key') === key);
      if (again && again.focus) again.focus();
    }
  }

  let lastSelected = null;
  function render() {
    const id = controller.state.selectedRunId;
    const changed = id !== lastSelected;
    lastSelected = id;
    withFocus(() => {
      if (id) {
        listWrap.setAttribute('hidden', '');
        detailWrap.removeAttribute('hidden');
        renderDetail(id);
      } else {
        detailWrap.setAttribute('hidden', '');
        listWrap.removeAttribute('hidden');
        renderList();
      }
    });
    // Moving between list and detail moves focus with it, so a keyboard or
    // screen-reader user is not left on a control that no longer exists.
    if (changed) {
      const target = id ? detailWrap.querySelector('.agent-detail-title') : listWrap.querySelector('.agent-run-row, [data-focus-key]');
      if (target && target.focus) target.focus();
    }
  }

  // ---------------------------------------------------------------- list
  function renderList() {
    clear(listWrap);
    const counts = controller.counts();
    const filter = controller.state.filter;

    const chips = h('div', { class: 'agent-filters', role: 'group', 'aria-label': 'Filter agent runs' }, FILTERS.map((f) => h('button', {
      class: `agent-chip ${filter === f.id ? 'active' : ''}`, type: 'button', 'aria-pressed': filter === f.id ? 'true' : 'false',
      'data-testid': `agent-filter-${f.id}`, 'data-focus-key': `filter-${f.id}`,
      html: `<span>${f.label}</span><span class="pill">${counts[f.id] || 0}</span>`,
      on: { click: () => controller.setFilter(f.id) },
    })));
    const refresh = h('button', {
      class: 'icon-btn', type: 'button', title: 'Refresh runs', 'aria-label': 'Refresh runs', 'data-testid': 'agent-runs-refresh', 'data-focus-key': 'refresh',
      html: agentIcon('refresh', 14), on: { click: () => controller.refreshRuns() },
    });
    const conn = h('button', {
      class: 'btn btn-sm', type: 'button', 'data-testid': 'agent-open-connections', 'data-focus-key': 'connections',
      html: `${agentIcon('plug', 13)}<span>Connections</span>`, on: { click: () => actions.openConnections && actions.openConnections() },
    });
    listWrap.appendChild(h('div', { class: 'agent-list-head' }, [chips, h('div', { class: 'agent-list-acts' }, [refresh, conn])]));

    if (controller.state.listError) {
      listWrap.appendChild(h('div', { class: 'agent-banner agent-banner-warn', role: 'alert', 'data-testid': 'agent-runs-error', html: agentIcon('warn', 14) + '<span></span>' }));
      listWrap.lastChild.lastChild.textContent = `Could not refresh runs: ${controller.state.listError} Showing what was last received.`;
    }
    const runs = controller.filteredRuns();
    const list = h('ul', { class: 'agent-run-list', 'aria-label': 'Agent runs', 'aria-busy': controller.state.listLoading ? 'true' : 'false', 'data-testid': 'agent-runs-list' });
    if (!runs.length) {
      list.appendChild(h('li', { class: 'empty agent-empty', 'data-testid': 'agent-runs-empty', text: filter === 'all'
        ? 'No agent runs yet. Runs started by a connected agent or skill appear here.'
        : 'No runs in this view.' }));
    }
    for (const r of runs) {
      const meta = runStateMeta(r.dto.state);
      const dv = r.display;
      const verdictMeta = outcomeMeta(dv.verdict);
      const planned = Number.isFinite(r.dto.planned) ? r.dto.planned : null;
      const executed = Number.isFinite(r.dto.executed) ? r.dto.executed : null;
      const progress = planned == null ? '' : `${executed == null ? '?' : executed}/${planned} steps`;
      const row = h('button', {
        class: 'agent-run-row', type: 'button', 'data-run-id': r.runId, 'data-testid': 'agent-run-row', 'data-focus-key': `run-${r.runId}`,
        'aria-label': `${runTitle(r.dto)}, ${meta.label}${dv.verdict !== 'pending' ? ', result ' + verdictMeta.label : ''}${progress ? ', ' + progress : ''}`,
        on: { click: () => controller.openRun(r.runId) },
      }, [
        h('span', { class: 'agent-run-main' }, [
          h('span', { class: 'agent-run-title', text: runTitle(r.dto) }),
          h('span', { class: 'agent-run-meta', text: [progress, r.dto.startedAt ? clockTime(r.dto.startedAt) : ''].filter(Boolean).join(' · ') }),
        ]),
        stateBadge(meta),
        dv.inconsistent ? h('span', { class: 'agent-state agent-tone-warn', title: dv.reason, html: `${agentIcon('unknown', 13)}<span>Unverified</span>` }) : null,
      ]);
      list.appendChild(h('li', {}, [row]));
    }
    listWrap.appendChild(list);
  }

  // -------------------------------------------------------------- detail
  function banner(kind, iconName, text, testid) {
    const b = h('div', { class: `agent-banner agent-banner-${kind}`, role: kind === 'danger' ? 'alert' : 'status', 'data-testid': testid || null, html: agentIcon(iconName, 14) + '<span class="agent-banner-text"></span>' });
    b.querySelector('.agent-banner-text').textContent = text;
    return b;
  }

  function counter(label, value, key) {
    return h('div', { class: 'agent-count', 'data-testid': `agent-count-${key}` }, [
      h('span', { class: 'agent-count-v', text: value == null ? '—' : String(value) }),
      h('span', { class: 'agent-count-l', text: label }),
    ]);
  }

  function renderDetail(runId) {
    clear(detailWrap);
    const view = controller.getView(runId);
    const dto = view && view.dto;
    const back = h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', 'data-testid': 'agent-run-back', 'data-focus-key': 'back',
      html: `${agentIcon('back', 13)}<span>All runs</span>`, on: { click: () => controller.closeRun() },
    });
    const refresh = h('button', {
      class: 'icon-btn', type: 'button', title: 'Reload from the run journal', 'aria-label': 'Reload from the run journal', 'data-testid': 'agent-run-reload', 'data-focus-key': 'reload',
      html: agentIcon('refresh', 14), on: { click: () => controller.hydrate(runId, { fromStart: true }) },
    });
    detailWrap.appendChild(h('div', { class: 'agent-detail-head' }, [back, h('span', { class: 'tb-spacer' }), refresh]));

    if (!view || !dto) {
      detailWrap.appendChild(h('h3', { class: 'agent-detail-title', tabindex: '-1', text: `Run ${shortId(runId, 14)}` }));
      if (view && view.sync === 'unavailable') {
        detailWrap.appendChild(banner('danger', 'warn', `This run could not be read: ${view.syncError || 'no reply from the runtime'}. Its outcome is unknown — nothing here should be read as a pass.`, 'agent-run-unavailable'));
      } else {
        detailWrap.appendChild(h('div', { class: 'empty agent-empty', role: 'status', text: view && view.sync === 'loading' ? 'Reading the run journal…' : 'No report for this run yet.' }));
      }
      return;
    }

    const meta = runStateMeta(dto.state);
    const dv = displayVerdict(dto);
    const vm = outcomeMeta(dv.verdict);
    detailWrap.appendChild(h('div', { class: 'agent-detail-titlebar' }, [
      h('h3', { class: 'agent-detail-title', tabindex: '-1', 'data-testid': 'agent-run-title', text: runTitle(dto) }),
      stateBadge(meta, 'agent-run-state'),
      dv.verdict !== 'pending' ? h('span', { class: `agent-state agent-tone-${vm.tone}`, 'data-testid': 'agent-run-verdict', html: `${agentIcon(vm.icon, 13)}<span>Result: ${vm.label}</span>` }) : null,
    ]));

    // --- honest framing banners
    if (view.sync === 'unavailable') {
      detailWrap.appendChild(banner('warn', 'warn', `Showing the last known state. The runtime could not be reached: ${view.syncError || 'no reply'}. The run may have moved on.`, 'agent-run-stale'));
    }
    if (dv.inconsistent) detailWrap.appendChild(banner('warn', 'unknown', dv.reason, 'agent-run-inconsistent'));
    else if (dv.verdict === 'unknown' && dv.reason) detailWrap.appendChild(banner('warn', 'unknown', dv.reason, 'agent-run-unknown-reason'));
    if (dto.cancelRequested && meta.group !== 'completed') {
      detailWrap.appendChild(banner('info', 'cancelled', 'Cancellation was requested. No further actions will be dispatched; anything already dispatched is not undone.', 'agent-run-cancel-requested'));
    }
    const comp = controller.completeness(runId);
    if (comp) renderCompleteness(comp);

    // --- counters (planned vs completed)
    detailWrap.appendChild(h('div', { class: 'agent-counts', role: 'group', 'aria-label': 'Step counts', 'data-testid': 'agent-run-counts' }, [
      counter('Planned', dto.planned, 'planned'),
      counter('Executed', dto.executed, 'executed'),
      counter('Passed', dto.passed, 'passed'),
      counter('Failed', dto.failed, 'failed'),
      counter('Skipped', dto.skipped, 'skipped'),
      counter('Cancelled', dto.cancelled, 'cancelled'),
      counter('Timed out', dto.timedOut, 'timedOut'),
      counter('Unknown', dto.unknown, 'unknown'),
      counter('Pending', dto.pending, 'pending'),
    ]));
    detailWrap.appendChild(h('p', { class: 'field-hint', 'data-testid': 'agent-run-assertions' }, [
      `Assertions ${Number.isFinite(dto.passedAssertions) ? dto.passedAssertions : '?'}/${Number.isFinite(dto.requiredAssertions) ? dto.requiredAssertions : '?'} passed · Evidence ${dto.evidenceComplete ? 'complete' : 'incomplete'}${dto.uncertainEffect ? ' · an action has an uncertain effect' : ''}`,
    ]));

    // --- run actions
    const acts = h('div', { class: 'agent-run-actions' });
    const active = meta.group !== 'completed';
    if (active) {
      const cancelBtn = h('button', {
        class: 'btn btn-sm btn-danger', type: 'button', 'data-testid': 'agent-run-cancel', 'data-focus-key': 'cancel',
        disabled: !!dto.cancelRequested, html: `${agentIcon('stop', 13)}<span>${dto.cancelRequested ? 'Cancel requested' : 'Cancel run'}</span>`,
        on: { click: async () => {
          const res = await controller.cancelRun(runId);
          if (!res.ok) actions.toast && actions.toast(describeError(res.error), 'error');
        } },
      });
      acts.appendChild(cancelBtn);
    }
    for (const ap of controller.pendingApprovals().filter((a) => a.runId === runId)) {
      acts.appendChild(h('button', {
        class: 'btn btn-sm btn-primary', type: 'button', 'data-testid': 'agent-review-approval', 'data-focus-key': `approval-${ap.approvalId}`,
        html: `${agentIcon('approval', 13)}<span>Review approval request</span>`,
        on: { click: () => actions.openApproval && actions.openApproval(ap.approvalId) },
      }));
    }
    if (acts.childNodes.length) detailWrap.appendChild(acts);

    // --- uncertain step / recovery
    const unc = controller.uncertainStep(runId);
    if (dto.state === 'uncertain' || dto.state === 'interrupted' || dto.uncertainEffect || unc) renderRecovery(runId, dto, unc);

    // --- timeline
    renderTimeline(runId, view);
  }

  function renderCompleteness(comp) {
    if (comp.openGap) {
      detailWrap.appendChild(banner('warn', 'gap', `Events ${comp.openGap.from}–${comp.openGap.to} have not arrived yet. This timeline is incomplete until they do.`, 'agent-run-gap'));
    }
    for (const hole of comp.holes) {
      detailWrap.appendChild(banner('warn', 'gap', `Events ${hole.from}–${hole.to} are not available. ${hole.reason || ''} This timeline is incomplete.`, 'agent-run-hole'));
    }
    for (const n of comp.notices) {
      const range = n.from != null && n.to != null ? ` (events ${n.from}–${n.to})` : n.dropped != null ? ` (${plural(n.dropped, 'event')} dropped)` : '';
      detailWrap.appendChild(banner('warn', 'gap', `${n.summary}${range}`, 'agent-run-truncated'));
    }
    if (comp.droppedLocal) {
      detailWrap.appendChild(banner('warn', 'gap', `${plural(comp.droppedLocal, 'older event')} are not shown here to keep the panel responsive. The run journal still has them.`, 'agent-run-trimmed'));
    }
  }

  function renderRecovery(runId, dto, unc) {
    const proven = controller.lastProvenStep(runId);
    const box = h('section', { class: 'agent-recovery', 'aria-labelledby': 'agent-recovery-h', 'data-testid': 'agent-run-recovery' });
    box.appendChild(h('h4', { id: 'agent-recovery-h', html: `${agentIcon('warn', 14)}<span>Needs your decision</span>` }));
    const gone = unc && unc.error && (unc.error.code === 'STALE_REF' || unc.error.code === 'AMBIGUOUS_TARGET');
    const lines = [];
    lines.push(proven ? `Last proven result: ${proven.intent || shortId(proven.stepId, 24)} (confirmed${proven.outcome ? ': ' + proven.outcome : ''}).` : 'No step has been proven yet.');
    if (unc) {
      lines.push(`Uncertain step: ${unc.intent || shortId(unc.stepId, 24)}${unc.target && unc.target.name ? ` on “${unc.target.name}” (text from the page)` : ''}. It may or may not have taken effect.`);
    } else {
      lines.push('A step may have been dispatched without a confirmed result.');
    }
    if (gone) lines.push('The target is gone or changed. Re-observe the page instead of guessing another selector.');
    lines.push('Braiwser will not repeat this step on its own. Check the real state of the site first.');
    const p = h('div', { class: 'agent-recovery-text' }, lines.map((l) => h('p', { text: l })));
    box.appendChild(p);

    const owner = unc ? findOwner(unc, dto) : findOwner(null, dto);
    const choices = h('div', { class: 'agent-recovery-choices', role: 'group', 'aria-label': 'Safe next choices' });
    const result = h('div', { class: 'agent-recovery-result', role: 'status', 'aria-live': 'polite', 'data-testid': 'agent-recovery-result' });
    const reobs = h('button', {
      class: 'btn btn-sm btn-primary', type: 'button', 'data-testid': 'agent-recover-reobserve', 'data-focus-key': 'reobserve',
      disabled: !owner || !owner.pageId, title: owner && owner.pageId ? 'Take a fresh read-only observation. Nothing is clicked or re-sent.' : 'No live page is attached to this run',
      html: `${agentIcon('eye', 13)}<span>Re-observe</span>`,
      on: { click: async () => {
        result.textContent = 'Asking the runtime for a fresh observation…';
        const res = await controller.observe({ sessionId: owner.sessionId, pageId: owner.pageId });
        result.textContent = res.ok
          ? `Observation ${shortId(res.observation.observationId, 12)} at ${clockTime(res.observation.at)}: ${res.observation.nodeCount} elements${res.observation.truncated ? ' (truncated)' : ''}.`
          : describeError(res.error);
      } },
    });
    choices.appendChild(reobs);
    if (owner && owner.controller === 'agent') {
      choices.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', 'data-testid': 'agent-recover-takeover', 'data-focus-key': 'takeover',
        html: `${agentIcon('human', 13)}<span>Take control and check</span>`,
        on: { click: async () => {
          const res = await controller.takeControl({ sessionId: owner.sessionId, pageId: owner.pageId, runId, reason: 'Check an uncertain step' });
          result.textContent = res.ok ? 'Control is yours. The agent cannot act until you resume.' : describeError(res.error);
        } },
      }));
    }
    if (dto.state !== 'passed' && !dto.cancelRequested && runStateMeta(dto.state).group !== 'completed') {
      choices.appendChild(h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', 'data-testid': 'agent-recover-cancel', 'data-focus-key': 'recover-cancel',
        html: `${agentIcon('stop', 13)}<span>Cancel run</span>`, on: { click: () => controller.cancelRun(runId) },
      }));
    }
    box.appendChild(choices);
    box.appendChild(result);
    detailWrap.appendChild(box);
  }

  function findOwner(step, dto) {
    const sid = (dto && dto.sessionId) || '';
    let o = sid ? controller.getOwner(sid) : null;
    if (!o) o = controller.ownerList().find((x) => x.runId === dto.runId) || null;
    if (o && step && step.pageId && !o.pageId) return { ...o, pageId: step.pageId };
    return o;
  }

  function renderTimeline(runId, view) {
    const steps = controller.steps(runId);
    detailWrap.appendChild(h('h4', { class: 'agent-section-h', text: 'Actions' }));
    const ol = h('ol', { class: 'agent-timeline', 'aria-label': 'Actions in this run', 'data-testid': 'agent-run-timeline' });
    if (!steps.length) {
      ol.appendChild(h('li', { class: 'empty agent-empty', text: view.sync === 'loading' ? 'Reading the run journal…' : 'No actions recorded yet.' }));
    }
    for (const s of steps) ol.appendChild(stepItem(runId, view, s));
    detailWrap.appendChild(ol);

    const other = view.events.filter((e) => !e.stepId);
    if (other.length) {
      const det = h('details', { class: 'agent-log', 'data-testid': 'agent-run-log' }, [
        h('summary', { text: `Run log (${other.length})` }),
        h('ul', {}, other.slice(-100).map((e) => h('li', {}, [
          h('span', { class: 'agent-log-seq', text: `#${e.sequence}` }),
          h('span', { class: 'agent-log-kind', text: e.kind }),
          h('span', { text: e.summary }),
        ]))),
      ]);
      detailWrap.appendChild(det);
    }
  }

  function stepItem(runId, view, s) {
    const om = outcomeMeta(s.status === 'pending' || s.status === 'running' ? 'pending' : s.status);
    const running = s.status === 'running';
    const stateNode = running
      ? h('span', { class: 'agent-state agent-tone-accent', 'data-testid': 'agent-step-state', html: `${agentIcon('running', 13)}<span>Running</span>` })
      : h('span', { class: `agent-state agent-tone-${om.tone}`, 'data-testid': 'agent-step-state', html: `${agentIcon(om.icon, 13)}<span>${om.label}</span>` });
    const li = h('li', { class: 'agent-step', 'data-step-id': s.stepId, 'data-status': s.status, 'data-testid': 'agent-step' });
    li.appendChild(h('div', { class: 'agent-step-head' }, [
      h('span', { class: 'agent-step-n', text: String(s.order + 1) }),
      h('span', { class: 'agent-step-intent', 'data-testid': 'agent-step-intent', text: s.intent || `Step ${shortId(s.stepId, 24)}` }),
      stateNode,
    ]));
    const dl = h('dl', { class: 'agent-step-dl' });
    const add = (label, value, testid) => {
      if (value == null || value === '') return;
      dl.appendChild(h('dt', { text: label }));
      dl.appendChild(h('dd', { 'data-testid': testid }, [value]));
    };
    if (s.target) {
      const label = [s.target.role, s.target.name ? `“${s.target.name}”` : ''].filter(Boolean).join(' ');
      add('Target', h('span', {}, [label || s.target.ref || 'unnamed', h('span', { class: 'agent-untrusted', text: ' (name is text from the page)' }), s.target.frame ? ` · frame ${s.target.frame}` : '']), 'agent-step-target');
    }
    if (s.policy) add('Policy', [s.policy.decision, s.policy.reason].filter(Boolean).join(' — '), 'agent-step-policy');
    if (s.waitReason) add('Waited for', s.waitReason, 'agent-step-wait');
    if (s.outcome) add('Outcome', s.outcome, 'agent-step-outcome');
    if (s.effect) {
      const effectText = { notDispatched: 'Not dispatched', dispatched: 'Dispatched, not yet confirmed', confirmed: 'Confirmed', unknown: 'Unknown — it may have happened' }[s.effect] || s.effect;
      add('Effect', effectText, 'agent-step-effect');
    }
    if (s.error) add('Error', describeError(s.error), 'agent-step-error');
    li.appendChild(dl);

    const links = h('div', { class: 'agent-step-links' });
    const evBtn = (label, uri, key) => links.appendChild(h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', 'data-testid': `agent-evidence-${key}`, 'data-focus-key': `ev-${key}-${s.stepId}`,
      html: `${agentIcon('link', 12)}<span>${label}</span>`,
      title: uri, on: { click: () => actions.openEvidence && actions.openEvidence(uri) },
    }));
    if (s.before) evBtn('Before', s.before, 'before');
    if (s.after) evBtn('After', s.after, 'after');
    for (const [i, uri] of s.evidence.entries()) if (uri !== s.before && uri !== s.after) evBtn(`Evidence ${i + 1}`, uri, `n${i}`);
    if (!s.before && !s.after && !s.evidence.length && s.status !== 'pending' && s.status !== 'running') {
      links.appendChild(h('span', { class: 'agent-no-evidence', text: 'No evidence recorded for this step.' }));
    }
    if (actions.addFinding && s.status !== 'pending' && s.status !== 'running') {
      links.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', 'data-testid': 'agent-add-finding', 'data-focus-key': `finding-${s.stepId}`,
        html: `${agentIcon('note', 12)}<span>Add finding</span>`,
        on: { click: () => actions.addFinding({ run: view.dto, step: s, runId }) },
      }));
    }
    li.appendChild(links);
    return li;
  }

  render();
  return {
    root,
    render,
    refresh: () => controller.refreshRuns(),
    openRun: (id) => controller.openRun(id),
    destroy() { destroyed = true; unsub(); root.remove(); },
  };
}
