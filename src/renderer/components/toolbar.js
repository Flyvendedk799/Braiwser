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
    placeholder: 'Search or enter address — URL, domain, /abs/path, or text',
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

  const backBtn = btn({ icon: 'back', title: 'Back', onClick: actions.back });
  const fwdBtn = btn({ icon: 'forward', title: 'Forward', onClick: actions.forward });
  const reloadBtn = btn({ icon: 'reload', title: 'Reload', onClick: actions.reload });

  const inspectBtn = btn({ icon: 'inspect', label: 'Inspect', title: 'Inspect element — capture a note and view its layout hierarchy (click an element)', onClick: () => actions.toggleMode('inspect') });
  const drawBtn = btn({ icon: 'draw', label: 'Draw', title: 'Drag on the page to circle an area, then add a note', onClick: () => actions.toggleMode('draw') });
  const arrangeBtn = btn({ icon: 'move', label: 'Rearrange', title: 'Rearrange the layout — click to select, drag to reorder, Alt-drag to free-move, handles to resize, plus smart re-layout. Every edit is captured as a note.', onClick: () => actions.toggleMode('arrange') });
  const assertBtn = btn({ icon: 'check', label: 'Assert', title: 'Add an assertion to the recording (click an element)', onClick: () => actions.toggleMode('assert') });

  const recBtn = btn({ icon: 'record', class: 'rec', label: 'Record', title: 'Record a user journey', onClick: actions.toggleRecord });
  const replayBtn = btn({ icon: 'replay', label: 'Replay', title: 'Replay the selected recording', onClick: actions.replay });

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
    h('div', { class: 'tb-group' }, [inspectBtn, drawBtn, arrangeBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group' }, [recBtn, replayBtn, assertBtn]),
    h('div', { class: 'tb-sep' }),
    h('div', { class: 'tb-group' }, [shotBtn, aiBtn, settingsBtn]),
  ]);

  function update(state) {
    const { mode, recording, currentUrl, canGoBack, canGoForward, hasRecording, replaying, bookmarked, loading, aiProvider, providerReady, profileName } = state;
    bookmarkBtn.textContent = bookmarked ? '★' : '☆';
    bookmarkBtn.classList.toggle('on', !!bookmarked);
    inspectBtn.classList.toggle('active', mode === 'inspect');
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

  return { root, update, setAddress, setSuggestions, focusAddress };
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
