// Braiwser — renderer controller.
// Owns app state, builds the shell, wires the <webview> guest, and orchestrates
// the annotation / recording / replay / AI / export flows. Talks to the backend
// only through window.braiwser (alias: window.caos) and to the guest page only through the webview.
import { h, clear, toast, confirmDialog, promptDialog, modal, menu, esc, icon } from './lib/dom.js';
import { createToolbar } from './components/toolbar.js';
import { createSidebar } from './components/sidebar.js';
import { createNotesPanel } from './components/notes-panel.js';
import { createSectionsPanel } from './components/sections-panel.js';
import { createStylePanel } from './components/style-panel.js';
import { createLayersPanel } from './components/layers-panel.js';
import { createAiPanel } from './components/ai-panel.js';
import { createAuditPanel } from './components/audit-panel.js';
import { openOnboardingModal, openSettingsModal } from './components/settings-modal.js';
import { createTabStrip } from './components/tabs.js';
import { compositeAnnotations } from './lib/screenshots.js';
import { personaCopy, chromeForPersona, isWelcomeUrl, isPlaygroundUrl } from './lib/persona.js';
import { createCoachmarks } from './components/coachmarks.js';
import { createVerifyPanel } from './components/verify-panel.js';
import { openHandoffModal } from './components/handoff-modal.js';
import { resolveAddress, localTarget, matchesLocalTarget } from './lib/address.js';
import { mergeFilteredOrder } from './lib/note-order.js';
import { createOperationContexts, createGeneration } from './controllers/operation-context.js';
import { createReplayDriver } from './controllers/replay-driver.js';
import { runReplay } from './controllers/replay-engine.js';
import { describeReplay, buildReplayReport, auditOutcome } from './controllers/run-report.js';
import * as recCtl from './controllers/recording-controller.js';
import { createAuditRunner, sameAuditedPage } from './controllers/audit-controller.js';
import { describeStorageHealth, describeRecovery } from './controllers/storage-health.js';
import { describeStructureResult, describeDroppedHistory } from './controllers/guest-feedback.js';
import { handoffWhere } from './controllers/handoff-ui.js';
import { reportContextFromSource, currentContextFromTab } from './controllers/audit-ui.js';
import { createVerifyRunner } from './controllers/verify-controller.js';
import { createSessionController } from './controllers/session-controller.js';
import { captureScreenshot } from './controllers/screenshot-capture.js';
import { requestFromGuest } from './controllers/guest-request.js';
import { createTabDerived, resetForNewDocument, dropStaleAudit } from './controllers/tab-state.js';
import { runBulk, describeBulk, toPanelResult } from './controllers/bulk.js';
import { createAwakeHolder } from './controllers/keep-awake.js';
import { mountAgentRuns } from './controllers/agent-runs-mount.js';

const caos = window.braiwser || window.caos;

const state = {
  config: null,
  settings: null,
  providers: {},
  projects: [],
  currentProject: null,
  sessions: [],
  currentSession: null,
  sessionEpoch: 0, // bumped whenever the current session/project changes (see operation-context)
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
  editStacks: { undo: 0, redo: 0 }, // page-edit history of the ACTIVE tab (mirror of tab.derived)
  styleTarget: null, // selector the Style panel is showing (mirror of the active tab's)
  leftView: 'workspace', // workspace navigation | live page structure
  leftCollapsed: false,
  rightCollapsed: false,
  sessionCounts: {},
  // Browser tabs (each is its own <webview>); `wv` aliases the active one.
  // Each tab: { id, wv, url, title, docGen, derived, ... } — see controllers/tab-state.js.
  tabs: [],
  activeTabId: null,
  bookmarked: false,
  history: [],
  bookmarks: [],
  systemTheme: 'dark',
  auditing: false,
  lastAudit: null, // the ACTIVE tab's audit report (mirror of tab.derived.audit.report)
  agentPresets: [],
  nextActionArmed: false,
};

let wv; // the ACTIVE tab's <webview>
let toolbar, sidebar, notesPanel, sectionsPanel, layersPanel, stylePanel, aiPanel, auditPanel, verifyPanel, tabStrip, webviewHost, shellBody;
let statusLeft, statusRight;
let deviceBadge;
let tabButtons = {};
let stageOverlay, overlayLabel, overlayFill, overlayCancelBtn;
let coachmarks = null;
let footerPrimaryBtn = null;
let footerHint = null;
let tabSeq = 0;

const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId) || null;
const tabById = (id) => state.tabs.find((t) => t.id === id) || null;

// ---- operation contexts (see controllers/*) -------------------------------------
// Replay, record, audit, verify, screenshot, restore and note capture each
// capture {tab, webview, document generation, session} when they START and
// consult it after every await instead of the mutable globals above.
const ops = createOperationContexts({
  getTab: tabById,
  getActiveTabId: () => state.activeTabId,
  getSession: () => state.currentSession,
  getSessionEpoch: () => state.sessionEpoch,
});
const projectGen = createGeneration();
let replayRun = null; // { ctx, ac:AbortController } while a replay is in flight
// A replay / recording / audit may run in a hidden tab; hold that guest unthrottled meanwhile.
const awake = createAwakeHolder(caos.power);

// Send to ONE specific tab's guest, tolerating a gone/not-ready view.
function sendToTab(tab, channel, ...args) {
  if (!tab || !tab.wv) return;
  try { tab.wv.send(channel, ...args); } catch (_e) { /* webview not ready or gone */ }
}

const sessions = createSessionController({
  api: caos,
  state,
  ui: {
    setNotes: (list) => { if (notesPanel) notesPanel.setAnnotations(list); },
    sessionChanged: () => { renderSidebar(); syncStatus(); },
    bumpCount: (id, delta) => bumpSessionCount(id, delta),
    refreshSessions: () => refreshSessions(),
    toast: (m, k) => toast(m, k),
  },
});

// ============================================================ BOOT
async function boot() {
  state.config = await caos.config();
  state.settings = await caos.settings.get();
  state.providers = await caos.secrets.providers();
  try { state.agentPresets = await caos.agent.detect(); } catch (_e) { state.agentPresets = []; }
  // The harness boots from a known shell, the same way it ignores saved tabs.
  if (!caos.e2e) {
    if (state.settings.sideTab === 'layers' || state.settings.sideTab === 'sections') state.sideTab = state.settings.sideTab;
    state.leftView = state.settings.leftView === 'page' ? 'page' : 'workspace';
    state.leftCollapsed = !!state.settings.leftCollapsed;
    state.rightCollapsed = !!state.settings.rightCollapsed;
  }
  state.systemTheme = await caos.system.theme();
  applyTheme();
  caos.system.onThemeChange((theme) => {
    state.systemTheme = theme;
    if ((state.settings.theme || 'dark') === 'system') applyTheme();
  });
  buildShell();
  setupShortcuts();
  caos.onCommand(({ command, arg }) => runCommand(command, arg));
  await refreshProjects();
  await refreshRecordings();
  await refreshHistory();
  await refreshBookmarks();
  checkStorageHealth(); // fire and forget: never blocks the app from opening
  // Restore previously-open tabs (skipped under e2e for a deterministic boot).
  const saved = !caos.e2e && Array.isArray(state.settings.openTabs) ? state.settings.openTabs : null;
  if (saved && saved.length) {
    saved.forEach((u) => createTab(u || state.config.welcomeUrl));
    const idx = state.settings.activeTabIndex || 0;
    if (state.tabs[idx]) setActiveTab(state.tabs[idx].id);
  } else {
    createTab(state.config.welcomeUrl);
  }
  applyDevice();

  // Agent runs: renders nothing unless the agentRuntime flag is on (see controllers/agent-runs-mount.js).
  try {
    mountAgentRuns({
      caos, toast,
      getCurrentSession: () => state.currentSession,
      refreshNotes: async () => {
        const s = state.currentSession;
        if (!s) return;
        const list = await caos.annotations.bySession(s.id);
        if (sessions.isCurrent(s.id)) { state.annotations = list; notesPanel.setAnnotations(list); }
      },
    });
  } catch (e) { console.warn('[agent-runs] not mounted: ' + ((e && e.message) || e)); }

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
      runCommand, runAudit, setDevice, applyTheme, currentDevice,
      auditPanel: () => auditPanel, notesPanel: () => notesPanel,
      exportRecordingAs, importBundleText,
      copyExport, verifySession, openSamplePage, exportClientPack, syncPersonaChrome,
      openOnboarding, coachmarks: () => coachmarks,
      setLeftView, setSidebarCollapsed,
    };
    import('./lib/e2e.js')
      .then((m) => m.run(internals))
      .catch((e) => caos.e2eDone({ ok: false, fatal: String((e && e.stack) || e) }));
  }
}

// ============================================================ STORAGE HEALTH
// A data file that is damaged or unreadable is held read-only (never overwritten)
// by the main process, so edits to it would not be saved. Say so up front and
// let the user choose how to continue. Dismissable, not hidden: it re-checks on
// the next launch.
let healthModal = null;
async function checkStorageHealth() {
  let health;
  try { health = await caos.store.status(); } catch (e) { console.warn('[store] status failed: ' + ((e && e.message) || e)); return; }
  const view = describeStorageHealth(health);
  if (!view.damaged) {
    if (view.maintenanceErrors.length) console.warn('[store] maintenance: ' + view.maintenanceErrors.join('; '));
    return;
  }
  openStorageHealthModal(view);
}

function openStorageHealthModal(view) {
  if (healthModal) { try { healthModal.close(); } catch (_e) { /* ignore */ } healthModal = null; }
  const body = h('div', { class: 'storage-health' }, [
    h('p', { text: 'Some of your saved data could not be loaded safely. Braiwser has not changed those files, and edits to them are not being saved until you choose how to continue.' }),
    ...view.items.map((it) => {
      const row = h('div', { class: 'storage-health-item', style: { margin: '10px 0', padding: '10px', border: '1px solid var(--border, #444)', borderRadius: '8px' } }, [
        h('div', { style: { fontWeight: '600' }, text: it.file + ' ' + it.title }),
        it.error ? h('div', { class: 'field-hint', text: it.error }) : null,
        h('div', { class: 'field-hint', text: it.advice }),
      ]);
      const btns = h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } });
      const run = async (mode, confirmText) => {
        if (confirmText && !(await confirmDialog({ title: 'Start with an empty file?', message: confirmText, confirmLabel: 'Start fresh', danger: true }))) return;
        let outcome;
        try { outcome = describeRecovery(it, mode, await caos.store.recover(it.name, mode)); }
        catch (e) { outcome = { ok: false, text: 'Recovery failed: ' + ((e && e.message) || e) }; }
        toast(outcome.text, outcome.ok ? 'success' : 'error', 6000);
        await reloadAfterRecovery();
        const left = describeStorageHealth(await caos.store.status().catch(() => null));
        if (left.damaged) openStorageHealthModal(left); else if (healthModal) { healthModal.close(); healthModal = null; }
      };
      if (it.canRestoreBackup) btns.appendChild(h('button', { class: 'btn btn-sm btn-primary', text: 'Restore from backup', on: { click: () => run('backup') } }));
      if (it.canStartFresh) {
        btns.appendChild(h('button', {
          class: 'btn btn-sm btn-danger',
          text: 'Start fresh',
          title: 'The damaged file is renamed and kept, not deleted',
          on: { click: () => run('empty', `This replaces ${it.file} with an empty file. The damaged copy is renamed and kept next to it, so it can still be recovered by hand.`) },
        }));
      }
      if (btns.childNodes.length) row.appendChild(btns);
      return row;
    }),
    view.maintenanceErrors.length ? h('div', { class: 'field-hint', text: 'Also: ' + view.maintenanceErrors.join('; ') }) : null,
  ]);
  healthModal = modal({
    title: 'Saved data needs attention',
    width: 520,
    body,
    actions: [{ label: 'Dismiss for now', kind: 'ghost' }],
    onClose: () => { healthModal = null; },
  });
}

