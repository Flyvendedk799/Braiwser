// In-app task loop. The provider proposes a typed action; the broker is the
// only thing that can perform it. Model reasoning is dropped and never stored.
'use strict';
const C = require('../../../shared/browser-contracts');

function createTaskRunner({ broker, provider, clock = { now: () => Date.now() }, budgets = {} } = {}) {
  const tasks = new Map();
  const limits = {
    maxSteps: budgets.maxSteps || 8,
    maxDurationMs: budgets.maxDurationMs || 120000,
    maxTokens: budgets.maxTokens || 20000,
  };

  function publicTask(task) {
    return {
      taskId: task.taskId,
      status: task.status,
      sessionId: task.sessionId,
      pageId: task.pageId,
      steps: task.steps,
      tokens: task.tokens,
      uncertain: task.uncertain === true,
      lastResult: task.lastResult,
      messages: task.messages.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  async function runLoop(task, signal) {
    const facade = broker.forPrincipal(task.principal);
    while (task.status === 'running' && !signal.aborted && task.steps < limits.maxSteps && task.tokens < limits.maxTokens) {
      let observation;
      try {
        observation = await facade.observe({ sessionId: task.sessionId, pageId: task.pageId, maxNodes: 40 }, { signal });
      } catch (e) {
        if (signal.aborted && String(signal.reason || '') === 'DEADLINE') { task.status = 'timedOut'; task.lastResult = 'timedOut'; return; }
        if (signal.aborted) { task.status = 'cancelled'; task.lastResult = 'cancelled'; return; }
        task.status = 'failed';
        task.lastResult = (e.publicError && e.publicError.message) || 'observe failed';
        return;
      }
      let decision;
      try {
        decision = await provider.next({ task: publicTask(task), observation, signal });
      } catch (e) {
        if (signal.aborted && String(signal.reason || '') === 'DEADLINE') { task.status = 'timedOut'; task.lastResult = 'timedOut'; return; }
        if (e && e.cancelled || signal.aborted) { task.status = 'cancelled'; task.lastResult = 'cancelled'; return; }
        task.status = e && e.timedOut ? 'timedOut' : 'failed';
        task.lastResult = task.status;
        return;
      }
      if (decision && Object.prototype.hasOwnProperty.call(decision, 'reasoning')) delete decision.reasoning;
      if (decision && Number.isFinite(decision.tokens)) task.tokens += decision.tokens;
      if (!decision || decision.type === 'done') {
        task.status = 'passed';
        task.lastResult = String((decision && decision.summary) || 'done').slice(0, 500);
        task.messages.push({ role: 'assistant', content: task.lastResult });
        return;
      }
      if (decision.type !== 'act' || !decision.action) {
        task.status = 'failed';
        task.lastResult = 'provider returned an unknown decision';
        return;
      }
      task.steps += 1;
      task.messages.push({ role: 'assistant', content: `act ${decision.action.kind}`.slice(0, 200) });
      try {
        const receipt = await facade.act({
          sessionId: task.sessionId,
          pageId: task.pageId,
          observationId: observation.observationId,
          documentEpoch: observation.documentEpoch,
          operationId: decision.operationId || `${task.taskId}.${task.steps}`,
          action: decision.action,
        }, { signal });
        task.lastResult = { status: receipt.status, code: receipt.code, effectUnknown: receipt.effectUnknown === true };
        if (receipt.status === 'uncertain' || receipt.effectUnknown) {
          task.status = 'uncertain';
          task.uncertain = true;
          return;
        }
      } catch (e) {
        if (e.publicError && e.publicError.retry === 'after-approval') {
          task.status = 'needsApproval';
          task.lastResult = 'waiting for a one-use approval';
          return;
        }
        task.status = e.publicError && e.publicError.code === 'CANCELLED' ? 'cancelled' : 'failed';
        task.lastResult = (e.publicError && e.publicError.message) || 'act failed';
        return;
      }
    }
    if (task.status !== 'running') return;
    if (signal.aborted) task.status = String(signal.reason || '') === 'DEADLINE' ? 'timedOut' : 'cancelled';
    else task.status = 'timedOut';
  }

  async function start(input, principal, signal) {
    if (!input || typeof input.goal !== 'string' || !input.goal.trim()) throw C.invalid('goal');
    if (!C.isClientId(input.sessionId) || !C.isClientId(input.pageId) || !C.isClientId(input.requestKey)) throw C.invalid('task');
    if (!provider || typeof provider.next !== 'function') throw C.brokerError('UNAVAILABLE', 'no provider adapter is configured', { detail: 'NO_PROVIDER' });
    const digest = C.sha256({ sessionId: input.sessionId, pageId: input.pageId, goal: input.goal });
    const key = `${principal.id}:${input.requestKey}`;
    for (const existing of tasks.values()) {
      if (existing.key !== key) continue;
      if (existing.digest !== digest) throw C.brokerError('DENIED', 'IDEMPOTENCY_CONFLICT: task request changed', { detail: 'IDEMPOTENCY_CONFLICT' });
      return publicTask(existing);
    }
    const task = {
      taskId: C.newId('task'), key, digest, principal, sessionId: input.sessionId, pageId: input.pageId,
      status: 'running', steps: 0, tokens: 0, uncertain: false, lastResult: null,
      messages: [{ role: 'user', content: input.goal.slice(0, 4000) }],
      startedAt: clock.now(),
    };
    tasks.set(task.taskId, task);
    const controller = new AbortController();
    task.controller = controller;
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    const timer = setTimeout(() => controller.abort('DEADLINE'), limits.maxDurationMs);
    try { await runLoop(task, controller.signal); }
    finally { clearTimeout(timer); }
    return publicTask(task);
  }

  function cancel(taskId) {
    const task = tasks.get(taskId);
    if (!task) return null;
    if (task.controller) task.controller.abort('CANCELLED');
    if (task.status === 'running') task.status = 'cancelled';
    return publicTask(task);
  }

  return {
    start, cancel,
    get(taskId) { const task = tasks.get(taskId); return task ? publicTask(task) : null; },
  };
}

module.exports = { createTaskRunner };
