'use strict';
// Trusted-shell IPC for the agent runtime UI: sender validation, argument
// validation, ui principal, approval digest gate, pushes to the shell only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserIpc, isTrustedSender, publicError, CHANNELS, PUSH, UI_PRINCIPAL } = require('../../src/main/ipc/browser');

function harness({ flag = true, broker } = {}) {
  const sent = [];
  const mainFrame = { processId: 1, routingId: 1, parent: null };
  const wc = { id: 7, send: (c, p) => sent.push([c, p]), isDestroyed: () => false, getType: () => 'window', mainFrame };
  const win = { webContents: wc, isDestroyed: () => false };
  const calls = [];
  const events = new EventEmitter();
  const b = broker || {
    events,
    forPrincipal(principal) {
      calls.push(['forPrincipal', principal]);
      const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret; };
      return {
        listRuns: rec('listRuns', [{ runId: 'r1', state: 'running' }]),
        getRun: rec('getRun', { runId: 'r1', state: 'running', events: [] }),
        cancelRun: rec('cancelRun', { runId: 'r1', cancelRequested: true }),
        handoff: rec('handoff', { owner: 'human', documentEpoch: 2, method: 'native' }),
        resume: rec('resume', { owner: 'agent', documentEpoch: 3 }),
        observe: rec('observe', { observationId: 'ob_1', nodes: [] }),
        approve: rec('approve', {}),
        readResource: rec('readResource', (uri) => ({ uri })),
      };
    },
  };
  let now = 1_000_000;
  const ipc = createBrowserIpcFor({ b, win, flag: () => flag, now: () => now, handle: undefined });
  return { ipc, sent, wc, win, mainFrame, calls, events: b.events, b, setNow: (n) => { now = n; }, ev: { sender: wc, senderFrame: mainFrame } };
}

function createBrowserIpcFor({ b, win, flag, now }) {
  const registered = new Map();
  const ipcMain = { handle: (c, fn) => registered.set(c, fn), removeHandler: (c) => registered.delete(c) };
  const api = createBrowserIpc({ ipcMain, getWindow: () => win, broker: b, flag, now, isShellWebContents: (wc) => wc === win.webContents });
  api.registered = registered;
  return api;
}

const call = (h, channel, payload, event) => h.ipc.registered.get(channel)(event || h.ev, payload);

test('registers exactly the browser:* channels', () => {
  const h = harness();
  assert.deepEqual([...h.ipc.registered.keys()].sort(), Object.values(CHANNELS).sort());
  assert.ok([...h.ipc.registered.keys()].every((c) => c.startsWith('browser:')));
});

test('sender validation: guests, subframes, other windows and missing frames are refused before any broker call', async () => {
  const h = harness();
  const guest = { id: 9, send() {}, isDestroyed: () => false, getType: () => 'webview', mainFrame: {} };
  const bad = [
    { sender: guest, senderFrame: { parent: null } },
    { sender: h.wc, senderFrame: { processId: 1, routingId: 2, parent: h.mainFrame } },
    { sender: h.wc, senderFrame: null },
    { sender: { ...h.wc, id: 99 }, senderFrame: h.mainFrame },
    { sender: h.wc, senderFrame: { processId: 5, routingId: 5, parent: null } },
    {},
  ];
  for (const e of bad) {
    const r = await call(h, CHANNELS.runCancel, { runId: 'r1' }, e);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'DENIED');
  }
  assert.equal(h.calls.length, 0, 'broker never touched');
  assert.equal(isTrustedSender(h.ev, h.win), true);
  assert.equal(isTrustedSender(h.ev, { ...h.win, isDestroyed: () => true }), false);
});