async function reloadAfterRecovery() {
  try {
    const next = await caos.settings.get();
    if (next) state.settings = next;
    await refreshProjects();
    await refreshSessions();
    await refreshRecordings();
    await refreshHistory();
    await refreshBookmarks();
    const s = state.currentSession;
    if (s) {
      const list = await caos.annotations.bySession(s.id);
      if (sessions.isCurrent(s.id)) { state.annotations = list; notesPanel.setAnnotations(list); refreshPins(); }
    }
  } catch (e) { console.warn('[store] reload failed: ' + ((e && e.message) || e)); }
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
    runAudit: () => runAudit(),
    openDeviceMenu: onDeviceMenu,
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
    selectView: setLeftView,
    toggleCollapsed: (force) => setSidebarCollapsed('left', force),
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
    exportBundle: exportProjectBundle,
    importBundle: importProjectBundle,
    removeBookmark: async (b) => { await caos.bookmarks.remove(b.id); await refreshBookmarks(); updateBookmarkState(); },
    clearHistory: async () => { if (await confirmDialog({ title: 'Clear history', message: 'Remove all browsing history?', confirmLabel: 'Clear' })) { await caos.history.clear(); await refreshHistory(); } },
  }, { sections: sectionsPanel.root, layers: layersPanel.root });

  // ---- Right panel ----
  notesPanel = createNotesPanel(state.config, {
    locate: (a) => locateAnnotation(a),
    editNote: (a, note) => updateAnnotation(a, { note }),
    toggleStatus: (a) => updateAnnotation(a, { status: (a.status || 'open') === 'open' ? 'resolved' : 'open' }),
    setPriority: (a, priority) => updateAnnotation(a, { priority }),
    setVisibility: (a, visibility) => updateAnnotation(a, { visibility }),
    remove: removeAnnotation,
    copySelector: (a) => copyText(a.target && a.target.selector, 'Selector copied'),
    suggestFix: (a) => { switchTab('ai'); aiPanel.runExternal('suggest-fix', { annotations: [a], context: { annotation: a } }); },
    currentUrl: () => state.currentUrl,
    bulkUpdate: bulkUpdateAnnotations,
    bulkRemove: bulkRemoveAnnotations,
    onCount: (total) => { setTabCount('notes', total); syncStatus(); },
    getPersona: () => (state.settings && state.settings.persona) || 'agent',
    startChecklist: (id) => applyChecklist(id),
    reorder: async (orderedIds, _opts) => {
      // The panel now sends the FULL ordered id list even while filtered. Still
      // run it through mergeFilteredOrder: it is a no-op for a full list and
      // guarantees storage never receives a partial, unknown or duplicated id
      // (e.g. when a note was added/removed since the panel last rendered).
      // A rejection makes the panel undo its optimistic move.
      const session = state.currentSession;
      if (!session) return;
      const full = mergeFilteredOrder(state.annotations.map((a) => a.id), orderedIds);
      const list = await caos.annotations.reorder(session.id, full);
      if (!sessions.isCurrent(session.id)) return; // user moved to another session meanwhile
      state.annotations = list;
      notesPanel.setAnnotations(state.annotations);
      refreshPins(); // page badges must follow the new numbering
    },
  });

  auditPanel = createAuditPanel(state.config, {
    run: () => runAudit(),
    locate: (f) => locateTarget(f.target, { audit: true }),
    copySelector: (f) => copyText(f.selector, 'Selector copied'),
    addOne: (f) => promoteFindings([f]),
    addAll: (list) => promoteFindings(list),
    onCount: (total) => setTabCount('audit', total),
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
    // requestId is minted by the panel and travels in `extra` into ai.run.
    cancel: (requestId) => caos.ai.cancel(requestId),
    save: saveAiResult,
    openSettings: openSettings,
  });
  syncProfileUi();

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Review panels' });
  ['notes', 'style', 'audit', 'ai', 'verify'].forEach((id) => {
    const labels = { notes: 'Notes', style: 'Style', audit: 'Audit', ai: 'AI', verify: 'Verify' };
    const showPill = id === 'notes' || id === 'audit';
    const btn = h('button', {
      class: `tab ${id === state.activeTab ? 'active' : ''}`,
      role: 'tab',
      id: 'tab-' + id,
      'aria-selected': id === state.activeTab ? 'true' : 'false',
      'aria-controls': 'panel-' + id,
      html: `<span>${labels[id]}</span>${showPill ? '<span class="pill">0</span>' : ''}`,
      on: { click: () => switchTab(id) },
    });
    tabButtons[id] = btn;
    tabs.appendChild(btn);
  });

  footerHint = h('span', { class: 'pf-label', text: 'Export' });
  footerPrimaryBtn = h('button', { class: 'btn btn-sm btn-primary', 'data-coach': 'ship', text: 'Hand off → Agent', title: 'Hand off this session to a coding agent', on: { click: () => runPersonaPrimary() } });
  const footer = h('div', { class: 'panel-footer' }, [
    h('div', { class: 'pf-row' }, [
      footerHint,
      exportBtn('Markdown', 'markdown'),
      exportBtn('Prompt', 'prompt'),
      exportBtn('JSON', 'json'),
    ]),
    h('div', { class: 'pf-row', 'data-coach': 'ship' }, [
      h('button', { class: 'btn btn-sm', text: 'Copy prompt', title: 'Copy the agent prompt to the clipboard', on: { click: () => copyExport('prompt') } }),
      footerPrimaryBtn,
    ]),
  ]);

  verifyPanel = createVerifyPanel({ run: () => verifySession() });
  [notesPanel, stylePanel, auditPanel, aiPanel, verifyPanel].forEach((p, i) => {
    const id = ['notes', 'style', 'audit', 'ai', 'verify'][i];
    if (!p || !p.root) return;
    p.root.id = 'panel-' + id;
    p.root.setAttribute('role', 'tabpanel');
    p.root.setAttribute('aria-labelledby', 'tab-' + id);
  });
  const panelCollapse = h('button', {
    class: 'panel-collapse',
    title: 'Collapse review sidebar',
    'aria-label': 'Collapse review sidebar',
    html: icon('forward', 15),
    on: { click: () => setSidebarCollapsed('right') },
  });
  const panelTop = h('div', { class: 'panel-top' }, [
    h('span', { class: 'panel-kicker', text: 'Review & ship' }),
    panelCollapse,
  ]);
  const panelCollapsedRail = h('div', { class: 'panel-collapsed-rail' }, [
    h('button', {
      class: 'panel-expand',
      title: 'Expand review sidebar',
      'aria-label': 'Expand review sidebar',
      html: icon('back', 16),
      on: { click: () => setSidebarCollapsed('right', false) },
    }),
    h('button', {
      class: 'side-rail-btn',
      title: 'Open Notes',
      'aria-label': 'Open Notes',
      html: icon('edit', 16),
      on: { click: () => { switchTab('notes'); setSidebarCollapsed('right', false); } },
    }),
    h('button', {
      class: 'side-rail-btn',
      title: 'Open Audit',
      'aria-label': 'Open Audit',
      html: icon('audit', 16),
      on: { click: () => { switchTab('audit'); setSidebarCollapsed('right', false); } },
    }),
  ]);
  const panel = h('aside', { class: 'panel' }, [panelTop, tabs, notesPanel.root, stylePanel.root, auditPanel.root, aiPanel.root, verifyPanel.root, footer, panelCollapsedRail]);

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
  deviceBadge = h('div', { class: 'device-badge' });
  const stage = h('div', { class: 'stage' }, [tabStrip.root, webviewHost, deviceBadge, stageOverlay, statusBar]);

  shellBody = h('div', { class: 'body' }, [sidebar.root, stage, panel]);
  root.appendChild(toolbar.root);
  root.appendChild(shellBody);

  renderSidebar();
  switchTab(state.activeTab);
  setSideTab(state.sideTab);
  setLeftView(state.leftView, false);
  setSidebarCollapsed('left', state.leftCollapsed, false);
  setSidebarCollapsed('right', state.rightCollapsed, false);
  syncPersonaChrome();
  coachmarks = createCoachmarks({
    isSample: () => isPlaygroundUrl(state.currentUrl),
    onStep: (id) => {
      if (id === 'note') switchTab('notes');
    },
    onComplete: ({ skipped }) => {
      caos.settings.set({ coachComplete: true }).then((next) => { if (next) state.settings = next; });
      if (skipped) toast('Coach skipped — Help → Try Sample Page anytime', 'info');
    },
  });
}

// ---- left sidebar -----------------------------------------------------------
function setSideTab(id) {
  state.sideTab = id;
  sidebar.setTab(id);
  if (id === 'sections') requestTree();
  if (!caos.e2e) caos.settings.set({ sideTab: id });
}

function setLeftView(id, persist = true) {
  state.leftView = id === 'page' ? 'page' : 'workspace';
  sidebar.setView(state.leftView);
  if (state.leftView === 'page' && state.sideTab === 'sections') requestTree();
  if (persist && !caos.e2e) caos.settings.set({ leftView: state.leftView });
}

function setSidebarCollapsed(side, force, persist = true) {
  const key = side === 'right' ? 'rightCollapsed' : 'leftCollapsed';
  const value = typeof force === 'boolean' ? force : !state[key];
  state[key] = value;
  if (shellBody) shellBody.classList.toggle(side === 'right' ? 'right-collapsed' : 'left-collapsed', value);
  if (persist && !caos.e2e) caos.settings.set({ [key]: value });
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
  const panels = { notes: notesPanel, style: stylePanel, audit: auditPanel, ai: aiPanel, verify: verifyPanel };
  if (!panels[id]) return;
  if (state.rightCollapsed) setSidebarCollapsed('right', false);
  state.activeTab = id;
  Object.entries(tabButtons).forEach(([k, b]) => {
    const on = k === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  Object.values(panels).forEach((p) => p && p.root && p.root.classList.remove('active'));
  panels[id].root.classList.add('active');
}

function setTabCount(id, total) {
  const btn = tabButtons[id];
  const pill = btn && btn.querySelector('.pill');
  if (pill) pill.textContent = String(total);
}

// ============================================================ SHORTCUTS
// Accelerators live in the native menu (src/main/menu.js) so they fire even
// while the guest <webview> owns keyboard focus — a renderer keydown listener
// never sees those. Escape stays here because a menu accelerator would swallow
// it from modals and text fields.
function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const t = e.target;
    const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (editable || document.querySelector('.modal-backdrop')) return;
    if (coachmarks && coachmarks.isVisible()) return;
    if (state.mode !== 'off') setMode('off');
  });
}

