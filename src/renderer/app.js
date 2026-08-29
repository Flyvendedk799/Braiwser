// Chrome AI OS — renderer controller.
// Owns app state, builds the shell, wires the <webview> guest, and orchestrates
// the annotation / recording / replay / AI / export flows. Talks to the backend
// only through window.caos and to the guest page only through the webview.
import { h, clear, toast, confirmDialog, promptDialog, modal, menu, esc } from './lib/dom.js';
import { createToolbar } from './components/toolbar.js';
import { createSidebar } from './components/sidebar.js';
import { createNotesPanel } from './components/notes-panel.js';
import { createSectionsPanel } from './components/sections-panel.js';
import { createStylePanel } from './components/style-panel.js';
import { createLayersPanel } from './components/layers-panel.js';
import { createAiPanel } from './components/ai-panel.js';
import { openOnboardingModal, openSettingsModal } from './components/settings-modal.js';
import { createTabStrip } from './components/tabs.js';
import { compositeAnnotations } from './lib/screenshots.js';

const caos = window.caos;

const state = {
  config: null,
  settings: null,
  providers: {},
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
  sideTab: 'sections', // left sidebar: 'sections' | 'layers'
  editStacks: { undo: 0, redo: 0 }, // page-edit history, reported by the guest
  styleTarget: null, // selector the Style panel is showing
  libraryOpen: false, // the projects/sessions/history drawer
  sessionCounts: {},
  // Browser tabs (each is its own <webview>); `wv` aliases the active one.
  tabs: [],
  activeTabId: null,
  bookmarked: false,
  history: [],
  bookmarks: [],
};

