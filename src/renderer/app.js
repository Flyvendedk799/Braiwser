// Chrome AI OS — renderer controller.
// Owns app state, builds the shell, wires the <webview> guest, and orchestrates
// the annotation / recording / replay / AI / export flows. Talks to the backend
// only through window.caos and to the guest page only through the webview.
import { h, clear, toast, confirmDialog, promptDialog, modal, menu, esc } from './lib/dom.js';
import { createToolbar } from './components/toolbar.js';
import { createSidebar } from './components/sidebar.js';
import { createNotesPanel } from './components/notes-panel.js';
import { createInspectorPanel } from './components/inspector-panel.js';
import { createAiPanel } from './components/ai-panel.js';
import { openSettingsModal } from './components/settings-modal.js';
import { createTabStrip } from './components/tabs.js';
import { compositeAnnotations } from './lib/screenshots.js';

const caos = window.caos;

const state = {
  config: null,
  settings: null,
  projects: [],
  currentProject: null,
  sessions: [],
  currentSession: null,
  annotations: [],
  recordings: [],
  selectedRecording: null,
  recordingBuffer: null,
  replaying: false,
  mode: 'off',
  currentUrl: '',
  currentTitle: '',
  activeTab: 'notes',
  sessionCounts: {},
  // Browser tabs (each is its own <webview>); `wv` aliases the active one.
  tabs: [],
  activeTabId: null,
  bookmarked: false,
  history: [],
  bookmarks: [],
};

let wv; // the ACTIVE tab's <webview>
let toolbar, sidebar, notesPanel, inspectorPanel, aiPanel, tabStrip, webviewHost;
let tabButtons = {};
let stageOverlay, overlayLabel, overlayFill, overlayCancelBtn;
const replayWaiters = new Map(); // index -> {resolve}
let pendingDomReady = null;
let tabSeq = 0;

const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId) || null;

// ============================================================ BOOT
async function boot() {
  state.config = await caos.config();
  state.settings = await caos.settings.get();
  buildShell();
  await refreshProjects();
  await refreshRecordings();
  await refreshHistory();
  await refreshBookmarks();
  // Open the first tab on the welcome page.
  createTab(state.config.welcomeUrl);

  if (caos.e2e) {
    const internals = {
      state, caos, getWv: () => wv,
      navigateTo, setMode, openSession, replaySelected, selectRecording,
      startRecording, refreshPins, refreshRecordings,
      createTab, setActiveTab, closeTab, refreshHistory, refreshBookmarks,
    };
    import('./lib/e2e.js')
      .then((m) => m.run(internals))
      .catch((e) => caos.e2eDone({ ok: false, fatal: String((e && e.stack) || e) }));
  }
}

// ============================================================ SHELL
function buildShell() {
  const root = document.getElementById('root');
  clear(root);

  toolbar = createToolbar({
    navigate: (v) => navigateTo(resolveAddress(v)),
    back: () => wv.canGoBack() && wv.goBack(),
    forward: () => wv.canGoForward() && wv.goForward(),
    reload: () => wv.reload(),
    toggleMode: setMode,
    toggleRecord: toggleRecord,
    replay: () => replaySelected(),
    screenshot: onScreenshot,
    openAi: () => switchTab('ai'),
    openSettings: openSettings,
    openFile: openFile,
    openFolder: openFolder,
    toggleBookmark: toggleBookmark,
  });

  sidebar = createSidebar({
    newProject: createProject,
    openProject: openProject,
    renameProject: renameProject,
    deleteProject: deleteProject,
    newSession: () => createSession(),
    openSession: openSession,
    renameSession: renameSession,
    deleteSession: deleteSession,
    selectRecording: selectRecording,
    replayRecording: (r) => { selectRecording(r); replaySelected(); },
    editRecording: editRecording,
    deleteRecording: deleteRecording,
    openUrl: (url) => navigateTo(url),
    removeBookmark: async (b) => { await caos.bookmarks.remove(b.id); await refreshBookmarks(); updateBookmarkState(); },
    clearHistory: async () => { if (await confirmDialog({ title: 'Clear history', message: 'Remove all browsing history?', confirmLabel: 'Clear' })) { await caos.history.clear(); await refreshHistory(); } },
  });

  // ---- Right panel ----
  notesPanel = createNotesPanel(state.config, {
    locate: (a) => sendWv('caos:highlight-target', a.target),
    editNote: (a, note) => updateAnnotation(a, { note }),
    toggleStatus: (a) => updateAnnotation(a, { status: (a.status || 'open') === 'open' ? 'resolved' : 'open' }),
    setPriority: (a, priority) => updateAnnotation(a, { priority }),
    remove: removeAnnotation,
    onCount: (total) => { if (tabButtons.notes) tabButtons.notes.querySelector('.pill').textContent = String(total); },
  });

  inspectorPanel = createInspectorPanel({
    requestTree: () => sendWv('caos:request-dom-tree'),
    highlight: (target) => sendWv('caos:highlight-target', target),
  });

  aiPanel = createAiPanel(state.config, {
    currentSessionId: () => state.currentSession && state.currentSession.id,
    run: (task, sessionId) => caos.ai.run({ task, sessionId, provider: state.settings.aiProvider }),
    save: saveAiResult,
    openSettings: openSettings,
  });

  const tabs = h('div', { class: 'tabs' });
  ['notes', 'inspector', 'ai'].forEach((id) => {
    const labels = { notes: 'Notes', inspector: 'Inspector', ai: 'AI' };
    const showPill = id === 'notes';
    const btn = h('button', {
      class: `tab ${id === state.activeTab ? 'active' : ''}`,
      html: `<span>${labels[id]}</span>${showPill ? '<span class="pill">0</span>' : ''}`,
      on: { click: () => switchTab(id) },
    });
    tabButtons[id] = btn;
    tabs.appendChild(btn);
  });

  const footer = h('div', { class: 'panel-footer' }, [
    exportBtn('Markdown', 'markdown'),
    exportBtn('Prompt', 'prompt'),
    exportBtn('JSON', 'json'),
    h('button', { class: 'btn btn-sm btn-primary', text: '→ Agent', title: 'Hand off this session to a coding agent', on: { click: handoffToAgent } }),
  ]);

  const panel = h('aside', { class: 'panel' }, [tabs, notesPanel.root, inspectorPanel.root, aiPanel.root, footer]);

  // ---- Stage (tab strip + webview host) ----
  tabStrip = createTabStrip({ newTab: () => createTab(state.config.welcomeUrl), selectTab: setActiveTab, closeTab: closeTab });
  webviewHost = h('div', { class: 'wv-host' });
  overlayLabel = h('span', { class: 'so-label' });
  overlayFill = h('div', { class: 'so-fill', style: { width: '0%' } });
  overlayCancelBtn = h('button', { class: 'btn btn-sm btn-ghost', text: 'Cancel', on: { click: cancelReplay } });
  stageOverlay = h('div', { class: 'stage-overlay' }, [overlayLabel, h('div', { class: 'so-bar' }, [overlayFill]), overlayCancelBtn]);
  const stage = h('div', { class: 'stage' }, [tabStrip.root, webviewHost, stageOverlay]);

  const body = h('div', { class: 'body' }, [sidebar.root, stage, panel]);
  root.appendChild(toolbar.root);
  root.appendChild(body);

  renderSidebar();
  switchTab(state.activeTab);
}

