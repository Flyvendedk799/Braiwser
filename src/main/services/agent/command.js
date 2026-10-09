// Agent command parsing and spawn planning (audit MB-02).
//
// The configured agent command used to be a string with project/prompt paths
// pasted in and run with `shell:true`, so a legal folder name could become shell
// syntax. This module turns that string into a SPAWN PLAN with two strictly
// separate modes:
//
//   argv         executable + argument array, `shell:false`. The template is
//                tokenised FIRST and {promptPath}/{projectPath} are substituted
//                into the finished tokens, so a path is always one literal
//                argument. This is what the built-in agent adapters and any
//                plain `tool arg arg` command use.
//   shell-script the user explicitly wrote shell syntax (pipes, redirects, `&&`,
//                `$(…)`, an explicit `sh -c` / `cmd /c`). It is still allowed,
//                but it is flagged (`userScript:true`) and paths are NOT pasted
//                into it: placeholders become references to environment
//                variables (BRAIWSER_PROMPT_PATH / BRAIWSER_PROJECT_PATH), whose
//                values the shell never re-parses as syntax.
//
// Windows `.cmd`/`.bat` shims (npm-installed CLIs) cannot be spawned directly
// with `shell:false`; they go through `cmd.exe /d /s /c` with a strictly
// validated, quoted command line, relative paths where possible, and are refused
// outright when an argument contains a character cmd.exe would still interpret
// inside quotes (`"`, `%`, `!`, control characters).
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const PROMPT_PLACEHOLDER = '{promptPath}';
const PROJECT_PLACEHOLDER = '{projectPath}';
const ENV_PROMPT = 'BRAIWSER_PROMPT_PATH';
const ENV_PROJECT = 'BRAIWSER_PROJECT_PATH';

const SHELL_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
]);

// Characters that are shell syntax when they appear unquoted.
const UNQUOTED_SYNTAX = new Set(['|', '&', ';', '<', '>', '(', ')', '`', '\n', '\r']);

