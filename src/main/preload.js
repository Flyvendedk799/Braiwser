// Shell preload — the ONLY bridge between the renderer UI and the main process.
// Exposes window.braiwser (canonical) and window.caos (alias during rename).
// The renderer never sees raw IPC channel strings.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const e2eEnabled = process.env.BRAIWSER_E2E === '1' || process.env.CAOS_E2E === '1';

const api = {
  // End-to-end self-test hooks (only meaningful when BRAIWSER_E2E=1 / CAOS_E2E=1).
  e2e: e2eEnabled,
  e2eDone: (payload) => invoke('caos:e2e-done', payload),
  e2eCheck: (check) => invoke('caos:e2e-check', check),

  config: () => invoke('caos:config'),

  // Menu accelerators dispatch command ids here; app.js owns the command table.
  onCommand: (cb) => {
    const listener = (_e, payload) => cb(payload || {});
    ipcRenderer.on('caos:command', listener);
    return () => ipcRenderer.removeListener('caos:command', listener);
  },

  onUpdate: (cb) => {
    const listener = (_e, payload) => cb(payload || {});
    ipcRenderer.on('caos:update', listener);
    return () => ipcRenderer.removeListener('caos:update', listener);
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
    templates: () => invoke('caos:agent.templates'),
    presets: () => invoke('caos:agent.presets'),
    detect: () => invoke('caos:agent.detect'),
    templatedPrompt: (payload) => invoke('caos:agent.templatedPrompt', payload),
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
    reorder: (sessionId, orderedIds) => invoke('caos:annotations.reorder', sessionId, orderedIds),
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
    claudeLoginStart: () => invoke('caos:auth.claudeLoginStart'),
    claudeLoginFinish: (pasted) => invoke('caos:auth.claudeLoginFinish', pasted),
    claudeDisconnect: () => invoke('caos:auth.claudeDisconnect'),
  },

  ai: {
    run: (payload) => invoke('caos:ai.run', payload),
  },

  export: {
    build: (format, sessionId, extras) => invoke('caos:export.build', format, sessionId, extras),
    buildElement: (payload, format) => invoke('caos:element.build', payload, format),
    recordingReport: (id, format) => invoke('caos:recording.report', id, format),
    recordingPdf: (id) => invoke('caos:recording.pdf', id),
    saveBinary: (payload) => invoke('caos:save-binary', payload),
    videoSource: (webContentsId) => invoke('caos:video.source', webContentsId),
    saveElement: (payload) => invoke('caos:element.save', payload),
    recording: (format, recordingId) => invoke('caos:export.recording', format, recordingId),
  },

  bundle: {
    export: (projectId) => invoke('caos:bundle.export', projectId),
    import: (text) => invoke('caos:bundle.import', text),
  },

  license: {
    status: () => invoke('caos:license.status'),
    activate: (key) => invoke('caos:license.activate', key),
    demoKey: (opts) => invoke('caos:license.demoKey', opts),
    canUse: (feature) => invoke('caos:license.canUse', feature),
  },

  analytics: {
    track: (event, props) => invoke('caos:analytics.track', event, props),
    funnel: () => invoke('caos:analytics.funnel'),
    diagnostics: () => invoke('caos:analytics.diagnostics'),
  },

  sync: {
    status: () => invoke('caos:sync.status'),
    signIn: (email) => invoke('caos:sync.signIn', email),
    signOut: () => invoke('caos:sync.signOut'),
    enqueue: (projectId) => invoke('caos:sync.enqueue', projectId),
    drain: () => invoke('caos:sync.drain'),
  },

  team: {
    list: () => invoke('caos:team.list'),
    create: (payload) => invoke('caos:team.create', payload),
    invite: (workspaceId, member) => invoke('caos:team.invite', workspaceId, member),
    listComments: (query) => invoke('caos:team.comments.list', query),
    addComment: (payload) => invoke('caos:team.comments.add', payload),
  },

  billing: {
    status: () => invoke('caos:billing.status'),
    checkout: (opts) => invoke('caos:billing.checkout', opts),
    seats: (n) => invoke('caos:billing.seats', n),
    gdprExport: () => invoke('caos:billing.gdprExport'),
    gdprDelete: () => invoke('caos:billing.gdprDelete'),
  },

  integrations: {
    issue: (payload) => invoke('caos:integrations.issue', payload),
    ciStarter: (projectPath) => invoke('caos:integrations.ciStarter', projectPath),
    webhook: (event, data) => invoke('caos:integrations.webhook', event, data),
    slack: (text) => invoke('caos:integrations.slack', text),
  },

  review: {
    checklists: () => invoke('caos:review.checklists'),
    applyChecklist: (id, sessionId) => invoke('caos:review.applyChecklist', id, sessionId),
    clientPack: (sessionId) => invoke('caos:review.clientPack', sessionId),
    htmlReport: (sessionId) => invoke('caos:review.htmlReport', sessionId),
    verifySave: (sessionId, payload) => invoke('caos:review.verifySave', sessionId, payload),
    verifyList: (sessionId) => invoke('caos:review.verifyList', sessionId),
  },

  update: {
    check: () => invoke('caos:update.check'),
    install: () => invoke('caos:update.install'),
  },

  enterprise: {
    status: () => invoke('caos:enterprise.status'),
    sso: (cfg) => invoke('caos:enterprise.sso', cfg),
    marketplace: () => invoke('caos:enterprise.marketplace'),
    schema: () => invoke('caos:enterprise.schema'),
  },
};

contextBridge.exposeInMainWorld('braiwser', api);
contextBridge.exposeInMainWorld('caos', api);