function exportBtn(label, format) {
  return h('button', { class: 'btn btn-sm', text: label, on: { click: () => doExport(format) } });
}

function switchTab(id) {
  state.activeTab = id;
  Object.entries(tabButtons).forEach(([k, b]) => b.classList.toggle('active', k === id));
  [notesPanel, inspectorPanel, aiPanel].forEach((p) => p.root.classList.remove('active'));
  ({ notes: notesPanel, inspector: inspectorPanel, ai: aiPanel })[id].root.classList.add('active');
}

// ============================================================ TABS + WEBVIEW WIRING
function createTab(url) {
  const el = h('webview', { class: 'wv', allowpopups: '' });
  // Preload MUST be set before the first load. sandbox=no lets the preload use
  // require() for its sibling engines; contextIsolation keeps the page out.
  el.setAttribute('preload', state.config.inspectorPath);
  el.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,nodeIntegration=no');
  const tab = { id: 'tab' + ++tabSeq, wv: el, url: url || '', title: '' };
  state.tabs.push(tab);
  webviewHost.appendChild(el);
  setupTabWebview(tab);
  setActiveTab(tab.id);
  if (url) { el.src = url; tab.url = url; }
  return tab;
}

function setActiveTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (state.replaying && tab.id !== state.activeTabId) {
    toast('Finish or cancel replay before switching tabs', 'warn');
    return;
  }
  state.activeTabId = id;
  wv = tab.wv; // global alias used throughout
  state.tabs.forEach((t) => t.wv.classList.toggle('active', t.id === id));
  state.currentUrl = tab.url;
  state.currentTitle = tab.title;
  toolbar.setAddress(tab.url);
  syncToolbar();
  updateBookmarkState();
  renderTabs();
  try { sendWv('caos:set-mode', state.mode); } catch (_e) { /* not ready */ }
  maybeRestoreAnnotations();
}

function closeTab(id) {
  if (state.replaying) { toast('Finish or cancel replay before closing tabs', 'warn'); return; }
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = state.tabs.splice(idx, 1);
  try { tab.wv.remove(); } catch (_e) { /* ignore */ }
  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) setActiveTab(next.id);
    else createTab(state.config.welcomeUrl);
  } else {
    renderTabs();
  }
}

function renderTabs() {
  tabStrip.update(state.tabs, state.activeTabId);
}