test('every command goes through broker.forPrincipal with the ui principal', async () => {
  const h = harness();
  await call(h, CHANNELS.runsList, {});
  await call(h, CHANNELS.runGet, { runId: 'r1', afterSequence: 4, maxEvents: 50 });
  await call(h, CHANNELS.runCancel, { runId: 'r1' });
  await call(h, CHANNELS.handoff, { sessionId: 's1', pageId: 'p1', reason: 'check login' });
  await call(h, CHANNELS.resume, { sessionId: 's1', pageId: 'p1' });
  await call(h, CHANNELS.observe, { sessionId: 's1', pageId: 'p1', maxNodes: 50 });
  await call(h, CHANNELS.capabilities, {});
  const principals = h.calls.filter((c) => c[0] === 'forPrincipal');
  assert.equal(principals.length, 7);
  for (const p of principals) {
    assert.deepEqual(p[1], UI_PRINCIPAL);
    assert.equal(p[1].kind, 'ui');
  }
  const get = h.calls.find((c) => c[0] === 'getRun');
  assert.deepEqual(get[1], { runId: 'r1', afterSequence: 4, maxEvents: 50 });
});

test('argument validation rejects before the broker is touched', async () => {
  const h = harness();
  const cases = [
    [CHANNELS.runGet, { runId: '../etc/passwd' }],
    [CHANNELS.runGet, { runId: 'r1', maxEvents: 5000 }],
    [CHANNELS.runGet, { runId: 'r1', afterSequence: -1 }],
    [CHANNELS.runGet, { runId: 'r1', extra: 1 }],
    [CHANNELS.runGet, 'r1'],
    [CHANNELS.runGet, [1]],
    [CHANNELS.runCancel, {}],
    [CHANNELS.handoff, { sessionId: 's1' }],
    [CHANNELS.handoff, { sessionId: 's1', pageId: 'p1', reason: 'x'.repeat(500) }],
    [CHANNELS.resume, { sessionId: 's1', pageId: 'p 1' }],
    [CHANNELS.observe, { sessionId: 's1', pageId: 'p1', maxNodes: 99999 }],
    [CHANNELS.resourceRead, { uri: 'file:///etc/passwd' }],
    [CHANNELS.resourceRead, { uri: 'braiwser://runs/../x/manifest' }],
    [CHANNELS.approvalDecide, { approvalId: 'ap', decision: 'maybe' }],
    [CHANNELS.connectionRevoke, { clientId: '' }],
  ];
  for (const [ch, payload] of cases) {
    const r = await call(h, ch, payload);
    assert.equal(r.ok, false, `${ch} ${JSON.stringify(payload)}`);
    assert.equal(r.error.code, 'DENIED');
    assert.match(r.error.message, /^Invalid request/);
  }
  assert.equal(h.calls.filter((c) => c[0] !== 'forPrincipal').length, 0);
});