// --------------------------------------------------------------- tokenising
// Splits a command template into tokens honouring single and double quotes.
// Backslashes are literal (Windows paths). Returns { tokens, shell } where
// `shell` is true when the text contains shell syntax a no-shell spawn would
// silently ignore or mangle.
function tokenize(template) {
  const s = String(template || '');
  const tokens = [];
  let cur = '';
  let has = false; // a quoted empty string is still a token
  let quote = null;
  let shell = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Expansion syntax inside double quotes means the author expects a shell.
      if (quote === '"' && (ch === '`' || (ch === '$' && /[({A-Za-z_]/.test(s[i + 1] || '')))) shell = true;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch) && ch !== '\n' && ch !== '\r') {
      if (has || cur) { tokens.push(cur); cur = ''; has = false; }
      continue;
    }
    if (UNQUOTED_SYNTAX.has(ch)) shell = true;
    if (ch === '$' && /[({A-Za-z_]/.test(s[i + 1] || '')) shell = true;
    if (ch === '%' && /%/.test(s.slice(i + 1))) shell = true; // %VAR% (cmd)
    cur += ch;
    has = true;
  }
  if (quote) return { tokens: [], shell: true, unterminated: true };
  if (has || cur) tokens.push(cur);
  return { tokens, shell };
}

function baseName(exe) {
  return String(exe || '').split(/[\\/]/).pop().toLowerCase();
}

function substituteTokens(tokens, { promptPath, projectPath }) {
  return tokens.map((t) => t
    .split(PROMPT_PLACEHOLDER).join(promptPath)
    .split(PROJECT_PLACEHOLDER).join(projectPath));
}

// Builds the shell-script text with placeholders turned into env references,
// quoting according to the surrounding quote state.
function scriptWithEnvRefs(script, platform) {
  const win = platform === 'win32';
  const ref = (name) => (win ? `%${name}%` : `$${name}`);
  let out = '';
  let quote = null;
  for (let i = 0; i < script.length;) {
    let name = null;
    if (script.startsWith(PROMPT_PLACEHOLDER, i)) { name = ENV_PROMPT; i += PROMPT_PLACEHOLDER.length; }
    else if (script.startsWith(PROJECT_PLACEHOLDER, i)) { name = ENV_PROJECT; i += PROJECT_PLACEHOLDER.length; }
    if (name) {
      if (quote === '"') out += ref(name);
      else if (quote === "'") out += `'"${ref(name)}"'`; // POSIX only; cmd has no single quotes
      else out += `"${ref(name)}"`;
      continue;
    }
    const ch = script[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || (ch === "'" && !win)) quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

// ------------------------------------------------------------- classification
// command: the configured string. presets: AGENT_PRESETS (built-in adapters).
// Returns { kind:'argv', exe, args, builtin } | { kind:'shell', script } |
//         { kind:'empty' } | { kind:'invalid', error }
function classifyCommand(command, presets = []) {
  const text = String(command || '').trim();
  if (!text) return { kind: 'empty' };
  const preset = presets.find((p) => p.command === text && p.exe && Array.isArray(p.args));
  if (preset) return { kind: 'argv', exe: preset.exe, args: preset.args.slice(), builtin: preset.id };
  const { tokens, shell, unterminated } = tokenize(text);
  if (unterminated) return { kind: 'invalid', error: 'Unterminated quote in the agent command.' };
  if (!tokens.length) return { kind: 'empty' };
  if (shell || SHELL_INTERPRETERS.has(baseName(tokens[0]))) return { kind: 'shell', script: text };
  return { kind: 'argv', exe: tokens[0], args: tokens.slice(1), builtin: null };
}

// ------------------------------------------------------------- resolution
// All PATH matches for `bin`, in PATH order. spawnSync with an argument array:
// `bin` is data, never shell text.
function whichAll(bin, platform = process.platform) {
  if (!bin || bin === 'cat') return [];
  try {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', platform === 'win32' ? [bin] : ['-a', bin], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (r.status !== 0) return [];
    return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

// Picks what to launch. On Windows prefer a real .exe/.com over a .cmd/.bat
// shim; extensionless npm stubs and .ps1 files are not launchable directly.
function pickExecutable(candidates, platform = process.platform) {
  if (platform !== 'win32') return candidates.length ? { path: candidates[0], shim: false } : null;
  const ext = (p) => path.extname(p).toLowerCase();
  const exe = candidates.find((p) => ext(p) === '.exe' || ext(p) === '.com');
  if (exe) return { path: exe, shim: false };
  const shim = candidates.find((p) => ext(p) === '.cmd' || ext(p) === '.bat');
  if (shim) return { path: shim, shim: true };
  return null;
}

function resolveExecutable(exe, { platform = process.platform, whichAllFn = whichAll } = {}) {
  // A path given explicitly is used as-is.
  if (/[\\/]/.test(exe)) {
    const ext = path.extname(exe).toLowerCase();
    return { path: exe, shim: platform === 'win32' && (ext === '.cmd' || ext === '.bat') };
  }
  return pickExecutable(whichAllFn(exe, platform), platform);
}

// ------------------------------------------------------------ cmd.exe shims
function unsafeForCmd(value) {
  return /["%!\r\n\0]/.test(value);
}

function quoteForCmd(value) {
  if (unsafeForCmd(value)) {
    const err = new Error(`Refusing to pass "${String(value).replace(/[\r\n\0]/g, '?')}" to a .cmd launcher: it contains a character cmd.exe would interpret (" % !). Use a different folder name or an .exe agent.`);
    err.code = 'UNSAFE_CMD_ARG';
    throw err;
  }
  return `"${value}"`;
}

// Inside the working directory, hand the shim a relative path: it contains none
// of the characters cmd.exe cares about even when the folder name does.
function relativeToCwd(value, cwd) {
  if (!cwd || !path.isAbsolute(value)) return value;
  const rel = path.relative(cwd, value);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return value;
  return rel;
}

// ------------------------------------------------------------- spawn plan
// Returns { file, args, options, mode, userScript, warning? } or { error, code }.
function buildSpawnPlan({ command, presets, promptPath, projectPath, cwd, platform = process.platform, resolve = resolveExecutable, env = process.env }) {
  const cls = classifyCommand(command, presets);
  if (cls.kind === 'empty') return { error: 'No agent command configured (set one in Settings).', code: 'NO_COMMAND' };
  if (cls.kind === 'invalid') return { error: cls.error, code: 'INVALID_COMMAND' };

  const childEnv = { ...env, [ENV_PROMPT]: promptPath, [ENV_PROJECT]: projectPath };
  const values = { promptPath, projectPath };

  if (cls.kind === 'shell') {
    return {
      mode: 'shell-script',
      userScript: true,
      warning: 'Running a user-written shell script. Project and prompt paths are passed as environment variables, not substituted.',
      file: scriptWithEnvRefs(cls.script, platform),
      args: [],
      options: { cwd, shell: true, env: childEnv, windowsHide: true },
    };
  }

  const exeName = substituteTokens([cls.exe], values)[0];
  let args = substituteTokens(cls.args, values);
  const found = resolve(exeName, { platform });
  if (!found) return { error: `Could not find "${exeName}" on PATH.`, code: 'NOT_FOUND' };

  if (platform === 'win32' && found.shim) {
    try {
      args = args.map((a) => quoteForCmd(relativeToCwd(a, cwd)));
      const line = `${quoteForCmd(found.path)} ${args.join(' ')}`.trim();
      return {
        mode: 'argv',
        userScript: false,
        viaCmdShim: true,
        file: env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${line}"`],
        options: { cwd, shell: false, env: childEnv, windowsHide: true, windowsVerbatimArguments: true },
      };
    } catch (err) {
      return { error: err.message, code: err.code || 'UNSAFE_CMD_ARG' };
    }
  }

  return {
    mode: 'argv',
    userScript: false,
    builtin: cls.builtin || null,
    file: found.path,
    args,
    options: { cwd, shell: false, env: childEnv, windowsHide: true },
  };
}

module.exports = {
  PROMPT_PLACEHOLDER,
  PROJECT_PLACEHOLDER,
  ENV_PROMPT,
  ENV_PROJECT,
  tokenize,
  classifyCommand,
  whichAll,
  pickExecutable,
  resolveExecutable,
  buildSpawnPlan,
  scriptWithEnvRefs,
  quoteForCmd,
};