function setupTabWebview(tab) {
  const el = tab.wv;
  const isActive = () => state.activeTabId === tab.id;

  el.addEventListener('dom-ready', () => {
    el.send('caos:set-mode', isActive() ? state.mode : 'off');
    if (isActive()) {
      if (pendingDomReady) { const r = pendingDomReady; pendingDomReady = null; r(); }
      maybeRestoreAnnotations();
    }
  });

  el.addEventListener('console-message', (e) => {
    if (e.level >= 2) console.warn(`[guest] ${e.message}`);
  });

  // Surface load failures (ignore -3 ERR_ABORTED and sub-frame errors) and
  // recover the guest renderer if it crashes.
  el.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || e.isMainFrame === false) return;
    tab.errored = true;
    if (isActive()) toast(`Load failed: ${e.errorDescription || e.errorCode}`, 'error', 4000);
  });
  el.addEventListener('render-process-gone', (e) => {
    if (isActive()) toast(`Page crashed (${(e && e.reason) || 'gone'}) — reloading`, 'error', 4000);
    try { el.reload(); } catch (_err) { /* ignore */ }
  });

  el.addEventListener('did-navigate', (e) => onNavigated(tab, e.url));
  el.addEventListener('did-navigate-in-page', (e) => onNavigated(tab, e.url));
  el.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    if (isActive()) { state.currentTitle = e.title; syncSessionTitle(); }
    renderTabs();
  });

  el.addEventListener('ipc-message', (e) => {
    const payload = e.args && e.args[0];
    switch (e.channel) {
      case 'caos:ready':
        if (payload) { tab.title = payload.title || tab.title; if (isActive()) state.currentTitle = tab.title; }
        break;
      case 'caos:annotation':
        if (isActive()) onAnnotation(payload);
        break;
      case 'caos:escape':
        setMode('off');
        break;
      case 'caos:rec-step':
        if (isActive() && state.recordingBuffer) state.recordingBuffer.steps.push(payload);
        break;
      case 'caos:replay-ack': {
        if (!isActive()) break; // only the tab replay runs on may answer
        const w = replayWaiters.get(payload.index);
        if (w) { replayWaiters.delete(payload.index); w.resolve(payload); }
        break;
      }
      case 'caos:dom-tree':
        if (isActive()) inspectorPanel.setTree(payload);
        break;
      case 'caos:assert-pick':
        if (isActive()) onAssertPick(payload);
        break;
    }
  });
}

function onNavigated(tab, url) {
  tab.url = url;
  // Record real navigations in history (skip the welcome page).
  if (url && !/welcome\.html$/.test(url)) {
    caos.history.record({ url, title: tab.title }).then(() => { if (state.activeTabId === tab.id) refreshHistory(); });
  }
  renderTabs();
  if (state.activeTabId !== tab.id) return;

  if (!state.replaying) {
    toolbar.setAddress(url);
    updateBookmarkState();
  }
  state.currentUrl = url;
  syncToolbar();
  // Record navigations that happen while recording (clicks/links etc.).
  if (state.recordingBuffer) {
    const steps = state.recordingBuffer.steps;
    const last = steps[steps.length - 1];
    if (!last || last.type !== 'navigate' || last.url !== url) {
      steps.push({ type: 'navigate', url, ts: Date.now() });
    }
  }
}

function navigateTo(url) {
  if (!url || !wv) return;
  const tab = activeTab();
  state.currentUrl = url;
  if (tab) tab.url = url;
  toolbar.setAddress(url);
  if (state.recordingBuffer) state.recordingBuffer.steps.push({ type: 'navigate', url, ts: Date.now() });
  wv.src = url;
  syncToolbar();
}

async function refreshHistory() {
  state.history = await caos.history.list(50);
  renderSidebar();
  updateSuggestions();
}
async function refreshBookmarks() {
  state.bookmarks = await caos.bookmarks.list();
  renderSidebar();
  updateSuggestions();
}

// Address-bar autocomplete: bookmarks first, then recent history (deduped).
function updateSuggestions() {
  if (!toolbar || !toolbar.setSuggestions) return;
  toolbar.setSuggestions([...(state.bookmarks || []), ...(state.history || [])]);
}
async function updateBookmarkState() {
  state.bookmarked = state.currentUrl ? await caos.bookmarks.isBookmarked(state.currentUrl) : false;
  syncToolbar();
}
async function toggleBookmark() {
  if (!state.currentUrl || /welcome\.html$/.test(state.currentUrl)) { toast('Nothing to bookmark', 'warn'); return; }
  const r = await caos.bookmarks.toggle({ url: state.currentUrl, title: state.currentTitle });
  state.bookmarked = !!r.bookmarked;
  await refreshBookmarks();
  syncToolbar();
  toast(state.bookmarked ? 'Bookmarked' : 'Bookmark removed');
}

