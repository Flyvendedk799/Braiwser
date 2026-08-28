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
const { DEFAULT_SETTINGS, DEVICE_PRESETS, THEMES } = require('../config');

const AI_PROVIDERS = ['claude', 'openai'];
const DEVICE_IDS = DEVICE_PRESETS.map((d) => d.id);
const THEME_IDS = THEMES.map((t) => t.id);

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
      ...(base.models && typeof base.models === 'object' ? base.models : {}),
    },
    aiProvider: AI_PROVIDERS.includes(base.aiProvider) ? base.aiProvider : DEFAULT_SETTINGS.aiProvider,
    onboardingComplete: !!base.onboardingComplete,
    restoreAnnotationsOnLoad: base.restoreAnnotationsOnLoad !== false,
    replayDelayMs: Number.isFinite(Number(base.replayDelayMs)) ? Math.max(0, Number(base.replayDelayMs)) : DEFAULT_SETTINGS.replayDelayMs,
    theme: THEME_IDS.includes(base.theme) ? base.theme : DEFAULT_SETTINGS.theme,
    device: DEVICE_IDS.includes(base.device) ? base.device : DEFAULT_SETTINGS.device,
    deviceLandscape: !!base.deviceLandscape,
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
  if (Object.prototype.hasOwnProperty.call(patch, 'restoreAnnotationsOnLoad')) {
    clean.restoreAnnotationsOnLoad = patch.restoreAnnotationsOnLoad !== false;
  }
  if (typeof patch.theme === 'string' && THEME_IDS.includes(patch.theme)) clean.theme = patch.theme;
  if (typeof patch.device === 'string' && DEVICE_IDS.includes(patch.device)) clean.device = patch.device;
  if (Object.prototype.hasOwnProperty.call(patch, 'deviceLandscape')) clean.deviceLandscape = !!patch.deviceLandscape;
  if (typeof patch.agentCommand === 'string') clean.agentCommand = patch.agentCommand.trim().slice(0, 2000);
  if (Array.isArray(patch.openTabs)) {
    clean.openTabs = patch.openTabs.filter((url) => typeof url === 'string' && url.length <= 4096).slice(0, 30);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'activeTabIndex')) {
    clean.activeTabIndex = Math.max(0, Number.parseInt(patch.activeTabIndex, 10) || 0);
  }

  return clean;
}

function createRepositories(userDataDir) {
  const dir = path.join(userDataDir, 'caos');
  fs.mkdirSync(dir, { recursive: true });

  const projectsC = new JsonCollection(dir, 'projects');
  const sessionsC = new JsonCollection(dir, 'sessions');
  const annotationsC = new JsonCollection(dir, 'annotations');
  const recordingsC = new JsonCollection(dir, 'recordings');
  const historyC = new JsonCollection(dir, 'history');
  const bookmarksC = new JsonCollection(dir, 'bookmarks');
  const settingsD = new JsonDocument(dir, 'settings', DEFAULT_SETTINGS);
  const secretsD = new JsonDocument(dir, 'secrets', {});

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
    bySession: (sessionId) => annotationsC.find((a) => a.sessionId === sessionId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    bySessionUrl: (sessionId, url) => annotationsC.find((a) => a.sessionId === sessionId && a.url === url),
    countsBySession: () => {
      const counts = {};
      for (const a of annotationsC.all()) counts[a.sessionId] = (counts[a.sessionId] || 0) + 1;
      return counts;
    },
    get: (i) => annotationsC.get(i),
    create: (a) => {
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
        createdAt: a.ts || now(),
        updatedAt: now(),
      };
      if (a.edit) doc.edit = a.edit; // rearrange edits carry their CSS/reorder payload
      // The viewport a note was captured at matters for responsive review, so
      // it travels with the annotation into every export.
      if (a.viewport && typeof a.viewport === 'object') doc.viewport = a.viewport;
      const saved = annotationsC.insert(doc);
      if (a.sessionId) sessionsC.update(a.sessionId, { updatedAt: now() });
      return saved;
    },
    update: (i, patch) => annotationsC.update(i, { ...patch, updatedAt: now() }),
    remove: (i) => annotationsC.remove(i),
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

  const secrets = {
    providers: () => {
      const s = secretsD.data();
      return { claude: !!s.claude, openai: !!s.openai };
    },
    getKey: (provider) => secretsD.data()[provider] || null,
    setKey: (provider, key) => {
      // Whitelist providers and require a non-empty string so the renderer can't
      // write arbitrary keys into secrets.json.
      if (provider !== 'claude' && provider !== 'openai') return secrets.providers();
      if (typeof key !== 'string' || !key) return secrets.providers();
      secretsD.set(provider, key);
      return secrets.providers();
    },
    clearKey: (provider) => { secretsD.unset(provider); return secrets.providers(); },
  };

  return { dir, projects, sessions, annotations, recordings, history, bookmarks, settings, secrets };
}

module.exports = { createRepositories };