let wv; // the ACTIVE tab's <webview>
let toolbar, sidebar, notesPanel, sectionsPanel, layersPanel, stylePanel, aiPanel, tabStrip, webviewHost;
let statusLeft, statusRight;
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
  state.providers = await caos.secrets.providers();
  // The harness boots from a known sidebar, the same way it ignores saved tabs.
  if (!caos.e2e) {
    if (state.settings.sideTab === 'layers' || state.settings.sideTab === 'sections') state.sideTab = state.settings.sideTab;
    state.libraryOpen = !!state.settings.libraryOpen;
  }
  buildShell();
  setupShortcuts();
  await refreshProjects();
  await refreshRecordings();
  await refreshHistory();
  await refreshBookmarks();
  // Restore previously-open tabs (skipped under e2e for a deterministic boot).
  const saved = !caos.e2e && Array.isArray(state.settings.openTabs) ? state.settings.openTabs : null;
  if (saved && saved.length) {
    saved.forEach((u) => createTab(u || state.config.welcomeUrl));
    const idx = state.settings.activeTabIndex || 0;
    if (state.tabs[idx]) setActiveTab(state.tabs[idx].id);
  } else {
    createTab(state.config.welcomeUrl);
  }

  if (!caos.e2e && !state.settings.onboardingComplete) {
    setTimeout(openOnboarding, 250);
  }

  if (caos.e2e) {
    const internals = {
      state, caos, getWv: () => wv,
      navigateTo, setMode, openSession, replaySelected, selectRecording,
      startRecording, refreshPins, refreshRecordings,
      createTab, setActiveTab, closeTab, refreshHistory, refreshBookmarks,
      captureElement, exportSelectedElement, exportRecordingDoc,
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
    back: () => wv && wv.canGoBack() && wv.goBack(),
    forward: () => wv && wv.canGoForward() && wv.goForward(),
    reload: () => { const t = activeTab(); if (!wv) return; try { if (t && t.loading) wv.stop(); else wv.reload(); } catch (_e) { /* ignore */ } },
    toggleMode: setMode,
    undo: () => sendWv('caos:undo-edit'),
    redo: () => sendWv('caos:redo-edit'),
    toggleRecord: toggleRecord,
    replay: () => replaySelected(),
    screenshot: onScreenshot,
    openAi: () => switchTab('ai'),
    openSettings: openSettings,
    openFile: openFile,
    openFolder: openFolder,
    toggleBookmark: toggleBookmark,
  });

  // Both side panels drive the page the same way: a quiet outline on hover, a
  // select (which scrolls + flashes) on click, and edits that record notes.
  const pageActions = {
    hover: (node) => { if (node && node.selector) sendWv('caos:hover-target', { selector: node.selector }); },
    hoverClear: () => sendWv('caos:hover-clear'),
    selectLayout: (target) => { if (target && target.selector) sendWv('caos:request-layout', target); },
    toggleHidden: (node) => { if (node && node.selector) sendWv('caos:toggle-hidden', { selector: node.selector }); },
    reorder: (payload) => sendWv('caos:reorder-sibling', payload),
  };

  sectionsPanel = createSectionsPanel({
    ...pageActions,
    refresh: () => requestTree(true),
    select: (node) => pageActions.selectLayout(node),
    moveInto: (payload) => sendWv('caos:move-into', payload),
  });

  layersPanel = createLayersPanel({
    ...pageActions,
    smartLayout: (kind, selector) => sendWv('caos:smart-layout', { kind, selector }),
    zOrder: (node, dir) => { if (node && node.selector) sendWv('caos:set-z-order', { selector: node.selector, dir }); },
  });

  sidebar = createSidebar({
    selectTab: setSideTab,
    toggleLibrary: () => setLibraryOpen(!state.libraryOpen),
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
    exportRecording: exportRecording,
    deleteRecording: deleteRecording,
    openUrl: (url) => navigateTo(url),
    removeBookmark: async (b) => { await caos.bookmarks.remove(b.id); await refreshBookmarks(); updateBookmarkState(); },
    clearHistory: async () => { if (await confirmDialog({ title: 'Clear history', message: 'Remove all browsing history?', confirmLabel: 'Clear' })) { await caos.history.clear(); await refreshHistory(); } },
  }, { sections: sectionsPanel.root, layers: layersPanel.root });

  // ---- Right panel ----
  notesPanel = createNotesPanel(state.config, {
    locate: (a) => locateAnnotation(a),
    editNote: (a, note) => updateAnnotation(a, { note }),
    toggleStatus: (a) => updateAnnotation(a, { status: (a.status || 'open') === 'open' ? 'resolved' : 'open' }),
    setPriority: (a, priority) => updateAnnotation(a, { priority }),
    remove: removeAnnotation,
    copySelector: (a) => copyText(a.target && a.target.selector, 'Selector copied'),
    suggestFix: (a) => { switchTab('ai'); aiPanel.runExternal('suggest-fix', { annotations: [a], context: { annotation: a } }); },
    onCount: (total) => {
      if (tabButtons.notes) tabButtons.notes.querySelector('.pill').textContent = String(total);
      syncStatus();
    },
  });

  stylePanel = createStylePanel({
    apply: (props, commit) => sendWv('caos:apply-style', { props, commit: !!commit }),
    setText: (text) => sendWv('caos:set-text', { text }),
    reset: () => sendWv('caos:reset-element', {}),
    copyCss: (css) => copyText(css, 'CSS copied'),
    selectParent: () => sendWv('caos:edit-select-parent'),
    exportElement: () => exportSelectedElement(),
  });

  aiPanel = createAiPanel(state.config, {
    currentSessionId: () => state.currentSession && state.currentSession.id,
    run: (task, sessionId, extra) => caos.ai.run({ task, sessionId, provider: state.settings.aiProvider, ...(extra || {}) }),
    save: saveAiResult,
    openSettings: openSettings,
  });
  syncProfileUi();

  const tabs = h('div', { class: 'tabs' });
  ['notes', 'style', 'ai'].forEach((id) => {
    const labels = { notes: 'Notes', style: 'Style', ai: 'AI' };
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
    h('div', { class: 'pf-row' }, [
      h('span', { class: 'pf-label', text: 'Export' }),
      exportBtn('Markdown', 'markdown'),
      exportBtn('Prompt', 'prompt'),
      exportBtn('JSON', 'json'),
    ]),
    h('div', { class: 'pf-row' }, [
      h('button', { class: 'btn btn-sm', text: 'Copy prompt', title: 'Copy the agent prompt to the clipboard', on: { click: () => copyExport('prompt') } }),
      h('button', { class: 'btn btn-sm btn-primary', text: 'Hand off → Agent', title: 'Hand off this session to a coding agent', on: { click: handoffToAgent } }),
    ]),
  ]);

  const panel = h('aside', { class: 'panel' }, [tabs, notesPanel.root, stylePanel.root, aiPanel.root, footer]);

  // ---- Stage (tab strip + webview host) ----
  tabStrip = createTabStrip({ newTab: () => createTab(state.config.welcomeUrl), selectTab: setActiveTab, closeTab: closeTab });
  webviewHost = h('div', { class: 'wv-host' });
  overlayLabel = h('span', { class: 'so-label' });
  overlayFill = h('div', { class: 'so-fill', style: { width: '0%' } });
  overlayCancelBtn = h('button', { class: 'btn btn-sm btn-ghost', text: 'Cancel', on: { click: cancelReplay } });
  stageOverlay = h('div', { class: 'stage-overlay' }, [overlayLabel, h('div', { class: 'so-bar' }, [overlayFill]), overlayCancelBtn]);
  statusLeft = h('div', { class: 'status-left' });
  statusRight = h('div', { class: 'status-right' });
  const statusBar = h('div', { class: 'statusbar' }, [statusLeft, statusRight]);
  const stage = h('div', { class: 'stage' }, [tabStrip.root, webviewHost, stageOverlay, statusBar]);

  const body = h('div', { class: 'body' }, [sidebar.root, stage, panel]);
  root.appendChild(toolbar.root);
  root.appendChild(body);

  renderSidebar();
  switchTab(state.activeTab);
  setSideTab(state.sideTab);
  setLibraryOpen(state.libraryOpen);
}