test('flag off or no broker: UNAVAILABLE, nothing runs', async () => {
  const off = harness({ flag: false });
  const r = await call(off, CHANNELS.runsList, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNAVAILABLE');
  assert.equal(off.calls.length, 0);
  const st = await call(off, CHANNELS.status, {});
  assert.equal(st.data.enabled, false);

  const none = createBrowserIpc({ ipcMain: { handle() {}, removeHandler() {} }, getWindow: () => null, broker: null, flag: () => true, getBroker: () => null });
  assert.equal(none.handlers[CHANNELS.status]().enabled, false);
});

test('errors: broker public errors pass through; internal errors do not leak', async () => {
  const h = harness({
    broker: {
      events: new EventEmitter(),
      forPrincipal: () => ({
        cancelRun: async () => { throw Object.assign(new Error('boom /secret/path'), { publicError: { code: 'TIMEOUT', message: 'Took too long', dispatched: true, effectUnknown: true, retry: 'safe-read', stack: 'x' } }); },
        getRun: async () => { throw new Error('ENOENT: C:\\Users\\me\\secret.json'); },
      }),
    },
  });
  const a = await call(h, CHANNELS.runCancel, { runId: 'r1' });
  assert.deepEqual(a.error, { code: 'TIMEOUT', message: 'Took too long', dispatched: true, effectUnknown: true, retry: 'safe-read' });
  const b = await call(h, CHANNELS.runGet, { runId: 'r1' });
  assert.equal(b.error.code, 'INTERNAL');
  assert.equal(JSON.stringify(b).includes('secret'), false);
  assert.equal(publicError({ publicError: { code: 'NOT_A_CODE' } }).code, 'INTERNAL');
});

// ---- approvals -----------------------------------------------------------------------
const approval = (over = {}) => ({ approvalId: 'ap_1', runId: 'r1', sessionId: 's1', pageId: 'p1', actionDigest: 'dig1', documentEpoch: 3, expiresAt: 1_000_000 + 60_000, action: { kind: 'click', label: 'Buy' }, ...over });

test('approval-decide: unknown id (forged), wrong digest, expired, wrong epoch are all denied without calling broker.approve', async () => {
  const h = harness();
  h.events.emit('approval-requested', approval());
  assert.equal(h.sent.at(-1)[0], PUSH.approval, 'announced to the shell');

  let r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_forged', decision: 'allow', actionDigest: 'dig1' });
  assert.match(r.error.message, /not known/);
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig-OTHER' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /action changed/);
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow' });
  assert.equal(r.ok, false, 'a missing digest never matches');
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1', documentEpoch: 4 });
  assert.match(r.error.message, /page changed/);
  h.setNow(1_000_000 + 61_000);
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1' });
  assert.match(r.error.message, /expired/);
  assert.equal(h.calls.filter((c) => c[0] === 'approve').length, 0);
});

test('approval-decide: matching digest reaches broker.approve exactly once; replay is refused', async () => {
  const h = harness();
  h.events.emit('approval-requested', approval());
  const r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1', documentEpoch: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { approvalId: 'ap_1', decision: 'allow', status: 'allowed' });
  const approves = h.calls.filter((c) => c[0] === 'approve');
  assert.equal(approves.length, 1);
  assert.deepEqual(approves[0][1], { approvalId: 'ap_1', decision: 'allow' });
  const again = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1' });
  assert.equal(again.ok, false);
  assert.equal(h.calls.filter((c) => c[0] === 'approve').length, 1);
});

test('approval-decide: deny does not need a digest; a broker refusal leaves the approval pending', async () => {
  const h = harness();
  h.events.emit('approval-requested', approval());
  const r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'deny' });
  assert.equal(r.ok, true);

  const h2 = harness({
    broker: {
      events: new EventEmitter(),
      forPrincipal: () => ({ approve: async () => { throw Object.assign(new Error('x'), { publicError: { code: 'DENIED', message: 'Policy changed', dispatched: false, effectUnknown: false, retry: 'never' } }); } }),
    },
  });
  h2.b.events.emit('approval-requested', approval());
  const bad = await call(h2, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.message, 'Policy changed');
  assert.equal(h2.ipc._approvals.get('ap_1').status, 'pending');
});

test('approvals are withdrawn when control moves to the human or the session closes', async () => {
  const h = harness();
  h.events.emit('approval-requested', approval());
  h.events.emit('owner-changed', { sessionId: 's1', pageId: 'p1', owner: 'human' });
  let r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_1', decision: 'allow', actionDigest: 'dig1' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /already been answered or withdrawn/);

  h.events.emit('approval-requested', approval({ approvalId: 'ap_2' }));
  h.events.emit('owner-changed', { sessionId: 's1', pageId: 'p1', owner: 'agent', documentEpoch: 9 });
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_2', decision: 'allow', actionDigest: 'dig1' });
  assert.equal(r.ok, false, 'new document epoch withdraws it');

  h.events.emit('approval-requested', approval({ approvalId: 'ap_3' }));
  h.events.emit('session-closed', { sessionId: 's1' });
  r = await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_3', decision: 'allow', actionDigest: 'dig1' });
  assert.equal(r.ok, false);
});

test('approvals-pending returns only approvals still pending', async () => {
  const h = harness();
  h.events.emit('approval-requested', approval());
  h.events.emit('approval-requested', approval({ approvalId: 'ap_2' }));
  await call(h, CHANNELS.approvalDecide, { approvalId: 'ap_2', decision: 'deny' });
  const r = await call(h, CHANNELS.approvalsPending, {});
  assert.deepEqual(r.data.approvals.map((a) => a.approvalId), ['ap_1']);
});

