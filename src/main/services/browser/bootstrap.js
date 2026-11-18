'use strict';
// Main-process bootstrap for the agent runtime. The ONE place that builds the
// broker, so MCP, CLI, skills and the Braiwser UI all share a single owner.
//
//   const runtime = startAgentRuntime({ repos, userDataDir, getWindow, log });
//   runtime.broker                       -> createBroker() result (or a disabled broker)
//   runtime.attachHost(webContents)      -> register <webview> guests of the shell window
//   await runtime.close()
//
// Off by default: when the flag is off nothing here touches the disk or opens a
// socket. Under e2e the broker exists (the UI is exercised) but the local bridge
// is never started.

const path = require('node:path');

// "class:observe,origin:http://localhost:3000,review:read" -> validated scope list.
// Classes are limited to the ones a default client may reasonably hold; submit,
// download, upload, credentials and preview-edit are never granted from an
// environment variable.
const DEFAULT_CLIENT_CLASSES = ['observe', 'navigate', 'interact'];
function parseDefaultScopes(raw) {
  const scopes = [];
  const rejected = [];
  for (const part of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50)) {
    let ok = false;
    if (part === 'review:read' || part === 'review:write') ok = true;
    else if (part.startsWith('class:')) ok = DEFAULT_CLIENT_CLASSES.includes(part.slice(6));
    else if (part.startsWith('origin:')) {
      try {
        const u = new URL(part.slice(7));
        ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.origin === part.slice(7).replace(/\/$/, '');
      } catch (_e) { ok = false; }
    }
    if (ok && !scopes.includes(part)) scopes.push(part.replace(/\/$/, '')); else if (!ok) rejected.push(part);
  }
  return { scopes, rejected };
}

function startAgentRuntime({ repos, userDataDir, getWindow, enabled, isE2E = false, log = () => {}, env = process.env } = {}) {
  const { createBroker } = require('./broker');
  if (!enabled) {
    const broker = createBroker({ featureFlag: false });
    return { broker, enabled: false, attachHost: () => () => {}, bridge: null, close: async () => {} };
  }

  const { createDrivers } = require('./drivers');
  const { getSharedBroker } = require('./debugger-broker');
  const { createBrokerSkills } = require('../automation/skill-registry');
  const { createGuestViews } = require('./guest-views');
  const guestViews = createGuestViews({ getWindow });

  const drivers = createDrivers({
    electron: {
      debuggerBroker: getSharedBroker(),
      createGuest: () => guestViews.create(),
    },
  });
  // The review an agent may read and report on: this app's own project store.
  let review = null;
  try {
    if (repos && repos.annotations && repos.recordings) review = require('../review/source').createStoreSource({ repos });
  } catch (err) {
    log('[agent-runtime] review source unavailable: ' + ((err && err.message) || err));
  }
  const skills = createBrokerSkills({
    // Owner-scoped, synchronous lookup: only recordings the store knows, already
    // redacted by the repository's second boundary.
    loadRecording: (recordingId) => (repos && repos.recordings ? repos.recordings.get(recordingId) || null : null),
    loadNote: (noteId) => (review ? review.loadNote(noteId) : null),
  });
  const brokerOptions = {
    featureFlag: true,
    dataDir: userDataDir,
    drivers: { playwright: drivers.playwright, 'electron-embedded': drivers['electron-embedded'] },
    skills,
    review,
    appVersion: process.versions.electron || 'dev',
    taskRunner: null,
  };
  const broker = createBroker(brokerOptions);
  if (process.env.BRAIWSER_AGENT_PROVIDER_URL) {
    const { createTaskRunner } = require('../agent/runtime');
    const { createHttpProvider } = require('../agent/providers/http');
    brokerOptions.taskRunner = createTaskRunner({
      broker,
      provider: createHttpProvider({
        endpoint: process.env.BRAIWSER_AGENT_PROVIDER_URL,
        apiKey: process.env.BRAIWSER_AGENT_PROVIDER_KEY || '',
        model: process.env.BRAIWSER_AGENT_MODEL || 'default',
      }),
    });
  }

  const unwatchers = [];
  const attachHost = (host) => {
    try {
      const off = drivers['electron-embedded'].watchHost(host);
      unwatchers.push(off);
      return off;
    } catch (err) {
      log('[agent-runtime] could not watch host: ' + ((err && err.message) || err));
      return () => {};
    }
  };

  let bridge = null;
  let gateway = null;
  const ready = (async () => {
    if (isE2E) return;
    try {
      const { createViewerGateway } = require('./viewer-gateway');
      gateway = createViewerGateway({ broker, host: '127.0.0.1', port: 0 });
      await gateway.listen();
    } catch (err) {
      log('[agent-runtime] viewer unavailable: ' + ((err && err.message) || err));
    }
    try {
      const { startBridge } = require('../automation/bridge-server');
      // The default client file grants NO scopes unless the person starting the app
      // names them (BRAIWSER_AGENT_SCOPES): an external agent can connect but is
      // granted nothing by default. Only well-formed scopes are accepted; a
      // malformed entry is dropped and logged, never widened.
      const { scopes, rejected } = parseDefaultScopes(env.BRAIWSER_AGENT_SCOPES);
      if (rejected.length) log('[agent-runtime] ignored ' + rejected.length + ' malformed entr' + (rejected.length === 1 ? 'y' : 'ies') + ' in BRAIWSER_AGENT_SCOPES');
      bridge = await startBridge({
        broker,
        infoDir: path.join(userDataDir, 'browser'),
        defaultClient: { principal: { id: 'mcp-default', kind: 'mcp', scopes } },
      });
    } catch (err) {
      log('[agent-runtime] bridge unavailable: ' + ((err && err.message) || err));
    }
  })();

  return {
    broker,
    enabled: true,
    guestViews,
    attachHost,
    get bridge() { return bridge; },
    ready,
    close: async () => {
      for (const off of unwatchers.splice(0)) { try { off(); } catch (_e) { /* destroyed */ } }
      try { guestViews.closeAll(); } catch (_e) { /* ignore */ }
      try { if (gateway) await gateway.close(); } catch (_e) { /* ignore */ }
      try { if (bridge) await bridge.close(); } catch (_e) { /* ignore */ }
      try { await broker.close(); } catch (_e) { /* ignore */ }
    },
  };
}

module.exports = { startAgentRuntime, parseDefaultScopes };
