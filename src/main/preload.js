// Shell preload — the ONLY bridge between the renderer UI and the main process.
// Exposes a clean, namespaced, promise-based API as window.caos. The renderer
// never sees raw IPC channel strings.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('caos', {
  // End-to-end self-test hooks (only meaningful when CAOS_E2E=1 is set).
  e2e: process.env.CAOS_E2E === '1',
  e2eDone: (payload) => invoke('caos:e2e-done', payload),

  config: () => invoke('caos:config'),

  // Menu accelerators dispatch command ids here; app.js owns the command table.
  onCommand: (cb) => {
    const listener = (_e, payload) => cb(payload || {});
    ipcRenderer.on('caos:command', listener);
    return () => ipcRenderer.removeListener('caos:command', listener);
  },

  system: {
    theme: () => invoke('caos:system-theme.get'),
    onThemeChange: (cb) => {
      const listener = (_e, theme) => cb(theme);
      ipcRenderer.on('caos:system-theme', listener);
      return () => ipcRenderer.removeListener('caos:system-theme', listener);
    },
  },

  fs: {
    openFile: () => invoke('caos:open-file'),
    openJson: () => invoke('caos:open-json'),
    openDirectory: () => invoke('caos:open-directory'),
    save: (payload) => invoke('caos:save', payload),
    saveScreenshot: (payload) => invoke('caos:save-screenshot', payload),
    reveal: (filePath) => invoke('caos:reveal', filePath),
    captureFullPage: (webContentsId) => invoke('caos:capture-fullpage', webContentsId),
  },

  agent: {
    write: (sessionId, extras) => invoke('caos:agent.write', sessionId, extras),
    run: (sessionId, filePath) => invoke('caos:agent.run', sessionId, filePath),
    onOutput: (cb) => {
      const listener = (_e, chunk) => cb(chunk);
      ipcRenderer.on('caos:agent.output', listener);
      return () => ipcRenderer.removeListener('caos:agent.output', listener);
    },
  },

  projects: {
    list: () => invoke('caos:projects.list'),
    get: (id) => invoke('caos:projects.get', id),
    create: (p) => invoke('caos:projects.create', p),
    touch: (id) => invoke('caos:projects.touch', id),
    update: (id, patch) => invoke('caos:projects.update', id, patch),
    remove: (id) => invoke('caos:projects.remove', id),
  },

  sessions: {
    list: (projectId) => invoke('caos:sessions.list', projectId),
    get: (id) => invoke('caos:sessions.get', id),
    create: (s) => invoke('caos:sessions.create', s),
    update: (id, patch) => invoke('caos:sessions.update', id, patch),
    remove: (id) => invoke('caos:sessions.remove', id),
  },

  annotations: {
    bySession: (sessionId) => invoke('caos:annotations.bySession', sessionId),
    bySessionUrl: (sessionId, url) => invoke('caos:annotations.bySessionUrl', sessionId, url),
    countsBySession: () => invoke('caos:annotations.countsBySession'),
    create: (a) => invoke('caos:annotations.create', a),
    update: (id, patch) => invoke('caos:annotations.update', id, patch),
    remove: (id) => invoke('caos:annotations.remove', id),
  },

  recordings: {
    list: (projectId) => invoke('caos:recordings.list', projectId),
    get: (id) => invoke('caos:recordings.get', id),
    create: (r) => invoke('caos:recordings.create', r),
    update: (id, patch) => invoke('caos:recordings.update', id, patch),
    remove: (id) => invoke('caos:recordings.remove', id),
  },

  history: {
    list: (limit) => invoke('caos:history.list', limit),
    record: (entry) => invoke('caos:history.record', entry),
    clear: () => invoke('caos:history.clear'),
  },

  bookmarks: {
    list: () => invoke('caos:bookmarks.list'),
    isBookmarked: (url) => invoke('caos:bookmarks.isBookmarked', url),
    toggle: (entry) => invoke('caos:bookmarks.toggle', entry),
    remove: (id) => invoke('caos:bookmarks.remove', id),
  },

  settings: {
    get: () => invoke('caos:settings.get'),
    set: (patch) => invoke('caos:settings.set', patch),
  },

  secrets: {
    providers: () => invoke('caos:secrets.providers'),
    setKey: (provider, key) => invoke('caos:secrets.setKey', provider, key),
    clearKey: (provider) => invoke('caos:secrets.clearKey', provider),
  },

  ai: {
    run: (payload) => invoke('caos:ai.run', payload),
  },

  export: {
    build: (format, sessionId, extras) => invoke('caos:export.build', format, sessionId, extras),
    recording: (format, recordingId) => invoke('caos:export.recording', format, recordingId),
  },

  bundle: {
    export: (projectId) => invoke('caos:bundle.export', projectId),
    import: (text) => invoke('caos:bundle.import', text),
  },
});
