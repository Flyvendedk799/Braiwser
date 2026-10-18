'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskRunner } = require('../../src/main/services/agent/runtime');
const { createHttpProvider } = require('../../src/main/services/agent/providers/http');

const principal = { id: 'ui-1', kind: 'ui', scopes: ['ui'] };

function brokerWith(act) {
  let observations = 0;
  return {
    observations: () => observations,
    forPrincipal() {
      return {
        async observe() {
          observations += 1;
          return { observationId: 'ob_1', documentEpoch: 1, nodes: [{ ref: 'r1', name: 'Save' }] };
        },
        act,
      };
    },
  };
}

test('a scripted provider completes one action and drops reasoning', async () => {
  let steps = 0;
  const calls = [];
  const broker = brokerWith(async (input) => { calls.push(input.action.kind); return { status: 'done', effectUnknown: false }; });
  const runner = createTaskRunner({
    broker,
    provider: {
      async next() {
        steps += 1;
        if (steps > 1) return { type: 'done', summary: 'saved' };
        return { type: 'act', reasoning: 'secret chain', operationId: 'op_1', action: { kind: 'click', ref: 'r1' }, tokens: 3 };
      },
    },
  });
  const first = await runner.start({ goal: 'Press save', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_1' }, principal);
  assert.equal(first.status, 'passed');
  assert.deepEqual(calls, ['click']);
  assert.equal(JSON.stringify(first.messages).includes('secret chain'), false);
  const replay = await runner.start({ goal: 'Press save', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_1' }, principal);
  assert.equal(replay.taskId, first.taskId);
  await assert.rejects(
    () => runner.start({ goal: 'Press something else', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_1' }, principal),
    (err) => err.publicError && /IDEMPOTENCY_CONFLICT/.test(err.publicError.message),
  );
});

test('uncertain and approval stops are not retried', async () => {
  let acts = 0;
  const uncertain = createTaskRunner({
    broker: brokerWith(async () => { acts += 1; return { status: 'uncertain', effectUnknown: true }; }),
    provider: { async next() { return { type: 'act', action: { kind: 'click', ref: 'r1' } }; } },
  });
  const u = await uncertain.start({ goal: 'Click', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_u' }, principal);
  assert.equal(u.status, 'uncertain');
  assert.equal(u.uncertain, true);
  assert.equal(acts, 1);

  const approval = createTaskRunner({
    broker: brokerWith(async () => {
      const err = new Error('approval');
      err.publicError = { code: 'DENIED', message: 'approval required', retry: 'after-approval', dispatched: false, effectUnknown: false };
      throw err;
    }),
    provider: { async next() { return { type: 'act', action: { kind: 'click', ref: 'r1' } }; } },
  });
  const a = await approval.start({ goal: 'Click', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_a' }, principal);
  assert.equal(a.status, 'needsApproval');
});

test('a step budget and a deadline both end as timedOut', async () => {
  const budget = createTaskRunner({
    broker: brokerWith(async () => ({ status: 'done', effectUnknown: false })),
    provider: { async next() { return { type: 'act', action: { kind: 'click', ref: 'r1' } }; } },
    budgets: { maxSteps: 2, maxDurationMs: 5000, maxTokens: 100 },
  });
  const b = await budget.start({ goal: 'Loop', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_b' }, principal);
  assert.equal(b.status, 'timedOut');
  assert.equal(b.steps, 2);

  const stalled = createTaskRunner({
    broker: brokerWith(async () => ({ status: 'done' })),
    provider: { next({ signal }) { return new Promise((_, reject) => { signal.addEventListener('abort', () => { const e = new Error('cancelled'); e.cancelled = true; reject(e); }); }); } },
    budgets: { maxDurationMs: 30 },
  });
  const t = await stalled.start({ goal: 'Wait', sessionId: 'bs_1', pageId: 'pg_1', requestKey: 'rk_t' }, principal);
  assert.equal(t.status, 'timedOut');
});

test('the http provider returns a closed decision and strips reasoning', async () => {
  let seen;
  const provider = createHttpProvider({
    endpoint: 'https://example.test/v1/chat',
    model: 'fixture',
    fetchImpl: async (_url, init) => {
      seen = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ type: 'done', summary: 'saved', reasoning: 'hide me' }) } }],
          usage: { total_tokens: 11 },
        }),
      };
    },
  });
  const decision = await provider.next({
    task: { messages: [{ role: 'user', content: 'Press save' }] },
    observation: { observationId: 'ob_1', nodes: [] },
  });
  assert.equal(decision.type, 'done');
  assert.equal(decision.summary, 'saved');
  assert.equal(decision.reasoning, undefined);
  assert.equal(decision.tokens, 11);
  assert.equal(seen.messages[0].content.includes('Never include reasoning'), true);
});
