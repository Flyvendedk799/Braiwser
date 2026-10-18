'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
function tmp(prefix = 'braiwser-rt-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function cleanup() {
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.on('exit', cleanup);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('until: timed out');
    await delay(stepMs);
  }
}
const ui = { id: 'ui-1', kind: 'ui', scopes: [] };
const mcp = (id = 'mcp-1', scopes = []) => ({ id, kind: 'mcp', scopes });

module.exports = { tmp, cleanup, delay, until, ui, mcp };