// ---- left sidebar -----------------------------------------------------------
function setSideTab(id) {
  state.sideTab = id;
  sidebar.setTab(id);
  if (id === 'sections') requestTree();
  if (!caos.e2e) caos.settings.set({ sideTab: id });
}

// persist=false when WE opened it for you (after saving a recording): a drawer
// you did not ask for should not become the state you boot into.
function setLibraryOpen(open, persist = true) {
  state.libraryOpen = !!open;
  sidebar.setLibraryOpen(state.libraryOpen);
  if (persist && !caos.e2e) caos.settings.set({ libraryOpen: state.libraryOpen });
}

// Ask the guest for the page structure. Coalesced, because navigation, edits and
// tab switches all want it and they often land together.
let _treeTimer = null;
function requestTree(now) {
  clearTimeout(_treeTimer);
  const go = () => { _treeTimer = null; sendWv('caos:request-dom-tree'); };
  if (now) go();
  else _treeTimer = setTimeout(go, 220);
}


function exportBtn(label, format) {
  return h('button', { class: 'btn btn-sm', text: label, on: { click: () => doExport(format) } });
}

function switchTab(id) {
  state.activeTab = id;
  Object.entries(tabButtons).forEach(([k, b]) => b.classList.toggle('active', k === id));
  [notesPanel, stylePanel, aiPanel].forEach((p) => p.root.classList.remove('active'));
  ({ notes: notesPanel, style: stylePanel, ai: aiPanel })[id].root.classList.add('active');
}

// ============================================================ SHORTCUTS
function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const mod = e.metaKey || e.ctrlKey;
    const k = (e.key || '').toLowerCase();
    if (mod && k === 'l') { e.preventDefault(); toolbar.focusAddress(); return; }
    if (mod && k === 't') { e.preventDefault(); createTab(state.config.welcomeUrl); return; }
    if (mod && k === 'w') { e.preventDefault(); if (state.activeTabId) closeTab(state.activeTabId); return; }
    if (mod && k === 'r') { e.preventDefault(); const tab = activeTab(); if (wv) { try { tab && tab.loading ? wv.stop() : wv.reload(); } catch (_e) { /* ignore */ } } return; }
    if (mod && (k === '1' || k === '2' || k === '3' || k === '4')) {
      e.preventDefault();
      setMode({ 1: 'inspect', 2: 'draw', 3: 'edit', 4: 'arrange' }[k]);
      return;
    }
    if (!mod && !editable && (k === '?' || (k === '/' && e.shiftKey))) { e.preventDefault(); showShortcuts(); return; }
    if (mod && k === '/') { e.preventDefault(); showShortcuts(); return; }
    if (mod && k === 'z') {
      e.preventDefault();
      sendWv(e.shiftKey ? 'caos:redo-edit' : 'caos:undo-edit');
      return;
    }
    if (mod && k === 'y') { e.preventDefault(); sendWv('caos:redo-edit'); return; }
    if (mod && k === '0') { e.preventDefault(); setMode('off'); return; }
    if (!mod && k === 'escape' && !editable && state.mode !== 'off') { setMode('off'); }
  });
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
  persistOpenTabs();
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
  requestTree();
  persistOpenTabs();
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
  persistOpenTabs();
}

