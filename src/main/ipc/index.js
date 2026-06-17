// Registers every IPC handler. The renderer never touches channel strings —
// the preload (src/main/preload.js) maps a clean named API onto these channels.
// Services (AI, export) are required lazily so a syntax error in one doesn't
// take down app boot, and so they pick up edits during dev reloads.
const { ipcMain, dialog, BrowserWindow, app, shell, webContents } = require('electron');
const fs = require('fs');
const { pathToFileURL } = require('url');
const config = require('../config');

function register({ repos, paths, getWindow }) {
  const win = () => getWindow() || BrowserWindow.getFocusedWindow();
  const on = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  // --- e2e self-test: print report and exit ---
  on('caos:e2e-done', (report) => {
    console.log('CAOS_E2E_REPORT ' + JSON.stringify(report));
    setTimeout(() => app.quit(), 100);
    return true;
  });

  // --- config + static paths ---
  on('caos:config', () => ({
    actionTags: config.ACTION_TAGS,
    priorities: config.PRIORITIES,
    statuses: config.STATUSES,
    assertionKinds: config.ASSERTION_KINDS,
    aiTasks: config.AI_TASKS,
    inspectorPath: pathToFileURL(paths.inspector).href,
    welcomeUrl: pathToFileURL(paths.welcome).href,
  }));

  // --- filesystem ---
  on('caos:open-file', async () => {
    const r = await dialog.showOpenDialog(win(), {
      title: 'Open a web page', properties: ['openFile'],
      filters: [{ name: 'Web pages', extensions: ['html', 'htm'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return { path: r.filePaths[0], url: pathToFileURL(r.filePaths[0]).href };
  });
  on('caos:open-directory', async () => {
    const r = await dialog.showOpenDialog(win(), { title: 'Open a project folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    const dir = r.filePaths[0];
    // try to find an entry html
    let entry = null;
    for (const name of ['index.html', 'public/index.html', 'src/index.html', 'dist/index.html']) {
      const p = require('path').join(dir, name);
      if (fs.existsSync(p)) { entry = p; break; }
    }
    return { path: dir, entry, url: entry ? pathToFileURL(entry).href : null };
  });
  on('caos:save', async ({ defaultName, content }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Save', defaultPath: defaultName || 'export.md' });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });
  on('caos:save-screenshot', async ({ defaultName, dataUrl }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Save screenshot', defaultPath: defaultName || 'screenshot.png' });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
    return r.filePath;
  });

  // --- projects ---
  on('caos:projects.list', () => repos.projects.list());
  on('caos:projects.get', (id) => repos.projects.get(id));
  on('caos:projects.create', (p) => repos.projects.create(p));
  on('caos:projects.touch', (id) => repos.projects.touch(id));
  on('caos:projects.update', (id, patch) => repos.projects.update(id, patch));
  on('caos:projects.remove', (id) => repos.projects.remove(id));

  // --- sessions ---
  on('caos:sessions.list', (projectId) => repos.sessions.list(projectId));
  on('caos:sessions.get', (id) => repos.sessions.get(id));
  on('caos:sessions.create', (s) => repos.sessions.create(s));
  on('caos:sessions.update', (id, patch) => repos.sessions.update(id, patch));
  on('caos:sessions.remove', (id) => repos.sessions.remove(id));

  // --- annotations ---
  on('caos:annotations.bySession', (sessionId) => repos.annotations.bySession(sessionId));
  on('caos:annotations.bySessionUrl', (sessionId, url) => repos.annotations.bySessionUrl(sessionId, url));
  on('caos:annotations.create', (a) => repos.annotations.create(a));
  on('caos:annotations.update', (id, patch) => repos.annotations.update(id, patch));
  on('caos:annotations.remove', (id) => repos.annotations.remove(id));

  // --- recordings ---
  on('caos:recordings.list', (projectId) => repos.recordings.list(projectId));
  on('caos:recordings.get', (id) => repos.recordings.get(id));
  on('caos:recordings.create', (r) => repos.recordings.create(r));
  on('caos:recordings.update', (id, patch) => repos.recordings.update(id, patch));
  on('caos:recordings.remove', (id) => repos.recordings.remove(id));

  // --- history + bookmarks ---
  on('caos:history.list', (limit) => repos.history.list(limit));
  on('caos:history.record', (entry) => repos.history.record(entry));
  on('caos:history.clear', () => repos.history.clear());
  on('caos:bookmarks.list', () => repos.bookmarks.list());
  on('caos:bookmarks.isBookmarked', (url) => repos.bookmarks.isBookmarked(url));
  on('caos:bookmarks.toggle', (entry) => repos.bookmarks.toggle(entry));
  on('caos:bookmarks.remove', (id) => repos.bookmarks.remove(id));

  // --- settings + secrets ---
  on('caos:settings.get', () => repos.settings.get());
  on('caos:settings.set', (patch) => repos.settings.set(patch));
  on('caos:secrets.providers', () => repos.secrets.providers());
  on('caos:secrets.setKey', (provider, key) => repos.secrets.setKey(provider, key));
  on('caos:secrets.clearKey', (provider) => repos.secrets.clearKey(provider));

  // --- AI ---
  on('caos:ai.run', async (payload) => {
    try {
      const { runAiTask } = require('../services/ai');
      return await runAiTask(payload, repos);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // --- export ---
  on('caos:export.build', (format, sessionId) => {
    const { buildExport } = require('../services/export');
    const session = repos.sessions.get(sessionId);
    const annotations = repos.annotations.bySession(sessionId);
    return buildExport(format, { session, annotations });
  });

  // --- agent hand-off ---
  function resolveProject(session) {
    return session && session.projectId ? repos.projects.get(session.projectId) : null;
  }
  on('caos:agent.write', (sessionId) => {
    const { writeRequest } = require('../services/agent/handoff');
    const session = repos.sessions.get(sessionId);
    const annotations = repos.annotations.bySession(sessionId);
    const project = resolveProject(session);
    const { file, cwd, length } = writeRequest({ session, annotations, project, appDir: repos.dir });
    return { file, cwd, length, command: (repos.settings.get().agentCommand || '').trim() };
  });
  on('caos:agent.run', async (sessionId, filePath) => {
    const command = (repos.settings.get().agentCommand || '').trim();
    if (!command) return { ok: false, error: 'No agent command configured (set one in Settings).' };
    const session = repos.sessions.get(sessionId);
    const project = resolveProject(session);
    const cwd = project && project.kind === 'local' && project.path ? project.path : repos.dir;
    const { runCommand } = require('../services/agent/handoff');
    const w = win();
    const onChunk = (chunk) => { try { if (w && !w.isDestroyed()) w.webContents.send('caos:agent.output', chunk); } catch (_e) { /* ignore */ } };
    return runCommand({ command, cwd, filePath, project, onChunk });
  });
  on('caos:reveal', (filePath) => { shell.showItemInFolder(filePath); return true; });

  // --- full-page screenshot via CDP (captures beyond the viewport) ---
  on('caos:capture-fullpage', async (webContentsId) => {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'guest webContents not found' };
    // Only attach the debugger to a guest <webview> hosted by our window — never
    // the privileged renderer or an arbitrary webContents id from the renderer.
    const host = win() && !win().isDestroyed() ? win().webContents : null;
    if (wc.getType() !== 'webview' || (host && wc.hostWebContents !== host)) {
      return { ok: false, error: 'not a guest webContents' };
    }
    const dbg = wc.debugger;
    let attached = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize || { width: 1200, height: 800 };
      const shot = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
      });
      return { ok: true, dataUrl: 'data:image/png;base64,' + shot.data, cssWidth: size.width, cssHeight: size.height };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      try { if (attached) dbg.detach(); } catch (_e) { /* ignore */ }
    }
  });
}

module.exports = register;