// Convert address-bar text into a navigable URL.
function resolveAddress(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^[a-z]+:\/\//i.test(v) || v.startsWith('about:') || v.startsWith('data:')) return v;
  if (v.startsWith('/')) return 'file://' + v;
  // bare domain: has a dot, no spaces, looks like a host
  if (/^[^\s]+\.[^\s]{2,}([/?#].*)?$/.test(v) && !/\s/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
}

function syncToolbar() {
  toolbar.update({
    mode: state.mode,
    recording: !!state.recordingBuffer,
    currentUrl: state.currentUrl,
    canGoBack: wv && wv.canGoBack ? safe(() => wv.canGoBack()) : false,
    canGoForward: wv && wv.canGoForward ? safe(() => wv.canGoForward()) : false,
    hasRecording: !!state.selectedRecording,
    replaying: state.replaying,
    bookmarked: state.bookmarked,
  });
}

function safe(fn) { try { return fn(); } catch (_e) { return false; } }

// Send to the active webview, tolerating a null/not-yet-ready/destroyed view.
function sendWv(channel, ...args) {
  if (!wv) return;
  try { wv.send(channel, ...args); } catch (_e) { /* webview not ready or gone */ }
}

// ============================================================ MODES
function setMode(mode) {
  state.mode = state.mode === mode ? 'off' : mode;
  if (wv) sendWv('caos:set-mode', state.mode);
  syncToolbar();
}

// ============================================================ ANNOTATIONS
async function onAnnotation(raw) {
  if (!raw) return;
  const session = await ensureSession();
  const annotation = { ...raw, sessionId: session.id, url: raw.url || state.currentUrl, title: raw.title || state.currentTitle };
  const saved = await caos.annotations.create(annotation);
  state.annotations.push(saved);
  notesPanel.setAnnotations(state.annotations);
  bumpSessionCount(session.id, 1);
  toast(`Note captured — ${saved.action}`, 'success');
  refreshPins();
}

async function updateAnnotation(a, patch) {
  const updated = await caos.annotations.update(a.id, patch);
  const i = state.annotations.findIndex((x) => x.id === a.id);
  if (i >= 0) state.annotations[i] = updated || { ...a, ...patch };
  notesPanel.setAnnotations(state.annotations);
  refreshPins();
}

async function removeAnnotation(a) {
  const ok = await confirmDialog({ title: 'Delete note', message: `Delete this ${a.action} note? This cannot be undone.`, confirmLabel: 'Delete' });
  if (!ok) return;
  await caos.annotations.remove(a.id);
  state.annotations = state.annotations.filter((x) => x.id !== a.id);
  notesPanel.setAnnotations(state.annotations);
  if (state.currentSession) bumpSessionCount(state.currentSession.id, -1);
  refreshPins();
  toast('Note deleted');
}

function maybeRestoreAnnotations() {
  if (!state.settings.restoreAnnotationsOnLoad || !state.currentSession) return;
  const url = state.currentUrl || (wv && safe(() => wv.getURL()));
  if (!url) return;
  caos.annotations.bySessionUrl(state.currentSession.id, url).then((list) => {
    // Number each pin by its position in the full session list so badges match
    // the Notes panel '#'. Fall back to draw-order (null) if not yet in state.
    const arr = (Array.isArray(list) ? list : []).map((a) => {
      const i = state.annotations.findIndex((x) => x.id === a.id);
      return { ...a, pinNum: i >= 0 ? i + 1 : null };
    });
    if (wv) sendWv('caos:restore-annotations', arr);
  });
}

// Re-send the full current set so pin badge numbers match the Notes list '#'.
function refreshPins() {
  if (!state.currentSession || !state.settings.restoreAnnotationsOnLoad) return;
  const url = state.currentUrl;
  const list = state.annotations
    .filter((a) => a.url === url)
    .map((a) => ({ ...a, pinNum: state.annotations.indexOf(a) + 1 }));
  if (wv) sendWv('caos:restore-annotations', list);
}

// ============================================================ SESSIONS
let _sessionInFlight = null;
async function ensureSession() {
  if (state.currentSession) return state.currentSession;
  // Concurrent annotations (e.g. rapid captures) must share ONE create, not
  // each spawn a duplicate "Quick notes" session.
  if (_sessionInFlight) return _sessionInFlight;
  _sessionInFlight = (async () => {
    const session = await caos.sessions.create({
      projectId: state.currentProject ? state.currentProject.id : null,
      name: 'Quick notes',
      url: state.currentUrl,
      title: state.currentTitle,
    });
    state.currentSession = session;
    state.annotations = [];
    await refreshSessions();
    toast('Started a “Quick notes” session');
    return session;
  })();
  try {
    return await _sessionInFlight;
  } finally {
    _sessionInFlight = null;
  }
}

function syncSessionTitle() {
  // Keep the active session's title fresh as the page reports titles.
  if (state.currentSession && state.currentTitle && !state.currentSession.title) {
    caos.sessions.update(state.currentSession.id, { title: state.currentTitle, url: state.currentUrl }).then((s) => {
      if (s) state.currentSession = s;
    });
  }
}

async function createSession() {
  const name = await promptDialog({ title: 'New session', label: 'Session name', value: 'Review', placeholder: 'e.g. Homepage pass' });
  if (!name) return;
  const session = await caos.sessions.create({
    projectId: state.currentProject ? state.currentProject.id : null,
    name,
    url: state.currentUrl,
    title: state.currentTitle,
  });
  await refreshSessions();
  await openSession(session);
}

async function openSession(session) {
  state.currentSession = session;
  state.annotations = await caos.annotations.bySession(session.id);
  notesPanel.setAnnotations(state.annotations);
  renderSidebar();
  switchTab('notes');
  if (session.url && session.url !== state.currentUrl) {
    navigateTo(session.url);
  } else {
    maybeRestoreAnnotations();
  }
}

async function renameSession(session) {
  const name = await promptDialog({ title: 'Rename session', label: 'Session name', value: session.name });
  if (!name) return;
  const updated = await caos.sessions.update(session.id, { name });
  if (state.currentSession && state.currentSession.id === session.id) state.currentSession = updated;
  await refreshSessions();
}

async function deleteSession(session) {
  const ok = await confirmDialog({ title: 'Delete session', message: `Delete “${session.name}” and all its notes?`, confirmLabel: 'Delete' });
  if (!ok) return;
  await caos.sessions.remove(session.id);
  if (state.currentSession && state.currentSession.id === session.id) {
    state.currentSession = null;
    state.annotations = [];
    notesPanel.setAnnotations([]);
    sendWv('caos:clear-overlays');
  }
  await refreshSessions();
  toast('Session deleted');
}

async function refreshSessions() {
  state.sessions = await caos.sessions.list(state.currentProject ? state.currentProject.id : undefined);
  // Badge counts in ONE pass (was N+1 bySession round-trips).
  state.sessionCounts = await caos.annotations.countsBySession();
  renderSidebar();
}

function bumpSessionCount(sessionId, delta) {
  state.sessionCounts[sessionId] = Math.max(0, (state.sessionCounts[sessionId] || 0) + delta);
  renderSidebar();
}

// ============================================================ PROJECTS
async function refreshProjects() {
  state.projects = await caos.projects.list();
  renderSidebar();
}

async function createProject() {
  const name = await promptDialog({ title: 'New project', label: 'Project name', placeholder: 'e.g. Marketing site' });
  if (!name) return;
  const project = await caos.projects.create({ name, path: '', kind: state.currentUrl && /^https?:/.test(state.currentUrl) ? 'url' : 'local' });
  await refreshProjects();
  await openProject(project);
}

async function openProject(project) {
  await caos.projects.touch(project.id);
  state.currentProject = (await caos.projects.get(project.id)) || project;
  state.currentSession = null;
  state.annotations = [];
  notesPanel.setAnnotations([]);
  await refreshSessions();
  await refreshRecordings();
  renderSidebar();
  toast(`Opened “${state.currentProject.name}”`);
}

async function renameProject(project) {
  const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: project.name });
  if (!name) return;
  await caos.projects.update(project.id, { name });
  if (state.currentProject && state.currentProject.id === project.id) state.currentProject.name = name;
  await refreshProjects();
}

async function deleteProject(project) {
  const ok = await confirmDialog({ title: 'Delete project', message: `Delete “${project.name}”? Its sessions, notes, and recordings will be removed.`, confirmLabel: 'Delete' });
  if (!ok) return;
  await caos.projects.remove(project.id);
  if (state.currentProject && state.currentProject.id === project.id) {
    state.currentProject = null;
    state.currentSession = null;
    state.annotations = [];
    notesPanel.setAnnotations([]);
  }
  await refreshProjects();
  await refreshSessions();
  await refreshRecordings();
  toast('Project deleted');
}

// ============================================================ FILE / FOLDER
async function openFile() {
  const res = await caos.fs.openFile();
  if (!res) return;
  await openLocalTarget(res, 'local');
}

async function openFolder() {
  const res = await caos.fs.openDirectory();
  if (!res) return;
  await openLocalTarget(res, 'local');
}

// Open a local file/dir result: create-or-find a matching project, then navigate.
async function openLocalTarget(res, kind) {
  navigateTo(res.url);
  const name = basename(res.path);
  let project = state.projects.find((p) => p.path === res.path);
  if (!project) {
    project = await caos.projects.create({ name, path: res.path, kind });
    await refreshProjects();
  }
  await openProject(project);
}

function basename(p) {
  if (!p) return 'Project';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ============================================================ RECORDING
async function toggleRecord() {
  if (state.recordingBuffer) {
    await stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (state.replaying) return;
  state.recordingBuffer = { startUrl: state.currentUrl, steps: [{ type: 'navigate', url: state.currentUrl, ts: Date.now() }] };
  sendWv('caos:start-recording');
  syncToolbar();
  showOverlay(true);
  overlayLabel.innerHTML = '<span class="rec-dot"></span> Recording…';
  overlayFill.parentElement.style.display = 'none';
  overlayCancelBtn.textContent = 'Stop';
  overlayCancelBtn.onclick = () => stopRecording();
}

async function stopRecording() {
  sendWv('caos:stop-recording');
  const buffer = state.recordingBuffer;
  state.recordingBuffer = null;
  syncToolbar();
  showOverlay(false);
  overlayFill.parentElement.style.display = '';
  overlayCancelBtn.onclick = cancelReplay;
  overlayCancelBtn.textContent = 'Cancel';

  if (!buffer || buffer.steps.length <= 1) {
    toast('Nothing recorded', 'warn');
    return;
  }
  const name = await promptDialog({ title: 'Save recording', label: 'Recording name', value: 'Journey', placeholder: 'e.g. Checkout flow' });
  if (!name) { toast('Recording discarded'); return; }
  await caos.recordings.create({
    projectId: state.currentProject ? state.currentProject.id : null,
    name,
    startUrl: buffer.startUrl,
    steps: buffer.steps,
  });
  await refreshRecordings();
  toast(`Saved “${name}” (${buffer.steps.length} steps)`, 'success');
}

async function refreshRecordings() {
  state.recordings = await caos.recordings.list(state.currentProject ? state.currentProject.id : undefined);
  if (state.selectedRecording && !state.recordings.find((r) => r.id === state.selectedRecording.id)) {
    state.selectedRecording = null;
  }
  renderSidebar();
  syncToolbar();
}

function selectRecording(r) {
  state.selectedRecording = r;
  renderSidebar();
  syncToolbar();
}

async function deleteRecording(r) {
  const ok = await confirmDialog({ title: 'Delete recording', message: `Delete “${r.name}”?`, confirmLabel: 'Delete' });
  if (!ok) return;
  await caos.recordings.remove(r.id);
  if (state.selectedRecording && state.selectedRecording.id === r.id) state.selectedRecording = null;
  await refreshRecordings();
  toast('Recording deleted');
}

// ============================================================ REPLAY
async function replaySelected() {
  const rec = state.selectedRecording;
  if (!rec || state.replaying || state.recordingBuffer) return;
  const full = (await caos.recordings.get(rec.id)) || rec;
  const steps = full.steps || [];
  if (!steps.length) { toast('Recording has no steps', 'warn'); return; }

  state.replaying = true;
  syncToolbar();
  showOverlay(true);
  overlayFill.parentElement.style.display = '';
  overlayCancelBtn.textContent = 'Cancel';
  overlayCancelBtn.onclick = cancelReplay;

  const delay = state.settings.replayDelayMs ?? 600;
  const results = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      if (!state.replaying) break;
      overlayLabel.textContent = `Replaying ${i + 1}/${steps.length}`;
      overlayFill.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
      const step = steps[i];
      let res;
      if (step.type === 'navigate') {
        await navigateAndWait(step.url);
        res = { ok: true };
      } else if (step.type === 'assert' && step.kind === 'url') {
        // URL assertions are evaluated host-side against the live location.
        const ok = compareStr(step.op || 'contains', state.currentUrl || '', step.expected);
        res = { ok, actual: state.currentUrl || '', error: ok ? '' : `url "${(state.currentUrl || '').slice(0, 48)}" ${step.op || 'contains'} "${step.expected}" failed` };
      } else {
        res = await replayStep(step, i);
      }
      const label = step.type === 'assert' ? `assert:${step.kind}` : step.type;
      results.push({ i, type: label, selector: step.selector || step.url || step.expected || '', ok: !!res.ok, error: res.error || '', actual: res.actual });
      if (!state.replaying) break;
      await sleep(delay);
    }
  } catch (e) {
    toast('Replay error: ' + (e && e.message ? e.message : e), 'error');
  } finally {
    finishReplay();
  }

  // Build a pass/fail report — replay doubles as a smoke test.
  const passed = results.filter((r) => r.ok).length;
  const report = { at: new Date().toISOString(), total: results.length, passed, failed: results.length - passed, steps: results };
  await caos.recordings.update(rec.id, { lastRun: report });
  await refreshRecordings();
  if (report.failed === 0) {
    toast(`Replay passed — ${passed}/${results.length} steps`, 'success');
  } else {
    toast(`Replay: ${report.failed} step(s) failed`, 'error', 4000);
    showReplayReport(rec, report);
  }
  return report;
}

function showReplayReport(rec, report) {
  const rows = report.steps
    .map((s) => {
      const detail = s.error ? esc(s.error) : s.actual != null && s.actual !== '' ? 'got: ' + esc(String(s.actual)) : esc(s.selector);
      return `<tr><td>${s.i + 1}</td><td class="mono">${esc(s.type)}</td><td style="color:${s.ok ? '#3ddc97' : '#ff6b6b'}">${s.ok ? 'pass' : 'fail'}</td><td class="mono">${detail}</td></tr>`;
    })
    .join('');
  modal({
    title: `Replay report — ${rec.name}`,
    width: 580,
    body: h('div', {
      html: `<p style="color:var(--dim);margin:0 0 10px">${report.passed}/${report.total} steps passed.</p>
        <table class="report-table"><thead><tr><th>#</th><th>type</th><th>result</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table>`,
    }),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

// ============================================================ ASSERTIONS
// In-page "Assert" mode points at an element; the host opens the editor.
function onAssertPick(picked) {
  if (!state.recordingBuffer) {
    toast('Start recording first, then add assertions', 'warn');
    return;
  }
  openAssertEditor({ selector: picked && picked.selector, sampleText: picked && picked.text }, (step) => {
    state.recordingBuffer.steps.push(step);
    toast(`Assertion added — ${step.kind}`, 'success');
  });
}

// Modal editor for a single assertion. onSave receives a normalized step.
function openAssertEditor(prefill, onSave) {
  const kinds = state.config.assertionKinds || [];
  let kindId = 'exists';
  const kindSel = h('select', { class: 'input' }, kinds.map((k) => h('option', { value: k.id, text: k.label })));
  const opSel = h('select', { class: 'input' });
  const selInput = h('input', { class: 'input mono', type: 'text', value: (prefill && prefill.selector) || '', placeholder: 'CSS selector' });
  const expInput = h('input', { class: 'input', type: 'text', value: '', placeholder: 'expected value' });
  const selField = field('Selector', selInput);
  const opField = field('Condition', opSel);
  const expField = field('Expected', expInput);

  function syncFields() {
    const k = kinds.find((x) => x.id === kindId) || {};
    selField.style.display = k.selector ? '' : 'none';
    expField.style.display = k.expected ? '' : 'none';
    opField.style.display = k.ops && k.ops.length ? '' : 'none';
    clear(opSel);
    (k.ops || []).forEach((op) => opSel.appendChild(h('option', { value: op, text: op })));
    if (k.id === 'text' && prefill && prefill.sampleText && !expInput.value) expInput.value = prefill.sampleText.slice(0, 40);
  }
  kindSel.addEventListener('change', () => { kindId = kindSel.value; syncFields(); });
  syncFields();

  const body = h('div', {}, [field('Assertion', kindSel), selField, opField, expField]);
  modal({
    title: 'Add assertion',
    width: 460,
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Add', kind: 'primary', onClick: () => {
          const k = kinds.find((x) => x.id === kindId) || {};
          if (k.selector && !selInput.value.trim()) { toast('A selector is required', 'warn'); return true; }
          if (k.expected && !expInput.value.trim()) { toast('An expected value is required', 'warn'); return true; }
          onSave({
            type: 'assert',
            kind: kindId,
            selector: k.selector ? selInput.value.trim() : undefined,
            op: k.ops && k.ops.length ? opSel.value : undefined,
            expected: k.expected ? expInput.value.trim() : undefined,
            ts: Date.now(),
          });
        },
      },
    ],
  });
}

function field(label, control) {
  return h('div', { class: 'field' }, [h('label', { class: 'field-label', text: label }), control]);
}

// ============================================================ RECORDING EDITOR
async function editRecording(rec) {
  const full = (await caos.recordings.get(rec.id)) || rec;
  const steps = (full.steps || []).map((s) => ({ ...s }));
  const list = h('div', { class: 'step-list' });

  function describeStep(s) {
    if (s.type === 'assert') return `assert ${s.kind}` + (s.selector ? ` ${s.selector}` : '') + (s.expected != null ? ` ${s.op || ''} "${s.expected}"` : '');
    if (s.type === 'navigate') return `navigate ${s.url || ''}`;
    if (s.type === 'input') return `input ${s.selector || ''} = "${s.value ?? ''}"`;
    if (s.type === 'scroll') return `scroll ${s.x || 0},${s.y || 0}`;
    return `${s.type} ${s.selector || s.key || ''}`;
  }
  function render() {
    clear(list);
    if (!steps.length) { list.appendChild(h('div', { class: 'empty', text: 'No steps.' })); return; }
    steps.forEach((s, i) => {
      const row = h('div', { class: `step-row ${s.type === 'assert' ? 'is-assert' : ''}` }, [
        h('span', { class: 'step-n', text: String(i + 1) }),
        h('span', { class: 'step-desc mono', text: describeStep(s) }),
        h('span', { class: 'step-acts' }, [
          h('button', { class: 'sr-act', title: 'Move up', text: '↑', on: { click: () => { if (i > 0) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; render(); } } } }),
          h('button', { class: 'sr-act', title: 'Move down', text: '↓', on: { click: () => { if (i < steps.length - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; render(); } } } }),
          h('button', { class: 'sr-act danger', title: 'Delete', text: '×', on: { click: () => { steps.splice(i, 1); render(); } } }),
        ]),
      ]);
      list.appendChild(row);
    });
  }
  render();

  const addBtn = h('button', { class: 'btn btn-sm', text: '+ Assertion', on: { click: () => openAssertEditor({}, (step) => { steps.push(step); render(); }) } });
  const body = h('div', {}, [
    h('div', { class: 'editor-head' }, [h('div', { class: 'field-hint', style: { margin: '0' }, text: `${full.name} · ${steps.length} steps. Reorder, delete, or add assertions, then Save.` }), addBtn]),
    list,
  ]);
  modal({
    title: 'Edit recording',
    width: 600,
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Save', kind: 'primary', onClick: async () => { await caos.recordings.update(full.id, { steps }); await refreshRecordings(); toast('Recording updated', 'success'); } },
    ],
  });
}