function renderTabs() {
  tabStrip.update(state.tabs, state.activeTabId);
}

// Bounded per-tab capture of guest console + load errors, surfaced to the agent.
function pushConsole(tab, entry) {
  (tab.consoleLog = tab.consoleLog || []).push({ ...entry, message: String(entry.message || '').slice(0, 500) });
  if (tab.consoleLog.length > 50) tab.consoleLog.shift();
}
function tabConsole() {
  const t = activeTab();
  return (t && t.consoleLog) || [];
}

// Persist the open tab set (debounced) so it can be restored next launch.
let _persistTimer = null;
function persistOpenTabs() {
  if (caos.e2e || state.replaying) return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    const openTabs = state.tabs.map((t) => t.url || state.config.welcomeUrl);
    const activeTabIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId));
    caos.settings.set({ openTabs, activeTabIndex });
  }, 500);
}

function setupTabWebview(tab) {
  const el = tab.wv;
  const isActive = () => state.activeTabId === tab.id;

  el.addEventListener('dom-ready', () => {
    el.send('caos:set-mode', isActive() ? state.mode : 'off');
    if (isActive()) {
      if (pendingDomReady) { const r = pendingDomReady; pendingDomReady = null; r(); }
      maybeRestoreAnnotations();
      requestTree();
    }
  });

  el.addEventListener('console-message', (e) => {
    if (e.level >= 1) pushConsole(tab, { level: e.level, message: e.message });
    if (e.level >= 2) console.warn(`[guest] ${e.message}`);
  });

  // Surface load failures (ignore -3 ERR_ABORTED and sub-frame errors) and
  // recover the guest renderer if it crashes.
  el.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || e.isMainFrame === false) return;
    tab.errored = true;
    pushConsole(tab, { kind: 'load-error', message: `${e.errorDescription || ''} (${e.errorCode}) ${e.validatedURL || ''}` });
    if (isActive()) toast(`Load failed: ${e.errorDescription || e.errorCode}`, 'error', 4000);
  });
  el.addEventListener('render-process-gone', (e) => {
    if (isActive()) toast(`Page crashed (${(e && e.reason) || 'gone'}) — reloading`, 'error', 4000);
    try { el.reload(); } catch (_err) { /* ignore */ }
  });

  el.addEventListener('did-start-loading', () => { tab.loading = true; renderTabs(); if (isActive()) syncToolbar(); });
  el.addEventListener('did-stop-loading', () => { tab.loading = false; renderTabs(); if (isActive()) syncToolbar(); });

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
        if (isActive()) requestTree();
        break;
      case 'caos:annotation':
        if (isActive()) onAnnotation(payload);
        break;
      case 'caos:edit-undo':
        // The guest reverted a rearrange edit — retract its captured note.
        if (isActive() && payload && payload.id) retractAnnotation(payload.id);
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
      case 'caos:style-picked':
        if (isActive()) {
          state.styleTarget = payload && payload.selector;
          stylePanel.setStyle(payload);
        }
        break;
      case 'caos:element-collected':
        if (isActive() && elementCapture) {
          const done = elementCapture;
          elementCapture = null;
          done(payload);
        }
        break;
      case 'caos:text-editing':
        if (isActive()) stylePanel.setTextEditing(payload && payload.editing);
        break;
      case 'caos:edit-stacks':
        if (isActive()) {
          state.editStacks = payload || { undo: 0, redo: 0 };
          syncToolbar();
        }
        break;
      case 'caos:annotation-update':
        // A style session grew — patch the note it already filed.
        if (isActive() && payload && payload.id) patchAnnotation(payload.id, payload.patch);
        break;
      case 'caos:mode-changed':
        // The guest walked itself into a mode (double-click in Inspect).
        if (isActive() && payload && payload.mode && payload.mode !== state.mode) {
          state.mode = payload.mode;
          syncToolbar();
          if (payload.mode === 'edit') switchTab('style');
        }
        break;
      case 'caos:dom-tree':
        if (isActive()) sectionsPanel.setTree(payload);
        break;
      case 'caos:layout-picked':
        if (!isActive()) break;
        layersPanel.setLayout(payload);
        // Keep Sections in step with whatever the page says is selected —
        // clicking an element in Inspect mode lands here too.
        {
          const chain = ((payload && payload.breadcrumb) || []).map((n) => n && n.selector).filter(Boolean);
          if (chain.length) sectionsPanel.setActive(chain);
        }
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
  persistOpenTabs();
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
  const aiProvider = state.settings && state.settings.aiProvider;
  toolbar.update({
    mode: state.mode,
    recording: !!state.recordingBuffer,
    currentUrl: state.currentUrl,
    canGoBack: wv && wv.canGoBack ? safe(() => wv.canGoBack()) : false,
    canGoForward: wv && wv.canGoForward ? safe(() => wv.canGoForward()) : false,
    hasRecording: !!state.selectedRecording,
    recordingName: state.selectedRecording ? state.selectedRecording.name : '',
    recordingSteps: state.selectedRecording && state.selectedRecording.steps ? state.selectedRecording.steps.length : 0,
    replaying: state.replaying,
    bookmarked: state.bookmarked,
    loading: !!(activeTab() && activeTab().loading),
    aiProvider,
    providerReady: !!(aiProvider && state.providers && state.providers[aiProvider]),
    profileName: state.settings && state.settings.profile && state.settings.profile.displayName,
    undoCount: state.editStacks.undo,
    redoCount: state.editStacks.redo,
  });
  syncStatus();
}

