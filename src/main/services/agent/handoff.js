// Agent hand-off. Turns a review session into action:
//   1) writeRequest — always writes the change-request prompt to a .md file
//      (into <project>/.caos for local projects, else the app data dir).
//   2) runCommand   — optionally spawns a user-configured agent command in the
//      project directory, streaming stdout/stderr back via onChunk.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { toPrompt } = require('../export/prompt');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function isLocal(project) {
  return !!(project && project.kind === 'local' && project.path);
}

function requestDir(project, appDir) {
  return isLocal(project) ? path.join(project.path, '.caos') : path.join(appDir, 'requests');
}

function cwdFor(project, dir) {
  return isLocal(project) ? project.path : dir;
}

// Writes the prompt file; returns its absolute path, the cwd a command would run
// in, and the content length (so callers can verify without re-reading).
function writeRequest({ session, annotations, project, appDir, consoleLog }) {
  const dir = requestDir(project, appDir);
  fs.mkdirSync(dir, { recursive: true });
  const content = toPrompt(session || {}, annotations || [], consoleLog);
  const file = path.join(dir, `request-${stamp()}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, cwd: cwdFor(project, dir), length: content.length };
}

// Spawns the agent command (via the shell so templated command lines work).
// Substitutes {promptPath} and {projectPath}. Resolves when the process exits.
function runCommand({ command, cwd, filePath, project, onChunk }) {
  return new Promise((resolve) => {
    const cmd = String(command)
      .replace(/\{promptPath\}/g, filePath)
      .replace(/\{projectPath\}/g, (project && project.path) || cwd);
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true });
    } catch (err) {
      resolve({ ok: false, error: err.message, output: '' });
      return;
    }
    let output = '';
    const cap = (buf) => {
      const s = buf.toString();
      output += s;
      if (output.length > 200000) output = output.slice(-200000); // cap memory
      if (onChunk) { try { onChunk(s); } catch (_e) { /* ignore */ } }
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (err) => {
      cap('\n[spawn error] ' + err.message + '\n');
      resolve({ ok: false, error: err.message, output });
    });
    child.on('close', (code) => resolve({ ok: code === 0, exitCode: code, output }));
  });
}

module.exports = { writeRequest, runCommand };
