// Domain repositories over the JSON store. This is the single source of truth
// for projects, sessions, annotations, recordings, settings, and secrets.
//
// Data model:
//   Project    { id, name, path, kind:'local'|'url', createdAt, lastOpenedAt }
//   Session    { id, projectId, name, url, title, createdAt, updatedAt }
//   Annotation { id, sessionId, kind:'element'|'region'|'edit', action, note,
//                target, url, title, status, priority, createdAt, updatedAt,
//                edit? { type, css, details } — present on kind:'edit' only
//                (a live rearrange change captured with its exact CSS) }
//   Recording  { id, projectId, name, startUrl, steps[], createdAt, updatedAt }
//
// Secrets (API keys) live in their OWN file under userData and are NEVER written
// into a project directory or returned wholesale to the renderer.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JsonCollection, JsonDocument } = require('./db');
const { migrateStore } = require('./schema');
const { STORE_DIR } = require('../migrate');
const { DEFAULT_SETTINGS, DEVICE_PRESETS, THEMES, PERSONAS } = require('../config');

// Four ways to pay for a call, two wires. `claude-code` and `codex` are
// subscriptions already signed in on the machine; the other two are metered API
// keys. See services/ai/auth.js.
const AI_PROVIDERS = ['claude-code', 'anthropic', 'codex', 'openai'];

// Settings written before the provider list grew named Anthropic 'claude'. Those
// installs have an API key, not a subscription, so they map to 'anthropic' —
// mapping them to 'claude-code' would silently point a configured user at a
// subscription they may not have.
const LEGACY_PROVIDERS = { claude: 'anthropic' };

function migrateProvider(value) {
  return LEGACY_PROVIDERS[value] || value;
}

// The per-provider model map is keyed by provider, so it needs the same rename —
// and the two Anthropic providers share a model, so a migrated choice seeds both.
function migrateModels(models) {
  const out = { ...models };
  if (typeof out.claude === 'string' && out.claude) {
    out.anthropic = out.anthropic || out.claude;
    out['claude-code'] = out['claude-code'] || out.claude;
  }
  delete out.claude;
  return out;
}
const DEVICE_IDS = DEVICE_PRESETS.map((d) => d.id);
const THEME_IDS = THEMES.map((t) => t.id);
const PERSONA_IDS = PERSONAS.map((p) => p.id);

function normalizeSettings(raw = {}) {
  const base = { ...DEFAULT_SETTINGS, ...raw };
  return {
    ...base,
    profile: {
      ...DEFAULT_SETTINGS.profile,
      ...(base.profile && typeof base.profile === 'object' ? base.profile : {}),
    },
    models: {
      ...DEFAULT_SETTINGS.models,
      ...(base.models && typeof base.models === 'object' ? migrateModels(base.models) : {}),
    },
    aiProvider: AI_PROVIDERS.includes(migrateProvider(base.aiProvider))
      ? migrateProvider(base.aiProvider)
      : DEFAULT_SETTINGS.aiProvider,
    onboardingComplete: !!base.onboardingComplete,
    restoreAnnotationsOnLoad: base.restoreAnnotationsOnLoad !== false,
    replayDelayMs: Number.isFinite(Number(base.replayDelayMs)) ? Math.max(0, Number(base.replayDelayMs)) : DEFAULT_SETTINGS.replayDelayMs,
    aiTimeoutMs: Number.isFinite(Number(base.aiTimeoutMs)) ? Math.max(5000, Number(base.aiTimeoutMs)) : DEFAULT_SETTINGS.aiTimeoutMs,
    theme: THEME_IDS.includes(base.theme) ? base.theme : DEFAULT_SETTINGS.theme,
    device: DEVICE_IDS.includes(base.device) ? base.device : DEFAULT_SETTINGS.device,
    deviceLandscape: !!base.deviceLandscape,
    persona: PERSONA_IDS.includes(base.persona) ? base.persona : DEFAULT_SETTINGS.persona,
    analyticsOptIn: !!base.analyticsOptIn,
    crashReportsOptIn: !!base.crashReportsOptIn,
    licenseKey: typeof base.licenseKey === 'string' ? base.licenseKey : '',
    agency: {
      ...DEFAULT_SETTINGS.agency,
      ...(base.agency && typeof base.agency === 'object' ? base.agency : {}),
    },
    sync: {
      ...DEFAULT_SETTINGS.sync,
      ...(base.sync && typeof base.sync === 'object' ? base.sync : {}),
    },
    integrations: {
      ...DEFAULT_SETTINGS.integrations,
      ...(base.integrations && typeof base.integrations === 'object' ? base.integrations : {}),
    },
  };
}