const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
const TOOL_HINTS = {
  off: {
    dot: 'off',
    text: 'No tool active — pick one above, or press ' + MOD + '1 Inspect · ' + MOD + '2 Draw · ' + MOD + '3 Edit · ' + MOD + '4 Rearrange',
  },
  inspect: {
    dot: 'inspect',
    text: 'Inspect — click any element to capture a note · double-click text to edit it · Esc to stop',
  },
  draw: {
    dot: 'draw',
    text: 'Draw — drag on the page to circle an area, release to write the note · Esc to stop',
  },
  edit: {
    dot: 'edit',
    text: 'Edit — click to select, click again to type · style it in the Style panel · Esc to stop',
  },
  arrange: {
    dot: 'arrange',
    text: 'Rearrange — drag any element to move it (into any container) · Alt-drag to free-move · handles to resize · Esc cancels',
  },
  assert: {
    dot: 'assert',
    text: 'Assert — click an element to add a check to the recording',
  },
};

function syncStatus() {
  if (!statusLeft) return;
  let hint = TOOL_HINTS[state.mode] || TOOL_HINTS.off;
  if (state.recordingBuffer) {
    hint = { dot: 'rec', text: 'Recording — every click, input and scroll is captured · press Stop when you are done' };
  } else if (state.replaying) {
    hint = { dot: 'rec', text: 'Replaying the journey — Cancel stops it' };
  }
  clear(statusLeft);
  statusLeft.appendChild(h('span', { class: 'status-dot dot-' + hint.dot }));
  statusLeft.appendChild(h('span', { class: 'status-text', text: hint.text }));

  clear(statusRight);
  const notes = state.annotations.length;
  const edits = state.editStacks.undo;
  if (edits) {
    statusRight.appendChild(h('span', { class: 'status-chip', text: edits + ' page edit' + (edits === 1 ? '' : 's') + ' · ' + MOD + 'Z to undo' }));
  }
  statusRight.appendChild(
    h('span', { class: 'status-meta', text: notes + (notes === 1 ? ' note' : ' notes') + (state.currentSession ? ' · ' + state.currentSession.name : '') })
  );
  statusRight.appendChild(
    h('button', { class: 'status-help', title: 'Keyboard shortcuts (?)', text: '?', on: { click: showShortcuts } })
  );
}

