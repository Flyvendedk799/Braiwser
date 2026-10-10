// Seats, and the local data export / erasure helpers.
//
// BILLING IS NOT IMPLEMENTED. There is no payment provider integration, checkout
// session, webhook or subscription reconciliation in this repository. A "seat
// count" here is a number stored locally, not something anyone paid for, and
// `createCheckoutIntent` refuses instead of producing a checkout-looking object.
// Licences are verified offline (services/license.js).
//
// The export/erase functions work on the data inventory below. The inventory is
// the single statement of what Braiwser stores about the user on this machine,
// and both export and erase are driven by it and tested against it, so the
// documented scope and the actual scope cannot silently diverge.
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('../config');

const NOT_IMPLEMENTED_NOTE =
  'Online checkout and payments are not implemented in this version. Seat counts are local numbers only.';

function billingStatus(repos) {
  const license = repos.license.get();
  const sync = repos.settings.get().sync || {};
  const ws = sync.workspaceId ? repos.workspaces.get(sync.workspaceId) : null;
  const seats = (license && license.seats) || (ws && ws.members && ws.members.length) || 1;
  return {
    tier: license.tier || 'free',
    seats,
    members: (ws && ws.members) || [],
    customerId: license.customerId || null,
    subscriptionId: license.subscriptionId || null,
    billing: { connected: false, status: 'not-implemented' },
    note: NOT_IMPLEMENTED_NOTE,
  };
}

function createCheckoutIntent() {
  return { ok: false, status: 'not-implemented', error: NOT_IMPLEMENTED_NOTE };
}

function applySeatChange(repos, seats) {
  const n = Math.max(1, Number(seats) || 1);
  repos.license.set({ ...repos.license.get(), seats: n });
  repos.auditLog.append('billing.seats', { seats: n, localOnly: true });
  return billingStatus(repos);
}

// ---- data inventory -----------------------------------------------------------
// Counts are read through the repositories' public API only.
function safeList(fn) {
  try {
    const v = fn();
    return Array.isArray(v) ? v : [];
  } catch (_e) {
    return [];
  }
}

function snapshot(repos) {
  const projects = safeList(() => repos.projects.list());
  const sessions = safeList(() => repos.sessions.list());
  const sessionCounts = (repos.annotations.countsBySession && repos.annotations.countsBySession()) || {};
  // Every session id that owns annotations, including orphans whose session is gone.
  const annotationSessionIds = Array.from(new Set([...sessions.map((s) => s.id), ...Object.keys(sessionCounts)]));
  const annotations = annotationSessionIds.flatMap((id) => safeList(() => repos.annotations.bySession(id)));
  const annotationIds = annotations.map((a) => a.id);
  const commentMap = new Map();
  for (const id of annotationSessionIds) for (const c of safeList(() => repos.comments.bySession(id))) commentMap.set(c.id, c);
  for (const id of annotationIds) for (const c of safeList(() => repos.comments.byAnnotation(id))) commentMap.set(c.id, c);
  // A repository that can enumerate comments directly finds the orphans too.
  if (typeof repos.comments.list === 'function') for (const c of safeList(() => repos.comments.list())) commentMap.set(c.id, c);
  return {
    projects,
    sessions,
    annotations,
    recordings: safeList(() => repos.recordings.list()),
    comments: Array.from(commentMap.values()),
    bookmarks: safeList(() => repos.bookmarks.list()),
    history: safeList(() => repos.history.list(Number.MAX_SAFE_INTEGER)),
    workspaces: safeList(() => repos.workspaces.list()),
    analytics: safeList(() => repos.analytics.list(Number.MAX_SAFE_INTEGER)),
    auditLog: safeList(() => repos.auditLog.list(Number.MAX_SAFE_INTEGER)),
    syncQueue: safeList(() => repos.syncQueue.list()),
  };
}

const COLLECTION_LABELS = {
  projects: 'Projects',
  sessions: 'Review sessions',
  annotations: 'Notes (annotations)',
  recordings: 'Journeys (recordings)',
  comments: 'Comments',
  bookmarks: 'Bookmarks',
  history: 'Browsing history',
  workspaces: 'Team workspaces (local records)',
  analytics: 'Local analytics events',
  auditLog: 'Audit log',
  syncQueue: 'Sync queue (local staging)',
};

// Personal or identifying settings: exported, and reset on erase. Everything else
// in settings is a preference (theme, layout, AI provider/model choice) and is kept.
const PERSONAL_SETTINGS = ['profile', 'agency', 'sync', 'integrations', 'licenseKey', 'openTabs', 'agentCommand'];

// Files in the store directory that hold credentials or key material, removed on erase.
const SECRET_FILES = ['credentials.json', 'machine.key', 'sync.key'];

const NOT_COVERED = [
  'Files you exported or saved elsewhere (reports, bundles, screenshots, videos).',
  'Handoff request files written into your own project folders (.braiwser).',
  'Cookies, cache and site data held by the embedded browser for pages you visited.',
  'Sign-ins owned by other tools (the `claude` or `codex` CLI login on this machine).',
  'Anything held by third-party AI providers if you ran an AI task with your own credential.',
];

