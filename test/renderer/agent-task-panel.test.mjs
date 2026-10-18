import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAgentDom, load, click, q } from './agent-dom-env.mjs';

setupAgentDom();
const { createAgentTaskPanel } = await load('components/agent-task-panel.js');
const { CH } = await load('lib/agent-bridge.js');

test('the task composer sends a goal through the trusted bridge and shows the runner status', async () => {
  const calls = [];
  const bridge = {
    async invoke(channel, payload) {
      calls.push([channel, payload]);
      return { taskId: 'tk_1', status: 'passed', uncertain: false };
    },
  };
  const panel = createAgentTaskPanel({
    bridge,
    getScope: () => ({ sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_panel', provider: 'fixture', origin: 'https://app.test' }),
  });
  document.body.appendChild(panel.root);
  assert.match(q('.agent-task-scope').textContent, /fixture/);
  q('.agent-task-goal').value = 'Check the save button';
  click(q('.agent-task button.btn'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls[0][0], CH.taskStart);
  assert.equal(calls[0][1].goal, 'Check the save button');
  assert.equal(calls[0][1].sessionId, 'bs_1');
  assert.match(q('.agent-task-status').textContent, /passed/);
  panel.destroy();
});