// ---- pushes ----------------------------------------------------------------------------
test('broker events are forwarded to the shell window only, and only while the flag is on', () => {
  const h = harness();
  h.events.emit('run-event', { runId: 'r1', event: { sequence: 1, kind: 'run.started' } });
  h.events.emit('owner-changed', { sessionId: 's1', owner: 'agent' });
  h.events.emit('session-closed', { sessionId: 's1' });
  assert.deepEqual(h.sent.map((s) => s[0]), [PUSH.runEvent, PUSH.owner, PUSH.sessionClosed]);
  h.events.emit('run-event', { notARun: true });
  assert.equal(h.sent.length, 3, 'payload without a runId is dropped');
});

test('no push when the window is gone, destroyed, or not a registered shell', () => {
  const h = harness();
  const gone = createBrowserIpc({ ipcMain: { handle() {}, removeHandler() {} }, getWindow: () => null, broker: h.b, flag: () => true });
  h.events.emit('run-event', { runId: 'r1' });
  assert.equal(h.sent.length, 1, 'registered window still receives');
  gone.dispose();
  const sent = [];
  const events = new EventEmitter();
  const wc = { id: 3, send: (c, p) => sent.push([c, p]), isDestroyed: () => false };
  const ipc2 = createBrowserIpc({ ipcMain: { handle() {}, removeHandler() {} }, getWindow: () => ({ webContents: wc, isDestroyed: () => false }), broker: { events, forPrincipal() {} }, flag: () => true, isShellWebContents: () => false });
  events.emit('run-event', { runId: 'r1' });
  assert.equal(sent.length, 0, 'not a registered shell => nothing sent');
  ipc2.dispose();
  const ipc3 = createBrowserIpc({ ipcMain: { handle() {}, removeHandler() {} }, getWindow: () => ({ webContents: wc, isDestroyed: () => true }), broker: { events, forPrincipal() {} }, flag: () => true });
  events.emit('run-event', { runId: 'r1' });
  assert.equal(sent.length, 0, 'destroyed window => nothing sent');
  ipc3.dispose();
});

test('dispose removes broker listeners and ipc handlers', () => {
  const h = harness();
  assert.ok(h.events.listenerCount('run-event') >= 1);
  h.ipc.dispose();
  assert.equal(h.events.listenerCount('run-event'), 0);
  assert.equal(h.events.listenerCount('approval-requested'), 0);
  assert.equal(h.ipc.registered.size, 0);
});

test('connections: unsupported broker reports supported:false; enable/revoke are UNSUPPORTED, not silently ok', async () => {
  const h = harness();
  const list = await call(h, CHANNELS.connections, {});
  assert.deepEqual(list.data, { supported: false, connections: [] });
  const r = await call(h, CHANNELS.connectionRevoke, { clientId: 'c1' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNSUPPORTED');
});

test('connections: supported broker lists, enables and revokes through the ui principal', async () => {
  const log = [];
  const h = harness({
    broker: {
      events: new EventEmitter(),
      forPrincipal: (p) => ({
        listConnections: async () => [{ clientId: 'c1', client: 'CLI', status: 'pending', scope: ['observe'] }],
        enableConnection: async (a) => { log.push(['enable', p.kind, a]); return {}; },
        revokeConnection: async (a) => { log.push(['revoke', p.kind, a]); return {}; },
      }),
    },
  });
  assert.equal((await call(h, CHANNELS.connections, {})).data.connections[0].clientId, 'c1');
  await call(h, CHANNELS.connectionEnable, { clientId: 'c1' });
  await call(h, CHANNELS.connectionRevoke, { clientId: 'c1' });
  assert.deepEqual(log, [['enable', 'ui', { clientId: 'c1' }], ['revoke', 'ui', { clientId: 'c1' }]]);
});

test('resource-read accepts only run evidence URIs and bounds the reply', async () => {
  const h = harness();
  const ok = await call(h, CHANNELS.resourceRead, { uri: 'braiwser://runs/r1/observations/ob_1' });
  assert.equal(ok.ok, true);
  const big = harness({ broker: { events: new EventEmitter(), forPrincipal: () => ({ readResource: async () => 'x'.repeat(400 * 1024) }) } });
  const r = await call(big, CHANNELS.resourceRead, { uri: 'braiwser://runs/r1/manifest' });
  assert.equal(r.ok, true);
  assert.equal(r.data.truncated, true);
});
