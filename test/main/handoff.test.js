'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRequest, runCommand, projectDirectory, cwdFor } = require('../../src/main/services/agent/handoff');
const { classifyCommand, tokenize, buildSpawnPlan, scriptWithEnvRefs, pickExecutable } = require('../../src/main/services/agent/command');
const { AGENT_PRESETS } = require('../../src/main/services/agent/templates');
const { whichAll } = require('../../src/main/services/agent/command');
const { createRepositories } = require('../../src/main/store/repositories');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-ho-')); }

test('PATH resolution accepts the standard Unix handoff reader', { skip: process.platform === 'win32' }, () => {
  assert.ok(whichAll('cat').some((candidate) => path.basename(candidate) === 'cat'));
});

// A stand-in agent: prints its argv, cwd and the env hand-off variables as JSON.
function writeFakeAgent(dir) {
  const file = path.join(dir, 'fake-agent.js');
  fs.writeFileSync(file, `
    process.stdout.write('@@' + JSON.stringify({
      argv: process.argv.slice(2), cwd: process.cwd(),
      envPrompt: process.env.BRAIWSER_PROMPT_PATH, envProject: process.env.BRAIWSER_PROJECT_PATH,
    }) + '@@');`);
  return file;
}
const parseOut = (out) => JSON.parse(/@@(.*)@@/s.exec(out)[1]);
const SESSION = { id: 'sess-1', name: 'S' };

// Folder names that are legal on every platform we run on but hostile as shell text.
const NASTY = ["we ird & $(touch PWNED) `x` ; ünï ' (1) %PATH% name", 'Ünïcode 日本語 проект'];

test('MB-01: Open File and Open Folder projects both write a request and pick the right cwd', () => {
  for (const name of NASTY) {
    const u = tmp();
    const dir = path.join(u, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<html></html>');
    const repos = createRepositories(path.join(u, 'ud'));
    const filePrj = repos.projects.create({ name: 'f', path: file, kind: 'local' });
    const folderPrj = repos.projects.create({ name: 'd', path: dir, kind: 'local' });
    for (const project of [filePrj, folderPrj]) {
      const r = writeRequest({ session: SESSION, annotations: [], project, appDir: repos.dir, content: 'hello' });
      assert.equal(path.dirname(r.file), path.join(dir, '.braiwser'));
      assert.equal(r.cwd, dir);
      assert.ok(fs.readFileSync(r.file, 'utf8').endsWith('hello'));
      assert.equal(cwdFor(project, repos.dir), dir);
    }
    // legacy record whose path is still the file (not yet migrated) also works
    const legacy = { kind: 'local', path: file };
    assert.equal(projectDirectory(legacy), dir);
    assert.doesNotThrow(() => writeRequest({ session: SESSION, project: legacy, appDir: path.join(u, 'app'), content: 'x' }));
  }
});

test('MB-01: url/missing projects fall back to the app dir; unwritable project dir falls back too', () => {
  const u = tmp();
  const app = path.join(u, 'app');
  fs.mkdirSync(app);
  const url = writeRequest({ session: SESSION, project: { kind: 'url', path: '' }, appDir: app, content: 'x' });
  assert.equal(path.dirname(url.file), path.join(app, 'requests'));
  const missing = writeRequest({ session: SESSION, project: { kind: 'local', path: path.join(u, 'nope') }, appDir: app, content: 'x' });
  assert.equal(path.dirname(missing.file), path.join(app, 'requests'));
  const proj = path.join(u, 'ro');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.braiwser'), 'i am a file, so mkdir fails');
  const blocked = writeRequest({ session: SESSION, project: { kind: 'local', path: proj }, appDir: app, content: 'x' });
  assert.equal(path.dirname(blocked.file), path.join(app, 'requests'));
  assert.equal(blocked.cwd, path.join(app, 'requests'));
});

test('MB-07: rapid and concurrent hand-offs produce distinct immutable files tied to their session', async () => {
  const u = tmp();
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => Promise.resolve().then(() =>
    writeRequest({ session: { id: 's' + i }, project: null, appDir: u, content: 'body ' + i }))));
  const files = new Set(results.map((r) => r.file));
  assert.equal(files.size, 60);
  assert.equal(new Set(results.map((r) => r.requestId)).size, 60);
  results.forEach((r, i) => {
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(text.includes(`session=s${i} `), 'tied to its originating session');
    assert.ok(text.includes(`id=${r.requestId}`));
    assert.ok(text.endsWith('body ' + i), 'never contains another request\'s text');
    assert.ok(path.basename(r.file).includes(r.requestId.slice(0, 8)));
  });
});

