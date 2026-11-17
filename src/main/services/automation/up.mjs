#!/usr/bin/env node
// One command for an MCP client: start (or attach to) a standalone Braiwser owner and
// speak MCP on stdio.
//
//   braiwser mcp --origin http://localhost:3000 [--review ./review]
//
// It only builds the trusted runtime configuration from flags the PERSON typed into
// their MCP client's config and hands over to runtime-sidecar.mjs, which co-locates the
// owner and the sidecar. Nothing here can be reached by a model: there is no tool that
// changes origins, classes or the review directory after start.
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage: braiwser mcp --origin URL [--origin URL ...] [options]

Starts a headless, supervised browser owner and serves MCP on stdio.

  --origin URL        A site the agent may open (scheme + host + port). Repeatable. Required.
  --classes LIST      What it may do there: observe,navigate,interact,submit (default: observe,navigate,interact)
  --review DIR        A directory of exported .braiwser.json bundles: the notes and journeys the agent may read
  --review-read-only  The agent may read the review but not claim, propose or report on notes
  --data DIR          Where the owner keeps its ledger, evidence and review state (default: ~/.braiwser/runtime)
  --chromium PATH     Chromium/Chrome executable (default: PLAYWRIGHT_CHROMIUM_EXECUTABLE, else Playwright's)
  --no-browser-sandbox  Only inside a container that is itself the boundary (Chromium cannot sandbox as root)
  --print-config      Print the configuration that would be used and exit
  --help

Example (Claude Code):
  claude mcp add braiwser -- npx -y github:Flyvendedk799/Braiwser braiwser mcp --origin http://localhost:3000 --review ./review`;

const CLASSES = ['observe', 'navigate', 'interact', 'submit'];

export class UsageError extends Error {}

function originOf(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new UsageError(`--origin is not an address: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError(`--origin must be http(s): ${raw}`);
  if (u.username || u.password) throw new UsageError('--origin must not carry credentials');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new UsageError(`--origin is a site, not a page (drop the path): ${raw}`);
  return u.origin;
}

// Pure: flags -> the runtime configuration. Throws UsageError with a message for the person.
export function buildConfig(argv, { env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      origin: { type: 'string', multiple: true }, classes: { type: 'string' }, review: { type: 'string' },
      'review-read-only': { type: 'boolean' }, data: { type: 'string' }, chromium: { type: 'string' },
      'no-browser-sandbox': { type: 'boolean' }, 'print-config': { type: 'boolean' }, help: { type: 'boolean' } } });
  } catch (error) { throw new UsageError(error.message); }
  const v = parsed.values;
  const [command, ...extra] = parsed.positionals;
  if (v.help || command === 'help') return { help: true };
  if (command !== 'mcp') throw new UsageError(command ? `Unknown command: ${command}` : 'Missing command: mcp');
  if (extra.length) throw new UsageError(`Unexpected argument: ${extra[0]}`);
  const origins = [...new Set((v.origin || []).map(originOf))];
  if (!origins.length) throw new UsageError('At least one --origin is required: the agent is granted no site by default.');
  if (origins.length > 20) throw new UsageError('At most 20 origins.');
  const classes = (v.classes ? v.classes.split(',').map((c) => c.trim()).filter(Boolean) : ['observe', 'navigate', 'interact']);
  for (const c of classes) if (!CLASSES.includes(c)) throw new UsageError(`Unknown class "${c}". Allowed: ${CLASSES.join(', ')}`);
  const abs = (p) => path.resolve(cwd, p);
  const scopes = [...new Set(classes)].map((c) => `class:${c}`).concat(origins.map((o) => `origin:${o}`));
  const config = {
    dataDir: v.data ? abs(v.data) : path.join(home, '.braiwser', 'runtime'),
    ownerId: 'local-owner',
    principal: { id: 'local-agent', kind: 'mcp', scopes },
  };
  if (v.review) {
    config.reviewDir = abs(v.review);
    scopes.push('review:read');
    if (!v['review-read-only']) scopes.push('review:write');
  } else if (v['review-read-only']) {
    throw new UsageError('--review-read-only needs --review DIR');
  }
  const executablePath = v.chromium ? abs(v.chromium) : env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const driverOptions = {};
  if (executablePath) driverOptions.executablePath = executablePath;
  if (v['no-browser-sandbox']) driverOptions.chromiumSandbox = false;
  if (Object.keys(driverOptions).length) config.driverOptions = driverOptions;
  return { config, print: !!v['print-config'] };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || ((t) => process.stdout.write(t));
  const err = io.stderr || ((t) => process.stderr.write(t));
  let built;
  try { built = buildConfig(argv, io); } catch (error) {
    if (error instanceof UsageError) { err(`${error.message}\n\n${USAGE}\n`); return 1; }
    throw error;
  }
  if (built.help) { out(`${USAGE}\n`); return 0; }
  if (built.print) { out(`${JSON.stringify(built.config, null, 2)}\n`); return 0; }
  // stdout belongs to the MCP protocol from here on.
  process.env.BRAIWSER_RUNTIME_CONFIG = JSON.stringify(built.config);
  await import('./runtime-sidecar.mjs');
  return process.exitCode || 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { if (code) process.exitCode = code; }, (error) => {
    process.stderr.write(`Braiwser could not start: ${String((error && error.message) || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
