import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAgent } from '../../integrations/harness-poll.mjs';

test('the harness polls status and returns when the agent owns the session again', async () => {
  const seen = [];
  const value = await waitForAgent({
    intervalMs: 1,
    status: async (id) => {
      seen.push(id);
      return seen.length < 2
        ? { handoffId: id, state: 'paused', controlOwner: 'paused' }
        : { handoffId: id, state: 'closed', controlOwner: 'agent' };
    },
    handoffId: 'ho_test',
  });
  assert.equal(value.controlOwner, 'agent');
  assert.deepEqual(seen, ['ho_test', 'ho_test']);
});
