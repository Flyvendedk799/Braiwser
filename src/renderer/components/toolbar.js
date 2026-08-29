// Top toolbar: navigation, address bar, mode toggles, recording, replay,
// screenshot, AI, settings. It renders once and exposes an update() to reflect
// state (active mode, recording, nav availability). All actions are delegated
// back to the controller via the `actions` callback bag.
import { h, icon, clear } from '../lib/dom.js';

export function createToolbar(actions) {
  const suggestions = h('datalist', { id: 'caos-address-suggestions' });
  const addressInput = h('input', {
    type: 'text',
    spellcheck: 'false',
    list: 'caos-address-suggestions',
    placeholder: 'Search or enter address',
    title: 'Enter a URL, a bare domain, an absolute path, or a search phrase',
    on: {
      keydown: (e) => {
        if (e.key === 'Enter') actions.navigate(addressInput.value.trim());
      },
      focus: () => addressInput.select(),
    },
  });

  const lock = h('span', { class: 'lock', html: icon('file', 14) });
  const bookmarkBtn = h('button', { class: 'star-btn', title: 'Bookmark this page', 'aria-label': 'Bookmark this page', text: '☆', on: { click: actions.toggleBookmark } });

  const btn = (cfg) =>
    h('button', {
      class: `icon-btn ${cfg.class || ''} ${cfg.label ? 'has-label' : ''}`.trim(),
      title: cfg.title || cfg.label || '',
      'aria-label': cfg.title || cfg.label || '',
      html: cfg.icon ? icon(cfg.icon, cfg.size || 16) + (cfg.label ? `<span>${cfg.label}</span>` : '') : `<span>${cfg.label}</span>`,
      on: { click: cfg.onClick },
    });

  const undoBtn = btn({ icon: 'undo', title: 'Undo the last page edit', onClick: actions.undo });
  const redoBtn = btn({ icon: 'redo', title: 'Redo the last undone edit', onClick: actions.redo });

  undoBtn.setAttribute('data-act', 'undo');
  redoBtn.setAttribute('data-act', 'redo');

  const backBtn = btn({ icon: 'back', title: 'Back', onClick: actions.back });
  const fwdBtn = btn({ icon: 'forward', title: 'Forward', onClick: actions.forward });
  const reloadBtn = btn({ icon: 'reload', title: 'Reload', onClick: actions.reload });

  // The three page tools are one segmented control: they are mutually
  // exclusive, and which one is on has to be readable at a glance.
  const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
  const inspectBtn = btn({ icon: 'inspect', label: 'Inspect', title: `Inspect element — capture a note and view its layout hierarchy (click an element) · ${MOD}⇧E`, onClick: () => actions.toggleMode('inspect') });
  const drawBtn = btn({ icon: 'draw', label: 'Draw', title: `Drag on the page to circle an area, then add a note · ${MOD}⇧D`, onClick: () => actions.toggleMode('draw') });
  const editBtn = btn({ icon: 'edit', label: 'Edit', title: `Edit content and style — click an element to change its copy, type, colour, spacing and size (double-click text in Inspect to jump straight here) · ${MOD}⇧T`, onClick: () => actions.toggleMode('edit') });
  const arrangeBtn = btn({ icon: 'move', label: 'Rearrange', title: `Rearrange the layout — drag any element to move it (into any container), click again to go deeper, Alt-drag to free-move, handles to resize, plus smart re-layout. Every edit is captured as a note. · ${MOD}⇧M`, onClick: () => actions.toggleMode('arrange') });
  const assertBtn = btn({ icon: 'check', label: 'Assert', title: 'Add an assertion to the recording (click an element)', onClick: () => actions.toggleMode('assert') });

  const recBtn = btn({ icon: 'record', class: 'rec', label: 'Record', title: 'Record a user journey', onClick: actions.toggleRecord });
  const replayBtn = btn({ icon: 'replay', label: 'Replay', title: 'Replay the selected recording', onClick: actions.replay });

  const auditBtn = btn({ icon: 'audit', label: 'Audit', title: 'Run an offline accessibility & UI-quality audit of this page', onClick: actions.runAudit });

  const deviceBtn = h('button', {
    class: 'icon-btn has-label device-btn',
    title: 'Device viewport',
    'aria-label': 'Device viewport',
    html: icon('device', 16) + '<span class="dv-label">Fit</span>',
    on: { click: (e) => actions.openDeviceMenu(e) },
  });

  const shotBtn = btn({ icon: 'camera', title: 'Capture screenshot', onClick: actions.screenshot });
  const aiBtn = btn({ icon: 'ai', label: 'AI', title: 'Open the AI tab', onClick: actions.openAi });
  const settingsBtn = btn({ icon: 'settings', label: 'Profile', title: 'Profile and AI providers', onClick: actions.openSettings });

  const openFileBtn = btn({ icon: 'file', label: 'File', title: 'Open a local file', onClick: actions.openFile });
  const openFolderBtn = btn({ icon: 'folder', label: 'Folder', title: 'Open a local folder', onClick: actions.openFolder });

  const root = h('header', { class: 'toolbar' }, [
    h('div', { class: 'tb-group' }, [backBtn, fwdBtn, reloadBtn]),
    h('div', { class: 'address' }, [lock, addressInput, bookmarkBtn, suggestions]),
    h('div', { class: 'tb-group' }, [openFileBtn, openFolderBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group' }, [undoBtn, redoBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group tb-seg' }, [inspectBtn, drawBtn, editBtn, arrangeBtn]),
    h('div', { class: 'tb-group' }, [auditBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group' }, [recBtn, replayBtn, assertBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group' }, [deviceBtn, shotBtn, aiBtn, settingsBtn]),
  ]);

  function update(state) {
    const { mode, recording, currentUrl, canGoBack, canGoForward, hasRecording, replaying, bookmarked, loading, aiProvider, providerReady, profileName, undoCount, redoCount, recordingName, recordingSteps, device, auditing } = state;
    replayBtn.title = hasRecording
      ? `Replay “${recordingName}”${recordingSteps ? ' (' + recordingSteps + ' steps)' : ''}`
      : 'Record a journey first — then this replays it';
    // Undo/redo cover every edit made to the page — rearrange, style, copy.
    undoBtn.disabled = !undoCount;
    redoBtn.disabled = !redoCount;
    undoBtn.title = undoCount ? `Undo ${undoCount} page edit${undoCount === 1 ? '' : 's'} (${MOD}⇧Z)` : 'Nothing to undo';
    redoBtn.title = redoCount ? `Redo ${redoCount} undone edit${redoCount === 1 ? '' : 's'} (${MOD}⇧Y)` : 'Nothing to redo';
    bookmarkBtn.textContent = bookmarked ? '★' : '☆';
    bookmarkBtn.classList.toggle('on', !!bookmarked);
    inspectBtn.classList.toggle('active', mode === 'inspect');
    editBtn.classList.toggle('active', mode === 'edit');
    drawBtn.classList.toggle('active', mode === 'draw');
    arrangeBtn.classList.toggle('active', mode === 'arrange');
    assertBtn.classList.toggle('active', mode === 'assert');
    assertBtn.classList.toggle('hot', mode === 'assert' && !!recording);
    recBtn.classList.toggle('active', !!recording);
    recBtn.querySelector('span').textContent = recording ? 'Stop' : 'Record';
    recBtn.querySelector('svg').outerHTML = icon(recording ? 'stop' : 'record', 16);
    // Reload becomes Stop while the active tab is loading.
    reloadBtn.querySelector('svg').outerHTML = icon(loading ? 'stop' : 'reload', 16);
    reloadBtn.title = loading ? 'Stop' : 'Reload';
    backBtn.disabled = !canGoBack;
    fwdBtn.disabled = !canGoForward;
    replayBtn.disabled = !hasRecording || replaying || !!recording;
    recBtn.disabled = replaying;
    auditBtn.disabled = !!auditing;
    auditBtn.classList.toggle('active', !!auditing);
    if (device) {
      deviceBtn.querySelector('.dv-label').textContent = device.short || device.label || 'Fit';
      deviceBtn.classList.toggle('active', device.id !== 'fit');
      deviceBtn.title = device.id === 'fit' ? 'Device viewport — fit to window' : `Device viewport — ${device.label} (${device.w}×${device.h})`;
      deviceBtn.setAttribute('aria-label', deviceBtn.title);
    }
    settingsBtn.classList.toggle('ready', !!providerReady);
    settingsBtn.classList.toggle('needs-setup', providerReady === false);
    settingsBtn.title = profileTooltip({ aiProvider, providerReady, profileName });
    settingsBtn.setAttribute('aria-label', settingsBtn.title);
    if (currentUrl != null) updateLock(currentUrl);
    if (document.activeElement !== addressInput && currentUrl != null) {
      addressInput.value = prettyUrl(currentUrl);
    }
  }

  function updateLock(url) {
    lock.classList.remove('insecure');
    if (/^https:/i.test(url)) { lock.textContent = '🔒'; lock.title = 'Secure (https)'; }
    else if (/^http:/i.test(url)) { lock.textContent = '⚠'; lock.title = 'Not secure (http)'; lock.classList.add('insecure'); }
    else { lock.innerHTML = icon('file', 14); lock.title = 'Local file'; }
  }

  function setAddress(url) {
    if (document.activeElement !== addressInput) addressInput.value = prettyUrl(url || '');
  }

  function focusAddress() { addressInput.focus(); addressInput.select(); }

  // Populate the address-bar autocomplete from history + bookmarks.
  function setSuggestions(items) {
    clear(suggestions);
    const seen = new Set();
    for (const it of items || []) {
      if (!it || !it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      const opt = document.createElement('option');
      opt.value = it.url;
      if (it.title) opt.label = it.title;
      suggestions.appendChild(opt);
      if (seen.size >= 40) break;
    }
  }

  return { root, update, setAddress, setSuggestions, focusAddress, deviceAnchor: () => deviceBtn };
}

function profileTooltip({ aiProvider, providerReady, profileName }) {
  const provider = aiProvider === 'openai' ? 'OpenAI' : 'Claude';
  const status = providerReady ? 'key set' : 'no key set';
  const name = profileName ? `${profileName} - ` : '';
  return `${name}Profile: ${provider} (${status})`;
}

// Show file:// paths and welcome page more cleanly in the address bar.
function prettyUrl(url) {
  if (!url) return '';
  if (url.startsWith('file://')) {
    try {
      const p = decodeURIComponent(new URL(url).pathname);
      if (/welcome\.html$/.test(p)) return '';
      return p;
    } catch (_e) {
      return url;
    }
  }
  return url;
}
