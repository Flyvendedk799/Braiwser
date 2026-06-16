// Settings modal: provider choice, per-provider model + API key management,
// replay delay, and restore-annotations toggle. Reads current settings/secret
// presence and persists via the controller's `actions` bag.
import { h, modal, icon, toast } from '../lib/dom.js';

export function openSettingsModal({ settings, providers, actions }) {
  let provider = settings.aiProvider || 'claude';

  const body = h('div', {});

  // ---- Provider radio cards ----
  const radioGroup = h('div', { class: 'radio-group' });
  const cards = {};
  ['claude', 'openai'].forEach((p) => {
    const radio = h('input', { type: 'radio', name: 'provider', value: p, checked: provider === p });
    const badge = h('span', { class: `rc-badge ${providers[p] ? 'ok' : 'no'}`, text: providers[p] ? 'Key set' : 'No key' });
    const card = h('label', { class: `radio-card ${provider === p ? 'sel' : ''}` }, [
      radio,
      h('span', { class: 'rc-name', text: p === 'claude' ? 'Claude' : 'OpenAI' }),
      badge,
    ]);
    radio.addEventListener('change', () => {
      provider = p;
      Object.values(cards).forEach((c) => c.card.classList.remove('sel'));
      card.classList.add('sel');
      persist({ aiProvider: provider });
    });
    cards[p] = { card, badge };
    radioGroup.appendChild(card);
  });

  body.appendChild(field('AI Provider', radioGroup, 'Which model answers AI tasks. Each provider needs its own API key below.'));

  // ---- Per-provider model + key ----
  const models = { ...(settings.models || {}) };
  ['claude', 'openai'].forEach((p) => {
    const modelInput = h('input', { class: 'input mono', type: 'text', value: models[p] || '', placeholder: p === 'claude' ? 'claude-sonnet-4-6' : 'gpt-4o' });
    modelInput.addEventListener('change', () => {
      models[p] = modelInput.value.trim();
      persist({ models: { ...models } });
    });

    const keyInput = h('input', { class: 'input', type: 'password', placeholder: providers[p] ? '•••••••• (stored — enter to replace)' : 'Paste API key' });
    const saveKeyBtn = h('button', { class: 'btn btn-sm', html: icon('save', 14) + '<span>Save key</span>', on: {
      click: async () => {
        const v = keyInput.value.trim();
        if (!v) { toast('Enter a key first', 'warn'); return; }
        await actions.setKey(p, v);
        providers[p] = true;
        keyInput.value = '';
        keyInput.placeholder = '•••••••• (stored — enter to replace)';
        cards[p].badge.className = 'rc-badge ok';
        cards[p].badge.textContent = 'Key set';
        toast(`${p === 'claude' ? 'Claude' : 'OpenAI'} key saved`, 'success');
      },
    } });
    const clearKeyBtn = h('button', { class: 'btn btn-sm btn-danger', title: 'Clear stored key', html: icon('trash', 14), on: {
      click: async () => {
        await actions.clearKey(p);
        providers[p] = false;
        keyInput.value = '';
        keyInput.placeholder = 'Paste API key';
        cards[p].badge.className = 'rc-badge no';
        cards[p].badge.textContent = 'No key';
        toast(`${p === 'claude' ? 'Claude' : 'OpenAI'} key cleared`);
      },
    } });

    const group = h('div', {}, [
      h('div', { style: { marginBottom: '8px' } }, [modelInput]),
      h('div', { class: 'input-row' }, [keyInput, saveKeyBtn, clearKeyBtn]),
    ]);
    body.appendChild(field(`${p === 'claude' ? 'Claude' : 'OpenAI'} — model & key`, group));
  });

  // ---- Replay delay ----
  const delayInput = h('input', { class: 'input', type: 'number', min: '0', step: '50', value: String(settings.replayDelayMs ?? 600) });
  delayInput.addEventListener('change', () => {
    const v = Math.max(0, parseInt(delayInput.value, 10) || 0);
    delayInput.value = String(v);
    persist({ replayDelayMs: v });
  });
  body.appendChild(field('Replay delay (ms)', delayInput, 'Pause between steps when replaying a recorded journey.'));

  // ---- Agent hand-off command ----
  const agentInput = h('input', { class: 'input mono', type: 'text', value: settings.agentCommand || '', placeholder: 'e.g. claude -p "Apply the changes in {promptPath}"' });
  agentInput.addEventListener('change', () => persist({ agentCommand: agentInput.value.trim() }));
  body.appendChild(field('Agent command (hand-off)', agentInput, 'Optional. Runs in the project folder when you hand off a session. Placeholders: {promptPath}, {projectPath}. Leave empty to only write the request file.'));

  // ---- Restore annotations toggle ----
  const toggle = h('input', { type: 'checkbox', checked: settings.restoreAnnotationsOnLoad !== false });
  toggle.addEventListener('change', () => persist({ restoreAnnotationsOnLoad: toggle.checked }));
  const toggleRow = h('div', { class: 'toggle-row' }, [
    h('div', {}, [
      h('div', { style: { fontWeight: '600', marginBottom: '3px' }, text: 'Restore annotations on load' }),
      h('div', { class: 'field-hint', style: { margin: '0' }, text: 'Re-draw numbered pins when revisiting a page in the active session.' }),
    ]),
    h('label', { class: 'switch' }, [toggle, h('span', { class: 'track' })]),
  ]);
  body.appendChild(h('div', { class: 'field' }, [toggleRow]));

  async function persist(patch) {
    const next = await actions.setSettings(patch);
    if (next) Object.assign(settings, next);
  }

  modal({ title: 'Settings', width: 520, body });
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field-label', text: label }),
    control,
    hint ? h('div', { class: 'field-hint', text: hint }) : null,
  ]);
}