test('MB-07: exclusive create — an existing file with the same name is never overwritten', () => {
  const u = tmp();
  const a = writeRequest({ session: SESSION, project: null, appDir: u, content: 'first' });
  const before = fs.readFileSync(a.file, 'utf8');
  for (let i = 0; i < 5; i += 1) writeRequest({ session: SESSION, project: null, appDir: u, content: 'later ' + i });
  assert.equal(fs.readFileSync(a.file, 'utf8'), before);
});

// ------------------------------------------------------------------ command planning
test('tokenize / classify: plain commands are argv, shell syntax and interpreters are scripts', () => {
  assert.deepEqual(tokenize('claude -p "{promptPath}"').tokens, ['claude', '-p', '{promptPath}']);
  assert.deepEqual(tokenize(`tool 'a b' "c d" e\\f`).tokens, ['tool', 'a b', 'c d', 'e\\f']);
  assert.equal(classifyCommand('claude -p "{promptPath}"', AGENT_PRESETS).builtin, 'claude');
  assert.deepEqual(classifyCommand('mytool --flag "{promptPath}"').kind, 'argv');
  for (const script of ['a | b', 'a && b', 'a > out.txt', 'echo $(whoami)', 'echo `x`', 'sh -c "x"', 'cmd /c type "{promptPath}"', 'powershell -Command x', 'a; b', 'echo %HOME% x %']) {
    assert.equal(classifyCommand(script).kind, 'shell', script);
  }
  assert.equal(classifyCommand('').kind, 'empty');
  assert.equal(classifyCommand('tool "unterminated').kind, 'invalid');
});

test('MB-02: argv plan keeps hostile paths as single literal arguments with shell:false', () => {
  for (const name of NASTY) {
    const p = path.join(os.tmpdir(), name, 'request-1.md');
    const plan = buildSpawnPlan({
      command: 'claude -p "{promptPath}"', presets: AGENT_PRESETS, promptPath: p, projectPath: path.dirname(p), cwd: path.dirname(p),
      platform: process.platform, resolve: () => ({ path: process.execPath, shim: false }),
    });
    assert.equal(plan.mode, 'argv');
    assert.equal(plan.options.shell, false);
    assert.equal(plan.userScript, false);
    assert.deepEqual(plan.args, ['-p', p]);
    assert.equal(plan.file, process.execPath);
  }
});

test('MB-02: shell-script plan is flagged and passes paths by environment, never pasted', () => {
  const p = path.join(os.tmpdir(), NASTY[0], 'request-1.md');
  const plan = buildSpawnPlan({
    command: 'cat "{promptPath}" | wc -c', presets: [], promptPath: p, projectPath: path.dirname(p), cwd: os.tmpdir(), platform: 'linux',
  });
  assert.equal(plan.mode, 'shell-script');
  assert.equal(plan.userScript, true);
  assert.ok(plan.warning);
  assert.ok(!plan.file.includes(p) && !plan.file.includes('PWNED'));
  assert.equal(plan.file, 'cat "$BRAIWSER_PROMPT_PATH" | wc -c');
  assert.equal(plan.options.env.BRAIWSER_PROMPT_PATH, p);
  assert.equal(scriptWithEnvRefs(`x '{promptPath}' "{projectPath}" {promptPath}`, 'linux'),
    `x ''"$BRAIWSER_PROMPT_PATH"'' "$BRAIWSER_PROJECT_PATH" "$BRAIWSER_PROMPT_PATH"`);
  assert.equal(scriptWithEnvRefs('cmd /c type "{promptPath}"', 'win32'), 'cmd /c type "%BRAIWSER_PROMPT_PATH%"');
});

test('MB-02: Windows .cmd shims run through cmd.exe /d /s /c with validated quoted args and relative paths', () => {
  const cwd = path.join(os.tmpdir(), 'proj & co');
  const prompt = path.join(cwd, '.braiwser', 'request-1.md');
  const shim = path.join(os.tmpdir(), 'npm', 'claude.cmd');
  const plan = buildSpawnPlan({
    command: 'claude -p "{promptPath}"', presets: AGENT_PRESETS, promptPath: prompt, projectPath: cwd, cwd, platform: 'win32',
    resolve: () => ({ path: shim, shim: true }), env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });
  assert.equal(plan.viaCmdShim, true);
  assert.equal(plan.options.shell, false);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.args[3], `""${shim}" "-p" "${path.join('.braiwser', 'request-1.md')}""`);
  assert.ok(!plan.args[3].includes('proj & co'), 'hostile folder name never reaches cmd.exe');
  // an argument cmd.exe would still interpret is refused, not escaped
  const bad = buildSpawnPlan({
    command: 'claude -p "{promptPath}"', presets: AGENT_PRESETS, promptPath: path.join(os.tmpdir(), '100%done', 'r.md'), projectPath: 'C:\\x', cwd: 'C:\\elsewhere', platform: 'win32',
    resolve: () => ({ path: shim, shim: true }),
  });
  assert.equal(bad.code, 'UNSAFE_CMD_ARG');
  assert.ok(!bad.file);
});