// ---- the shortcut sheet -------------------------------------------------------
const SHORTCUTS = [
  ['Tools', [
    [MOD + '1', 'Inspect — capture notes'],
    [MOD + '2', 'Draw — circle a region'],
    [MOD + '3', 'Edit — copy and style'],
    [MOD + '4', 'Rearrange — move and resize'],
    [MOD + '0 / Esc', 'Put the tools away'],
  ]],
  ['On the page', [
    ['Click', 'Capture / select the element'],
    ['Double-click', 'Edit the text right there'],
    ['Drag', 'Move it (Rearrange) or circle it (Draw)'],
    ['Alt-drag', 'Free-move, ignoring the layout'],
    ['Esc', 'Cancel the drag or close the note'],
  ]],
  ['History', [
    [MOD + 'Z', 'Undo the last page edit'],
    [MOD + '⇧Z / ' + MOD + 'Y', 'Redo it'],
  ]],
  ['Notes & editor', [
    [MOD + '↵', 'Save the note you are writing'],
    ['Drag a label', 'Scrub a number in the Style panel'],
  ]],
  ['Browsing', [
    [MOD + 'L', 'Focus the address bar'],
    [MOD + 'T / ' + MOD + 'W', 'New tab / close tab'],
    [MOD + 'R', 'Reload the page'],
  ]],
];

function showShortcuts() {
  const body = h('div', { class: 'shortcuts' }, SHORTCUTS.map(([group, rows]) =>
    h('div', { class: 'sc-group' }, [
      h('div', { class: 'sc-group-title', text: group }),
      h('div', { class: 'sc-rows' }, rows.map(([keys, what]) =>
        h('div', { class: 'sc-row' }, [
          h('kbd', { class: 'sc-keys', text: keys }),
          h('span', { class: 'sc-what', text: what }),
        ])
      )),
    ])
  ));
  modal({ title: 'Keyboard shortcuts', width: 540, body, actions: [{ label: 'Close', kind: 'primary' }] });
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
  // Edit mode has a panel: put the properties in front of you when it goes on.
  if (state.mode === 'edit') {
    switchTab('style');
    sendWv('caos:request-style', {});
  }
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

// ---- single-element export ---------------------------------------------------
// Ask the guest for everything the selected element needs to stand on its own,
// then let the main process fetch its assets and package it.
let elementCapture = null;

function captureElement(selector) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    elementCapture = done;
    sendWv('caos:collect-element', { selector: selector || '' });
    setTimeout(() => { elementCapture = null; done(null); }, 8000);
  });
}

async function exportSelectedElement() {
  const selector = state.styleTarget;
  if (!selector) { toast('Select an element first', 'warn'); return null; }
  const busy = toast('Capturing element…', 'info', 10000);
  let bundle;
  try {
    const payload = await captureElement(selector);
    if (!payload) { busy(); toast('Could not capture that element', 'error'); return null; }
    bundle = await caos.export.buildElement(payload, 'auto');
  } catch (err) {
    busy();
    toast('Export failed: ' + ((err && err.message) || err), 'error', 5000);
    return null;
  }
  busy();
  const saved = await caos.export.saveElement({ name: bundle.name, base64: bundle.base64 });
  if (!saved) return null;
  const kb = Math.max(1, Math.round((bundle.meta.bytes || 0) / 1024));
  const extra = bundle.meta.assets ? ` · ${bundle.meta.assets} asset${bundle.meta.assets === 1 ? '' : 's'}` : '';
  toast(`Exported ${bundle.kind === 'zip' ? 'zip' : 'file'} — ${kb} KB${extra}`, 'success', 4000);
  if (bundle.warnings && bundle.warnings.length) {
    toast(bundle.warnings[0] + (bundle.warnings.length > 1 ? ` (+${bundle.warnings.length - 1} more)` : ''), 'warn', 5000);
  }
  return saved;
}