function cleanText(value, max = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function sanitizeSettingsPatch(patch, current) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;

  if (Object.prototype.hasOwnProperty.call(patch, 'onboardingComplete')) {
    clean.onboardingComplete = !!patch.onboardingComplete;
  }
  if (patch.profile && typeof patch.profile === 'object' && !Array.isArray(patch.profile)) {
    clean.profile = { ...(current.profile || {}) };
    if (Object.prototype.hasOwnProperty.call(patch.profile, 'displayName')) {
      clean.profile.displayName = cleanText(patch.profile.displayName, 80);
    }
  }
  if (typeof patch.aiProvider === 'string' && AI_PROVIDERS.includes(patch.aiProvider)) {
    clean.aiProvider = patch.aiProvider;
  }
  if (patch.models && typeof patch.models === 'object' && !Array.isArray(patch.models)) {
    clean.models = { ...(current.models || {}) };
    for (const provider of AI_PROVIDERS) {
      if (Object.prototype.hasOwnProperty.call(patch.models, provider)) {
        clean.models[provider] = cleanText(patch.models[provider], 120) || DEFAULT_SETTINGS.models[provider];
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'replayDelayMs')) {
    clean.replayDelayMs = Math.max(0, Number.parseInt(patch.replayDelayMs, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'aiTimeoutMs')) {
    clean.aiTimeoutMs = Math.max(5000, Number.parseInt(patch.aiTimeoutMs, 10) || DEFAULT_SETTINGS.aiTimeoutMs);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'restoreAnnotationsOnLoad')) {
    clean.restoreAnnotationsOnLoad = patch.restoreAnnotationsOnLoad !== false;
  }
  if (typeof patch.theme === 'string' && THEME_IDS.includes(patch.theme)) clean.theme = patch.theme;
  if (typeof patch.device === 'string' && DEVICE_IDS.includes(patch.device)) clean.device = patch.device;
  if (Object.prototype.hasOwnProperty.call(patch, 'deviceLandscape')) clean.deviceLandscape = !!patch.deviceLandscape;
  if (typeof patch.persona === 'string' && PERSONA_IDS.includes(patch.persona)) clean.persona = patch.persona;
  if (Object.prototype.hasOwnProperty.call(patch, 'analyticsOptIn')) clean.analyticsOptIn = !!patch.analyticsOptIn;
  if (Object.prototype.hasOwnProperty.call(patch, 'crashReportsOptIn')) clean.crashReportsOptIn = !!patch.crashReportsOptIn;
  if (typeof patch.licenseKey === 'string') clean.licenseKey = patch.licenseKey.trim().slice(0, 256);
  if (typeof patch.agentCommand === 'string') clean.agentCommand = patch.agentCommand.trim().slice(0, 2000);
  if (Array.isArray(patch.openTabs)) {
    clean.openTabs = patch.openTabs.filter((url) => typeof url === 'string' && url.length <= 4096).slice(0, 30);
  }
  if (typeof patch.sideTab === 'string') {
    clean.sideTab = patch.sideTab === 'layers' ? 'layers' : 'sections';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'libraryOpen')) {
    clean.libraryOpen = !!patch.libraryOpen;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'activeTabIndex')) {
    clean.activeTabIndex = Math.max(0, Number.parseInt(patch.activeTabIndex, 10) || 0);
  }
  if (patch.agency && typeof patch.agency === 'object' && !Array.isArray(patch.agency)) {
    clean.agency = { ...(current.agency || {}) };
    if (typeof patch.agency.name === 'string') clean.agency.name = cleanText(patch.agency.name, 120);
    if (typeof patch.agency.logoDataUrl === 'string') clean.agency.logoDataUrl = patch.agency.logoDataUrl.slice(0, 500000);
  }
  if (patch.sync && typeof patch.sync === 'object' && !Array.isArray(patch.sync)) {
    clean.sync = { ...(current.sync || {}) };
    if (Object.prototype.hasOwnProperty.call(patch.sync, 'enabled')) clean.sync.enabled = !!patch.sync.enabled;
    if (typeof patch.sync.accountEmail === 'string') clean.sync.accountEmail = cleanText(patch.sync.accountEmail, 200);
    if (typeof patch.sync.workspaceId === 'string') clean.sync.workspaceId = cleanText(patch.sync.workspaceId, 80);
  }
  if (patch.integrations && typeof patch.integrations === 'object' && !Array.isArray(patch.integrations)) {
    clean.integrations = { ...(current.integrations || {}), ...patch.integrations };
  }

  return clean;
}

