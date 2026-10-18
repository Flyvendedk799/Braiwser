// FakeBrokerBridge: an in-memory stand-in for the `agentRuntime` preload facade
// ({ invoke(channel,payload), on(channel,cb) }) so the Agent Runs UI can be
// verified without the runtime. It speaks the same wire format the main-process
// handlers do: { ok:true, data } | { ok:false, error }.
//
// It is deliberately a simple model, not a broker: tests script its behaviour
// (journal contents, dropped replies, held replies, pushes) to hit the cases the
// UI must handle honestly.

export class FakeBrokerBridge {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.runs = new Map(); // runId -> { dto, journal: [event] }
    this.approvals = [];
    this.connections = { supported: true, connections: [] };
    this.capabilities = { driver: 'playwright', humanHandoff: 'native', modes: ['headless'] };
    this.calls = []; // [{ channel, payload }]
    this.listeners = new Map(); // channel -> Set(cb)
    this.hold = new Map(); // channel -> { promise, release }  (reply delayed until release())
    this.fail = new Map(); // channel -> error DTO  (reply { ok:false })
    this.noReply = new Set(); // channels that resolve undefined (transport gave nothing)
    this.throwTransport = new Set(); // channels where invoke itself rejects
    this.handlers = {};
    this.facade = { invoke: (c, p) => this.invoke(c, p), on: (c, cb) => this.on(c, cb) };
  }

  // ---- scripting helpers -----------------------------------------------------
  addRun(dto, journal = []) {
    const run = {
      dto: {
        runId: dto.runId, state: 'running', verdict: 'pending', sequence: journal.length, cancelRequested: false,
        planned: 0, executed: 0, passed: 0, skipped: 0, cancelled: 0, timedOut: 0, failed: 0, unknown: 0, pending: 0,
        requiredAssertions: 0, passedAssertions: 0, evidenceComplete: false, uncertainEffect: false,
        deadlineAt: new Date(Date.now() + 60000).toISOString(), events: [], nextSequence: journal.length,
        manifestUri: `braiwser://runs/${dto.runId}/manifest`, ...dto,
      },
      journal: journal.slice(),
    };
    this.runs.set(dto.runId, run);
    return run;
  }

  holdChannel(channel) {
    let release;
    const promise = new Promise((r) => { release = r; });
    this.hold.set(channel, { promise, release });
    return release;
  }

  // Push a main -> shell event to subscribers.
  emit(channel, payload) {
    for (const cb of Array.from(this.listeners.get(channel) || [])) cb(JSON.parse(JSON.stringify(payload)));
  }

  listenerCount(channel) {
    if (channel) return (this.listeners.get(channel) || new Set()).size;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  callsTo(channel) { return this.calls.filter((c) => c.channel === channel); }

  // ---- facade ------------------------------------------------------------------
  on(channel, cb) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel).add(cb);
    return () => this.listeners.get(channel).delete(cb);
  }

  async invoke(channel, payload) {
    this.calls.push({ channel, payload });
    if (this.throwTransport.has(channel)) throw new Error('transport down');
    const h = this.hold.get(channel);
    if (h) { this.hold.delete(channel); await h.promise; }
    if (this.noReply.has(channel)) return undefined;
    if (this.fail.has(channel)) return { ok: false, error: this.fail.get(channel) };
    try {
      const data = await this.dispatch(channel, payload || {});
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.publicError || { code: 'INTERNAL', message: 'fake failure', dispatched: false, effectUnknown: false, retry: 'never' } };
    }
  }

  async dispatch(channel, p) {
    if (this.handlers[channel]) return this.handlers[channel](p, this);
    switch (channel) {
      case 'browser:status': return { enabled: this.enabled, flagOn: this.enabled, brokerAvailable: true, source: 'setting', reason: '' };
      case 'browser:runs-list': return { runs: Array.from(this.runs.values()).map((r) => ({ ...r.dto, events: [] })) };
      case 'browser:run-get': {
        const r = this.runs.get(p.runId);
        if (!r) throw Object.assign(new Error('x'), { publicError: { code: 'DENIED', message: 'Unknown run', dispatched: false, effectUnknown: false, retry: 'never' } });
        const after = p.afterSequence || 0;
        const events = r.journal.filter((e) => e.sequence > after).slice(0, p.maxEvents || 100);
        return { ...r.dto, events, nextSequence: events.length ? events[events.length - 1].sequence : after };
      }
      case 'browser:run-cancel': {
        const r = this.runs.get(p.runId);
        r.dto.cancelRequested = true;
        return { ...r.dto, events: [] };
      }
      case 'browser:approvals-pending': return { approvals: this.approvals };
      case 'browser:capabilities': return this.capabilities;
      case 'browser:connections': return this.connections;
      case 'browser:connection-enable':
      case 'browser:connection-revoke': {
        const c = this.connections.connections.find((x) => x.clientId === p.clientId);
        if (c) c.status = channel.endsWith('enable') ? 'active' : 'revoked';
        return {};
      }
      case 'browser:session-handoff': return { owner: 'human', documentEpoch: 7, method: 'native' };
      case 'browser:session-resume': return { owner: 'agent', documentEpoch: 8, observationId: 'ob_fresh_1' };
      case 'browser:approval-decide': return { approvalId: p.approvalId, decision: p.decision, status: p.decision === 'allow' ? 'allowed' : 'denied' };
      case 'browser:observe': return { observationId: 'ob_9', url: 'https://example.test/', documentEpoch: 8, nodes: [{}, {}, {}], truncated: false, evidenceUri: 'braiwser://runs/r1/observations/ob_9' };
      case 'browser:resource-read': return { uri: p.uri, note: 'fake evidence' };
      default: throw new Error(`FakeBrokerBridge: unscripted channel ${channel}`);
    }
  }
}

// ---- event builders --------------------------------------------------------------
export const ev = (sequence, kind, extra = {}) => ({ sequence, kind, summary: extra.summary || kind, ...extra });

export const approvalPayload = (over = {}) => ({
  approvalId: 'ap_1', runId: 'r1', sessionId: 's1', pageId: 'p1', origin: 'https://shop.example.test',
  action: { kind: 'click', label: 'Place order', target: 'Buy now' }, destination: 'https://shop.example.test/checkout',
  dataSummary: 'Order of 2 items, total 41.00 USD', scope: ['click on shop.example.test'], expiresAt: Date.now() + 120000,
  actionDigest: 'dig_aaaa1111', documentEpoch: 3, ...over,
});

export const ownerPayload = (over = {}) => ({
  sessionId: 's1', pageId: 'p1', owner: 'agent', mode: 'headless', driver: 'playwright', url: 'https://shop.example.test/cart',
  runId: 'r1', documentEpoch: 3, ...over,
});
