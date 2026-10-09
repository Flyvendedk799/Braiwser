// A deliberately dumb stdio MCP server used to drive scripts/run.mjs. It does NOT
// use the adapter (so it can emit run DTOs the adapter's own guards would refuse).
// run.mjs forwards only BRAIWSER_BRIDGE_INFO, so the scenario is delivered as the
// JSON file that variable points at: { start, statuses[], cancel, log }.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.BRAIWSER_BRIDGE_INFO, 'utf8'));
const log = (entry) => { if (scenario.log) appendFileSync(scenario.log, `${JSON.stringify(entry)}\n`); };
const env = () => ({ info: process.env.BRAIWSER_BRIDGE_INFO, leak: process.env.LEAK_CANARY });
let i = 0;
const server = new McpServer({ name: 'fixture', version: '0.0.0' });
const wrap = (v) => (v && v.ok !== undefined ? v : { ok: true, value: v, error: null });
const reply = (v) => { const value = wrap(v); return { structuredContent: value, isError: value.ok === false, content: [{ type: 'text', text: JSON.stringify(value) }] }; };
const loose = z.object({}).passthrough();

server.registerTool('browser_run', { inputSchema: loose }, async (args) => { log({ tool: 'browser_run', args, env: env() }); return reply(scenario.start); });
server.registerTool('browser_run_status', { inputSchema: loose }, async (args) => {
  log({ tool: 'browser_run_status', args, env: env() });
  const list = scenario.statuses || [];
  const item = list[Math.min(i, list.length - 1)];
  i += 1;
  return reply(item);
});
server.registerTool('browser_run_cancel', { inputSchema: loose }, async (args) => { log({ tool: 'browser_run_cancel', args, env: env() }); return reply(scenario.cancel); });
await server.connect(new StdioServerTransport());
