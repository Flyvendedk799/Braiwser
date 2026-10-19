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

export async function startServer({ dataDir, port = 0, deployment = 'local',
  principal, ownerId = 'local-owner', driverOptions = {}, featureFlag = true, idleMs = 300000 } = {}) {
  if (deployment !== 'local') throw new Error('UNSUPPORTED: hosted viewer deployment has not passed its release gates');
  if (!featureFlag) throw new Error('UNAVAILABLE: standalone runtime must be explicitly enabled');
  if (!dataDir || !principal?.id || principal.kind !== 'mcp' || !Array.isArray(principal.scopes)) {
    throw new TypeError('dataDir and an explicitly scoped MCP principal are required');
  }
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'owner.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  let broker, bridge, gateway, closed = false, idleTimer;
  const bridgeFile = path.join(dataDir, 'agent-bridge.json');
  const ownerFile = path.join(dataDir, 'viewer-owner.json');
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
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
    const ownerToken = crypto.randomBytes(32).toString('base64url');
    gateway = viewerModule.createViewerGateway({ broker, port,
      owner: { token: ownerToken, id: ownerId, principalId: principal.id } });
    const baseUrl = await gateway.listen();
    bridge = await bridgeModule.startBridge({ broker, infoDir: dataDir,
      defaultClient: { principal } });
    fs.writeFileSync(ownerFile, JSON.stringify({ version: 1, baseUrl, ownerId, token: ownerToken }), { mode: 0o600 });
    let lastBusy = Date.now();
    idleTimer = setInterval(() => {
      if (broker.stats().sessions || bridge.connectionCount()) lastBusy = Date.now();
      else if (Date.now() - lastBusy > idleMs) void close();
    }, Math.max(100, Math.min(30000, idleMs / 3)));
    idleTimer.unref();
    return { broker, bridge, gateway, baseUrl, bridgeFile, ownerFile, close,
      readiness: { ready: true, deployment: 'local', automationSchemaMajor: 1, handoffVersion: '2.1.0' } };
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