function dataInventory(repos) {
  const snap = snapshot(repos);
  const collections = Object.keys(COLLECTION_LABELS).map((id) => ({
    id,
    label: COLLECTION_LABELS[id],
    count: snap[id].length,
    exported: true,
    erased: true,
  }));
  const settings = repos.settings.get();
  return {
    collections,
    settings: PERSONAL_SETTINGS.map((id) => ({ id, exported: id !== 'licenseKey', erased: true, hasValue: hasValue(settings[id]) })),
    license: { exported: 'tier and activation date only (never the key)', erased: true },
    secretFiles: SECRET_FILES.slice(),
    notCovered: NOT_COVERED.slice(),
    total: collections.reduce((n, c) => n + c.count, 0),
  };
}

function hasValue(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v).some(hasValue);
  return v !== false;
}

// ---- export -------------------------------------------------------------------
function exportGdprPackage(repos) {
  const snap = snapshot(repos);
  const settings = repos.settings.get();
  const license = repos.license.get() || {};
  const payload = {
    exportedAt: new Date().toISOString(),
    scope: 'Everything Braiwser stores on this machine (see inventory). API keys and sign-ins are never exported.',
    inventory: dataInventory(repos),
    profile: settings.profile,
    agency: settings.agency,
    sync: settings.sync,
    integrations: settings.integrations,
    license: { tier: license.tier || 'free', activatedAt: license.activatedAt || null },
    projects: snap.projects,
    sessions: snap.sessions,
    annotations: snap.annotations,
    recordings: snap.recordings,
    comments: snap.comments,
    bookmarks: snap.bookmarks,
    history: snap.history,
    workspaces: snap.workspaces,
    // Event rows only exist if the user opted in; they are exported either way if present.
    analytics: snap.analytics,
    auditLog: snap.auditLog,
    syncQueue: snap.syncQueue.map(({ blob, ...row }) => ({ ...row, blobBytes: blob ? Buffer.byteLength(blob, 'base64') : 0 })),
  };
  return {
    defaultName: `braiwser-data-export-${Date.now()}.json`,
    content: JSON.stringify(payload, null, 2),
    mime: 'application/json',
  };
}

// ---- erase --------------------------------------------------------------------
function resetPersonalSettings(repos) {
  repos.settings.set({
    profile: { ...DEFAULT_SETTINGS.profile },
    agency: { ...DEFAULT_SETTINGS.agency },
    sync: { ...DEFAULT_SETTINGS.sync },
    integrations: JSON.parse(JSON.stringify(DEFAULT_SETTINGS.integrations)),
    licenseKey: '',
    openTabs: [],
    agentCommand: '',
  });
}

function removeSecretFiles(dir, errors) {
  for (const name of SECRET_FILES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  try { require('./ai/auth').reset(); } catch (_e) { /* auth not loaded */ }
}

// Erases everything in the inventory. Returns what was removed and what (if
// anything) is left, so the caller can show the truth instead of an unconditional "done".
function deleteAccountData(repos) {
  const errors = [];
  const step = (label, fn) => {
    try { fn(); } catch (err) { errors.push(`${label}: ${err && err.message ? err.message : err}`); }
  };
  const before = snapshot(repos);
  const deleted = Object.fromEntries(Object.keys(COLLECTION_LABELS).map((id) => [id, before[id].length]));

  // Dependents first, so no cascade has to be relied on.
  step('comments', () => {
    if (typeof repos.comments.clear === 'function') repos.comments.clear();
    for (const c of before.comments) repos.comments.remove(c.id);
  });
  step('annotations', () => before.annotations.forEach((a) => repos.annotations.remove(a.id)));
  step('recordings', () => before.recordings.forEach((r) => repos.recordings.remove(r.id)));
  step('sessions', () => before.sessions.forEach((s) => repos.sessions.remove(s.id)));
  step('projects', () => before.projects.forEach((p) => repos.projects.remove(p.id)));
  step('bookmarks', () => before.bookmarks.forEach((b) => repos.bookmarks.remove(b.id)));
  step('history', () => repos.history.clear());
  step('workspaces', () => before.workspaces.forEach((w) => repos.workspaces.remove(w.id)));
  step('analytics', () => repos.analytics.clear());
  step('syncQueue', () => repos.syncQueue.clear());
  step('auditLog', () => repos.auditLog.clear());
  step('settings', () => resetPersonalSettings(repos));
  step('license', () => repos.license.set({ key: '', activatedAt: null, tier: 'free', seats: null, customerId: null, subscriptionId: null, lastError: null }));
  step('legacy secrets', () => {
    const legacy = repos.secrets && repos.secrets.legacy;
    if (legacy) for (const name of ['claude', 'openai', 'anthropic']) legacy.unset(name);
  });
  removeSecretFiles(repos.dir, errors);

  const after = snapshot(repos);
  const remaining = Object.fromEntries(Object.keys(COLLECTION_LABELS).map((id) => [id, after[id].length]));
  // The one record kept: proof that an erase happened (no personal content).
  step('audit record', () => repos.auditLog.append('gdpr.delete', { deleted }));

  const leftovers = Object.entries(remaining).filter(([, n]) => n > 0).map(([id, n]) => `${COLLECTION_LABELS[id]}: ${n}`);
  return {
    ok: errors.length === 0 && leftovers.length === 0,
    deleted,
    remaining,
    errors: errors.concat(leftovers.map((l) => `not erased - ${l}`)),
    notCovered: NOT_COVERED.slice(),
  };
}

module.exports = {
  billingStatus,
  createCheckoutIntent,
  applySeatChange,
  exportGdprPackage,
  deleteAccountData,
  dataInventory,
  COLLECTION_LABELS,
  PERSONAL_SETTINGS,
  SECRET_FILES,
  NOT_IMPLEMENTED_NOTE,
};
