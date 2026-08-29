// Native application menu.
//
// Every item dispatches a *command id* to the focused window's renderer over
// `caos:command`; the renderer owns a single command table (app.js
// `runCommand`). Keeping the menu declarative means accelerators work even
// while the guest <webview> has keyboard focus — which is most of the time in
// this app, and the reason renderer-level keydown handling alone was never
// enough.
const { Menu, app, shell } = require('electron');

const isMac = process.platform === 'darwin';

// Send a command to the window the menu was invoked from. `browserWindow` is
// provided by Electron for menu clicks; fall back to the app's main window.
function dispatch(getWindow) {
  return (command, arg) => (_item, browserWindow) => {
    const win = browserWindow && !browserWindow.isDestroyed() ? browserWindow : getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('caos:command', { command, arg });
  };
}

function buildTemplate({ getWindow, devices, themes }) {
  const send = dispatch(getWindow);
  const cmd = (label, command, accelerator, extra) => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: send(command),
    ...(extra || {}),
  });

  const deviceItems = devices.map((d) => ({
    label: d.label + (d.w ? `  ${d.w}×${d.h}` : ''),
    click: send('view.device', d.id),
  }));

  const themeItems = themes.map((t) => ({
    label: t.label,
    click: send('view.theme', t.id),
  }));

  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: 'About Braiwser', click: send('help.about') },
        { type: 'separator' },
        cmd('Settings…', 'settings.open', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      cmd('New Tab', 'tab.new', 'CmdOrCtrl+T'),
      cmd('Close Tab', 'tab.close', 'CmdOrCtrl+W'),
      { type: 'separator' },
      cmd('Open File…', 'file.open', 'CmdOrCtrl+O'),
      cmd('Open Folder…', 'folder.open', 'CmdOrCtrl+Shift+O'),
      { type: 'separator' },
      cmd('New Project…', 'project.new'),
      cmd('New Session…', 'session.new', 'CmdOrCtrl+N'),
      { type: 'separator' },
      {
        label: 'Export Review',
        submenu: [
          cmd('Markdown…', 'export.markdown'),
          cmd('Agent Prompt…', 'export.prompt'),
          cmd('JSON…', 'export.json'),
          { type: 'separator' },
          cmd('Copy Agent Prompt', 'export.copyPrompt', 'CmdOrCtrl+Shift+C'),
        ],
      },
      cmd('Hand Off to Coding Agent…', 'agent.handoff', 'CmdOrCtrl+Shift+H'),
      { type: 'separator' },
      cmd('Export Project Bundle…', 'bundle.export'),
      cmd('Import Project Bundle…', 'bundle.import'),
      ...(isMac ? [] : [{ type: 'separator' }, cmd('Settings…', 'settings.open', 'Ctrl+,'), { role: 'quit' }]),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      cmd('Search Notes', 'notes.search', 'CmdOrCtrl+F'),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      cmd('Notes Panel', 'panel.notes', 'CmdOrCtrl+1'),
      cmd('Style Panel', 'panel.style', 'CmdOrCtrl+2'),
      cmd('Audit Panel', 'panel.audit', 'CmdOrCtrl+3'),
      cmd('AI Panel', 'panel.ai', 'CmdOrCtrl+4'),
      { type: 'separator' },
      { label: 'Theme', submenu: themeItems },
      { label: 'Device Viewport', submenu: deviceItems },
      cmd('Rotate Viewport', 'view.rotate', 'CmdOrCtrl+Shift+R'),
      { type: 'separator' },
      cmd('Zoom In', 'zoom.in', 'CmdOrCtrl+Plus'),
      cmd('Zoom Out', 'zoom.out', 'CmdOrCtrl+-'),
      cmd('Actual Size', 'zoom.reset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      cmd('Toggle Page DevTools', 'devtools.page', isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I'),
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Go',
    submenu: [
      cmd('Back', 'nav.back', isMac ? 'Cmd+[' : 'Alt+Left'),
      cmd('Forward', 'nav.forward', isMac ? 'Cmd+]' : 'Alt+Right'),
      cmd('Reload Page', 'nav.reload', 'CmdOrCtrl+R'),
      { type: 'separator' },
      cmd('Focus Address Bar', 'nav.address', 'CmdOrCtrl+L'),
      cmd('Home', 'nav.home', 'CmdOrCtrl+Shift+Home'),
      { type: 'separator' },
      cmd('Bookmark This Page', 'nav.bookmark', 'CmdOrCtrl+D'),
    ],
  });

  template.push({
    label: 'Review',
    submenu: [
      cmd('Inspect Elements', 'mode.inspect', 'CmdOrCtrl+Shift+E'),
      cmd('Draw Region', 'mode.draw', 'CmdOrCtrl+Shift+D'),
      cmd('Edit Content & Style', 'mode.edit', 'CmdOrCtrl+Shift+T'),
      cmd('Rearrange Layout', 'mode.arrange', 'CmdOrCtrl+Shift+M'),
      cmd('Add Assertion', 'mode.assert', 'CmdOrCtrl+Shift+A'),
      // No accelerator: Escape is handled in the renderer so modals and text
      // fields keep it. A menu accelerator would swallow it app-wide.
      cmd('Exit Mode', 'mode.off'),
      { type: 'separator' },
      // Page edits (restyle, rewrite, rearrange) carry their own history — the
      // Edit menu's undo/redo roles belong to whatever text field has focus.
      cmd('Undo Page Edit', 'edit.undo', 'CmdOrCtrl+Shift+Z'),
      cmd('Redo Page Edit', 'edit.redo', 'CmdOrCtrl+Shift+Y'),
      { type: 'separator' },
      cmd('Run Page Audit', 'audit.run', 'CmdOrCtrl+Shift+U'),
      { type: 'separator' },
      cmd('Record Journey', 'record.toggle', 'CmdOrCtrl+Shift+J'),
      cmd('Replay Selected Journey', 'replay.run', 'CmdOrCtrl+Shift+P'),
      { type: 'separator' },
      cmd('Capture Screenshot', 'shot.viewport', 'CmdOrCtrl+Shift+S'),
      cmd('Capture Full Page', 'shot.fullpage', 'CmdOrCtrl+Alt+S'),
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      cmd('Keyboard Shortcuts', 'help.shortcuts', 'CmdOrCtrl+/'),
      cmd('Getting Started', 'help.welcome'),
      { type: 'separator' },
      {
        label: 'Braiwser on GitHub',
        click: () => shell.openExternal('https://github.com/Flyvendedk799/Braiwser'),
      },
      cmd('About Braiwser', 'help.about'),
    ],
  });

  return template;
}

function installMenu(opts) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(opts)));
}

module.exports = { installMenu };