// ============================================================ COMMANDS
// One table for every menu item. Keeping it here (rather than in the menu)
// means the menu stays declarative and every command is testable in-process.
const COMMANDS = {
  'tab.new': () => createTab(state.config.welcomeUrl),
  'tab.close': () => { if (state.activeTabId) closeTab(state.activeTabId); },
  'file.open': () => openFile(),
  'folder.open': () => openFolder(),
  'project.new': () => createProject(),
  'session.new': () => createSession(),
  'export.markdown': () => doExport('markdown'),
  'export.prompt': () => doExport('prompt'),
  'export.json': () => doExport('json'),
  'export.copyPrompt': () => copyExport('prompt'),
  'export.clientPack': () => exportClientPack(),
  'agent.handoff': () => handoffToAgent(),
  'review.verify': () => verifySession(),
  'bundle.export': () => exportProjectBundle(state.currentProject),
  'bundle.import': () => importProjectBundle(),
  'settings.open': () => openSettings(),

  'notes.search': () => { switchTab('notes'); notesPanel.focusSearch(); },
  'panel.notes': () => switchTab('notes'),
  'panel.style': () => switchTab('style'),
  'panel.audit': () => switchTab('audit'),
  'panel.ai': () => switchTab('ai'),
  'panel.verify': () => switchTab('verify'),

  'view.theme': (id) => setTheme(id),
  'view.device': (id) => setDevice(id),
  'view.rotate': () => rotateDevice(),
  'zoom.in': () => nudgeZoom(0.5),
  'zoom.out': () => nudgeZoom(-0.5),
  'zoom.reset': () => setZoom(0),
  'devtools.page': () => togglePageDevTools(),

  'nav.back': () => { if (wv && safe(() => wv.canGoBack())) wv.goBack(); },
  'nav.forward': () => { if (wv && safe(() => wv.canGoForward())) wv.goForward(); },
  'nav.reload': () => { const t = activeTab(); if (!wv) return; try { t && t.loading ? wv.stop() : wv.reload(); } catch (_e) { /* ignore */ } },
  'nav.address': () => toolbar.focusAddress(),
  'nav.home': () => navigateTo(state.config.welcomeUrl),
  'nav.sample': () => openSamplePage({ inspect: true }),
  'nav.bookmark': () => toggleBookmark(),

  'mode.inspect': () => setMode('inspect'),
  'mode.draw': () => setMode('draw'),
  'mode.edit': () => setMode('edit'),
  'mode.arrange': () => setMode('arrange'),
  'mode.assert': () => setMode('assert'),
  'mode.off': () => setMode('off'),
  'audit.run': () => runAudit(),
  'edit.undo': () => sendWv('caos:undo-edit'),
  'edit.redo': () => sendWv('caos:redo-edit'),
  'record.toggle': () => toggleRecord(),
  'replay.run': () => replaySelected(),
  'shot.viewport': () => doScreenshot(false),
  'shot.fullpage': () => doScreenshot(true),

  'help.shortcuts': () => showShortcuts(),
  'help.about': () => showAbout(),
  'help.welcome': () => navigateTo(state.config.welcomeUrl),
};

function runCommand(command, arg) {
  const fn = COMMANDS[command];
  if (!fn) return false;
  const fail = (e) => toast('That action failed: ' + (e && e.message ? e.message : e), 'error');
  try {
    const out = fn(arg);
    // Most commands are async; a rejected promise must surface, not vanish.
    if (out && typeof out.then === 'function') out.then(undefined, fail);
  } catch (e) {
    fail(e);
  }
  return true;
}

// ============================================================ THEME
// settings.theme is 'dark' | 'light' | 'system'; 'system' resolves against the
// live OS preference reported by the main process.
function resolvedTheme() {
  const choice = (state.settings && state.settings.theme) || 'dark';
  return choice === 'system' ? state.systemTheme || 'dark' : choice;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  paintGuestTheme();
}

async function setTheme(id) {
  const next = await caos.settings.set({ theme: id });
  if (next) state.settings = next;
  applyTheme();
  toast(`Theme: ${id}`);
}

// ============================================================ DEVICE VIEWPORT
function devicePresets() {
  return (state.config && state.config.devicePresets) || [{ id: 'fit', label: 'Fit to window', w: 0, h: 0 }];
}

// The active preset, already rotated if landscape is on. `short` is the compact
// label the toolbar button shows.
function currentDevice() {
  const id = (state.settings && state.settings.device) || 'fit';
  const preset = devicePresets().find((d) => d.id === id) || devicePresets()[0];
  const landscape = !!(state.settings && state.settings.deviceLandscape) && preset.w > 0;
  return {
    id: preset.id,
    label: preset.label,
    short: preset.id === 'fit' ? 'Fit' : `${landscape ? preset.h : preset.w}px`,
    w: landscape ? preset.h : preset.w,
    h: landscape ? preset.w : preset.h,
    landscape,
  };
}

// Size every tab's webview, not just the active one, so switching tabs does not
// briefly show a differently-sized page.
function applyDevice() {
  const d = currentDevice();
  const on = d.id !== 'fit' && d.w > 0;
  if (webviewHost) webviewHost.classList.toggle('device', on);
  for (const t of state.tabs) {
    if (!t.wv) continue;
    t.wv.style.width = on ? d.w + 'px' : '';
    t.wv.style.height = on ? d.h + 'px' : '';
  }
  if (deviceBadge) {
    deviceBadge.classList.toggle('show', on);
    deviceBadge.innerHTML = on ? `<b>${esc(d.label)}</b> ${d.w} × ${d.h}${d.landscape ? ' · landscape' : ''}` : '';
  }
  syncToolbar();
}

async function setDevice(id) {
  const next = await caos.settings.set({ device: id });
  if (next) state.settings = next;
  applyDevice();
  const d = currentDevice();
  toast(d.id === 'fit' ? 'Viewport: fit to window' : `Viewport: ${d.label} ${d.w}×${d.h}`);
}

async function rotateDevice() {
  if (currentDevice().id === 'fit') { toast('Pick a device viewport first', 'warn'); return; }
  const next = await caos.settings.set({ deviceLandscape: !state.settings.deviceLandscape });
  if (next) state.settings = next;
  applyDevice();
}

function onDeviceMenu() {
  const anchorEl = toolbar.deviceAnchor();
  const active = currentDevice();
  const items = devicePresets().map((d) => ({
    label: (d.id === active.id ? '● ' : '   ') + d.label + (d.w ? `  ${d.w}×${d.h}` : ''),
    onClick: () => setDevice(d.id),
  }));
  items.push({ label: (state.settings.deviceLandscape ? '● ' : '   ') + 'Rotate (landscape)', onClick: () => rotateDevice() });
  menu(anchorEl, items);
}

// ============================================================ ZOOM / DEVTOOLS
function setZoom(level) {
  const tab = activeTab();
  if (!wv || !tab) return;
  tab.zoom = level;
  try { wv.setZoomLevel(level); } catch (_e) { /* not ready */ }
}

function nudgeZoom(delta) {
  const tab = activeTab();
  if (!tab) return;
  const next = Math.max(-4, Math.min(4, (tab.zoom || 0) + delta));
  setZoom(next);
  toast(`Page zoom ${Math.round(Math.pow(1.2, next) * 100)}%`);
}

function togglePageDevTools() {
  if (!wv) return;
  try {
    if (wv.isDevToolsOpened()) wv.closeDevTools();
    else wv.openDevTools();
  } catch (_e) {
    toast('DevTools are not available for this page', 'warn');
  }
}

// ============================================================ TABS + WEBVIEW WIRING
function createTab(url) {
  const el = h('webview', { class: 'wv', allowpopups: '' });
  // Preload MUST be set before the first load. sandbox=no lets the preload use
  // require() for its sibling engines; contextIsolation keeps the page out.
  el.setAttribute('preload', state.config.inspectorPath);
  el.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,nodeIntegration=no');
  const tab = { id: 'tab' + ++tabSeq, wv: el, url: url || '', title: '', docGen: 0, documentId: '', derived: createTabDerived(), closed: false };
  state.tabs.push(tab);
  webviewHost.appendChild(el);
  const d = currentDevice();
  if (d.id !== 'fit' && d.w > 0) { el.style.width = d.w + 'px'; el.style.height = d.h + 'px'; }
  setupTabWebview(tab);
  setActiveTab(tab.id);
  if (url) { el.src = url; tab.url = url; }
  persistOpenTabs();
  return tab;
}

// Repaint every panel that describes ONE guest document from that tab's own
// record, so a selection/structure/audit from another tab never lingers.
function paintDerived(tab) {
  const d = tab.derived;
  state.styleTarget = d.styleTarget;
  state.editStacks = d.editStacks;
  if (stylePanel) { stylePanel.setStyle(d.styleInfo); stylePanel.setTextEditing(d.textEditing); }
  if (layersPanel) layersPanel.setLayout(d.layout);
  if (sectionsPanel) sectionsPanel.setTree(d.tree);
  state.lastAudit = d.audit ? d.audit.report : null;
  if (auditPanel) {
    auditPanel.setReport(d.audit ? d.audit.report : null, d.audit ? reportContextFromSource(d.audit.source) : null);
    if (d.audit && d.audit.promoted.size) auditPanel.markPromoted([...d.audit.promoted]);
    syncAuditContext();
  }
}

// Tell the Audit panel which page the user is looking at now, so a report from
// another page/tab is flagged stale rather than offered for promotion.
function syncAuditContext() {
  if (!auditPanel || !auditPanel.setCurrentContext) return;
  const t = activeTab();
  auditPanel.setCurrentContext(currentContextFromTab(t, t ? viewportFor(t.wv) : null));
}

function setActiveTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  const prev = activeTab();
  const switching = !prev || prev.id !== tab.id;
  // Replay and recording stay bound to the tab that started them (their
  // contexts capture the guest element), so switching away is safe; say so.
  if (switching && state.replaying) toast('Replay keeps running on its own tab', 'info', 2200);
  if (switching && state.recordingBuffer && state.recordingBuffer.ownerTabId !== tab.id) {
    toast('Recording stays on its original tab — switch back to keep capturing', 'info', 2800);
  }
  if (switching && prev) sendToTab(prev, 'caos:set-mode', 'off'); // only the front tab holds a tool
  state.activeTabId = id;
  wv = tab.wv; // global alias used throughout
  state.tabs.forEach((t) => t.wv.classList.toggle('active', t.id === id));
  state.currentUrl = tab.url;
  state.currentTitle = tab.title;
  if (switching) paintDerived(tab);
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
  // The recording's owner tab is going away: finish the recording first so the
  // steps are saved/discarded deliberately instead of silently dying.
  if (state.recordingBuffer && state.recordingBuffer.ownerTabId === id) stopRecording();
  audits.abandon(id, 'The tab was closed');
  const [tab] = state.tabs.splice(idx, 1);
  tab.closed = true;
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

// A new document replaced the old one in `tab`: the guest's selection, layers,
// structure and edit history are gone, and a pending audit/restore for the old
// document must not land on the new one.
function onNewDocument(tab) {
  tab.docGen += 1;
  tab.documentId = ''; // the new document announces its id with caos:ready
  resetForNewDocument(tab.derived);
  audits.abandon(tab.id, 'The page navigated during the audit');
  if (state.activeTabId !== tab.id) return;
  state.styleTarget = null;
  state.editStacks = tab.derived.editStacks;
  if (stylePanel) { stylePanel.setStyle(null); stylePanel.setTextEditing(false); }
  if (layersPanel) layersPanel.setLayout(null);
  if (sectionsPanel) sectionsPanel.setTree(null);
  syncToolbar();
}

