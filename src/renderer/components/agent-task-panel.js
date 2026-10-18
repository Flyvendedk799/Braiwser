// Layer 1 task composer. It starts work through the trusted shell bridge and
// shows the runner's status. It does not talk to a provider itself.
import { h } from '../lib/dom.js';
import { CH } from '../lib/agent-bridge.js';

const STARTERS = [
  ['Inspect this flow', 'Inspect the open page and report what a person can do.'],
  ['Reproduce a bug', 'Reproduce the visible failure and stop when you can name the step.'],
  ['Verify a fix', 'Run the frozen checks and report expected versus actual.'],
];

export function createAgentTaskPanel({ bridge, getScope = () => ({}), onStatus = () => {} } = {}) {
  const goal = h('textarea', {
    class: 'agent-task-goal', rows: '3', 'aria-label': 'Task for the in-app agent',
    placeholder: 'What should the agent do in this browser?',
  });
  const status = h('p', { class: 'agent-task-status', role: 'status', text: 'Idle' });
  const scope = h('p', { class: 'agent-task-scope' });
  const start = h('button', { type: 'button', class: 'btn primary', text: 'Start task' });
  const starters = h('div', { class: 'agent-task-starters' }, STARTERS.map(([label, text]) => h('button', {
    type: 'button', class: 'agent-chip', text: label,
    on: { click: () => { goal.value = text; goal.focus(); } },
  })));
  const root = h('section', { class: 'agent-task', 'data-testid': 'agent-task-panel' }, [
    h('h3', { text: 'Agent task' }),
    scope,
    starters,
    goal,
    h('div', { class: 'agent-task-actions' }, [start]),
    status,
  ]);

  function paintScope() {
    const s = getScope() || {};
    const parts = [];
    if (s.provider) parts.push(s.provider);
    if (s.origin) parts.push(s.origin);
    if (s.profile) parts.push(s.profile);
    scope.textContent = parts.length ? parts.join(' · ') : 'Provider, origin and profile appear here before a task starts.';
  }
  paintScope();

  let busy = false;
  start.addEventListener('click', async () => {
    if (busy) return;
    const text = goal.value.trim();
    if (!text) { status.textContent = 'Write a task first.'; return; }
    const s = getScope() || {};
    if (!s.sessionId || !s.pageId) { status.textContent = 'Choose a browser session before starting.'; return; }
    busy = true;
    start.disabled = true;
    status.textContent = 'Running…';
    try {
      const result = await bridge.invoke(CH.taskStart, {
        goal: text, sessionId: s.sessionId, pageId: s.pageId, requestKey: s.requestKey || `task_${Date.now()}`,
      });
      status.textContent = `${result.status}${result.uncertain ? ' · effect uncertain' : ''}`;
      onStatus(result);
    } catch (err) {
      status.textContent = err && err.message ? err.message : 'The task did not start.';
    } finally {
      busy = false;
      start.disabled = false;
    }
  });

  return { root, paintScope, destroy() { root.remove(); } };
}