// Patch a note the guest already filed (a style session that keeps growing).
async function patchAnnotation(id, patch) {
  const a = state.annotations.find((x) => x.id === id);
  if (!a || !patch) return;
  await updateAnnotation(a, patch);
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

// Silently remove an annotation by id (used when a rearrange edit is undone —
// the note must disappear together with the reverted change, no confirm).
async function retractAnnotation(id) {
  const a = state.annotations.find((x) => x.id === id);
  if (!a) return;
  await caos.annotations.remove(id);
  state.annotations = state.annotations.filter((x) => x.id !== id);
  notesPanel.setAnnotations(state.annotations);
  if (state.currentSession) bumpSessionCount(state.currentSession.id, -1);
  refreshPins();
  toast('Edit undone — note removed');
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

// Locate an annotation's element — navigating to its page first if the active
// tab is showing a different URL — then highlight it and report if not found.
async function locateAnnotation(a) {
  if (!a || !a.target) return;
  if (a.url && a.url !== state.currentUrl) {
    await navigateAndWait(a.url);
    await sleep(150);
  }
  const ok = await highlightAndAck(a.target);
  if (!ok) toast('Could not locate that element on the page', 'warn');
}

function highlightAndAck(target) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; wv.removeEventListener('ipc-message', h); resolve(v); } };
    const h = (e) => { if (e.channel === 'caos:highlight-ack') done(!!(e.args[0] && e.args[0].ok)); };
    if (wv) wv.addEventListener('ipc-message', h);
    sendWv('caos:highlight-target', target);
    setTimeout(() => done(false), 1500);
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
  const saved = await caos.recordings.create({
    projectId: state.currentProject ? state.currentProject.id : null,
    name,
    startUrl: buffer.startUrl,
    steps: buffer.steps,
  });
  await refreshRecordings();
  // Recordings live in the Library drawer, which is folded away by default —
  // saving one used to leave no visible trace at all. Select it (so Replay
  // lights up), open the drawer, and point at the row.
  if (saved) {
    selectRecording(saved);
    setLibraryOpen(true, false);
    setTimeout(() => sidebar.revealRow(saved.id), 60);
  }
  toast(`Saved “${name}” (${buffer.steps.length} steps) — Library ▸ Recordings`, 'success', 4200);
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
// ---- exporting a journey ------------------------------------------------------
// Three shapes, one journey: a film of it happening, or a written account of
// every step for a bug report / an agent. The written ones describe the whole
// run, including how the last replay went.
function exportRecording(rec) {
  if (!rec) return;
  const pick = (fn) => () => { m.close(); fn(); return true; };
  const m = modal({
    title: 'Export “' + rec.name + '”',
    width: 460,
    body: h('div', { class: 'export-choices' }, [
      h('div', { class: 'export-choice', on: { click: pick(() => exportRecordingVideo(rec)) } }, [
        h('div', { class: 'ec-title', text: '🎬  Video (.webm)' }),
        h('div', { class: 'ec-sub', text: 'Replays the journey now and films the page while it runs.' }),
      ]),
      h('div', { class: 'export-choice', on: { click: pick(() => exportRecordingDoc(rec, 'pdf')) } }, [
        h('div', { class: 'ec-title', text: '📄  PDF report' }),
        h('div', { class: 'ec-sub', text: 'Every step in order — targets, values, scrolls, assertions and the last replay’s results.' }),
      ]),
      h('div', { class: 'export-choice', on: { click: pick(() => exportRecordingDoc(rec, 'markdown')) } }, [
        h('div', { class: 'ec-title', text: '📝  Markdown' }),
        h('div', { class: 'ec-sub', text: 'The same account as text, for an issue or a coding agent.' }),
      ]),
    ]),
    actions: [{ label: 'Cancel', kind: 'ghost' }],
  });
}