function createRepositories(userDataDir) {
  const dir = path.join(userDataDir, STORE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const schema = migrateStore(dir);

  const projectsC = new JsonCollection(dir, 'projects');
  const sessionsC = new JsonCollection(dir, 'sessions');
  const annotationsC = new JsonCollection(dir, 'annotations');
  const recordingsC = new JsonCollection(dir, 'recordings');
  const historyC = new JsonCollection(dir, 'history');
  const bookmarksC = new JsonCollection(dir, 'bookmarks');
  const commentsC = new JsonCollection(dir, 'comments');
  const workspacesC = new JsonCollection(dir, 'workspaces');
  const analyticsC = new JsonCollection(dir, 'analytics');
  const auditLogC = new JsonCollection(dir, 'audit-log');
  const settingsD = new JsonDocument(dir, 'settings', DEFAULT_SETTINGS);
  const secretsD = new JsonDocument(dir, 'secrets', {});
  const licenseD = new JsonDocument(dir, 'license', { key: '', activatedAt: null, tier: 'free' });
  const syncQueueC = new JsonCollection(dir, 'sync-queue');

  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID();

  const projects = {
    list: () => projectsC.all().sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '')),
    get: (i) => projectsC.get(i),
    create: ({ name, path: p, kind }) =>
      projectsC.insert({ id: id(), name, path: p, kind: kind || 'local', createdAt: now(), lastOpenedAt: now() }),
    touch: (i) => projectsC.update(i, { lastOpenedAt: now() }),
    update: (i, patch) => projectsC.update(i, patch),
    remove: (i) => {
      for (const s of sessionsC.find((s) => s.projectId === i)) annotationsC.removeWhere((a) => a.sessionId === s.id);
      sessionsC.removeWhere((s) => s.projectId === i);
      recordingsC.removeWhere((r) => r.projectId === i);
      return projectsC.remove(i);
    },
  };

  const sessions = {
    list: (projectId) => {
      const all = sessionsC.all();
      const f = projectId ? all.filter((s) => s.projectId === projectId) : all;
      return f.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },
    get: (i) => sessionsC.get(i),
    create: ({ projectId, name, url, title }) =>
      sessionsC.insert({ id: id(), projectId: projectId || null, name: name || 'Review', url: url || '', title: title || '', createdAt: now(), updatedAt: now() }),
    update: (i, patch) => sessionsC.update(i, { ...patch, updatedAt: now() }),
    remove: (i) => { annotationsC.removeWhere((a) => a.sessionId === i); return sessionsC.remove(i); },
  };

  const annotations = {
    bySession: (sessionId) => annotationsC.find((a) => a.sessionId === sessionId).sort((a, b) => {
      const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    }),
    bySessionUrl: (sessionId, url) => annotationsC.find((a) => a.sessionId === sessionId && a.url === url),
    countsBySession: () => {
      const counts = {};
      for (const a of annotationsC.all()) counts[a.sessionId] = (counts[a.sessionId] || 0) + 1;
      return counts;
    },
    get: (i) => annotationsC.get(i),
    create: (a) => {
      const existing = annotationsC.find((x) => x.sessionId === a.sessionId);
      const doc = {
        id: a.id || id(),
        sessionId: a.sessionId,
        kind: a.kind || 'element',
        action: a.action || 'comment',
        note: a.note || '',
        target: a.target || {},
        url: a.url || '',
        title: a.title || '',
        status: a.status || 'open',
        priority: a.priority || 'normal',
        visibility: a.visibility === 'client' ? 'client' : 'internal',
        sortOrder: Number.isFinite(a.sortOrder) ? a.sortOrder : existing.length,
        createdAt: a.ts || now(),
        updatedAt: now(),
      };
      if (a.edit) doc.edit = a.edit;
      if (a.viewport && typeof a.viewport === 'object') doc.viewport = a.viewport;
      const saved = annotationsC.insert(doc);
      if (a.sessionId) sessionsC.update(a.sessionId, { updatedAt: now() });
      return saved;
    },
    update: (i, patch) => annotationsC.update(i, { ...patch, updatedAt: now() }),
    remove: (i) => annotationsC.remove(i),
    reorder: (sessionId, orderedIds) => {
      if (!Array.isArray(orderedIds)) return annotations.bySession(sessionId);
      orderedIds.forEach((aid, index) => {
        const row = annotationsC.get(aid);
        if (row && row.sessionId === sessionId) annotationsC.update(aid, { sortOrder: index, updatedAt: now() });
      });
      return annotations.bySession(sessionId);
    },
  };

  const recordings = {
    list: (projectId) => {
      const all = recordingsC.all();
      const f = projectId ? all.filter((r) => r.projectId === projectId) : all;
      return f.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },
    get: (i) => recordingsC.get(i),
    create: ({ projectId, name, startUrl, steps }) =>
      recordingsC.insert({ id: id(), projectId: projectId || null, name: name || 'Journey', startUrl: startUrl || '', steps: steps || [], createdAt: now(), updatedAt: now() }),
    update: (i, patch) => recordingsC.update(i, { ...patch, updatedAt: now() }),
    remove: (i) => recordingsC.remove(i),
  };

  const HISTORY_MAX = 1000;
  const history = {
    list: (limit) => historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '')).slice(0, limit || 100),
    record: ({ url, title }) => {
      if (!url) return null;
      const recent = historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || ''))[0];
      if (recent && recent.url === url) return historyC.update(recent.id, { visitedAt: now(), title: title || recent.title });
      const inserted = historyC.insert({ id: id(), url, title: title || '', visitedAt: now() });
      // Bound growth: keep only the newest HISTORY_MAX entries.
      const all = historyC.all();
      if (all.length > HISTORY_MAX) {
        const keep = new Set(all.sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '')).slice(0, HISTORY_MAX).map((x) => x.id));
        historyC.removeWhere((x) => !keep.has(x.id));
      }
      return inserted;
    },
    clear: () => { historyC.removeWhere(() => true); return true; },
  };

  const bookmarks = {
    list: () => bookmarksC.all().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    isBookmarked: (url) => bookmarksC.find((b) => b.url === url).length > 0,
    toggle: ({ url, title }) => {
      if (!url) return { bookmarked: false };
      const existing = bookmarksC.find((b) => b.url === url);
      if (existing.length) { existing.forEach((b) => bookmarksC.remove(b.id)); return { bookmarked: false }; }
      bookmarksC.insert({ id: id(), url, title: title || '', createdAt: now() });
      return { bookmarked: true };
    },
    remove: (i) => bookmarksC.remove(i),
  };

  const settings = {
    get: () => normalizeSettings(settingsD.data()),
    set: (patch) => {
      const current = normalizeSettings(settingsD.data());
      return normalizeSettings(settingsD.merge(sanitizeSettingsPatch(patch, current)));
    },
  };

  // API keys no longer live here. They are held encrypted by services/ai/auth.js,
  // which also resolves the two subscription logins — so a key is never sitting
  // in plaintext next to the projects, and nothing in the store can hand one back
  // to the renderer. What remains is the old document, exposed only so the
  // one-time migration can drain it and blank it.
  const secrets = { legacy: secretsD };

  const license = {
    get: () => licenseD.data(),
    set: (patch) => licenseD.merge(patch || {}),
  };

  const comments = {
    byAnnotation: (annotationId) => commentsC.find((c) => c.annotationId === annotationId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    bySession: (sessionId) => commentsC.find((c) => c.sessionId === sessionId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    create: ({ sessionId, annotationId, author, body }) =>
      commentsC.insert({ id: id(), sessionId, annotationId, author: author || 'You', body: body || '', createdAt: now() }),
    remove: (i) => commentsC.remove(i),
  };

  const workspaces = {
    list: () => workspacesC.all(),
    get: (i) => workspacesC.get(i),
    create: ({ name, role }) =>
      workspacesC.insert({
        id: id(),
        name: name || 'Workspace',
        role: role || 'owner',
        members: [{ email: '', role: 'owner', joinedAt: now() }],
        createdAt: now(),
      }),
    update: (i, patch) => workspacesC.update(i, patch),
    remove: (i) => workspacesC.remove(i),
  };

  const analytics = {
    track: (event, props = {}) => {
      const settings = normalizeSettings(settingsD.data());
      if (!settings.analyticsOptIn) return null;
      return analyticsC.insert({ id: id(), event, props, at: now() });
    },
    list: (limit = 200) => analyticsC.all().slice(-limit),
    clear: () => { analyticsC.removeWhere(() => true); return true; },
  };

  const auditLog = {
    append: (action, detail = {}) => auditLogC.insert({ id: id(), action, detail, at: now() }),
    list: (limit = 200) => auditLogC.all().slice(-limit),
    clear: () => { auditLogC.removeWhere(() => true); return true; },
  };

  const syncQueue = {
    enqueue: (op) => syncQueueC.insert({ id: id(), ...op, createdAt: now(), status: 'pending' }),
    list: () => syncQueueC.all(),
    mark: (i, status) => syncQueueC.update(i, { status }),
    clear: () => { syncQueueC.removeWhere(() => true); return true; },
  };

  return {
    dir,
    schema,
    projects,
    sessions,
    annotations,
    recordings,
    history,
    bookmarks,
    settings,
    secrets,
    license,
    comments,
    workspaces,
    analytics,
    auditLog,
    syncQueue,
  };
}

module.exports = { createRepositories };
