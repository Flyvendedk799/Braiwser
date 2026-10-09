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

function startAgentRuntime({ repos, userDataDir, getWindow, enabled, isE2E = false, log = () => {} } = {}) {
  const { createBroker } = require('./broker');
  if (!enabled) {
    const broker = createBroker({ featureFlag: false });
    return { broker, enabled: false, attachHost: () => () => {}, bridge: null, close: async () => {} };
  }

  const { createDrivers } = require('./drivers');
  const { getSharedBroker } = require('./debugger-broker');
  const { createBrokerSkills } = require('../automation/skill-registry');

  const drivers = createDrivers({ electron: { debuggerBroker: getSharedBroker() } });
  const skills = createBrokerSkills({
    // Owner-scoped, synchronous lookup: only recordings the store knows, already
    // redacted by the repository's second boundary.
    loadRecording: (recordingId) => (repos && repos.recordings ? repos.recordings.get(recordingId) || null : null),
  });
  const broker = createBroker({
    featureFlag: true,
    dataDir: userDataDir,
    drivers: { playwright: drivers.playwright, 'electron-embedded': drivers['electron-embedded'] },
    skills,
    appVersion: process.versions.electron || 'dev',
  });

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
  const ready = (async () => {
    if (isE2E) return;
    try {
      const { startBridge } = require('../automation/bridge-server');
      // The default client file grants NO scopes: an external agent can connect
      // but is granted nothing until the owner widens it in the connection drawer.
      bridge = await startBridge({
        broker,
        infoDir: path.join(userDataDir, 'browser'),
        defaultClient: { principal: { id: 'mcp-default', kind: 'mcp', scopes: [] } },
      });
    } catch (err) {
      log('[agent-runtime] bridge unavailable: ' + ((err && err.message) || err));
    }
  })();

  return {
    broker,
    enabled: true,
    attachHost,
    get bridge() { return bridge; },
    ready,
    close: async () => {
      for (const off of unwatchers.splice(0)) { try { off(); } catch (_e) { /* destroyed */ } }
      try { if (bridge) await bridge.close(); } catch (_e) { /* ignore */ }
      try { await broker.close(); } catch (_e) { /* ignore */ }
    },
  };
}

module.exports = { startAgentRuntime };