async function exportRecordingDoc(rec, kind) {
  try {
    if (kind === 'pdf') {
      const out = await caos.export.recordingPdf(rec.id);
      const saved = await caos.export.saveBinary({
        defaultName: out.name,
        base64: out.base64,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (saved) toast('Saved ' + out.name + ' (' + Math.max(1, Math.round(out.bytes / 1024)) + ' KB)', 'success');
      return saved;
    }
    const out = await caos.export.recordingReport(rec.id, 'markdown');
    const saved = await caos.fs.save({ defaultName: out.name, content: out.content });
    if (saved) toast('Saved ' + out.name, 'success');
    return saved;
  } catch (err) {
    toast('Export failed: ' + ((err && err.message) || err), 'error', 5000);
    return null;
  }
}

// Film the guest page while the journey replays. The main process hands us the
// page's own web contents, so the frame is the page and nothing else.
async function exportRecordingVideo(rec) {
  if (state.replaying || state.recordingBuffer) { toast('Finish what is running first', 'warn'); return null; }
  selectRecording(rec);
  let stream = null;
  let recorder = null;
  const chunks = [];
  try {
    await caos.export.videoSource(wv.getWebContentsId());
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)
    );
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    toast('Could not start recording the screen: ' + ((err && err.message) || err), 'error', 5000);
    return null;
  }

  toast('Filming the replay…', 'info', 2000);
  try {
    await replaySelected();
  } finally {
    await new Promise((r) => setTimeout(r, 400)); // let the last frames land
    try { recorder.stop(); } catch (_e) { /* ignore */ }
    await new Promise((r) => { recorder.onstop = r; setTimeout(r, 1500); });
    stream.getTracks().forEach((t) => t.stop());
    await caos.export.videoSource(null);
  }

  const blob = new Blob(chunks, { type: 'video/webm' });
  if (!blob.size) { toast('Nothing was captured', 'error'); return null; }
  const base64 = await blobToBase64(blob);
  const slug = (rec.name || 'journey').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'journey';
  const saved = await caos.export.saveBinary({
    defaultName: slug + '.webm',
    base64,
    filters: [{ name: 'WebM video', extensions: ['webm'] }],
  });
  if (saved) toast('Saved ' + slug + '.webm (' + Math.max(1, Math.round(blob.size / 1024)) + ' KB)', 'success', 4000);
  return saved;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

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

// Action→color map from the canonical config (passed to the screenshot compositor).
function actionColors() {
  const m = {};
  for (const t of (state.config && state.config.actionTags) || []) m[t.id] = t.color;
  return m;
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
      if (onPage.length) dataUrl = await compositeAnnotations(dataUrl, onPage, { cssWidth: wv.clientWidth, colors: actionColors() });
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
      if (items.length) dataUrl = await compositeAnnotations(dataUrl, items, { cssWidth: cap.cssWidth, colors: actionColors() });
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

async function copyText(text, okMsg) {
  if (!text) { toast('Nothing to copy', 'warn'); return; }
  try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied', 'success'); }
  catch (_e) { toast('Copy failed', 'error'); }
}

async function copyExport(format) {
  if (!state.currentSession) { toast('Open or start a session first', 'warn'); return; }
  try {
    const result = await caos.export.build(format, state.currentSession.id, { consoleLog: tabConsole() });
    if (!result || !result.content) { toast('Nothing to copy', 'warn'); return; }
    await copyText(result.content, 'Prompt copied to clipboard');
  } catch (e) {
    toast('Copy failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

async function doExport(format) {
  if (!state.currentSession) { toast('Open or start a session first', 'warn'); return; }
  try {
    const result = await caos.export.build(format, state.currentSession.id, { consoleLog: tabConsole() });
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
    res = await caos.agent.write(state.currentSession.id, { consoleLog: tabConsole() });
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
async function openOnboarding() {
  state.providers = await caos.secrets.providers();
  openOnboardingModal({
    settings: state.settings,
    providers: { ...state.providers },
    actions: profileActions(),
  });
}

async function openSettings() {
  state.providers = await caos.secrets.providers();
  openSettingsModal({
    settings: state.settings,
    providers: { ...state.providers },
    actions: profileActions(),
  });
}

function profileActions() {
  return {
    setSettings: async (patch) => {
      const next = await caos.settings.set(patch);
      if (next) state.settings = next;
      syncProfileUi();
      return state.settings;
    },
    setKey: async (provider, key) => {
      state.providers = await caos.secrets.setKey(provider, key);
      syncProfileUi();
      return state.providers;
    },
    clearKey: async (provider) => {
      state.providers = await caos.secrets.clearKey(provider);
      syncProfileUi();
      return state.providers;
    },
  };
}

function syncProfileUi() {
  if (aiPanel && aiPanel.setProfile) aiPanel.setProfile(state.settings, state.providers);
  if (toolbar) syncToolbar();
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
