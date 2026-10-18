// Agent hand-off. Turns a review session into action:
//   1) writeRequest — always writes the change-request prompt to a uniquely named
//      .md file (into <project>/.braiwser for trusted local projects, else the
//      app data dir).
//   2) runCommand   — optionally spawns the user-configured agent command in the
//      project directory, streaming stdout/stderr back via onChunk. See
//      ./command.js: commands run as executable + args with shell:false; an
//      explicitly shell-syntax command is flagged and gets paths via env vars.
//
// Project directory semantics (MB-01): for a local project `project.path` is a
// DIRECTORY (an Open File project keeps its page in `project.entry`). Projects
// created by a bundle import (`project.imported`) carry a path from someone
// else's machine: it is never written to and never used as a cwd, and the agent
// command will not run for them until the user picks a local folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { toPrompt } = require('../export/prompt');
const { buildSpawnPlan } = require('./command');
const { AGENT_PRESETS } = require('./templates');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
}

// The directory a hand-off may write into / run in, or null. Existing legacy
// file-projects (path = a file) resolve to the file's parent.
function projectDirectory(project, fsx = fs) {
  if (!project || project.kind !== 'local' || !project.path || project.imported) return null;
  try {
    const st = fsx.statSync(project.path);
    if (st.isDirectory()) return project.path;
    if (st.isFile()) return path.dirname(project.path);
  } catch (_e) { /* missing */ }
  return null;
}

function requestDir(project, appDir) {
  const dir = projectDirectory(project);
  return dir ? path.join(dir, '.braiwser') : path.join(appDir, 'requests');
}

function cwdFor(project, fallbackDir) {
  return projectDirectory(project) || fallbackDir;
}

// Exclusive-create a uniquely named file; never overwrites an earlier request.
function createUnique(dir, body, requestId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = attempt === 0 ? requestId.slice(0, 8) : crypto.randomUUID().slice(0, 8);
    const file = path.join(dir, `request-${stamp()}-${suffix}.md`);
    try {
      fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not allocate a unique request file name.');
}

// Writes the prompt file; returns its absolute path, the request id, the cwd a
// command would run in, and the content length.
function writeRequest({ session, annotations, project, appDir, consoleLog, content }) {
  const requestId = crypto.randomUUID();
  const text = content != null ? String(content) : toPrompt(session || {}, annotations || [], consoleLog);
  const header = `<!-- braiwser-request id=${requestId} session=${(session && session.id) || ''} -->\n\n`;
  const body = header + text;

  let dir = requestDir(project, appDir);
  let fellBack = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // e.g. a read-only project folder: keep the hand-off working from app data.
    dir = path.join(appDir, 'requests');
    fs.mkdirSync(dir, { recursive: true });
    fellBack = true;
  }
  const file = createUnique(dir, body, requestId);
  const projectCwd = fellBack ? null : projectDirectory(project);
  return { file, requestId, cwd: projectCwd || dir, length: body.length, imported: !!(project && project.imported) };
}

const REQUEST_FILE = /^request-[A-Za-z0-9._-]+\.md$/;

// Runs the agent command. Resolves when the process exits.
//   command  — settings string; project — for the imported-trust check;
//   cwd      — directory to run in (use cwdFor); filePath — the request file.
function runCommand({ command, cwd, filePath, project, onChunk, platform, resolve, presets = AGENT_PRESETS }) {
  return new Promise((done) => {
    if (project && project.imported) {
      done({
        ok: false,
        code: 'IMPORTED_PROJECT',
        error: 'This project was imported from a bundle, so its folder is not trusted. Choose a local folder for it before running an agent.',
        output: '',
      });
      return;
    }
    if (!filePath || !REQUEST_FILE.test(path.basename(String(filePath)))) {
      done({ ok: false, code: 'BAD_REQUEST_FILE', error: 'The agent can only be run on a request file written by Braiwser.', output: '' });
      return;
    }
    const projectPath = projectDirectory(project) || cwd;
    const plan = buildSpawnPlan({ command, presets, promptPath: filePath, projectPath, cwd, platform, resolve });
    if (plan.error) {
      done({ ok: false, code: plan.code, error: plan.error, output: '' });
      return;
    }
    let child;
    try {
      child = spawn(plan.file, plan.args, plan.options);
    } catch (err) {
      done({ ok: false, error: err.message, output: '', mode: plan.mode, userScript: plan.userScript });
      return;
    }
    let output = '';
    if (plan.warning) output = `[braiwser] ${plan.warning}\n`;
    const cap = (buf) => {
      const s = buf.toString();
      output += s;
      if (output.length > 200000) output = output.slice(-200000); // cap memory
      if (onChunk) { try { onChunk(s); } catch (_e) { /* ignore */ } }
    };
    const meta = { mode: plan.mode, userScript: !!plan.userScript };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (err) => {
      cap('\n[spawn error] ' + err.message + '\n');
      done({ ok: false, error: err.message, output, ...meta });
    });
    child.on('close', (code) => done({ ok: code === 0, exitCode: code, output, ...meta }));
  });
}

module.exports = { writeRequest, runCommand, projectDirectory, cwdFor, requestDir };
