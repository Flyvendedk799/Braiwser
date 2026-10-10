// Domain repositories over the JSON store. This is the single source of truth
// for projects, sessions, annotations, recordings, settings, and secrets.
//
// Data model:
//   Project    { id, name, path, entry?, kind:'local'|'url', imported?, createdAt, lastOpenedAt }
//                path   — for kind:'local' ALWAYS a project DIRECTORY (an Open File
//                         project stores the file's parent directory here); the
//                         agent hand-off writes into and runs in this directory.
//                entry  — absolute path of the page that was opened (the file for
//                         Open File, the detected index.html for Open Folder), or
//                         absent. Never used as a cwd.
//                imported — true for projects created from a bundle: their path came
//                         from someone else's machine, so it is NOT trusted for
//                         writing files or running the agent command until the user
//                         picks a local directory (projects.relocate).
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
const { JsonCollection, JsonDocument, transact, cleanupStaleTmp } = require('./db');
const { redactSteps, redactRecording, recordingHasSecrets } = require('../../shared/redact');
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
    coachComplete: !!base.coachComplete,
    nextActionDone: !!base.nextActionDone,
    restoreAnnotationsOnLoad: base.restoreAnnotationsOnLoad !== false,
    replayDelayMs: Number.isFinite(Number(base.replayDelayMs)) ? Math.max(0, Number(base.replayDelayMs)) : DEFAULT_SETTINGS.replayDelayMs,
    aiTimeoutMs: Number.isFinite(Number(base.aiTimeoutMs)) ? Math.max(5000, Number(base.aiTimeoutMs)) : DEFAULT_SETTINGS.aiTimeoutMs,
    theme: THEME_IDS.includes(base.theme) ? base.theme : DEFAULT_SETTINGS.theme,
    device: DEVICE_IDS.includes(base.device) ? base.device : DEFAULT_SETTINGS.device,
    deviceLandscape: !!base.deviceLandscape,
    leftView: base.leftView === 'page' ? 'page' : 'workspace',
    leftCollapsed: !!base.leftCollapsed,
    rightCollapsed: !!base.rightCollapsed,
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
    featureFlags: {
      agentRuntime: !!(base.featureFlags && base.featureFlags.agentRuntime),
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
  if (Object.prototype.hasOwnProperty.call(patch, 'coachComplete')) {
    clean.coachComplete = !!patch.coachComplete;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'nextActionDone')) {
    clean.nextActionDone = !!patch.nextActionDone;
  }
  if (patch.profile && typeof patch.profile === 'object' && !Array.isArray(patch.profile)) {
    clean.profile = { ...(current.profile || {}) };
    if (Object.prototype.hasOwnProperty.call(patch.profile, 'displayName')) {
      clean.profile.displayName = cleanText(patch.profile.displayName, 80);
    }
  }
  if (patch.featureFlags && typeof patch.featureFlags === 'object' && !Array.isArray(patch.featureFlags)) {
    clean.featureFlags = { ...(current.featureFlags || {}) };
    if (Object.prototype.hasOwnProperty.call(patch.featureFlags, 'agentRuntime')) {
      clean.featureFlags.agentRuntime = !!patch.featureFlags.agentRuntime;
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
  if (typeof patch.leftView === 'string') clean.leftView = patch.leftView === 'page' ? 'page' : 'workspace';
  if (Object.prototype.hasOwnProperty.call(patch, 'leftCollapsed')) clean.leftCollapsed = !!patch.leftCollapsed;
  if (Object.prototype.hasOwnProperty.call(patch, 'rightCollapsed')) clean.rightCollapsed = !!patch.rightCollapsed;
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


// Visibility is a privacy switch (client deliverables). Anything that is not
// explicitly 'client' — including records written before the field existed —
// is internal, so an unmarked note can never leak into a client pack.
function normalizeVisibility(v) {
  return v === 'client' ? 'client' : 'internal';
}

function withVisibility(a) {
  if (!a || a.visibility === normalizeVisibility(a.visibility)) return a;
  return { ...a, visibility: normalizeVisibility(a.visibility) };
}

// A 'local' project's `path` is always a directory. Open File used to store the
// file itself there, which made the hand-off try to create `<file>/.braiwser`.
// A file path is split into directory (path) + entry (the file itself).
function normalizeLocation(fsx, { path: p, entry, kind }) {
  const out = { path: p };
  if (typeof entry === 'string' && entry) out.entry = entry;
  if (kind === 'url' || typeof p !== 'string' || !p) return out;
  try {
    if (fsx.statSync(p).isFile()) {
      out.path = path.dirname(p);
      out.entry = out.entry || p;
    }
  } catch (_e) { /* missing path: keep as the user gave it */ }
  return out;
}

function createRepositories(userDataDir, opts = {}) {
  const fsx = opts.fs || fs;
  const dir = path.join(userDataDir, STORE_DIR);
  fsx.mkdirSync(dir, { recursive: true });
  cleanupStaleTmp(dir, undefined, fsx);
  const schema = migrateStore(dir, { fs: fsx });

  const fo = { fs: fsx };
  const projectsC = new JsonCollection(dir, 'projects', fo);
  const sessionsC = new JsonCollection(dir, 'sessions', fo);
  const annotationsC = new JsonCollection(dir, 'annotations', fo);
  const recordingsC = new JsonCollection(dir, 'recordings', fo);
  const historyC = new JsonCollection(dir, 'history', fo);
  const bookmarksC = new JsonCollection(dir, 'bookmarks', fo);
  const commentsC = new JsonCollection(dir, 'comments', fo);
  const workspacesC = new JsonCollection(dir, 'workspaces', fo);
  const analyticsC = new JsonCollection(dir, 'analytics', fo);
  const auditLogC = new JsonCollection(dir, 'audit-log', fo);
  const settingsD = new JsonDocument(dir, 'settings', DEFAULT_SETTINGS, fo);
  const secretsD = new JsonDocument(dir, 'secrets', {}, fo);
  const licenseD = new JsonDocument(dir, 'license', { key: '', activatedAt: null, tier: 'free' }, fo);
  const syncQueueC = new JsonCollection(dir, 'sync-queue', fo);
  const allStores = [
    projectsC, sessionsC, annotationsC, recordingsC, historyC, bookmarksC, commentsC,
    workspacesC, analyticsC, auditLogC, settingsD, secretsD, licenseD, syncQueueC,
  ];

  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID();

  const buildProject = ({ name, path: p, kind, entry, imported }) => {
    const loc = normalizeLocation(fsx, { path: p, entry, kind });
    const doc = { id: id(), name, path: loc.path, kind: kind || 'local', createdAt: now(), lastOpenedAt: now() };
    if (loc.entry) doc.entry = loc.entry;
    if (imported) doc.imported = true;
    return doc;
  };

  const projects = {
    list: () => projectsC.all().sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '')),
    get: (i) => projectsC.get(i),
    create: (p) => projectsC.insert(buildProject(p || {})),
    touch: (i) => projectsC.update(i, { lastOpenedAt: now() }),
    // `imported` can only be cleared by `relocate` (a fresh local selection).
    update: (i, patch) => {
      const { imported: _ignored, ...rest } = patch || {};
      if (Object.prototype.hasOwnProperty.call(rest, 'path')) {
        const cur = projectsC.get(i);
        const loc = normalizeLocation(fsx, { path: rest.path, entry: rest.entry, kind: rest.kind || (cur && cur.kind) });
        rest.path = loc.path;
        if (loc.entry) rest.entry = loc.entry;
      }
      return projectsC.update(i, rest);
    },
    // The user picked a local directory for an imported (or moved) project. This
    // is the ONLY way a project stops being `imported`.
    relocate: (i, { path: dirPath, entry } = {}) => {
      let st;
      try { st = fsx.statSync(dirPath); } catch (_e) { st = null; }
      if (!st || !st.isDirectory()) throw new Error('Choose an existing folder for this project.');
      const cur = projectsC.get(i);
      if (!cur) return null;
      const next = { ...cur, path: dirPath, kind: 'local', imported: false, relocatedAt: now() };
      if (typeof entry === 'string' && entry) next.entry = entry; else delete next.entry;
      projectsC.replaceDoc(i, next);
      return projectsC.get(i);
    },
    remove: (i) => transact([projectsC, sessionsC, annotationsC, recordingsC, commentsC], (tx) => {
      const sessionIds = new Set(tx(sessionsC).find((s) => s.projectId === i).map((s) => s.id));
      const gone = new Set();
      tx(annotationsC).removeWhere((a) => {
        const hit = sessionIds.has(a.sessionId);
        if (hit) gone.add(a.id);
        return hit;
      });
      tx(commentsC).removeWhere((c) => sessionIds.has(c.sessionId) || gone.has(c.annotationId));
      tx(sessionsC).removeWhere((s) => s.projectId === i);
      tx(recordingsC).removeWhere((r) => r.projectId === i);
      return tx(projectsC).remove(i);
    }),
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
    remove: (i) => transact([sessionsC, annotationsC, commentsC], (tx) => {
      const gone = new Set();
      tx(annotationsC).removeWhere((a) => {
        const hit = a.sessionId === i;
        if (hit) gone.add(a.id);
        return hit;
      });
      tx(commentsC).removeWhere((c) => c.sessionId === i || gone.has(c.annotationId));
      return tx(sessionsC).remove(i);
    }),
  };

  const buildAnnotation = (a, defaultOrder) => {
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
      visibility: normalizeVisibility(a.visibility),
      sortOrder: Number.isFinite(a.sortOrder) ? a.sortOrder : defaultOrder,
      createdAt: a.ts || now(),
      updatedAt: now(),
    };
    if (a.edit) doc.edit = a.edit;
    if (a.viewport && typeof a.viewport === 'object') doc.viewport = a.viewport;
    return doc;
  };

  const annotations = {
    bySession: (sessionId) => annotationsC.find((a) => a.sessionId === sessionId).map(withVisibility).sort((a, b) => {
      const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    }),
    bySessionUrl: (sessionId, url) => annotationsC.find((a) => a.sessionId === sessionId && a.url === url).map(withVisibility),
    countsBySession: () => {
      const counts = {};
      for (const a of annotationsC.all()) counts[a.sessionId] = (counts[a.sessionId] || 0) + 1;
      return counts;
    },
    get: (i) => withVisibility(annotationsC.get(i)),
    // Annotation + the session's updatedAt bump commit together or not at all.
    create: (a) => transact([annotationsC, sessionsC], (tx) => {
      const existing = tx(annotationsC).find((x) => x.sessionId === a.sessionId);
      const doc = buildAnnotation(a, existing.length);
      tx(annotationsC).insert(doc);
      if (a.sessionId) tx(sessionsC).update(a.sessionId, { updatedAt: now() });
      return doc;
    }),
    update: (i, patch) => {
      const p = { ...patch, updatedAt: now() };
      if (Object.prototype.hasOwnProperty.call(p, 'visibility')) p.visibility = normalizeVisibility(p.visibility);
      return annotationsC.update(i, p);
    },
    remove: (i) => annotationsC.remove(i),
    // One write for the whole list, however long it is.
    reorder: (sessionId, orderedIds) => {
      if (!Array.isArray(orderedIds)) return annotations.bySession(sessionId);
      const mine = new Set(annotationsC.find((a) => a.sessionId === sessionId).map((a) => a.id));
      const stamp = now();
      const patches = [];
      orderedIds.forEach((aid, index) => {
        if (mine.has(aid)) patches.push({ id: aid, patch: { sortOrder: index, updatedAt: stamp } });
      });
      annotationsC.updateMany(patches);
      return annotations.bySession(sessionId);
    },
  };

  const recordings = {
    // Second redaction boundary (CE-01): nothing leaves the repository with a
    // plaintext secret in it, whatever an older build or an import wrote.
    list: (projectId) => {
      const all = recordingsC.all();
      const f = projectId ? all.filter((r) => r.projectId === projectId) : all;
      return f.map(redactRecording).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },
    get: (i) => {
      const r = recordingsC.get(i);
      return r ? redactRecording(r) : r;
    },
    create: ({ projectId, name, startUrl, steps }) =>
      recordingsC.insert({ id: id(), projectId: projectId || null, name: name || 'Journey', startUrl: startUrl || '', steps: redactSteps(steps || []), createdAt: now(), updatedAt: now() }),
    update: (i, patch) => {
      const p = { ...patch, updatedAt: now() };
      if (Object.prototype.hasOwnProperty.call(p, 'steps')) p.steps = redactSteps(p.steps);
      return redactRecording(recordingsC.update(i, p));
    },
    remove: (i) => recordingsC.remove(i),
  };

  // Bulk import: a whole project tree lands in ONE write per file and either
  // fully commits or fully rolls back (bundle import used to do hundreds of
  // synchronous rewrites and could leave half a project behind).
  //   project:     { name, path, kind, imported? }   (imported defaults to true)
  //   sessions:    [{ sourceId, name, url, title }]
  //   annotations: [{ sessionSourceId | sessionId, ...annotation fields }]
  //   recordings:  [{ name, startUrl, steps }]
  const bulk = {
    importProject: ({ project, sessions: sess = [], annotations: anns = [], recordings: recs = [] }) =>
      transact([projectsC, sessionsC, annotationsC, recordingsC], (tx) => {
        const p = buildProject({ ...project, imported: !project || project.imported !== false });
        tx(projectsC).insert(p);
        const sessionIdMap = {};
        const createdSessions = [];
        for (const s of sess) {
          const doc = { id: id(), projectId: p.id, name: s.name || 'Review', url: s.url || '', title: s.title || '', createdAt: now(), updatedAt: now() };
          if (s.sourceId != null) sessionIdMap[s.sourceId] = doc.id;
          createdSessions.push(doc);
        }
        tx(sessionsC).insertMany(createdSessions);
        const orderCount = {};
        const createdAnns = [];
        for (const a of anns) {
          const sid = sessionIdMap[a.sessionSourceId != null ? a.sessionSourceId : a.sessionId];
          if (!sid) continue; // orphaned annotation — drop rather than guess
          const n = orderCount[sid] || 0;
          orderCount[sid] = n + 1;
          createdAnns.push(buildAnnotation({ ...a, id: undefined, sessionId: sid }, n));
        }
        tx(annotationsC).insertMany(createdAnns);
        const createdRecs = recs.map((r) => ({
          id: id(), projectId: p.id, name: r.name || 'Journey', startUrl: r.startUrl || '',
          steps: redactSteps(Array.isArray(r.steps) ? r.steps : []), createdAt: now(), updatedAt: now(),
        }));
        tx(recordingsC).insertMany(createdRecs);
        return {
          project: p,
          sessionIdMap,
          counts: { sessions: createdSessions.length, annotations: createdAnns.length, recordings: createdRecs.length },
        };
      }),
  };

  const HISTORY_MAX = 1000;
  const byVisited = (a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '');
  const history = {
    list: (limit) => historyC.all().sort(byVisited).slice(0, limit || 100),
    record: ({ url, title }) => {
      if (!url) return null;
      return transact([historyC], (tx) => {
        const h = tx(historyC);
        const recent = h.all().sort(byVisited)[0];
        if (recent && recent.url === url) return h.update(recent.id, { visitedAt: now(), title: title || recent.title });
        const inserted = h.insert({ id: id(), url, title: title || '', visitedAt: now() });
        // Bound growth: keep only the newest HISTORY_MAX entries (same write).
        if (h.list.length > HISTORY_MAX) {
          const keep = new Set(h.all().sort(byVisited).slice(0, HISTORY_MAX).map((x) => x.id));
          h.removeWhere((x) => !keep.has(x.id));
        }
        return inserted;
      });
    },
    clear: () => { historyC.removeWhere(() => true); return true; },
  };

  const bookmarks = {
    list: () => bookmarksC.all().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    isBookmarked: (url) => bookmarksC.find((b) => b.url === url).length > 0,
    toggle: ({ url, title }) => {
      if (!url) return { bookmarked: false };
      return transact([bookmarksC], (tx) => {
        const b = tx(bookmarksC);
        if (b.removeWhere((x) => x.url === url)) return { bookmarked: false };
        b.insert({ id: id(), url, title: title || '', createdAt: now() });
        return { bookmarked: true };
      });
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

  // --- one-time / idempotent upgrades of data written by older builds --------
  // Each step is skipped (and reported) when its file is in a recovery state;
  // none of them can delete anything the user created.
  const maintenance = { projectsNormalized: 0, annotationsNormalized: 0, recordingsScrubbed: 0, errors: [] };
  const attempt = (label, fn) => {
    try { fn(); } catch (err) { maintenance.errors.push({ step: label, message: (err && err.message) || String(err) }); }
  };
  attempt('projects', () => {
    const patches = [];
    for (const p of projectsC.all()) {
      if (p.kind === 'url' || typeof p.path !== 'string' || !p.path) continue;
      const loc = normalizeLocation(fsx, p);
      if (loc.path !== p.path || (loc.entry && loc.entry !== p.entry)) patches.push({ id: p.id, patch: { path: loc.path, entry: loc.entry } });
    }
    if (patches.length) { projectsC.updateMany(patches); maintenance.projectsNormalized = patches.length; }
  });
  attempt('annotations', () => {
    const patches = annotationsC.all()
      .filter((a) => a.visibility !== normalizeVisibility(a.visibility))
      .map((a) => ({
        id: a.id,
        patch: a.visibility == null || a.visibility === ''
          ? { visibility: 'internal' }
          : { visibility: 'internal', legacyVisibility: String(a.visibility).slice(0, 40) },
      }));
    if (patches.length) { annotationsC.updateMany(patches); maintenance.annotationsNormalized = patches.length; }
  });
  attempt('recordings', () => {
    const all = recordingsC.all();
    const scrubbed = all.map(redactRecording);
    const n = scrubbed.filter((r, i) => r !== all[i]).length;
    if (!n) return;
    // No backup: the previous generation is exactly the file with secrets in it.
    recordingsC.replaceAll(scrubbed, { backup: false });
    maintenance.recordingsScrubbed = n;
  });

  // Storage health: which files (if any) are read-only because they could not be
  // read or are damaged. Plain data, safe to send over IPC.
  function health() {
    const problems = allStores.map((s) => s.status()).filter((s) => !s.ok);
    return {
      ok: problems.length === 0 && maintenance.errors.length === 0,
      problems,
      maintenance: { ...maintenance, errors: maintenance.errors.slice() },
      schema,
    };
  }

  function recover(name, mode) {
    const store = allStores.find((s) => s.name === name);
    if (!store) throw new Error(`Unknown store file: ${name}`);
    return store.recover(mode);
  }

  return {
    dir,
    schema,
    projects,
    sessions,
    annotations,
    recordings,
    bulk,
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
    health,
    recover,
    transact,
  };
}

module.exports = { createRepositories, normalizeVisibility };
