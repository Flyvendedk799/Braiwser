// Domain repositories over the JSON store. This is the single source of truth
// for projects, sessions, annotations, recordings, settings, and secrets.
//
// Data model:
//   Project    { id, name, path, kind:'local'|'url', createdAt, lastOpenedAt }
//   Session    { id, projectId, name, url, title, createdAt, updatedAt }
//   Annotation { id, sessionId, kind:'element'|'region', action, note, target,
//                url, title, status, priority, createdAt, updatedAt }
//   Recording  { id, projectId, name, startUrl, steps[], createdAt, updatedAt }
//
// Secrets (API keys) live in their OWN file under userData and are NEVER written
// into a project directory or returned wholesale to the renderer.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JsonCollection, JsonDocument } = require('./db');
const { DEFAULT_SETTINGS } = require('../config');

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

  const history = {
    list: (limit) => historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '')).slice(0, limit || 100),
    record: ({ url, title }) => {
      if (!url) return null;
      const recent = historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || ''))[0];
      if (recent && recent.url === url) return historyC.update(recent.id, { visitedAt: now(), title: title || recent.title });
      return historyC.insert({ id: id(), url, title: title || '', visitedAt: now() });
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
    get: () => settingsD.data(),
    set: (patch) => settingsD.merge(patch),
  };

  const secrets = {
    providers: () => {
      const s = secretsD.data();
      return { claude: !!s.claude, openai: !!s.openai };
    },
    getKey: (provider) => secretsD.data()[provider] || null,
    setKey: (provider, key) => { secretsD.set(provider, key); return secrets.providers(); },
    clearKey: (provider) => { secretsD.unset(provider); return secrets.providers(); },
  };

  return { dir, projects, sessions, annotations, recordings, history, bookmarks, settings, secrets };
}

module.exports = { createRepositories };
