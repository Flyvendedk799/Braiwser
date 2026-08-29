// Registers every IPC handler. The renderer never touches channel strings —
// the preload (src/main/preload.js) maps a clean named API onto these channels.
// Services (AI, export) are required lazily so a syntax error in one doesn't
// take down app boot, and so they pick up edits during dev reloads.
const { ipcMain, dialog, BrowserWindow, app, shell, webContents, nativeTheme } = require('electron');
const fs = require('fs');
const { pathToFileURL } = require('url');
const config = require('../config');

function register({ repos, paths, getWindow }) {
  const win = () => getWindow() || BrowserWindow.getFocusedWindow();
  const on = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  // --- e2e self-test: print report and exit ---
  // Checks stream in as they run, so a renderer crash still leaves a report.
  const e2eChecks = [];
  on('caos:e2e-check', (c) => { e2eChecks.push(c); return true; });
  register.e2ePartial = () => e2eChecks;
  on('caos:e2e-done', (report) => {
    const failures = ((report && report.checks) || []).filter((c) => !c.pass);
    const failed = !report || report.ok === false || !!report.fatal || failures.length > 0;
    if (report && report.fatal) console.log('E2E FATAL: ' + report.fatal);
    for (const f of failures) console.log(`E2E FAIL: ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    console.log(`E2E ${failed ? 'FAILED' : 'PASSED'} — ${(report && report.passed) || 0}/${(report && report.total) || 0} checks`);
    console.log('CAOS_E2E_REPORT ' + JSON.stringify(report));
    // Exit non-zero on failure so CI actually goes red.
    setTimeout(() => app.exit(failed ? 1 : 0), 100);
    return true;
  });

  // --- config + static paths ---
  on('caos:config', () => ({
    actionTags: config.ACTION_TAGS,
    priorities: config.PRIORITIES,
    statuses: config.STATUSES,
    assertionKinds: config.ASSERTION_KINDS,
    devicePresets: config.DEVICE_PRESETS,
    themes: config.THEMES,
    modelChoices: config.MODEL_CHOICES,
    auditSeverities: config.AUDIT_SEVERITIES,
    shortcuts: config.SHORTCUTS,
    aiTasks: config.AI_TASKS,
    appVersion: app.getVersion(),
    platform: process.platform,
    inspectorPath: pathToFileURL(paths.inspector).href,
    welcomeUrl: pathToFileURL(paths.welcome).href,
  }));

  // Current effective system theme, for settings.theme === 'system'.
  on('caos:system-theme.get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

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
  on('caos:open-json', async () => {
    const r = await dialog.showOpenDialog(win(), {
      title: 'Import a Braiwser project bundle',
      properties: ['openFile'],
      filters: [{ name: 'Braiwser bundle', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    try {
      return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
    } catch (err) {
      throw new Error(`Could not read ${r.filePaths[0]}: ${err.message}`);
    }
  });
  on('caos:save', async ({ defaultName, content }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Save', defaultPath: defaultName || 'export.md' });
    if (r.canceled || !r.filePath) return null;
    try { fs.writeFileSync(r.filePath, content, 'utf8'); }
    catch (err) { throw new Error(`Failed to save ${r.filePath}: ${err.message}`); }
    return r.filePath;
  });
  on('caos:save-screenshot', async ({ defaultName, dataUrl }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Save screenshot', defaultPath: defaultName || 'screenshot.png' });
    if (r.canceled || !r.filePath) return null;
    try { fs.writeFileSync(r.filePath, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (err) { throw new Error(`Failed to save ${r.filePath}: ${err.message}`); }
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
  on('caos:annotations.countsBySession', () => repos.annotations.countsBySession());
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
  on('caos:settings.set', (patch) => {
    const next = repos.settings.set(patch);
    // Keep Electron's own chrome (native dialogs, form controls, scrollbars) in
    // step with the app theme the moment the user changes it.
    nativeTheme.themeSource = next.theme === 'light' || next.theme === 'dark' ? next.theme : 'system';
    return next;
  });
  on('caos:secrets.providers', () => repos.secrets.providers());
  on('caos:secrets.setKey', (provider, key) => repos.secrets.setKey(provider, key));
  on('caos:secrets.clearKey', (provider) => repos.secrets.clearKey(provider));

  // --- recording exports (Playwright spec / raw JSON) ---
  on('caos:export.recording', (format, recordingId) => {
    const { toPlaywrightSpec, toRecordingJson } = require('../services/export/playwright');
    const rec = repos.recordings.get(recordingId);
    if (!rec) throw new Error('Recording not found');
    return format === 'json' ? toRecordingJson(rec) : toPlaywrightSpec(rec);
  });

  // --- project bundles (share / archive a whole review) ---
  on('caos:bundle.export', (projectId) => {
    const { exportBundle } = require('../services/bundle');
    return exportBundle(repos, projectId);
  });
  on('caos:bundle.import', (text) => {
    const { importBundle } = require('../services/bundle');
    return importBundle(repos, text);
  });

  // --- AI ---
  on('caos:ai.run', async (payload) => {
    try {
      const { runAiTask } = require('../services/ai');
      return await runAiTask(payload, repos);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // --- recording exports (markdown / pdf / video) ---
  on('caos:recording.report', (recordingId, format) => {
    const rec = repos.recordings.get(recordingId);
    if (!rec) throw new Error('Recording not found');
    const { toRecordingMarkdown, toRecordingHtml } = require('../services/export/recording');
    const slug = String(rec.name || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'recording';
    if (format === 'html') return { name: slug + '.html', content: toRecordingHtml(rec, rec.lastRun) };
    return { name: slug + '.md', content: toRecordingMarkdown(rec, rec.lastRun) };
  });

  // Print the HTML report through an offscreen window — no PDF dependency, and
  // what you see in the Markdown is exactly what lands in the PDF.
  on('caos:recording.pdf', async (recordingId) => {
    const rec = repos.recordings.get(recordingId);
    if (!rec) throw new Error('Recording not found');
    const { toRecordingHtml } = require('../services/export/recording');
    const html = toRecordingHtml(rec, rec.lastRun);
    const printer = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
    try {
      await printer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await printer.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        pageSize: 'A4',
      });
      const slug = String(rec.name || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'recording';
      return { name: slug + '.pdf', base64: pdf.toString('base64'), bytes: pdf.length };
    } finally {
      try { printer.destroy(); } catch (_e) { /* ignore */ }
    }
  });

  // Save any binary the renderer produced (pdf, webm, zip…).
  on('caos:save-binary', async ({ defaultName, base64, filters }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Save', defaultPath: defaultName || 'file.bin', filters: filters || undefined });
    if (r.canceled || !r.filePath) return null;
    try { fs.writeFileSync(r.filePath, Buffer.from(String(base64), 'base64')); }
    catch (err) { throw new Error(`Failed to save ${r.filePath}: ${err.message}`); }
    return r.filePath;
  });

  // --- single-element export ---
  // build() returns the bundle; save() puts it on disk. Split so the harness can
  // exercise the capture without a file dialog.
  on('caos:element.build', async (payload, format) => {
    const { buildElementBundle } = require('../services/export/element');
    return buildElementBundle(payload, format || 'auto');
  });
  on('caos:element.save', async ({ name, base64 }) => {
    const isZip = /\.zip$/i.test(name || '');
    const r = await dialog.showSaveDialog(win(), {
      title: 'Export element',
      defaultPath: name || 'element.html',
      filters: isZip
        ? [{ name: 'Zip archive', extensions: ['zip'] }]
        : [{ name: 'HTML file', extensions: ['html'] }],
    });
    if (r.canceled || !r.filePath) return null;
    try { fs.writeFileSync(r.filePath, Buffer.from(String(base64), 'base64')); }
    catch (err) { throw new Error(`Failed to save ${r.filePath}: ${err.message}`); }
    return r.filePath;
  });

  // --- export ---
  on('caos:export.build', (format, sessionId, extras) => {
    const { buildExport } = require('../services/export');
    const session = repos.sessions.get(sessionId);
    const annotations = repos.annotations.bySession(sessionId);
    return buildExport(format, { session, annotations, consoleLog: extras && extras.consoleLog });
  });

  // --- agent hand-off ---
  function resolveProject(session) {
    return session && session.projectId ? repos.projects.get(session.projectId) : null;
  }
  on('caos:agent.write', (sessionId, extras) => {
    const { writeRequest } = require('../services/agent/handoff');
    const session = repos.sessions.get(sessionId);
    const annotations = repos.annotations.bySession(sessionId);
    const project = resolveProject(session);
    const { file, cwd, length } = writeRequest({ session, annotations, project, appDir: repos.dir, consoleLog: extras && extras.consoleLog });
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
    let overrode = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
      // Capture from the top so the shot starts at the top of the document.
      try { await wc.executeJavaScript('window.scrollTo(0, 0)', true); } catch (_e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 60));
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize || { width: 1200, height: 800 };
      // Grow the VIEWPORT to the document and take an ordinary screenshot.
      // 'captureBeyondViewport' is the tidier API, but on this Chromium it takes
      // the renderer down outright (a NOTREACHED, not a catchable error) often
      // enough to lose the app — and a crash is a worse screenshot than a
      // slightly reflowed one. Height is capped so a runaway page cannot ask for
      // a surface nothing can allocate.
      const width = Math.max(320, Math.min(4000, Math.ceil(size.width)));
      const full = Math.ceil(size.height);
      const height = Math.max(240, Math.min(12000, full));
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      overrode = true;
      await new Promise((r) => setTimeout(r, 140)); // let it lay out at the new size
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + shot.data,
        cssWidth: width,
        cssHeight: height,
        truncated: height < full,
      };
    } catch (e) {
      // Last resort: whatever is on screen right now.
      try {
        const img = await wc.capturePage();
        const size = img.getSize();
        return { ok: true, dataUrl: img.toDataURL(), cssWidth: size.width, cssHeight: size.height, viewportOnly: true };
      } catch (_e2) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    } finally {
      if (overrode) { try { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch (_e) { /* ignore */ } }
      try { if (attached) dbg.detach(); } catch (_e) { /* ignore */ }
    }
  });
}

module.exports = register;