test('pickExecutable prefers real executables over .cmd shims and ignores extensionless/.ps1 on Windows', () => {
  assert.deepEqual(pickExecutable(['C:\\n\\claude', 'C:\\n\\claude.cmd', 'C:\\n\\claude.ps1'], 'win32'), { path: 'C:\\n\\claude.cmd', shim: true });
  assert.deepEqual(pickExecutable(['C:\\n\\claude.cmd', 'C:\\bin\\claude.exe'], 'win32'), { path: 'C:\\bin\\claude.exe', shim: false });
  assert.equal(pickExecutable(['C:\\n\\claude'], 'win32'), null);
  assert.deepEqual(pickExecutable(['/usr/bin/claude'], 'linux'), { path: '/usr/bin/claude', shim: false });
});

// ------------------------------------------------------------------ real processes
test('MB-02: a real agent process receives hostile project/prompt paths as literal arguments (argv mode)', async () => {
  for (const name of NASTY) {
    const u = tmp();
    const script = writeFakeAgent(u);
    const dir = path.join(u, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = { kind: 'local', path: dir };
    const req = writeRequest({ session: SESSION, project, appDir: u, content: 'hi' });
    const command = `"${process.execPath}" "${script}" "{promptPath}" "{projectPath}"`;
    const res = await runCommand({ command, cwd: cwdFor(project, u), filePath: req.file, project });
    assert.equal(res.ok, true, res.error || res.output);
    assert.equal(res.mode, 'argv');
    assert.equal(res.userScript, false);
    const seen = parseOut(res.output);
    assert.deepEqual(seen.argv, [req.file, dir]);
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false, 'no command injection');
    assert.equal(fs.existsSync(path.join(process.cwd(), 'PWNED')), false);
  }
});

test('MB-02: explicit shell scripts still run, are flagged, and receive paths via env', async () => {
  const u = tmp();
  const script = writeFakeAgent(u);
  const dir = path.join(u, NASTY[0]);
  fs.mkdirSync(dir, { recursive: true });
  const project = { kind: 'local', path: dir };
  const req = writeRequest({ session: SESSION, project, appDir: u, content: 'hi' });
  const command = `"${process.execPath}" "${script}" "{promptPath}" && "${process.execPath}" -e "0"`;
  const res = await runCommand({ command, cwd: dir, filePath: req.file, project });
  assert.equal(res.ok, true, res.error || res.output);
  assert.equal(res.mode, 'shell-script');
  assert.equal(res.userScript, true);
  assert.match(res.output, /user-written shell script/);
  const seen = parseOut(res.output);
  assert.deepEqual(seen.argv, [req.file]);
  assert.equal(seen.envPrompt, req.file);
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
});

test('MB-02: imported projects cannot run an agent, regardless of path or command', async () => {
  const u = tmp();
  const script = writeFakeAgent(u);
  const project = { kind: 'local', path: u, imported: true };
  assert.equal(projectDirectory(project), null);
  const req = writeRequest({ session: SESSION, project, appDir: u, content: 'hi' });
  assert.equal(path.dirname(req.file), path.join(u, 'requests'), 'nothing is written into the imported path');
  assert.equal(req.imported, true);
  let spawned = false;
  const res = await runCommand({ command: `"${process.execPath}" "${script}"`, cwd: u, filePath: req.file, project, resolve: () => { spawned = true; return null; } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'IMPORTED_PROJECT');
  assert.equal(spawned, false);
});

test('MB-02: only Braiwser request files can be handed to the agent; missing tools fail cleanly', async () => {
  const u = tmp();
  const bad = await runCommand({ command: 'claude -p "{promptPath}"', cwd: u, filePath: path.join(u, 'secrets.txt'), project: null });
  assert.equal(bad.code, 'BAD_REQUEST_FILE');
  const req = writeRequest({ session: SESSION, project: null, appDir: u, content: 'x' });
  const none = await runCommand({ command: 'definitely-not-a-real-tool-xyz "{promptPath}"', cwd: u, filePath: req.file, project: null });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NOT_FOUND');
  const empty = await runCommand({ command: '  ', cwd: u, filePath: req.file, project: null });
  assert.equal(empty.code, 'NO_COMMAND');
});
