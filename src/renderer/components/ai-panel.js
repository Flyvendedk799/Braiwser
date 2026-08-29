// AI tab: pick a task from config.aiTasks, Run it over the current session via
// caos.ai.run, show a spinner, then render the result with Copy / Save actions.
// On error (e.g. missing key) show a message with a link to Profile.
import { h, icon, clear, toast, esc } from '../lib/dom.js';

export function createAiPanel(config, actions) {
  const taskIds = Object.keys(config.aiTasks || {});
  let lastText = '';
  let profileSettings = {};
  let profileProviders = {};

  const select = h('select', { class: 'select' }, taskIds.map((id) =>
    h('option', { value: id, text: prettyTask(id) })
  ));
  const desc = h('div', { class: 'ai-task-desc', text: config.aiTasks[taskIds[0]] || '' });
  select.addEventListener('change', () => { desc.textContent = config.aiTasks[select.value] || ''; });

  const runBtn = h('button', { class: 'btn btn-primary btn-sm', html: icon('ai', 14) + '<span>Run</span>', on: { click: run } });
  const providerBtn = h('button', { class: 'provider-status', title: 'Open Profile', on: { click: actions.openSettings } });

  const resultWrap = h('div', { class: 'ai-result-wrap' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'ai' } }, [
    h('div', { class: 'ai-bar' }, [
      h('div', { class: 'ai-row' }, [select, runBtn]),
      h('div', { class: 'ai-profile-row' }, [providerBtn]),
      desc,
    ]),
    resultWrap,
  ]);

  function idle() {
    clear(resultWrap);
    resultWrap.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('ai', 30) }),
        h('div', { class: 'ph-title', text: 'AI assistant' }),
        h('div', { class: 'ph-sub', text: 'Pick a task and run it over this session’s notes — clean them up, cluster themes, or generate a coding-agent prompt.' }),
      ])
    );
  }

  function loading() {
    clear(resultWrap);
    resultWrap.appendChild(h('div', { class: 'ai-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'Thinking…' })]));
  }

  async function run() {
    const sessionId = actions.currentSessionId();
    if (!sessionId) {
      showError('No active session yet. Capture at least one note first, then run an AI task.', false);
      return;
    }
    runBtn.disabled = true;
    loading();
    try {
      const res = await actions.run(select.value, sessionId);
      if (!res || res.ok === false) {
        showError((res && res.error) || 'The AI request failed.', isKeyError(res && res.error));
      } else {
        showResult(res.text || '', { local: !!res.local });
      }
    } catch (e) {
      showError(String((e && e.message) || e), false);
    } finally {
      runBtn.disabled = false;
    }
  }

  function isKeyError(msg) {
    return /key|auth|credential|provider|401|unauthorized/i.test(String(msg || ''));
  }

  function showError(message, keyHint) {
    clear(resultWrap);
    const box = h('div', { class: 'ai-error' });
    box.innerHTML = renderInline(message);
    if (keyHint) {
      const link = h('a', { text: 'Open Profile →', on: { click: actions.openSettings } });
      box.appendChild(h('div', { style: { marginTop: '8px' } }, [link]));
    }
    resultWrap.appendChild(box);
  }

  function showResult(text, opts = {}) {
    lastText = text;
    clear(resultWrap);
    if (opts.local) {
      resultWrap.appendChild(localNotice());
    }
    const body = h('div', { class: 'ai-result' });
    body.innerHTML = renderMarkdownish(text);
    resultWrap.appendChild(body);
    resultWrap.appendChild(
      h('div', { class: 'ai-result-actions' }, [
        h('button', { class: 'btn btn-sm', html: icon('copy', 14) + '<span>Copy</span>', on: { click: copy } }),
        h('button', { class: 'btn btn-sm', html: icon('save', 14) + '<span>Save</span>', on: { click: save } }),
      ])
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lastText);
      toast('Copied to clipboard', 'success');
    } catch (_e) {
      toast('Copy failed', 'error');
    }
  }

  function save() {
    actions.save(select.value, lastText);
  }

  // Run a specific task programmatically (e.g. per-note Suggest-fix) with an
  // optional extra payload (annotations/context). Renders into this panel.
  async function runExternal(taskId, extra) {
    if (taskIds.includes(taskId)) { select.value = taskId; desc.textContent = config.aiTasks[taskId] || ''; }
    runBtn.disabled = true;
    loading();
    try {
      const res = await actions.run(taskId, actions.currentSessionId(), extra || {});
      if (!res || res.ok === false) showError((res && res.error) || 'The AI request failed.', isKeyError(res && res.error));
      else showResult(res.text || '', { local: !!res.local });
    } catch (e) {
      showError(String((e && e.message) || e), false);
    } finally {
      runBtn.disabled = false;
    }
  }

  idle();
  setProfile(profileSettings, profileProviders);
  return {
    root,
    runExternal,
    setProfile,
    focusTask: (id) => { if (id && taskIds.includes(id)) { select.value = id; desc.textContent = config.aiTasks[id] || ''; } },
  };

  function setProfile(settings = {}, providers = {}) {
    profileSettings = settings || {};
    profileProviders = providers || {};
    const provider = profileSettings.aiProvider || 'claude-code';
    const ready = !!(profileProviders[provider] && profileProviders[provider].ready);
    providerBtn.className = `provider-status ${ready ? 'ready' : 'needs-setup'}`;
    providerBtn.innerHTML = `${icon(ready ? 'check' : 'settings', 13)}<span>${providerLabel(provider)}</span><span class="provider-status-dot">${readyWord(provider, ready)}</span>`;
    providerBtn.title = `${providerLabel(provider)} — ${readyWord(provider, ready)} · open Profile`;
    providerBtn.setAttribute('aria-label', providerBtn.title);
  }

  function localNotice() {
    const link = h('a', { text: 'Open Profile', on: { click: actions.openSettings } });
    return h('div', { class: 'ai-local-notice' }, [
      h('span', { text: `${providerLabel(profileSettings.aiProvider || 'claude-code')} is not connected, so this result was generated locally.` }),
      link,
    ]);
  }
}

function prettyTask(id) {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const PROVIDER_LABELS = {
  'claude-code': 'Claude subscription',
  anthropic: 'Anthropic API key',
  codex: 'ChatGPT subscription',
  openai: 'OpenAI API key',
};

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider || 'Claude';
}

// A subscription is "signed in"; a metered provider has a "key". Saying "no key"
// beside a subscription sends people looking for a field that is not there.
function readyWord(provider, ready) {
  const subscription = provider === 'claude-code' || provider === 'codex';
  if (subscription) return ready ? 'Signed in' : 'Not signed in';
  return ready ? 'Key set' : 'No key';
}

// Escape, then apply a light markdown subset: headings, bold, inline code, and
// fenced code blocks. Good enough for displaying AI output cleanly.
function renderMarkdownish(text) {
  let s = esc(text);
  // fenced code blocks
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  // headings
  s = s.replace(/^###?#?\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // bold + inline code
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderInline(text) {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}
