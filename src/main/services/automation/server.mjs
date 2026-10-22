#!/usr/bin/env node
// Single supervised owner. A sidecar disconnect is not browser cancellation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import brokerModule from '../browser/broker.js';
import driverModule from '../browser/drivers/playwright.js';
import skillsModule from './skill-registry.js';
import bridgeModule from './bridge-server.js';
import viewerModule from '../browser/viewer-gateway.js';
export { createOperations } from './operations.mjs';

// `proxy` deployment: a trusted server (OpenBot) relays an authenticated human over a private network.
// The shared secret is supplied by the supervisor, never written to disk, and the gateway is not public.
export async function startServer({ dataDir, port = 0, deployment = 'local', bindHost = '127.0.0.1', allowedHosts = [], proxyToken = null,
  principal, ownerId = 'local-owner', driverOptions = {}, featureFlag = true, idleMs = 300000, keepAlive = false, renewMs = 60 * 60 * 1000 } = {}) {
  if (!['local', 'proxy'].includes(deployment)) throw new Error('UNSUPPORTED: public viewer deployment has not passed its release gates');
  if (deployment === 'proxy' && (typeof proxyToken !== 'string' || proxyToken.length < 32)) throw new TypeError('proxy deployment requires a strong shared secret');
  if (deployment === 'proxy' && (typeof bindHost !== 'string' || !/^[0-9.]{7,15}$/.test(bindHost))) throw new TypeError('proxy deployment requires an explicit private bind address');
  if (!featureFlag) throw new Error('UNAVAILABLE: standalone runtime must be explicitly enabled');
  if (!dataDir || !principal?.id || principal.kind !== 'mcp' || !Array.isArray(principal.scopes)) {
    throw new TypeError('dataDir and an explicitly scoped MCP principal are required');
  }
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'owner.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  let broker, bridge, gateway, closed = false, idleTimer, renewTimer;
  const bridgeFile = path.join(dataDir, 'agent-bridge.json');
  const ownerFile = path.join(dataDir, 'viewer-owner.json');
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    clearInterval(renewTimer);
    try { await bridge?.close(); } finally {
      try { await gateway?.close(); } finally {
        try { await broker?.close(); } finally {
          for (const file of [bridgeFile, ownerFile]) fs.rmSync(file, { force: true });
          fs.closeSync(lock);
          fs.rmSync(lockPath, { force: true });
        }
      }
    }
  }
  try {
    broker = brokerModule.createBroker({ dataDir, featureFlag,
      limits: { assertionWaitMs: 1000 },
      drivers: { playwright: driverModule.createPlaywrightDriver(driverOptions) },
      skills: skillsModule.createBrokerSkills(), appVersion: 'braiwser-server' });
    const proxied = deployment === 'proxy';
    const ownerToken = proxied ? proxyToken : crypto.randomBytes(32).toString('base64url');
    gateway = viewerModule.createViewerGateway({ broker, port, host: proxied ? bindHost : '127.0.0.1',
      proxy: proxied ? { allowedHosts } : null,
      owner: { token: ownerToken, id: ownerId, principalId: principal.id } });
    const baseUrl = await gateway.listen();
    bridge = await bridgeModule.startBridge({ broker, infoDir: dataDir,
      defaultClient: { principal } });
    fs.writeFileSync(ownerFile, JSON.stringify({ version: 1, baseUrl, ownerId, ...(proxied ? {} : { token: ownerToken }) }), { mode: 0o600 });
    let lastBusy = Date.now();
    // A standing owner outlives its client's 8-hour credential: renew it well before it lapses so the
    // connected sidecar is never cut off. The token itself never changes or leaves the protected file.
    if (keepAlive && bridge.info) {
      renewTimer = setInterval(() => {
        try { bridge.renewClientFile(bridgeFile, bridge.info.token, { ttlMs: 8 * 60 * 60 * 1000 }); } catch { /* retried next interval */ }
      }, renewMs);
      renewTimer.unref();
    }
    if (!keepAlive) {
      idleTimer = setInterval(() => {
        if (broker.stats().sessions || bridge.connectionCount()) lastBusy = Date.now();
        else if (Date.now() - lastBusy > idleMs) void close();
      }, Math.max(100, Math.min(30000, idleMs / 3)));
      idleTimer.unref();
    }
    return { broker, bridge, gateway, baseUrl, bridgeFile, ownerFile, close,
      readiness: { ready: true, deployment, automationSchemaMajor: 1, handoffVersion: '2.1.0', watchVersion: proxied ? 1 : 0 } };
  } catch (error) { await close(); throw error; }
}

export async function main(env = process.env) {
  const config = JSON.parse(fs.readFileSync(env.BRAIWSER_SERVER_CONFIG, 'utf8'));
  const service = await startServer(config);
  process.stdout.write(`${JSON.stringify({ ...service.readiness, baseUrl: service.baseUrl,
    bridgeFile: service.bridgeFile, ownerFile: service.ownerFile })}\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return service;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Braiwser startup failed; inspect protected configuration and store lock.\n'); process.exitCode = 1; });
}