function setupTabWebview(tab) {
  const el = tab.wv;
  const isActive = () => state.activeTabId === tab.id;

  el.addEventListener('dom-ready', () => {
    sendToTab(tab, 'caos:set-mode', isActive() ? state.mode : 'off');
    // The recorder lives in the document's preload: every new document starts
    // with an inactive recorder, so an owned tab is re-armed here (idempotent).
    recCtl.onDomReady(state.recordingBuffer, tab, sendToTab);
    if (isActive()) {
      maybeRestoreAnnotations(tab);
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

  el.addEventListener('did-navigate', (e) => { onNewDocument(tab); onNavigated(tab, e.url); });
  el.addEventListener('did-navigate-in-page', (e) => onNavigated(tab, e.url));
  el.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    if (isActive()) { state.currentTitle = e.title; syncSessionTitle(); }
    renderTabs();
  });

  el.addEventListener('ipc-message', (e) => {
    const payload = e.args && e.args[0];
    const d = tab.derived;
    switch (e.channel) {
      case 'caos:ready':
        if (payload) {
          tab.title = payload.title || tab.title;
          if (payload.documentId) tab.documentId = payload.documentId; // identity of the document now shown
          if (isActive()) state.currentTitle = tab.title;
        }
        if (isActive()) requestTree();
        break;
      case 'caos:annotation':
        if (isActive()) onAnnotation(payload, tab);
        break;
      case 'caos:edit-undo':
        // The guest reverted a rearrange edit — retract its captured note.
        if (isActive() && payload && payload.id) retractAnnotation(payload.id);
        break;
      case 'caos:escape':
        if (isActive()) setMode('off');
        break;
      case 'caos:rec-step':
        // Only the recording's owner tab may add steps.
        if (recCtl.accepts(state.recordingBuffer, tab)) recCtl.pushGuestStep(state.recordingBuffer, payload);
        break;
      case 'caos:recording-status':
        // Guest reports whether its recorder is active; re-arm a fresh document.
        recCtl.onStatus(state.recordingBuffer, tab, payload, sendToTab);
        break;
      case 'caos:replay-ack':
        // Acknowledgements are consumed by the replay driver bound to THIS element.
        break;
      case 'caos:style-picked':
        d.styleInfo = payload || null;
        d.styleTarget = (payload && payload.selector) || null;
        if (isActive()) {
          state.styleTarget = d.styleTarget;
          stylePanel.setStyle(payload);
          notifyCoach('element-selected');
        }
        break;
      case 'caos:element-collected':
        // Request/reply handled by captureElement() on this element.
        break;
      case 'caos:text-editing':
        d.textEditing = !!(payload && payload.editing);
        if (isActive()) stylePanel.setTextEditing(d.textEditing);
        break;
      case 'caos:edit-stacks':
        d.editStacks = payload || { undo: 0, redo: 0 };
        {
          const lost = describeDroppedHistory(payload, d.droppedEdits);
          d.droppedEdits = lost.dropped;
          if (lost.toast && isActive()) toast(lost.toast.text, lost.toast.tone, 4500);
        }
        if (isActive()) {
          state.editStacks = d.editStacks;
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
          notifyCoach('inspect-mode', state.mode === 'inspect');
          if (payload.mode === 'edit') switchTab('style');
        }
        break;
      case 'caos:dom-tree':
        d.tree = payload || null;
        if (isActive()) sectionsPanel.setTree(payload);
        break;
      case 'caos:layout-picked':
        d.layout = payload || null;
        if (!isActive()) break;
        layersPanel.setLayout(payload);
        notifyCoach('element-selected');
        // The left rail is contextual: selecting something on the page brings
        // its structure forward, while project/session navigation stays in
        // Workspace.
        if (!state.leftCollapsed) setLeftView('page');
        // Keep Sections in step with whatever the page says is selected —
        // clicking an element in Inspect mode lands here too.
        {
          const chain = ((payload && payload.breadcrumb) || []).map((n) => n && n.selector).filter(Boolean);
          if (chain.length) sectionsPanel.setActive(chain);
        }
        break;
      case 'caos:structure-result':
        // Reorder / move replies: a rejected edit is said so, an applied one refreshes the tree.
        if (isActive() && payload) {
          const fb = describeStructureResult(payload);
          if (fb.toast) toast(fb.toast.text, fb.toast.tone, 4500);
          if (fb.refresh) requestTree(true);
        }
        break;
      case 'caos:assert-pick':
        if (isActive()) onAssertPick(payload);
        break;
      case 'caos:audit-result':
        // Consumed only by the audit run that started on this tab; anything else is dropped.
        audits.deliver(tab.id, payload);
        break;
    }
  });
}

// The coach advances on what the user does (Inspect on, element picked, note
// saved, shipped); it never blocks the page. notify() is the current API,
// advance() the back-compat alias.
function notifyCoach(event, detail) {
  if (!coachmarks) return;
  const fn = coachmarks.notify || coachmarks.advance;
  if (fn) fn(event, detail);
}

function onNavigated(tab, url) {
  tab.url = url;
  const isFront = state.activeTabId === tab.id;
  // Audit findings describe a specific page: when the tab now shows another
  // one, drop them (promotion/locate/verify must not use stale evidence).
  if (dropStaleAudit(tab.derived, { tabId: tab.id, url }) && isFront) {
    state.lastAudit = null;
    auditPanel.setReport(null);
  }
  if (isFront) syncAuditContext();
  if (isWelcomeUrl(url)) {
    const hash = String(url).split('#')[1] || '';
    if (hash === 'open-folder') { openFolder(); return; }
    if (hash === 'open-file') { openFile(); return; }
    if (hash === 'sample') { openSamplePage({ inspect: true }); return; }
    paintGuestTheme();
  }
  // Record real navigations in history (skip the welcome page).
  if (url && !isWelcomeUrl(url)) {
    caos.history.record({ url, title: tab.title }).then(() => { if (state.activeTabId === tab.id) refreshHistory(); });
  }
  renderTabs();
  persistOpenTabs();
  // Record navigations that happen while recording (clicks/links etc.) — on the
  // recording's owner tab, wherever the user is looking.
  recCtl.pushNavigation(state.recordingBuffer, tab, url);
  if (!isFront) return;

  if (!state.replaying) {
    toolbar.setAddress(url);
    updateBookmarkState();
  }
  state.currentUrl = url;
  syncToolbar();
}

function navigateTo(url) {
  if (!url || !wv) return;
  const tab = activeTab();
  state.currentUrl = url;
  if (tab) tab.url = url;
  toolbar.setAddress(url);
  if (state.recordingBuffer && tab && recCtl.accepts(state.recordingBuffer, tab)) {
    state.recordingBuffer.steps.push({ type: 'navigate', url, ts: Date.now() });
  }
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
    device: currentDevice(),
    auditing: state.auditing,
    chrome: chromeForPersona((state.settings && state.settings.persona) || 'agent'),
    aiProvider,
    providerReady: !!(aiProvider && state.providers && state.providers[aiProvider] && state.providers[aiProvider].ready),
    profileName: state.settings && state.settings.profile && state.settings.profile.displayName,
    undoCount: state.editStacks.undo,
    redoCount: state.editStacks.redo,
  });
  if (verifyPanel && verifyPanel.setPageReady) {
    verifyPanel.setPageReady(hasReviewablePage());
  }
  syncStatus();
}

function hasReviewablePage() {
  const url = state.currentUrl || '';
  return !!(url && !isWelcomeUrl(url));
}

function paintGuestTheme() {
  const theme = document.documentElement.dataset.theme || 'dark';
  const js = 'document.documentElement.setAttribute("data-theme",' + JSON.stringify(theme) + ');document.documentElement.style.colorScheme=' + JSON.stringify(theme) + ';';
  for (const t of state.tabs || []) {
    if (!t.wv || !isWelcomeUrl(t.url)) continue;
    try { t.wv.executeJavaScript(js); } catch (_e) { /* not ready */ }
  }
}

const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
const TOOL_HINTS = {
  off: {
    dot: 'off',
    text: 'No tool active — pick one above, or press ' + MOD + '⇧E Inspect · ' + MOD + '⇧D Draw · ' + MOD + '⇧T Edit · ' + MOD + '⇧M Rearrange',
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
  if (state.mode === 'off' && !state.recordingBuffer && !state.replaying) {
    const copy = personaCopy((state.settings && state.settings.persona) || 'agent', state.config && state.config.personas);
    if (copy.tip) hint = { dot: 'off', text: copy.tip };
  }
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
    statusRight.appendChild(h('span', { class: 'status-chip', text: edits + ' page edit' + (edits === 1 ? '' : 's') + ' · ' + MOD + '⇧Z to undo' }));
  }
  statusRight.appendChild(
    h('span', { class: 'status-meta', text: notes + (notes === 1 ? ' note' : ' notes') + (state.currentSession ? ' · ' + state.currentSession.name : '') })
  );
  statusRight.appendChild(
    h('button', { class: 'status-help', title: 'Keyboard shortcuts (?)', text: '?', on: { click: showShortcuts } })
  );
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
  // Lets the first-run coach point at the page once Inspect is actually on.
  notifyCoach('inspect-mode', state.mode === 'inspect');
}

// ============================================================ ANNOTATIONS
async function onAnnotation(raw, tab) {
  // Capture the tab BEFORE any await: the note belongs to the page it was made on.
  const ctx = ops.capture('note', { tabId: tab && tab.id });
  const saved = await captureAnnotation(raw, { ctx });
  if (saved) toast(`Note captured — ${saved.action}`, 'success');
}

// The viewport a note/audit was made at, measured on the given guest element.
function viewportFor(webview) {
  const d = currentDevice();
  return { id: d.id, label: d.label, w: d.w || (webview ? webview.clientWidth : 0), h: d.h || (webview ? webview.clientHeight : 0) };
}

// Persist one annotation into a session, stamping it with the page and the
// viewport it was captured at. Shared by in-page capture and audit promotion.
//   opts.ctx     operation context captured when the note was made (url/title/tab)
//   opts.session the session to save into (promotion captures it once per batch)
// The saved note is recorded against the session it was created for; the
// visible list/pins are only touched if that session is still on screen.
async function captureAnnotation(raw, opts = {}) {
  if (!raw) return null;
  const ctx = opts.ctx || ops.capture('note');
  let session = opts.session;
  if (!session) {
    try { session = await ensureSession(); } catch (e) {
      toast('Could not start a session: ' + (e && e.message ? e.message : e), 'error');
      return null;
    }
  }
  const annotation = {
    ...raw,
    sessionId: session.id,
    url: raw.url || ctx.url,
    title: raw.title || ctx.title,
    visibility: raw.visibility || chromeForPersona((state.settings && state.settings.persona) || 'agent').defaultVisibility,
    viewport: raw.viewport || viewportFor(ctx.wv),
  };
  let result;
  try {
    result = await sessions.addNote(session, annotation);
  } catch (e) {
    toast('Could not save that note: ' + (e && e.message ? e.message : e), 'error');
    return null;
  }
  if (result.displayed) {
    refreshPins(tabById(ctx.tabId) || undefined);
    if (state.annotations.length === 1) armNextAction();
  }
  notifyCoach('note-saved');
  return result.saved;
}

// ---- bulk triage -----------------------------------------------------------
// Failures are counted (not announced as successes) and kept visible with a retry.
// Partial failures are reported to the Notes panel (which keeps the failed notes
// selected and shows its own "N of M failed - Retry" bar); we only count what worked.
async function bulkUpdateAnnotations(list, patch) {
  if (!list || !list.length) return;
  const sid = state.currentSession && state.currentSession.id;
  const res = await runBulk(list, async (a) => (await caos.annotations.update(a.id, patch)) || { ...a, ...patch });
  if (sessions.isCurrent(sid)) {
    for (const { item, result } of res.ok) {
      const i = state.annotations.findIndex((x) => x.id === item.id);
      if (i >= 0) state.annotations[i] = result;
    }
    notesPanel.setAnnotations(state.annotations);
    refreshPins();
  }
  const msg = describeBulk('Updated', 'note', res);
  if (!res.failed.length) toast(msg.text, msg.tone);
  return toPanelResult(res);
}

