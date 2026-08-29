#!/usr/bin/env node
// Static sanity check — the fast gate that runs before the (slow, real-browser)
// e2e suite. Dependency-free on purpose: `npm ci && npm run check` must work on
// a bare checkout.
//
//   1. every source file parses
//   2. package.json is valid and its `main` exists
//   3. every path the main process hands the renderer actually exists
//   4. the renderer's ESM imports resolve to real files
//   5. main/webview stay CommonJS and the renderer stays ESM (the invariant the
//      Electron sandbox policy depends on)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const problems = [];
let checked = 0;

function fail(msg) {
  problems.push(msg);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(path.join(root, 'src'));
const jsFiles = files.filter((f) => f.endsWith('.js'));

// 1. Parse every source file.
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked += 1;
  } catch (err) {
    fail(`syntax error in ${path.relative(root, file)}\n${(err.stderr || '').toString().trim()}`);
  }
}

// 2. package.json.
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}
if (pkg && !fs.existsSync(path.join(root, pkg.main))) {
  fail(`package.json "main" points at a missing file: ${pkg.main}`);
}

// 3. Paths the main process publishes to the renderer over caos:config.
for (const rel of ['src/webview/inspector.js', 'src/renderer/welcome.html', 'src/renderer/index.html']) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing required file: ${rel}`);
}

// 4. Renderer ESM imports must resolve.
for (const file of jsFiles.filter((f) => f.includes(`${path.sep}renderer${path.sep}`))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) {
      fail(`${path.relative(root, file)} imports a missing module: ${m[1]}`);
    }
  }
}

// 5. Module-system invariant: the renderer is ESM under contextIsolation and
// must never require(); main and webview are CommonJS and must never import.
for (const file of jsFiles) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  const isRenderer = rel.startsWith(`src${path.sep}renderer`);
  if (isRenderer && /^\s*const\s+.*=\s*require\(/m.test(src)) {
    fail(`${rel} is renderer code but uses require() — it runs under contextIsolation`);
  }
  if (!isRenderer && /^\s*import\s+.*\s+from\s+['"]/m.test(src)) {
    fail(`${rel} is main/webview code but uses ESM import — those load as CommonJS`);
  }
}

if (problems.length) {
  console.error(`\ncheck failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`);
  for (const p of problems) console.error(' • ' + p);
  process.exit(1);
}

console.log(`check passed — ${checked} source files parse, imports resolve, module systems are consistent`);
