import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/main/services/automation/mcp.mjs';

// Real MCP client <-> real adapter server over the SDK's in-memory transport.
export async function connect(broker, principal, options = {}) {
  const server = createMcpServer(broker, { principal, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args, extra) => {
    const r = await client.callTool({ name, arguments: args }, undefined, extra);
    return r;
  };
  // Unwraps the typed envelope; throws if the tool reported an error.
  const ok = async (name, args) => {
    const r = await call(name, args);
    if (r.isError || !r.structuredContent.ok) throw new Error(`${name} failed: ${JSON.stringify(r.structuredContent || r.content)}`);
    return r.structuredContent.value;
  };
  const fail = async (name, args) => {
    const r = await call(name, args);
    if (!r.isError) throw new Error(`${name} unexpectedly succeeded`);
    return r;
  };
  return { client, server, call, ok, fail, close: async () => { await client.close(); await server.close(); } };
}

export async function openPage(h, extra = {}) {
  return h.ok('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'interact'] }, ...extra });
}
