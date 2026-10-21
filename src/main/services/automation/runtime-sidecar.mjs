#!/usr/bin/env node
// Trusted supervisor entrypoint: co-locates owner and sidecar in one namespace.
// Existing descriptors are never silently replaced after a broker loss.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main as sidecar } from './sidecar.mjs';
import bridge from './bridge.js';

const expectedRevision = process.env.BRAIWSER_EXPECTED_REVISION;
if (expectedRevision) {
  const installed = fs.readFileSync(new URL('../../../../runtime-revision', import.meta.url), 'utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(expectedRevision) || installed !== expectedRevision) throw new Error('Pinned Braiwser runtime revision mismatch');
}
const config = JSON.parse(process.env.BRAIWSER_RUNTIME_CONFIG || '{}');
if (!config.dataDir || !config.principal) throw new Error('Trusted runtime config required');
// A supervisor in another namespace (the OpenBot server outside a desk container) cannot see this
// runtime's browser path; the installer recorded it beside the checkout.
if (!config.driverOptions?.executablePath) {
  try {
    const installed = JSON.parse(fs.readFileSync(new URL('../../../../runtime-browser.json', import.meta.url), 'utf8'));
    if (typeof installed.executablePath === 'string' && installed.executablePath) config.driverOptions = { ...config.driverOptions, executablePath: installed.executablePath };
  } catch { /* the driver falls back to its own discovery */ }
}
const dir = path.resolve(config.dataDir);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const info = path.join(dir, 'agent-bridge.json');
const deadline = Date.now() + 15000;
if (!fs.existsSync(info) && !fs.existsSync(path.join(dir, 'owner.lock'))) {
  const configFile = path.join(dir, 'server-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, BRAIWSER_SERVER_CONFIG: configFile }, detached: true,
    windowsHide: true, stdio: 'ignore',
  });
  child.unref();
}
while (!fs.existsSync(info) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
if (!fs.existsSync(info)) throw new Error('Owner readiness timed out; reconcile lost context before restart');
const probe = await bridge.connectBridge(bridge.readConnectionInfo(info));
await probe.close();
process.env.BRAIWSER_BRIDGE_INFO = info;
const code = await sidecar();
if (code) process.exitCode = code;
