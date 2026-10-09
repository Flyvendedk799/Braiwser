// Owner / status strip, shown above the status bar while an agent session exists.
//   target origin · headed/headless/attached adapter · who controls the page
//   Observe · Pause · Stop · Take control   (Resume while the human has control)
//
// The strip renders the runtime's owner record, never its own guess: it flips to
// "Human control" only once the runtime says so and back to "Agent control" only
// on a Resume the runtime confirmed. While the human is in control the
// agent-facing controls (Observe / Pause / Take control) are disabled.
// Screenshot previews are timestamped snapshots and say they are not live.
import { h } from '../lib/dom.js';
import {
  agentIcon, controllerMeta, adapterLabel, originOf, clockTime, safeImageSrc, describeError, shortId,
} from '../lib/agent-ui.js';

export function createOwnerStrip({ controller, actions = {} }) {
  let selected = null;
  let message = '';
  let messageKind = 'info';
  let lastController = null;

  const picker = h('select', { class: 'select agent-strip-picker', 'aria-label': 'Agent session', 'data-testid': 'agent-strip-session', hidden: '' });
  picker.addEventListener('change', () => { selected = picker.value; render(); });
  const badge = h('span', { class: 'agent-badge', 'data-testid': 'agent-strip-controller' });
  const origin = h('span', { class: 'agent-strip-origin', 'data-testid': 'agent-strip-origin' });
  const adapter = h('span', { class: 'status-chip', 'data-testid': 'agent-strip-adapter' });
  const runLabel = h('span', { class: 'agent-strip-run', 'data-testid': 'agent-strip-run' });
  const previewImg = h('img', { class: 'agent-strip-shot', alt: '', 'data-testid': 'agent-strip-preview', hidden: '' });
  const previewCap = h('span', { class: 'agent-strip-cap', 'data-testid': 'agent-strip-preview-caption' });
  const note = h('div', { class: 'agent-strip-note', role: 'status', 'aria-live': 'polite', 'data-testid': 'agent-strip-note' });

  function btn(id, label, ic, onClick) {
    return h('button', {
      class: 'btn btn-sm agent-strip-btn', type: 'button', 'data-action': id, 'data-testid': `agent-strip-${id}`,
      html: `${agentIcon(ic, 13)}<span>${label}</span>`,
      on: { click: onClick },
    });
  }
  const observeBtn = btn('observe', 'Observe', 'eye', () => doObserve());
  const pauseBtn = btn('pause', 'Pause', 'pause', () => {});
  const stopBtn = btn('stop', 'Stop', 'stop', () => doStop());
  const takeBtn = btn('take-control', 'Take control', 'human', () => doTake());
  const resumeBtn = btn('resume', 'Resume', 'agent', () => doResume());
  const btnBar = h('div', { class: 'agent-strip-btns', role: 'group', 'aria-label': 'Agent session controls' }, [observeBtn, pauseBtn, stopBtn, takeBtn, resumeBtn]);

  const root = h('section', {
    class: 'agent-strip', role: 'region', 'aria-label': 'Agent session status', 'data-testid': 'agent-strip', hidden: '',
  }, [
    h('div', { class: 'agent-strip-row' }, [picker, badge, origin, adapter, runLabel, h('span', { class: 'tb-spacer' }), btnBar]),
    h('div', { class: 'agent-strip-row agent-strip-sub' }, [previewImg, previewCap, note]),
  ]);

  function setMessage(text, kind = 'info') {
    message = text || '';
    messageKind = kind;
    render();
  }

  const owner = () => (selected ? controller.getOwner(selected) : null);

  function caps() { return controller.state.capabilities || {}; }
  function handoffMode(o) { return (o && o.humanHandoff) || caps().humanHandoff || ''; }

  async function doTake() {
    const o = owner();
    if (!o) return;
    setMessage('Asking the runtime to stop the agent and hand the page to you…');
    const res = await controller.takeControl({ sessionId: o.sessionId, pageId: o.pageId, runId: o.runId, reason: 'Take control' });
    if (!res.ok) setMessage(describeError(res.error), 'error');
    else setMessage(res.method === 'checkpoint-relaunch'
      ? 'Control is yours. This session resumes from a checkpoint relaunch, so live page state is not preserved.'
      : 'Control is yours. The agent cannot act until you resume.', 'info');
  }

  async function doResume() {
    const o = owner();
    if (!o) return;
    setMessage('Asking the runtime to re-observe the page before the agent acts…');
    const res = await controller.resume({ sessionId: o.sessionId, pageId: o.pageId });
    if (!res.ok) { setMessage(describeError(res.error), 'error'); return; }
    const fresh = res.reply && typeof res.reply.observationId === 'string' && res.reply.observationId;
    const now = controller.getOwner(o.sessionId);
    if (!now || now.controller !== 'agent') setMessage('Resume was accepted but the runtime has not confirmed agent control yet.', 'warn');
    else if (!fresh) setMessage('The agent has control again, but the runtime did not report a fresh observation. Earlier element references were invalidated.', 'warn');
    else setMessage(`Fresh observation ${shortId(fresh, 12)} recorded. The agent has control again.`, 'info');
  }

  async function doStop() {
    const o = owner();
    if (!o || !o.runId) return;
    setMessage('Requesting cancellation…');
    const res = await controller.cancelRun(o.runId);
    if (!res.ok) setMessage(describeError(res.error), 'error');
    else setMessage('Cancellation requested. Future actions are stopped; anything already dispatched is not undone.', 'info');
  }

  async function doObserve() {
    const o = owner();
    if (!o) return;
    setMessage('Asking the runtime for a fresh observation…');
    const res = await controller.observe({ sessionId: o.sessionId, pageId: o.pageId });
    if (!res.ok) { setMessage(describeError(res.error), 'error'); return; }
    const ob = res.observation;
    setMessage(`Observation ${shortId(ob.observationId, 12)} at ${clockTime(ob.at)}: ${ob.nodeCount} elements${ob.truncated ? ' (truncated)' : ''}. This is a snapshot, not live.`, 'info');
  }

  function setBtn(b, enabled, why) {
    b.disabled = !enabled;
    b.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    if (why) b.title = why; else b.removeAttribute('title');
  }

  function render() {
    const list = controller.ownerList();
    if (!list.length) { root.setAttribute('hidden', ''); selected = null; return; }
    if (!selected || !list.some((o) => o.sessionId === selected)) selected = list[list.length - 1].sessionId;
    // Several sessions can run in parallel: the picker chooses which one the
    // strip describes. Switching browser tabs never changes it.
    if (list.length > 1) {
      picker.removeAttribute('hidden');
      picker.textContent = '';
      list.forEach((o) => {
        const opt = h('option', { value: o.sessionId, text: `${shortId(o.sessionId, 12)} · ${originOf(o.url) || 'no page'}` });
        if (o.sessionId === selected) opt.selected = true;
        picker.appendChild(opt);
      });
    } else picker.setAttribute('hidden', '');

    const o = controller.getOwner(selected);
    root.removeAttribute('hidden');
    const cm = controllerMeta(o.controller);
    badge.className = `agent-badge agent-badge-${cm.tone}`;
    badge.innerHTML = `${agentIcon(cm.icon, 13)}<span>${cm.label}</span>`;
    badge.dataset.controller = o.controller;
    origin.textContent = originOf(o.url) || 'No page yet';
    origin.title = o.url || '';
    adapter.textContent = adapterLabel(o);
    runLabel.textContent = o.runId ? `Run ${shortId(o.runId, 12)}` : '';
    if (lastController !== o.controller) { message = ''; lastController = o.controller; }
    let derived = o.currentAction ? `Now: ${o.currentAction}` : (o.reason ? o.reason : '');

    const agentOn = controller.agentControlsEnabled(o.sessionId);
    const human = o.controller === 'human';
    const hm = handoffMode(o);
    const busy = !!o.busy;

    takeBtn.hidden = human;
    resumeBtn.hidden = !human;
    setBtn(observeBtn, agentOn && !!o.pageId && !busy, agentOn ? 'Take a fresh read-only observation of the page' : 'Disabled while you or the runtime hold control');
    setBtn(pauseBtn, false, 'Pause is not supported by this runtime build. Use Take control to stop the agent and act yourself.');
    setBtn(stopBtn, !!o.runId && !busy, o.runId ? 'Cancel the run. Already-dispatched actions are not undone.' : 'No run is attached to this session');
    setBtn(takeBtn, agentOn && hm !== 'unsupported' && o.controller === 'agent',
      hm === 'unsupported' ? 'This adapter cannot hand the page to a person.'
        : o.controller === 'quarantined' ? 'Quarantined: unavailable until the runtime reconciles the in-flight action.'
          : o.controller === 'handoff-pending' ? 'Handover in progress.' : '');
    setBtn(resumeBtn, human && !busy, 'The runtime re-observes the page and invalidates earlier element references first.');

    const src = o.preview ? safeImageSrc(o.preview.src) : '';
    if (src) {
      const at = clockTime(o.preview.capturedAt);
      previewImg.removeAttribute('hidden');
      previewImg.src = src;
      previewImg.alt = at ? `Snapshot of the page taken at ${at}. Not live.` : 'Snapshot of the page. Not live.';
      previewCap.textContent = at ? `Snapshot ${at} · not live` : 'Snapshot · not live';
    } else {
      previewImg.setAttribute('hidden', '');
      previewImg.removeAttribute('src');
      previewCap.textContent = '';
    }

    if (human) derived = 'You have control. The agent cannot act. Resume asks the runtime to re-observe the page before the agent continues.';
    if (o.controller === 'quarantined') derived = 'Quarantined: an action may still be in flight. Nothing is replayed automatically.';
    if (o.controller === 'handoff-pending') derived = 'Waiting for in-flight agent work to stop before handing the page to you.';
    note.textContent = message || derived;
    note.dataset.kind = message ? messageKind : 'info';
  }

  const unsub = controller.subscribe((ev) => { if (ev.type === 'owner' || ev.type === 'capabilities' || ev.type === 'status') render(); });
  render();

  return {
    root, render, setMessage,
    select(sessionId) { selected = sessionId; message = ''; render(); },
    destroy() { unsub(); root.remove(); },
  };
}
