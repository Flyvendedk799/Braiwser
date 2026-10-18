// One report of what this install can actually do. It does not launch a browser
// and it does not treat a missing binary as a different browser.
'use strict';
const { PROTOCOL_VERSION } = require('../../../shared/handoff-contracts');

function packageVersion() {
  try { return require('../../../../package.json').version; } catch { return 'unknown'; }
}

function doctorReport({ env = process.env, viewerBaseUrl = null, deployment = 'local' } = {}) {
  const remote = deployment === 'remote' || env.BRAIWSER_DEPLOYMENT === 'remote';
  const origin = viewerBaseUrl || env.BRAIWSER_VIEWER_ORIGIN || null;
  const loopback = typeof origin === 'string' && /127\.0\.0\.1|localhost|\[::1\]/.test(origin);
  let viewer = 'not-configured';
  if (remote && loopback) viewer = 'VIEWER_UNREACHABLE';
  else if (origin) viewer = remote ? 'remote-https' : 'loopback';
  return {
    protocol: PROTOCOL_VERSION,
    runtime: packageVersion(),
    driver: 'playwright',
    deployment: remote ? 'remote' : 'local',
    viewerBaseUrl: viewer === 'VIEWER_UNREACHABLE' ? null : origin,
    viewer,
    authentication: origin && viewer !== 'VIEWER_UNREACHABLE' ? 'redeem-once' : 'not-ready',
    unsupported: ['multi-user', 'checkpoint-relaunch', 'mobile-control'],
    agentRuntime: env.BRAIWSER_AGENT_RUNTIME === '1' ? 'enabled' : 'disabled-by-default',
  };
}

module.exports = { doctorReport };