function navigateAndWait(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; pendingDomReady = null; resolve(); } };
    pendingDomReady = finish;
    state.currentUrl = url;
    wv.src = url;
    setTimeout(finish, 8000); // safety timeout
  });
}

function replayStep(step, index) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; replayWaiters.delete(index); resolve(res || { ok: false, error: 'timeout' }); } };
    replayWaiters.set(index, { resolve: (p) => done(p) });
    sendWv('caos:replay-step', { step, index });
    setTimeout(() => done({ ok: false, error: 'no response (timeout)' }), 5000); // per-step timeout
  });
}

function cancelReplay() {
  if (!state.replaying) return;
  state.replaying = false;
  toast('Replay cancelled');
}

function finishReplay() {
  state.replaying = false;
  replayWaiters.clear();
  pendingDomReady = null;
  showOverlay(false);
  overlayFill.style.width = '0%';
  syncToolbar();
}

function showOverlay(show) {
  stageOverlay.classList.toggle('show', show);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// String comparison shared with the replay engine's assert ops.
function compareStr(op, actual, expected) {
  const a = String(actual == null ? '' : actual);
  const e = String(expected == null ? '' : expected);
  if (op === 'equals') return a === e;
  if (op === 'matches') { try { return new RegExp(e).test(a); } catch (_err) { return false; } }
  return a.toLowerCase().includes(e.toLowerCase());
}

// ============================================================ SCREENSHOT
function onScreenshot(e) {
  const anchorEl = (e && e.currentTarget) || document.body;
  menu(anchorEl, [
    { label: 'Viewport', onClick: () => doScreenshot(false) },
    { label: 'Full page (beyond viewport)', onClick: () => doScreenshot(true) },
  ]);
}

function currentUrlAnnotations() {
  return state.annotations.filter((a) => a.url === state.currentUrl);
}

// Ask the inspector for live page-coordinate boxes for the given annotations.
function requestPageBoxes(annotations) {
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.channel === 'caos:page-boxes') { wv.removeEventListener('ipc-message', handler); resolve(e.args[0] || []); }
    };
    wv.addEventListener('ipc-message', handler);
    sendWv('caos:request-page-boxes', annotations);
    setTimeout(() => { wv.removeEventListener('ipc-message', handler); resolve([]); }, 3000);
  });
}

