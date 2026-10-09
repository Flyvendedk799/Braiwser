#!/usr/bin/env node
// Stdio MCP entrypoint ("sidecar"). It owns NO browser, NO store and NO ledger:
// it authenticates to the single owning broker (the running Braiwser app) over
// the local bridge and serves the MCP tools on stdin/stdout.
//
//   command: node
//   args:    [".../src/main/services/automation/sidecar.mjs"]
//   env:     BRAIWSER_BRIDGE_INFO=<path to the connection file Braiwser wrote>
//
// stdout is reserved for protocol messages. Anything that would print there is
// redirected to stderr before any other module can log.
import { pathToFileURL } from 'node:url';

const toStderr = (...args) => process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
console.log = toStderr; console.info = toStderr; console.debug = toStderr;

export async function main(env = process.env) {
  const bridge = (await import('./bridge.js')).default;
  const { serveStdio } = await import('./mcp.mjs');
  const debug = env.BRAIWSER_MCP_DEBUG === '1';
  const log = debug ? (event) => toStderr('[braiwser-mcp]', event) : undefined;

  let facade;
  try {
    const info = bridge.loadConnectionInfo(env);
    facade = await bridge.connectBridge(info);
  } catch (error) {
    // Never print the token or the file's contents.
    toStderr(`[braiwser-mcp] cannot connect to Braiwser: ${(error.publicError && error.publicError.message) || error.message}`);
    toStderr('[braiwser-mcp] Start Braiwser with the agent runtime enabled and set BRAIWSER_BRIDGE_INFO to its connection file.');
    return 1;
  }
  const server = await serveStdio(facade, { log });
  const shutdown = async () => { try { await facade.close(); } catch { /* ignore */ } };
  server.server.onclose = () => { shutdown().finally(() => process.exit(0)); };
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { if (code) process.exit(code); }).catch((error) => {
    toStderr(`[braiwser-mcp] fatal: ${error && error.message}`);
    process.exit(1);
  });
}