async function bulkRemoveAnnotations(list) {
  if (!list || !list.length) return;
  const ok = await confirmDialog({
    title: 'Delete notes',
    message: `Delete ${list.length} note${list.length === 1 ? '' : 's'}? This cannot be undone.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  return bulkRemoveAnnotationsNoConfirm(list);
}

async function bulkRemoveAnnotationsNoConfirm(list) {
  const sid = state.currentSession && state.currentSession.id;
  const res = await runBulk(list, (a) => caos.annotations.remove(a.id));
  const gone = new Set(res.ok.map((r) => r.item.id));
  if (sid && gone.size) bumpSessionCount(sid, -gone.size);
  if (sessions.isCurrent(sid)) {
    state.annotations = state.annotations.filter((x) => !gone.has(x.id));
    notesPanel.setAnnotations(state.annotations);
    refreshPins();
  }
  const msg = describeBulk('Deleted', 'note', res);
  if (!res.failed.length) toast(msg.text, msg.tone);
  return toPanelResult(res);
}

// ---- single-element export ---------------------------------------------------
// Ask the guest for everything the selected element needs to stand on its own,
// then let the main process fetch its assets and package it. The request is
// bound to the guest element it was made on (a tab switch cannot misroute it).
function captureElement(selector, ctx) {
  const c = ctx || ops.capture('element');
  return requestFromGuest(c.wv, {
    channel: 'caos:collect-element',
    payload: { selector: selector || '' },
    replyChannel: 'caos:element-collected',
    timeoutMs: 8000,
    fallback: null,
  });
}

async function exportSelectedElement() {
  const ctx = ops.capture('element');
  const tab = tabById(ctx.tabId);
  const selector = tab ? tab.derived.styleTarget : state.styleTarget;
  if (!selector) { toast('Select an element first', 'warn'); return null; }
  const busy = toast('Capturing element…', 'info', 10000);
  let bundle;
  try {
    const payload = await captureElement(selector, ctx);
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
  // Say honestly when the capture was cut short or lossy.
  if (bundle.meta && bundle.meta.truncated) {
    toast('The element was too large to capture completely' + (bundle.meta.truncatedReason ? ' — ' + bundle.meta.truncatedReason : '') + '. The export is partial.', 'warn', 6000);
  }
  const warnings = Array.from(new Set([...(bundle.warnings || []), ...((bundle.meta && bundle.meta.warnings) || [])]));
  if (warnings.length) {
    toast(warnings[0] + (warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''), 'warn', 5000);
  }
  return saved;
}

// Patch a note the guest already filed (a style session that keeps growing).
async function patchAnnotation(id, patch) {
  const a = state.annotations.find((x) => x.id === id);
  if (!a || !patch) return;
  await updateAnnotation(a, patch);
}

// The session an annotation belongs to (falls back to the one on screen).
const sessionOf = (a) => (a && a.sessionId) || (state.currentSession && state.currentSession.id) || null;

async function updateAnnotation(a, patch) {
  const sid = sessionOf(a);
  const updated = await caos.annotations.update(a.id, patch);
  if (!sessions.isCurrent(sid)) return; // saved durably; that session is no longer on screen
  const i = state.annotations.findIndex((x) => x.id === a.id);
  if (i >= 0) state.annotations[i] = updated || { ...a, ...patch };
  notesPanel.setAnnotations(state.annotations);
  refreshPins();
}

async function removeAnnotation(a) {
  const ok = await confirmDialog({ title: 'Delete note', message: `Delete this ${a.action} note? This cannot be undone.`, confirmLabel: 'Delete' });
  if (!ok) return;
  const sid = sessionOf(a);
  await caos.annotations.remove(a.id);
  if (sid) bumpSessionCount(sid, -1);
  if (sessions.isCurrent(sid)) {
    state.annotations = state.annotations.filter((x) => x.id !== a.id);
    notesPanel.setAnnotations(state.annotations);
    refreshPins();
  }
  toast('Note deleted');
}

// Silently remove an annotation by id (used when a rearrange edit is undone —
// the note must disappear together with the reverted change, no confirm).
async function retractAnnotation(id) {
  const a = state.annotations.find((x) => x.id === id);
  if (!a) return;
  const sid = sessionOf(a);
  await caos.annotations.remove(id);
  if (sid) bumpSessionCount(sid, -1);
  if (sessions.isCurrent(sid)) {
    state.annotations = state.annotations.filter((x) => x.id !== id);
    notesPanel.setAnnotations(state.annotations);
    refreshPins();
  }
  toast('Edit undone — note removed');
}

// Re-send this page's pins to its guest. The fetch is bound to the session and
// tab it started for: if either changed (or the tab navigated) by the time the
// notes arrive, nothing is sent.
function maybeRestoreAnnotations(tab = activeTab()) {
  if (!state.settings.restoreAnnotationsOnLoad || !state.currentSession || !tab) return;
  const url = tab.url || safe(() => tab.wv.getURL());
  if (!url) return;
  const ctx = ops.capture('restore', { tabId: tab.id });
  sessions.restorePins({
    session: state.currentSession,
    url,
    stillValid: () => ops.isCurrent(ctx, { doc: true }) && tab.url === url,
    deliver: (arr) => sendToTab(tab, 'caos:restore-annotations', arr),
  });
}

// Wait for a tab's navigation with an explicit outcome (ready | failed |
// timeout | cancelled), bound to the tab captured in ctx.
function navigateTabAndWait(ctx, url, timeoutMs) {
  const tab = tabById(ctx.tabId);
  return createReplayDriver({ ctx, getUrl: () => (tab && tab.url) || '' }).navigate(url, { timeoutMs: timeoutMs || 8000 });
}

// Locate an annotation's element — navigating to its page first if the active
// tab is showing a different URL — then highlight it and report if not found.
async function locateAnnotation(a) {
  if (!a || !a.target) return;
  const ctx = ops.capture('locate');
  if (!ctx.wv) return;
  if (a.url && a.url !== ctx.url) {
    const nav = await navigateTabAndWait(ctx, a.url);
    if (nav.outcome !== 'ready') { toast('Could not open that note’s page', 'warn'); return; }
    await sleep(150);
  }
  if (ops.staleReason(ctx)) return; // the tab went away while navigating
  const ok = await highlightAndAck(ctx.wv, a.target);
  if (!ok) toast('Could not locate that element on the page', 'warn');
}

// Highlight an arbitrary target descriptor (used by audit findings, which are
// not annotations but carry the same anchor shape). Audit findings are only
// located on the page they were found on.
async function locateTarget(target, { audit = false } = {}) {
  if (!target) { toast('This finding has no element to locate', 'warn'); return; }
  const ctx = ops.capture('locate');
  if (!ctx.wv) return;
  if (audit) {
    const tab = tabById(ctx.tabId);
    const a = tab && tab.derived.audit;
    if (!a || !sameAuditedPage(a.source, { tabId: ctx.tabId, url: ctx.url })) {
      toast('These findings belong to a different page — run the audit again', 'warn');
      return;
    }
  }
  const ok = await highlightAndAck(ctx.wv, target);
  if (!ok) toast('Could not locate that element on the page', 'warn');
}

async function highlightAndAck(webview, target) {
  const reply = await requestFromGuest(webview, {
    channel: 'caos:highlight-target',
    payload: target,
    replyChannel: 'caos:highlight-ack',
    timeoutMs: 1500,
    fallback: null,
  });
  return !!(reply && reply.ok);
}

// Re-send the full current set so pin badge numbers match the Notes list '#'.
function refreshPins(tab = activeTab()) {
  if (!state.currentSession || !state.settings.restoreAnnotationsOnLoad || !tab) return;
  const url = tab.url;
  const list = state.annotations
    .filter((a) => a.url === url)
    .map((a) => ({ ...a, pinNum: state.annotations.indexOf(a) + 1 }));
  sendToTab(tab, 'caos:restore-annotations', list);
}

// ============================================================ SESSIONS
// State transitions live in controllers/session-controller.js: every async
// step is guarded by the session it was dispatched for.
function ensureSession() {
  return sessions.ensure();
}

function syncSessionTitle() {
  // Keep the active session's title fresh as the page reports titles.
  sessions.syncTitle().catch(() => { /* best effort */ });
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
  // The session is shown immediately with an empty list; its notes replace that
  // only if it is still the session the user asked for when they arrive.
  const loading = sessions.open(session);
  switchTab('notes');
  // Verify belongs to the session: show its latest run, or clear the previous one.
  if (verifyPanel) {
    const runs = Array.isArray(session.verifyRuns) ? session.verifyRuns : [];
    verifyPanel.setRun(runs.length ? runs[runs.length - 1] : null);
  }
  const applied = await loading;
  if (!applied) return;
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
  if (updated && sessions.isCurrent(session.id)) state.currentSession = updated;
  await refreshSessions();
}

async function deleteSession(session) {
  const ok = await confirmDialog({ title: 'Delete session', message: `Delete “${session.name}” and all its notes?`, confirmLabel: 'Delete' });
  if (!ok) return;
  await caos.sessions.remove(session.id);
  if (sessions.isCurrent(session.id)) {
    sessions.close();
    if (verifyPanel) verifyPanel.setRun(null);
    sendWv('caos:clear-overlays');
  }
  await refreshSessions();
  toast('Session deleted');
}

async function refreshSessions() {
  const projectId = state.currentProject ? state.currentProject.id : undefined;
  const list = await caos.sessions.list(projectId);
  // Badge counts in ONE pass (was N+1 bySession round-trips).
  const counts = await caos.annotations.countsBySession();
  // A project switch during the reads makes these lists belong to another project.
  if ((state.currentProject ? state.currentProject.id : undefined) !== projectId) return;
  state.sessions = list;
  state.sessionCounts = counts;
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
  const token = projectGen.begin(); // the latest requested project wins
  await caos.projects.touch(project.id);
  const loaded = (await caos.projects.get(project.id)) || project;
  if (!projectGen.valid(token)) return;
  state.currentProject = loaded;
  sessions.close();
  if (verifyPanel) verifyPanel.setRun(null);
  await refreshSessions();
  await refreshRecordings();
  if (!projectGen.valid(token)) return;
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
    projectGen.invalidate();
    state.currentProject = null;
    sessions.close();
    if (verifyPanel) verifyPanel.setRun(null);
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
  await openLocalTarget(res, 'file');
}

async function openFolder() {
  const res = await caos.fs.openDirectory();
  if (!res) return;
  await openLocalTarget(res, 'folder');
}

// Open a local file/dir result: create-or-find a matching project, then navigate.
// A project's `path` is always its DIRECTORY (hand-off writes and runs there);
// the page that was opened is kept separately as `entry` (MB-01).
async function openLocalTarget(res, kind) {
  navigateTo(res.url);
  const target = localTarget(kind, res);
  if (!target) return;
  let project = state.projects.find((p) => matchesLocalTarget(p, target));
  if (!project) {
    project = await caos.projects.create({ name: target.name, path: target.path, entry: target.entry, kind: 'local' });
    await refreshProjects();
  }
  await openProject(project);
}

// ============================================================ RECORDING
async function toggleRecord() {
  if (state.recordingBuffer) {
    await stopRecording();
  } else {
    startRecording();
  }
}

// A recording belongs to the tab it started on (controllers/recording-controller.js):
// the owner is re-armed on every new document, and stopping stops every guest
// that was armed — not just whichever tab is in front.
function startRecording() {
  if (state.replaying || state.recordingBuffer) return;
  const tab = activeTab();
  if (!tab) return;
  state.recordingBuffer = recCtl.createRecordingBuffer({ startUrl: state.currentUrl, ownerTabId: tab.id });
  recCtl.arm(state.recordingBuffer, tab, sendToTab);
  state.recordingBuffer.releaseAwake = awake.acquire(() => tab.wv.getWebContentsId());
  syncToolbar();
  showOverlay(true);
  overlayLabel.innerHTML = '<span class="rec-dot"></span> Recording…';
  overlayFill.parentElement.style.display = 'none';
  overlayCancelBtn.textContent = 'Stop';
  overlayCancelBtn.onclick = () => stopRecording();
}

async function stopRecording() {
  const buffer = state.recordingBuffer;
  if (buffer) {
    recCtl.stopAll(buffer, state.tabs, sendToTab);
    if (buffer.releaseAwake) buffer.releaseAwake();
  } else {
    sendWv('caos:stop-recording');
  }
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
  // Recordings live in Workspace. Select it (so Replay lights up), bring the
  // workspace rail forward, and point at the row.
  if (saved) {
    selectRecording(saved);
    setLeftView('workspace', false);
    setSidebarCollapsed('left', false, false);
    setTimeout(() => sidebar.revealRow(saved.id), 60);
  }
  toast(`Saved “${name}” (${buffer.steps.length} steps) — Library ▸ Recordings`, 'success', 4200);
}

async function refreshRecordings() {
  const projectId = state.currentProject ? state.currentProject.id : undefined;
  const list = await caos.recordings.list(projectId);
  if ((state.currentProject ? state.currentProject.id : undefined) !== projectId) return; // project changed during the read
  state.recordings = list;
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
// Five shapes, one journey: a film of it happening, a written account of every
// step for a bug report / an agent, or the steps themselves as a spec or raw
// JSON. The written ones describe the whole run, including how the last replay
// went.
function exportRecording(rec) {
  if (!rec) return;
  const pick = (fn) => () => { m.close(); fn(); return true; };
  const choice = (fn, title, sub) => h('div', { class: 'export-choice', on: { click: pick(fn) } }, [
    h('div', { class: 'ec-title', text: title }),
    h('div', { class: 'ec-sub', text: sub }),
  ]);
  const m = modal({
    title: 'Export “' + rec.name + '”',
    width: 460,
    body: h('div', { class: 'export-choices' }, [
      choice(() => exportRecordingVideo(rec), '🎬  Video (.mp4)',
        'Replays the journey now and films the page — just the page — while it runs.'),
      choice(() => exportRecordingDoc(rec, 'pdf'), '📄  PDF report',
        'Every step in order — targets, values, scrolls, assertions and the last replay’s results.'),
      choice(() => exportRecordingDoc(rec, 'markdown'), '📝  Markdown',
        'The same account as text, for an issue or a coding agent.'),
      choice(() => exportRecordingAs('playwright', rec), '🧪  Playwright test',
        'The selector-anchored steps as a spec you can drop straight into your test suite.'),
      choice(() => exportRecordingAs('json', rec), '📦  JSON',
        'The raw steps, for archiving or re-import.'),
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

// The container to film in. MP4/H.264 first: it carries its duration and sample
// table in the finalised moov atom, so players can scrub, seek and fast-forward
// it, and it drops straight into a ticket, a slide or a chat. MediaRecorder's
// WebM has no duration in the header and no cue index, so players treat it as a
// live stream you can only watch start-to-finish — a last resort, not a default.
const VIDEO_FORMATS = [
  { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4', label: 'MP4 video' },
  { mime: 'video/mp4', ext: 'mp4', label: 'MP4 video' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm', label: 'WebM video' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM video' },
];

function pickVideoFormat() {
  if (!window.MediaRecorder) return null;
  return VIDEO_FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) || null;
}

// Film the guest page while the journey replays. The main process hands us the
// page's own frame, so the film is the page at its own resolution — none of our
// toolbar, sidebar or window chrome in shot, and no cropping guesswork.
async function exportRecordingVideo(rec) {
  if (state.replaying || state.recordingBuffer) { toast('Finish what is running first', 'warn'); return null; }
  const fmt = pickVideoFormat();
  if (!fmt) { toast('This build cannot record video', 'error'); return null; }
  selectRecording(rec);
  const ctx = ops.capture('video'); // film THIS tab even if the user switches away
  if (!ctx.wv) { toast('Open a page first', 'warn'); return null; }

  let stream = null;
  let recorder = null;
  let track = null;
  const chunks = [];
  try {
    await caos.export.videoSource(ctx.wv.getWebContentsId());
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    track = stream.getVideoTracks()[0] || null;
    recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 6_000_000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    await caos.export.videoSource(null);
    toast('Could not start filming the page: ' + ((err && err.message) || err), 'error', 5000);
    return null;
  }

  const startedAt = Date.now();
  toast('Filming the replay…', 'info', 2000);
  try {
    await replayRecording(rec, { forVideo: true, ctx });
  } finally {
    await new Promise((r) => setTimeout(r, 600)); // let the last frames land
    // Flush the tail, then wait for the muxer to finalise — for MP4 this is when
    // the moov atom (duration + seek index) is written, so cutting it short here
    // is exactly what produces an unseekable file.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      recorder.onstop = finish;
      try { recorder.requestData(); } catch (_e) { /* ignore */ }
      try { recorder.stop(); } catch (_e) { finish(); }
      setTimeout(finish, 4000);
    });
    stream.getTracks().forEach((t) => t.stop());
    await caos.export.videoSource(null);
  }

  const blob = new Blob(chunks, { type: fmt.mime });
  if (!blob.size) {
    toast(track && track.readyState === 'ended'
      ? 'The page stopped before anything was filmed'
      : 'Nothing was captured', 'error', 5000);
    return null;
  }

  const base64 = await blobToBase64(blob);
  const slug = (rec.name || 'journey').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'journey';
  const name = slug + '.' + fmt.ext;
  const saved = await caos.export.saveBinary({
    defaultName: name,
    base64,
    filters: [{ name: fmt.label, extensions: [fmt.ext] }],
  });
  if (saved) {
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    toast(`Saved ${name} — ${secs}s, ${Math.max(1, Math.round(blob.size / 1024))} KB`, 'success', 4000);
  }
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

// Replay is bound to the tab (and guest element) that was in front when it
// started: navigation, steps, URL assertions and acknowledgements all go through
// that context, so switching or creating tabs mid-run cannot redirect it.
// The outcome is a verdict (passed | failed | cancelled | timedOut | skipped |
// unknown) over the PLANNED steps — see controllers/replay-engine.js.
function replaySelected(opts = {}) {
  const rec = state.selectedRecording;
  if (!rec) return Promise.resolve(undefined);
  return replayRecording(rec, opts);
}

async function replayRecording(rec, opts = {}) {
  if (!rec || state.replaying || state.recordingBuffer) return;
  const full = (await caos.recordings.get(rec.id)) || rec;
  const steps = full.steps || [];
  if (!steps.length) { toast('Recording has no steps', 'warn'); return; }
  if (state.replaying || state.recordingBuffer) return; // another run started while we were reading

  const ctx = opts.ctx || ops.capture('replay');
  const tab = tabById(ctx.tabId);
  if (!tab || ops.staleReason(ctx)) { toast('That tab is gone — open a page and try again', 'warn'); return; }

  const forVideo = !!opts.forVideo;
  const baseDelay = state.settings.replayDelayMs ?? 600;
  // E2E deliberately drops the delay to tens of ms — keep that path instant.
  const fast = !forVideo && baseDelay < 100;

  const ac = new AbortController();
  replayRun = { ctx, ac };
  state.replaying = true;
  syncToolbar();
  showOverlay(true);
  overlayFill.parentElement.style.display = '';
  overlayCancelBtn.textContent = 'Cancel';
  overlayCancelBtn.onclick = cancelReplay;

  const driver = createReplayDriver({ ctx, getUrl: () => tab.url });
  const releaseAwake = awake.acquire(() => ctx.wv.getWebContentsId());
  driver.setCursor(true);
  let report;
  try {
    report = await runReplay({
      steps, driver, signal: ac.signal, baseDelay, forVideo, fast,
      onProgress: ({ i, total }) => {
        overlayLabel.textContent = `Replaying ${i + 1}/${total}`;
        overlayFill.style.width = Math.round(((i + 1) / total) * 100) + '%';
      },
      extra: { recordingId: rec.id, runId: ctx.runId, tabId: ctx.tabId },
    });
  } catch (e) {
    toast('Replay error: ' + (e && e.message ? e.message : e), 'error');
    report = buildReplayReport({ steps, results: [], terminal: 'unknown', extra: { recordingId: rec.id, runId: ctx.runId, tabId: ctx.tabId } });
  } finally {
    driver.setCursor(false);
    finishReplay();
    releaseAwake(); // cancel, error and timeout all end here
  }

  // The report doubles as a smoke test: persist it with its honest status
  // (a cancelled or half-run journey is recorded as such, never as passed).
  try {
    await caos.recordings.update(rec.id, { lastRun: report });
    await refreshRecordings();
  } catch (e) {
    toast('Could not save the replay result: ' + (e && e.message ? e.message : e), 'error');
  }
  const summary = describeReplay(report);
  toast(summary.text, summary.tone, summary.tone === 'error' ? 4000 : undefined);
  if (report.status !== 'passed' && report.status !== 'cancelled') showReplayReport(rec, report);
  return report;
}

function showReplayReport(rec, report) {
  const colors = { passed: '#3ddc97', failed: '#ff6b6b', timedOut: '#ff6b6b', cancelled: '#ffb454', skipped: '#9aa2b1', unknown: '#ffb454' };
  const rows = report.steps
    .map((s) => {
      const st = s.status || (s.ok ? 'passed' : 'failed');
      const detail = s.error ? esc(s.error) : s.actual != null && s.actual !== '' ? 'got: ' + esc(String(s.actual)) : esc(s.selector);
      return `<tr><td>${s.i + 1}</td><td class="mono">${esc(s.type)}</td><td style="color:${colors[st] || '#ff6b6b'}">${esc(st === 'passed' ? 'pass' : st === 'failed' ? 'fail' : st)}</td><td class="mono">${detail}</td></tr>`;
    })
    .join('');
  const headline = `${report.passed}/${report.total} steps passed` + (report.status === 'passed' ? '.' : ` — result: ${esc(report.status)}.`);
  modal({
    title: `Replay report — ${rec.name}`,
    width: 580,
    body: h('div', {
      html: `<p style="color:var(--dim);margin:0 0 10px">${headline}</p>
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

// Cancel settles every pending waiter at once (the replay's AbortSignal is shared
// with the driver) and ends the run with terminal status 'cancelled'; the
// not-yet-run steps are reported as skipped, never as passed.
function cancelReplay() {
  if (!state.replaying) return;
  if (replayRun) replayRun.ac.abort();
  else state.replaying = false;
  toast('Replay cancelled');
}

function finishReplay() {
  state.replaying = false;
  replayRun = null;
  showOverlay(false);
  overlayFill.style.width = '0%';
  syncToolbar();
}

function showOverlay(show) {
  stageOverlay.classList.toggle('show', show);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ PAGE AUDIT
// The audit runs inside the guest page (src/webview/audit.js) so it sees the
// real, computed, post-JavaScript DOM. Findings are not annotations until the
// user promotes them — an audit is a suggestion, a note is a decision.
//
// A run is bound to the tab/document it started on (controllers/audit-controller.js);
// its report is stored on THAT tab with the identity of the audited page, and a
// failure/timeout/skip is an explicit outcome — never a clean zero report.
const audits = createAuditRunner({
  send: (ctx) => ctx.wv.send('caos:run-audit', { runId: ctx.runId }),
  staleReason: (ctx) => ops.staleReason(ctx, { doc: true }),
  getViewport: (ctx) => viewportFor(ctx.wv),
});

// Run an audit for ctx. Resolves { outcome, report, source } (see run-report.auditOutcome).
async function runAuditFor(ctx) {
  const skipped = (reason) => ({ outcome: auditOutcome(null, { skipped: true, reason }), report: null, source: null });
  const tab = tabById(ctx.tabId);
  if (!tab || ops.staleReason(ctx)) return { outcome: auditOutcome(null, { cancelled: true, reason: 'The tab is gone' }), report: null, source: null };
  if (state.auditing) return skipped('An audit is already running');
  if (/welcome\.html$/.test(ctx.url || '') || isWelcomeUrl(ctx.url)) { toast('Open a real page to audit', 'warn'); return skipped('No page to audit'); }
  const front = () => state.activeTabId === ctx.tabId;
  state.auditing = true;
  if (front()) { switchTab('audit'); auditPanel.setRunning(true); }
  syncToolbar();
  let res;
  const releaseAwake = awake.acquire(() => ctx.wv.getWebContentsId());
  try {
    res = await audits.run(ctx);
  } finally {
    state.auditing = false;
    releaseAwake();
  }
  const report = res.report;
  if (report && !res.stale) {
    tab.derived.audit = { report, outcome: res.outcome, source: res.source, promoted: new Set() };
    if (front()) {
      state.lastAudit = report;
      auditPanel.setReport(report, reportContextFromSource(res.source));
      syncAuditContext();
      if (report.error) toast(report.error, 'warn', 4000);
      else if (!report.total) toast('Audit passed — no issues found', 'success');
      else toast(`Audit found ${report.total} issue${report.total === 1 ? '' : 's'}`, report.counts && report.counts.critical ? 'error' : 'warn');
    }
  } else if (front()) {
    // Abandoned (page changed / tab closed): show what this tab really has.
    auditPanel.setReport(tab.derived.audit ? tab.derived.audit.report : null, tab.derived.audit ? reportContextFromSource(tab.derived.audit.source) : null);
    syncAuditContext();
  }
  syncToolbar();
  return res;
}

function runAudit() {
  if (!wv) { toast('Open a page first', 'warn'); return Promise.resolve(null); }
  if (state.auditing) return Promise.resolve(null);
  return runAuditFor(ops.capture('audit')).then((res) => res.report);
}

// Severity decides both the action tag and the note priority, so a promoted
// finding lands in exports already triaged.
const AUDIT_ACTION = { critical: 'fix', serious: 'fix', moderate: 'change', minor: 'comment' };
const AUDIT_PRIORITY = { critical: 'critical', serious: 'high', moderate: 'normal', minor: 'low' };

// `source` is the identity of the audited page ({url,title,viewport,...}); the
// note is stamped with it, not with whatever page is showing when the user
// presses "Add as note".
function findingToAnnotation(f, source) {
  const detail = f.detail ? ` ${f.detail}` : '';
  const help = f.help ? ` Fix: ${f.help}` : '';
  const out = {
    kind: f.target && f.target.selector ? 'element' : 'region',
    action: AUDIT_ACTION[f.severity] || 'comment',
    note: `[audit:${f.ruleId}] ${f.title}.${detail}${help}`.trim(),
    target: f.target || {},
    priority: AUDIT_PRIORITY[f.severity] || 'normal',
  };
  if (source) {
    out.url = source.url;
    out.title = source.title;
    if (source.viewport) out.viewport = source.viewport;
  }
  return out;
}

async function promoteFindings(findings) {
  const list = (findings || []).filter(Boolean);
  if (!list.length) { toast('Nothing to capture', 'warn'); return; }
  const ctx = ops.capture('promote');
  const tab = tabById(ctx.tabId);
  const audit = tab && tab.derived.audit;
  if (!audit || !sameAuditedPage(audit.source, { tabId: ctx.tabId, url: ctx.url })) {
    toast('These findings belong to a different page — run the audit again', 'warn');
    return;
  }
  let session;
  try { session = await ensureSession(); } catch (e) {
    toast('Could not start a session: ' + (e && e.message ? e.message : e), 'error');
    return;
  }
  const done = [];
  for (const f of list) {
    const saved = await captureAnnotation(findingToAnnotation(f, audit.source), { ctx, session });
    if (saved) done.push(f.id);
  }
  done.forEach((id) => audit.promoted.add(id));
  if (tab.derived.audit === audit && state.activeTabId === tab.id) auditPanel.markPromoted(done);
  if (done.length) toast(`Captured ${done.length} finding${done.length === 1 ? '' : 's'} as notes`, 'success');
}

// ============================================================ BUNDLES
async function exportProjectBundle(project) {
  const p = project || state.currentProject;
  if (!p) { toast('Open a project first', 'warn'); return; }
  try {
    const bundle = await caos.bundle.export(p.id);
    const saved = await caos.fs.save({ defaultName: bundle.defaultName, content: bundle.content });
    if (saved) {
      const c = bundle.counts;
      toast(`Exported ${c.sessions} session(s), ${c.annotations} note(s), ${c.recordings} recording(s)`, 'success');
    }
  } catch (e) {
    toast('Bundle export failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

async function importProjectBundle() {
  let picked;
  try {
    picked = await caos.fs.openJson();
  } catch (e) {
    toast('Could not read that file: ' + (e && e.message ? e.message : e), 'error');
    return;
  }
  if (!picked) return;
  await importBundleText(picked.text);
}

async function importBundleText(text) {
  try {
    const res = await caos.bundle.import(text);
    await refreshProjects();
    await openProject(res.project);
    const c = res.counts;
    const summary = `“${res.project.name}” — ${c.sessions} session(s), ${c.annotations} note(s), ${c.recordings} recording(s)`;
    if (res.partial || (res.warnings && res.warnings.length)) {
      // Not an unqualified success: say what was dropped or altered.
      toast(`Imported ${summary} — partial: ${res.droppedCount || 0} item(s) dropped`, 'warn', 6000);
      showImportReport(res);
    } else {
      toast(`Imported ${summary}`, 'success');
    }
    return res;
  } catch (e) {
    toast('Import failed: ' + (e && e.message ? e.message : e), 'error');
    return null;
  }
}

function noteList(items) {
  return h('ul', {}, items.map((t) => h('li', { text: t })));
}

// What a bundle import dropped or altered (import is validated, never silent).
function showImportReport(res) {
  const dropped = (res.dropped || []).map((d) => `${d.type} #${(d.index || 0) + 1}: ${d.reason}`);
  if ((res.droppedCount || 0) > dropped.length) dropped.push(`…and ${res.droppedCount - dropped.length} more`);
  const parts = [];
  if (dropped.length) parts.push(h('h4', { text: 'Not imported' }), noteList(dropped));
  if (res.warnings && res.warnings.length) parts.push(h('h4', { text: 'Changed on import' }), noteList(res.warnings));
  modal({ title: 'Import was partial', width: 520, body: h('div', {}, parts), actions: [{ label: 'Close', kind: 'primary' }] });
}

// Playwright export: say which steps could not be exported and that secrets
// are supplied at runtime, never written into the file.
function showPlaywrightExportNotes(out) {
  const skipped = (out && out.skipped) || [];
  const secrets = (out && out.secrets) || [];
  if (!skipped.length && !secrets.length) return;
  const parts = [];
  if (skipped.length) {
    parts.push(h('h4', { text: `${skipped.length} step${skipped.length === 1 ? '' : 's'} not exported — the test fails at each` }),
      noteList(skipped.slice(0, 12).map((s2) => (s2.index < 0 ? 'Start URL' : `Step ${s2.index + 1}${s2.type ? ' (' + s2.type + ')' : ''}`) + ': ' + s2.reason)));
  }
  if (secrets.length) {
    parts.push(h('h4', { text: 'Secrets are not in the file' }),
      h('p', { class: 'field-hint', text: 'Set these environment variables before running the test:' }), noteList(secrets));
  }
  modal({ title: 'Playwright export notes', width: 520, body: h('div', {}, parts), actions: [{ label: 'Close', kind: 'primary' }] });
}

// ============================================================ RECORDING EXPORT
async function exportRecordingAs(format, rec) {
  try {
    const out = await caos.export.recording(format, rec.id);
    const saved = await caos.fs.save({ defaultName: out.defaultName, content: out.content });
    if (saved) toast(format === 'json' ? 'Journey exported' : 'Playwright test written', 'success');
    if (saved && format === 'playwright') showPlaywrightExportNotes(out);
    return out;
  } catch (e) {
    toast('Export failed: ' + (e && e.message ? e.message : e), 'error');
    return null;
  }
}

// ============================================================ HELP
function keyLabel(combo) {
  const mac = (state.config && state.config.platform) === 'darwin';
  return String(combo)
    .replace(/Mod/g, mac ? '\u2318' : 'Ctrl')
    .replace(/Alt/g, mac ? '\u2325' : 'Alt')
    .replace(/Shift/g, mac ? '\u21e7' : 'Shift')
    .split('+')
    .map((s2) => s2.trim())
    .filter(Boolean);
}

function showShortcuts() {
  const body = h('div', {});
  for (const group of (state.config && state.config.shortcuts) || []) {
    const rows = group.items.map(([label, combo]) =>
      h('div', { class: 'shortcut-row' }, [
        h('span', { text: label }),
        h('span', { class: 'shortcut-keys' }, keyLabel(combo).map((k) => h('kbd', { text: k }))),
      ])
    );
    body.appendChild(h('div', { class: 'shortcut-group' }, [h('h4', { text: group.group }), ...rows]));
  }
  modal({ title: 'Keyboard shortcuts', width: 520, body, actions: [{ label: 'Close', kind: 'primary' }] });
}

function showAbout() {
  const version = (state.config && state.config.appVersion) || '';
  const body = h('div', {}, [
    h('div', { class: 'about-hero' }, [
      h('div', { class: 'about-mark', html: icon('inspect', 24) }),
      h('div', {}, [
        h('div', { class: 'about-name', text: 'Braiwser' }),
        h('div', { class: 'about-version', text: 'v' + version }),
      ]),
    ]),
    h('p', { class: 'about-copy', text: 'An annotation-first inspector browser for reviewing web UIs and handing precise change requests to a coding agent. Open any project or URL, click elements to capture them, audit accessibility, record journeys as tests, and export the whole review as Markdown, an agent prompt, or a Playwright spec.' }),
    h('p', { class: 'about-copy', text: 'Everything — projects, notes, journeys, API keys — stays on this machine. Nothing is uploaded unless you run an AI task with your own key.' }),
  ]);
  modal({ title: 'About', width: 480, body, actions: [{ label: 'Close', kind: 'primary' }] });
}

// ============================================================ SCREENSHOT
function onScreenshot(e) {
  const anchorEl = (e && e.currentTarget) || document.body;
  menu(anchorEl, [
    { label: 'Viewport', onClick: () => doScreenshot(false) },
    { label: 'Full page (beyond viewport)', onClick: () => doScreenshot(true) },
  ]);
}

// Action→color map from the canonical config (passed to the screenshot compositor).
function actionColors() {
  const m = {};
  for (const t of (state.config && state.config.actionTags) || []) m[t.id] = t.color;
  return m;
}

// Live scroll origin, device pixel ratio and CSS viewport of ONE guest, so
// overlay boxes can be converted into the screenshot's coordinate space.
function measureGuest(webview) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 1500);
    try {
      Promise.resolve(webview.executeJavaScript(
        '({scroll:{x:window.scrollX,y:window.scrollY},dpr:window.devicePixelRatio,viewport:{w:window.innerWidth,h:window.innerHeight}})'
      )).then(finish, () => finish(null));
    } catch (_e) { finish(null); }
  });
}

async function saveShot(dataUrl, count, suffix) {
  const name = `screenshot${suffix ? '-' + suffix : ''}-${stamp()}.png`;
  const saved = await caos.fs.saveScreenshot({ defaultName: name, dataUrl });
  if (saved) toast(count ? `Screenshot saved with ${count} annotations` : 'Screenshot saved', 'success');
}

// The tab, document, viewport and scroll origin are snapshotted around the
// async capture (controllers/screenshot-capture.js). Overlay boxes are FRESH
// (requested right after the pixels), tagged by coordinate space, and converted
// into the image's space; if the page moved they are omitted, not misdrawn.
async function doScreenshot(full) {
  const ctx = ops.capture('screenshot');
  if (!ctx.wv) { toast('Open a page first', 'warn'); return; }
  try {
    const res = await captureScreenshot(ctx, { full: !!full }, {
      staleReason: (c, o) => ops.staleReason(c, o),
      measure: (c) => measureGuest(c.wv),
      captureViewport: async (c) => (await c.wv.capturePage()).toDataURL(),
      captureFull: (c) => caos.fs.captureFullPage(c.wv.getWebContentsId()),
      requestBoxes: (c, items, space) => {
        const requestId = 'box-' + c.runId;
        return requestFromGuest(c.wv, {
          channel: 'caos:request-boxes',
          payload: { requestId, space, annotations: items },
          replyChannel: 'caos:boxes',
          accept: (r) => !!r && r.requestId === requestId,
          timeoutMs: 3000,
          fallback: null,
        });
      },
      documentIdOf: (c) => { const t = tabById(c.tabId); return (t && t.documentId) || ''; },
      annotationsFor: (c) => state.annotations
        .filter((a) => a.url === c.url && a.target)
        .map((a) => ({ ...a, pinNum: state.annotations.indexOf(a) + 1 })),
      composite: (dataUrl, items, o) => compositeAnnotations(dataUrl, items, { ...o, colors: actionColors() }),
      fallbackWidth: (c) => c.wv.clientWidth,
    });
    if (!res.ok) { toast(res.error || 'Screenshot failed', res.error && /cancelled/.test(res.error) ? 'warn' : 'error'); return; }
    await saveShot(res.dataUrl, res.count, full ? 'fullpage' : '');
    if (res.note) toast(res.note, 'warn', 4000);
    else if (res.skipped) toast(`${res.skipped} note${res.skipped === 1 ? '' : 's'} could not be placed on the screenshot`, 'warn', 4000);
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
  const session = state.currentSession; // export the session the user asked about, even if they switch meanwhile
  if (!session) { toast('Open or start a session first', 'warn'); return; }
  try {
    const result = await caos.export.build(format, session.id, { consoleLog: tabConsole() });
    if (!result || !result.content) { toast('Nothing to copy', 'warn'); return; }
    await copyText(result.content, 'Prompt copied to clipboard');
    markShipped();
    return result;
  } catch (e) {
    toast('Copy failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

async function doExport(format) {
  const session = state.currentSession;
  if (!session) { toast('Open or start a session first', 'warn'); return; }
  try {
    const result = await caos.export.build(format, session.id, { consoleLog: tabConsole() });
    if (!result) { toast('Nothing to export', 'warn'); return; }
    const saved = await caos.fs.save({ defaultName: result.defaultName, content: result.content });
    if (saved) toast(`Exported ${format}`, 'success');
  } catch (e) {
    toast('Export failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ============================================================ AGENT HAND-OFF
async function handoffToAgent() {
  const session = state.currentSession;
  if (!session) { toast('Open or start a session first', 'warn'); return; }
  if (!state.annotations.length) { toast('No notes to hand off yet', 'warn'); return; }

  let res;
  try {
    res = await caos.agent.write(session.id, { consoleLog: tabConsole() });
  } catch (e) {
    toast('Hand-off failed: ' + (e && e.message ? e.message : e), 'error');
    return;
  }
  const { file } = res;
  let command = (res && res.command) || (state.settings && state.settings.agentCommand) || '';
  let presets = state.agentPresets;
  try { presets = await caos.agent.detect(); state.agentPresets = presets; } catch (_e) { /* keep */ }

  let project = null;
  try { project = session.projectId ? await caos.projects.get(session.projectId) : null; } catch (_e) { /* treated as no project */ }
  const where = handoffWhere(res, project);

  markShipped();
  toast('Request written', 'success');
  openHandoffModal({
    file,
    command,
    presets,
    cwd: where.cwd,
    entry: where.entry,
    needsLocalDirectory: where.needsLocalDirectory,
    notices: where.notices,
    // Pick a real folder for an imported / URL project. Only the main process
    // can clear "imported"; the next agent.run re-reads the project there.
    onChooseDirectory: !project ? undefined : async () => {
      const updated = await caos.projects.relocate(project.id);
      if (!updated) return null;
      if (state.currentProject && state.currentProject.id === updated.id) state.currentProject = updated;
      await refreshProjects();
      return { cwd: updated.path };
    },
    onSetCommand: async (cmd) => {
      command = cmd;
      const next = await caos.settings.set({ agentCommand: cmd });
      if (next) state.settings = next;
    },
    onReveal: (path) => caos.fs.reveal(path),
    onCopy: () => copyExport('prompt'),
    onVerify: () => verifySession(),
    onRun: async ({ file: promptFile, onChunk }) => {
      const unsub = caos.agent.onOutput((chunk) => onChunk && onChunk(chunk));
      try {
        return await caos.agent.run(session.id, promptFile);
      } finally {
        if (unsub) unsub();
      }
    },
  });
}

// ============================================================ SETTINGS
// The settings/onboarding modals render option lists that live in config, so
// hand them a view of settings with those choices folded in.
function settingsView() {
  return {
    ...state.settings,
    availableThemes: (state.config && state.config.themes) || [],
    modelChoices: (state.config && state.config.modelChoices) || {},
    personas: (state.config && state.config.personas) || [],
  };
}

async function openOnboarding() {
  state.providers = await caos.secrets.providers();
  openOnboardingModal({
    settings: settingsView(),
    providers: { ...state.providers },
    actions: profileActions(),
    onComplete: ({ persona, skipped }) => {
      syncPersonaChrome();
      if (skipped) return;
      openSamplePage({ inspect: true, startCoach: true, persona });
    },
  });
}

async function openSettings() {
  state.providers = await caos.secrets.providers();
  try { state.agentPresets = await caos.agent.detect(); } catch (_e) { /* ignore */ }
  openSettingsModal({
    settings: settingsView(),
    providers: { ...state.providers },
    actions: profileActions(),
  });
}

function profileActions() {
  return {
    setSettings: async (patch) => {
      const next = await caos.settings.set(patch);
      if (next) state.settings = next;
      // Appearance and viewport changes must land immediately, not on restart.
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) applyTheme();
      if (patch && (patch.device !== undefined || patch.deviceLandscape !== undefined)) applyDevice();
      if (patch && patch.persona) syncPersonaChrome();
      syncProfileUi();
      return settingsView();
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
    // The Claude subscription sign-in, for a machine with no `claude` CLI. Step
    // one opens the browser; step two takes the code it shows.
    claudeLoginStart: () => caos.secrets.claudeLoginStart(),
    claudeLoginFinish: async (pasted) => {
      const result = await caos.secrets.claudeLoginFinish(pasted);
      if (result && result.status) state.providers = result.status;
      syncProfileUi();
      return result;
    },
    claudeDisconnect: async () => {
      state.providers = await caos.secrets.claudeDisconnect();
      syncProfileUi();
      return state.providers;
    },
    refreshProviders: async () => {
      state.providers = await caos.secrets.providers();
      syncProfileUi();
      return state.providers;
    },
    licenseStatus: () => caos.license.status(),
    dataInventory: () => caos.billing.dataInventory(),
    exportAccountData: exportAccountData,
    deleteAccountData: deleteAccountData,
    activateLicense: (key) => caos.license.activate(key),
    syncSignIn: (email) => caos.sync.signIn(email),
    syncSignOut: () => caos.sync.signOut(),
    agentPresets: state.agentPresets || [],
  };
}

// "Your data on this device": export saves the JSON the main process built.
async function exportAccountData() {
  const pack = await caos.billing.gdprExport();
  if (!pack) throw new Error('Nothing to export');
  const saved = await caos.fs.save({ defaultName: pack.defaultName, content: pack.content });
  if (saved) toast('Data exported', 'success');
  return pack;
}

// Delete everything the app stores, then make the open window forget it too.
// The raw result goes back to the modal, which states what was and was not erased.
async function deleteAccountData() {
  const result = await caos.billing.gdprDelete();
  try {
    projectGen.invalidate();
    state.currentProject = null;
    sessions.close();
    if (verifyPanel) verifyPanel.setRun(null);
    const next = await caos.settings.get();
    if (next) state.settings = next;
    state.providers = await caos.secrets.providers();
    syncProfileUi();
    await refreshProjects();
    await refreshSessions();
    await refreshRecordings();
    await refreshHistory();
    await refreshBookmarks();
  } catch (e) { console.warn('[delete] refresh failed: ' + ((e && e.message) || e)); }
  return result;
}

function syncProfileUi() {
  if (aiPanel && aiPanel.setProfile) aiPanel.setProfile(state.settings, state.providers);
  if (toolbar) syncToolbar();
  syncPersonaChrome();
}

function currentPersona() {
  return (state.settings && state.settings.persona) || 'agent';
}

function syncPersonaChrome() {
  if (!toolbar) return;
  const chrome = chromeForPersona(currentPersona());
  toolbar.applyChrome(chrome);
  if (tabButtons) {
    Object.entries(tabButtons).forEach(([id, btn]) => {
      const emphasized = chrome.tabs.includes(id);
      btn.classList.toggle('tab-muted', !emphasized && id !== 'notes');
    });
  }
  if (footerPrimaryBtn) {
    const copy = personaCopy(currentPersona(), state.config && state.config.personas);
    footerPrimaryBtn.textContent = copy.primary.label;
    footerPrimaryBtn.title = copy.tip || copy.primary.label;
  }
}

function runPersonaPrimary() {
  const copy = personaCopy(currentPersona(), state.config && state.config.personas);
  const cmd = copy.primary && copy.primary.command;
  if (cmd) runCommand(cmd);
}

function openSamplePage({ inspect = false, startCoach = false } = {}) {
  const url = state.config && state.config.playgroundUrl;
  if (!url) { toast('Sample page is missing', 'error'); return; }
  navigateTo(url);
  if (inspect) setTimeout(() => { if (state.mode !== 'inspect') setMode('inspect'); }, 350);
  if (startCoach && !caos.e2e && !(state.settings && state.settings.coachComplete)) {
    setTimeout(() => { if (coachmarks) coachmarks.show(0); }, 500);
  }
}

function armNextAction() {
  if (caos.e2e) return;
  if (state.settings && state.settings.nextActionDone) return;
  if (coachmarks && coachmarks.isVisible()) return;
  state.nextActionArmed = true;
  if (notesPanel && notesPanel.setNextAction) {
    notesPanel.setNextAction({
      show: true,
      persona: currentPersona(),
      onAction: (id) => {
        if (id === 'copy') copyExport('prompt');
        else if (id === 'handoff') handoffToAgent();
        else if (id === 'audit') runAudit();
        else if (id === 'client-pack') exportClientPack();
      },
      onDismiss: () => markShipped(),
    });
  }
}

function markShipped() {
  state.nextActionArmed = false;
  if (notesPanel && notesPanel.setNextAction) notesPanel.setNextAction({ show: false });
  notifyCoach('shipped');
  if (!caos.e2e) caos.settings.set({ nextActionDone: true }).then((next) => { if (next) state.settings = next; });
}

async function exportClientPack() {
  const session = state.currentSession;
  if (!session) { toast('Open or start a session first', 'warn'); return; }
  try {
    const pack = await caos.review.clientPack(session.id);
    const name = ((pack && pack.title) || 'client-pack').replace(/[^\w.-]+/g, '-').slice(0, 60) + '.md';
    const saved = await caos.fs.save({ defaultName: name, content: (pack && pack.markdown) || '' });
    if (saved) {
      toast('Client pack exported', 'success');
      markShipped();
    }
    return pack;
  } catch (e) {
    toast('Client pack failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

async function applyChecklist(id) {
  const session = await ensureSession();
  const res = await caos.review.applyChecklist(id, session.id);
  const list = await caos.annotations.bySession(session.id);
  if (sessions.isCurrent(session.id)) {
    state.annotations = list;
    notesPanel.setAnnotations(state.annotations);
  }
  if (res && res.created && res.created.length) {
    bumpSessionCount(session.id, res.created.length);
    toast('Checklist added as notes', 'success');
  }
}

// Viewport pixels of the tab captured in ctx. Only the visible tab can be
// captured faithfully; a background tab yields no shot rather than another
// tab's pixels.
async function captureViewportShot(ctx) {
  try {
    const c = ctx || ops.capture('shot');
    if (!c.wv || ops.staleReason(c, { active: true })) return '';
    const img = await c.wv.capturePage();
    return img && img.toDataURL ? img.toDataURL() : '';
  } catch (_e) {
    return '';
  }
}

// Verify: a single-flight run whose session, tab, baseline and recording are
// captured at the start (controllers/verify-controller.js). Results are saved
// only to that session; failed/skipped audits stay failed/skipped.
const verifyRunner = createVerifyRunner({
  getSession: () => state.currentSession,
  captureContext: () => ops.capture('verify'),
  getAnnotations: () => state.annotations,
  getSelectedRecording: () => state.selectedRecording,
  getBaselineAudit: (ctx) => {
    const tab = tabById(ctx.tabId);
    const a = tab && tab.derived.audit;
    // Only an audit of THIS page counts as a baseline; otherwise there is none.
    return a && sameAuditedPage(a.source, { tabId: ctx.tabId, url: ctx.url }) ? a.outcome : null;
  },
  setBusy: (on) => { if (verifyPanel) verifyPanel.setRunning(on); },
  captureShot: (ctx) => captureViewportShot(ctx),
  runAudit: async (ctx) => (await runAuditFor(ctx)).outcome,
  replay: (ctx, rec) => replayRecording(rec, { ctx }),
  save: (sessionId, payload) => caos.review.verifySave(sessionId, payload),
  showRun: (run) => { if (verifyPanel) verifyPanel.setRun(run); },
  currentUrlOf: (ctx) => { const t = tabById(ctx.tabId); return (t && t.url) || ctx.url; },
  toast: (m, k) => toast(m, k),
});

async function verifySession() {
  if (!state.currentSession) { toast('Open or start a session first', 'warn'); return null; }
  switchTab('verify');
  return verifyRunner.run();
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
