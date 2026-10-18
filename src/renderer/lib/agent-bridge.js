// The renderer's only door to the agent runtime. It speaks to the narrow
// `agentRuntime` facade exposed by the shell preload (invoke/on over `browser:`
// channels) and enforces one rule above all: a missing, malformed or rejected
// reply is an ERROR. It is never turned into `{ ok: true }`.

export const CH = Object.freeze({
  status: 'browser:status',
  runsList: 'browser:runs-list',
  runGet: 'browser:run-get',
  runCancel: 'browser:run-cancel',
  handoff: 'browser:session-handoff',
  resume: 'browser:session-resume',
  approvalDecide: 'browser:approval-decide',
  approvalsPending: 'browser:approvals-pending',
  capabilities: 'browser:capabilities',
  connections: 'browser:connections',
  connectionEnable: 'browser:connection-enable',
  connectionRevoke: 'browser:connection-revoke',
  resourceRead: 'browser:resource-read',
  observe: 'browser:observe',
  taskStart: 'browser:task-start',
  // pushed main -> shell
  evRun: 'browser:run-event',
  evApproval: 'browser:approval-requested',
  evOwner: 'browser:owner-changed',
  evSession: 'browser:session-closed',
});

export class AgentBridgeError extends Error {
  constructor(info = {}) {
    super(typeof info.message === 'string' && info.message ? info.message : 'The agent runtime did not answer.');
    this.name = 'AgentBridgeError';
    this.code = info.code || 'UNAVAILABLE';
    this.dispatched = !!info.dispatched;
    this.effectUnknown = !!info.effectUnknown;
    this.retry = info.retry || 'never';
    // True when there was no usable reply at all (transport failure / malformed).
    this.replyMissing = !!info.replyMissing;
  }
}

export function createAgentBridge(api) {
  const facade = api && typeof api.invoke === 'function' ? api : null;
  return {
    available: !!facade,
    async invoke(channel, payload) {
      if (!facade) throw new AgentBridgeError({ code: 'UNAVAILABLE', message: 'The agent runtime is not available in this window.', replyMissing: true });
      let reply;
      try {
        reply = await facade.invoke(channel, payload === undefined ? {} : payload);
      } catch (err) {
        // The command may or may not have reached the broker: say so.
        throw new AgentBridgeError({
          code: 'UNAVAILABLE',
          message: 'Lost contact with the agent runtime. The command may or may not have been delivered.',
          effectUnknown: true,
          replyMissing: true,
        });
      }
      if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
        throw new AgentBridgeError({ code: 'UNAVAILABLE', message: 'The agent runtime sent an unreadable reply.', effectUnknown: true, replyMissing: true });
      }
      if (!reply.ok) throw new AgentBridgeError(reply.error || {});
      return reply.data;
    },
    on(channel, cb) {
      if (!facade || typeof facade.on !== 'function') return () => {};
      const off = facade.on(channel, cb);
      return typeof off === 'function' ? off : () => {};
    },
  };
}