async function saveShot(dataUrl, count, suffix) {
  const name = `screenshot${suffix ? '-' + suffix : ''}-${stamp()}.png`;
  const saved = await caos.fs.saveScreenshot({ defaultName: name, dataUrl });
  if (saved) toast(count ? `Screenshot saved with ${count} annotations` : 'Screenshot saved', 'success');
}

async function doScreenshot(full) {
  try {
    if (!full) {
      const img = await wv.capturePage();
      let dataUrl = img.toDataURL();
      const onPage = currentUrlAnnotations().filter((a) => a.target && a.target.box);
      if (onPage.length) dataUrl = await compositeAnnotations(dataUrl, onPage, { cssWidth: wv.clientWidth });
      await saveShot(dataUrl, onPage.length);
      return;
    }
    // Full page: capture beyond the viewport via CDP, then composite using
    // freshly-resolved page-coordinate boxes.
    const cap = await caos.fs.captureFullPage(wv.getWebContentsId());
    if (!cap || !cap.ok) { toast('Full-page capture failed: ' + ((cap && cap.error) || '?'), 'error'); return; }
    let dataUrl = cap.dataUrl;
    const onPage = currentUrlAnnotations();
    let count = 0;
    if (onPage.length) {
      const boxes = await requestPageBoxes(onPage);
      const items = onPage.map((a, i) => ({ action: a.action, note: a.note, box: boxes[i] })).filter((it) => it.box);
      count = items.length;
      if (items.length) dataUrl = await compositeAnnotations(dataUrl, items, { cssWidth: cap.cssWidth });
    }
    await saveShot(dataUrl, count, 'fullpage');
  } catch (e) {
    toast('Screenshot failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ============================================================ AI / EXPORT
async function saveAiResult(task, text) {
  if (!text) return;
  try {
    const name = `ai-${task}-${stamp()}.md`;
    const saved = await caos.fs.save({ defaultName: name, content: text });
    if (saved) toast('Saved', 'success');
  } catch (e) {
    toast('Save failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

async function doExport(format) {
  if (!state.currentSession) { toast('Open or start a session first', 'warn'); return; }
  try {
    const result = await caos.export.build(format, state.currentSession.id);
    if (!result) { toast('Nothing to export', 'warn'); return; }
    const saved = await caos.fs.save({ defaultName: result.defaultName, content: result.content });
    if (saved) toast(`Exported ${format}`, 'success');
  } catch (e) {
    toast('Export failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ============================================================ AGENT HAND-OFF
async function handoffToAgent() {
  if (!state.currentSession) { toast('Open or start a session first', 'warn'); return; }
  if (!state.annotations.length) { toast('No notes to hand off yet', 'warn'); return; }

  let res;
  try {
    res = await caos.agent.write(state.currentSession.id);
  } catch (e) {
    toast('Hand-off failed: ' + (e && e.message ? e.message : e), 'error');
    return;
  }
  const { file, command } = res;

  const outPre = h('pre', { class: 'agent-output' });
  outPre.style.display = command ? 'block' : 'none';
  const body = h('div', {}, [
    h('div', { style: { color: 'var(--dim)', marginBottom: '6px' }, text: 'Wrote change-request prompt to:' }),
    h('div', { class: 'mono', style: { wordBreak: 'break-all', marginBottom: '10px', color: 'var(--text)' }, text: file }),
    command
      ? h('div', { class: 'field-hint', style: { margin: '0 0 8px' }, html: 'Agent command: <code>' + esc(command) + '</code>' })
      : h('div', { class: 'field-hint', style: { margin: '0 0 8px' }, text: 'No agent command configured — set one in Settings to run an agent on this request automatically.' }),
    outPre,
  ]);

  let unsub = null;
  let running = false;
  const actions = [
    { label: 'Reveal', kind: 'ghost', onClick: () => { caos.fs.reveal(file); return true; } },
  ];
  if (command) {
    actions.push({
      label: 'Run agent',
      kind: 'primary',
      onClick: async () => {
        if (running) return true;
        running = true;
        outPre.textContent = '$ ' + command + '\n\n';
        unsub = caos.agent.onOutput((chunk) => { outPre.textContent += chunk; outPre.scrollTop = outPre.scrollHeight; });
        const r = await caos.agent.run(state.currentSession.id, file);
        if (unsub) { unsub(); unsub = null; }
        running = false;
        const tag = r.ok ? 'done' : 'exit ' + (r.exitCode ?? '?') + (r.error ? ' — ' + r.error : '');
        outPre.textContent += '\n[' + tag + ']\n';
        outPre.scrollTop = outPre.scrollHeight;
        toast(r.ok ? 'Agent finished' : 'Agent exited with errors', r.ok ? 'success' : 'error');
        return true; // keep the modal open to show output
      },
    });
  }
  actions.push({ label: 'Close', kind: command ? 'ghost' : 'primary' });

  modal({ title: 'Hand off to agent', width: 600, body, actions, onClose: () => { if (unsub) unsub(); } });
  toast('Request written', 'success');
}

// ============================================================ SETTINGS
async function openSettings() {
  const providers = await caos.secrets.providers();
  openSettingsModal({
    settings: state.settings,
    providers,
    actions: {
      setSettings: async (patch) => {
        const next = await caos.settings.set(patch);
        if (next) state.settings = next;
        return state.settings;
      },
      setKey: (provider, key) => caos.secrets.setKey(provider, key),
      clearKey: (provider) => caos.secrets.clearKey(provider),
    },
  });
}

// ============================================================ HELPERS
function renderSidebar() {
  sidebar.update({
    projects: state.projects,
    currentProject: state.currentProject,
    sessions: state.sessions,
    currentSession: state.currentSession,
    recordings: state.recordings,
    selectedRecording: state.selectedRecording,
    sessionCounts: state.sessionCounts,
    history: state.history,
    bookmarks: state.bookmarks,
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

boot().catch((e) => {
  console.error('Boot failed', e && e.stack ? e.stack : e);
  toast('Failed to start: ' + (e && e.message ? e.message : e), 'error', 6000);
});
