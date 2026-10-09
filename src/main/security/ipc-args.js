'use strict';
// Argument validation hooks for IPC channels that take filesystem paths, URLs
// or webContents ids. These are shape checks — the handler still owns semantic
// authorisation (e.g. the guest must belong to the sender's window).
//
// A rule is `(args: any[]) => void` and throws on a bad call. Rules are looked
// up by channel in createIpcGuard({ argRules }).

const path = require('path');

function fail(msg) { throw new Error(msg); }

function isAbsolutePathString(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096
    && !v.includes('\0') && (path.isAbsolute(v) || path.win32.isAbsolute(v));
}

const v = {
  absPath: (name) => (x) => { if (!isAbsolutePathString(x)) fail(`${name || 'path'} must be an absolute path string`); },
  positiveInt: (name) => (x) => { if (!Number.isInteger(x) || x < 1) fail(`${name || 'id'} must be a positive integer`); },
  positiveIntOrNull: (name) => (x) => {
    if (x !== null && x !== undefined && (!Number.isInteger(x) || x < 1)) fail(`${name || 'id'} must be a positive integer or null`);
  },
  optional: (inner) => (x) => { if (x !== undefined && x !== null && x !== '') inner(x); },
  httpUrl: (name) => (x) => {
    let u;
    try { u = new URL(String(x)); } catch (_e) { fail(`${name || 'url'} is not a valid URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${name || 'url'} must be http(s)`);
  },
};

// rules([v1, v2]) validates positional arguments; extra args are ignored (the
// handler signature is unchanged), missing required ones fail.
function rules(positional) {
  return (args) => {
    positional.forEach((check, i) => { if (check) check(args[i]); });
  };
}

const DEFAULT_ARG_RULES = {
  'caos:reveal': rules([v.absPath('filePath')]),
  'caos:integrations.ciStarter': rules([v.optional(v.absPath('projectPath'))]),
  'caos:capture-fullpage': rules([v.positiveInt('webContentsId')]),
  'caos:video.source': rules([v.positiveIntOrNull('webContentsId')]),
  'caos:throttle.hold': rules([v.positiveIntOrNull('webContentsId')]),
};

module.exports = { DEFAULT_ARG_RULES, rules, validators: v, isAbsolutePathString };
