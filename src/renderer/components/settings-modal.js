// Settings + onboarding modals: local profile, provider choice, per-provider
// model + API key management, replay delay, and restore-annotations toggle.
import { h, modal, icon, toast } from '../lib/dom.js';

const PROVIDERS = ['claude', 'openai'];
const PROVIDER_LABELS = {
  claude: 'Claude',
  openai: 'OpenAI',
};
const MODEL_PLACEHOLDERS = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
};

export function openSettingsModal({ settings, providers, actions }) {
  let provider = settings.aiProvider || 'claude';
  const profile = { ...(settings.profile || {}) };
  const models = { ...(settings.models || {}) };

  const body = h('div', {});
  body.appendChild(
    h('div', { class: 'profile-callout' }, [
      h('div', {}, [
        h('div', { class: 'profile-kicker', text: 'Local profile' }),
        h('div', { class: 'profile-title', text: profile.displayName || 'You' }),
        h('div', { class: 'profile-sub', text: 'Provider choices and API keys stay on this machine.' }),
      ]),
      h('span', { class: 'profile-provider-pill', text: providerLabel(provider) }),
    ])
  );
  const profileTitle = body.querySelector('.profile-title');

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: profile.displayName || '',
    placeholder: 'Your name',
  });
  nameInput.addEventListener('change', () => {
    profile.displayName = nameInput.value.trim();
    profileTitle.textContent = profile.displayName || 'You';
    persist({ profile: { ...profile } });
  });
  body.appendChild(field('Profile name', nameInput, 'Optional, used only to label this local workspace.'));

  // ---- Provider radio cards ----
  const radioGroup = h('div', { class: 'radio-group' });
  const cards = {};
  PROVIDERS.forEach((p) => {
    const radio = h('input', { type: 'radio', name: 'provider', value: p, checked: provider === p });
    const badge = h('span', { class: `rc-badge ${providers[p] ? 'ok' : 'no'}`, text: providers[p] ? 'Key set' : 'No key' });
    const card = h('label', { class: `radio-card ${provider === p ? 'sel' : ''}` }, [
      radio,
      h('span', { class: 'rc-name', text: providerLabel(p) }),
      badge,
    ]);
    radio.addEventListener('change', () => {
      provider = p;
      Object.values(cards).forEach((c) => c.card.classList.remove('sel'));
      card.classList.add('sel');
      body.querySelector('.profile-provider-pill').textContent = providerLabel(provider);
      persist({ aiProvider: provider });
    });
    cards[p] = { card, badge };
    radioGroup.appendChild(card);
  });

  body.appendChild(field('AI Provider', radioGroup, 'Which model answers AI tasks. Each provider needs its own API key below.'));

  // ---- Per-provider model + key ----
  PROVIDERS.forEach((p) => {
    const modelInput = h('input', { class: 'input mono', type: 'text', value: models[p] || '', placeholder: MODEL_PLACEHOLDERS[p] });
    modelInput.addEventListener('change', () => {
      models[p] = modelInput.value.trim();
      persist({ models: { ...models } });
    });

    const keyInput = h('input', { class: 'input', type: 'password', placeholder: providers[p] ? 'Stored key - enter a new one to replace' : 'Paste API key' });
    const saveKeyBtn = h('button', { class: 'btn btn-sm', html: icon('save', 14) + '<span>Save key</span>', on: {
      click: async () => {
        const v = keyInput.value.trim();
        if (!v) { toast('Enter a key first', 'warn'); return; }
        await actions.setKey(p, v);
        providers[p] = true;
        keyInput.value = '';
        keyInput.placeholder = 'Stored key - enter a new one to replace';
        cards[p].badge.className = 'rc-badge ok';
        cards[p].badge.textContent = 'Key set';
        toast(`${providerLabel(p)} key saved`, 'success');
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
        toast(`${providerLabel(p)} key cleared`);
      },
    } });

    const group = h('div', {}, [
      h('div', { style: { marginBottom: '8px' } }, [modelInput]),
      h('div', { class: 'input-row' }, [keyInput, saveKeyBtn, clearKeyBtn]),
    ]);
    body.appendChild(field(`${providerLabel(p)} - model and API key`, group));
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

  modal({ title: 'Profile and Settings', width: 560, body, actions: [{ label: 'Done', kind: 'primary' }] });
}

export function openOnboardingModal({ settings, providers, actions }) {
  let provider = settings.aiProvider || 'claude';
  const profile = { ...(settings.profile || {}) };
  const models = { ...(settings.models || {}) };
  const keyInputs = {};
  const cards = {};

  const body = h('div', { class: 'onboarding-body' }, [
    h('div', { class: 'onboarding-hero' }, [
      h('div', { class: 'onboarding-mark', html: icon('ai', 24) }),
      h('div', {}, [
        h('div', { class: 'onboarding-title', text: 'Set up your AI profile' }),
        h('div', { class: 'onboarding-copy', text: 'Choose Claude or OpenAI now, add an API key if you have one, and switch providers later from Profile.' }),
      ]),
    ]),
  ]);

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: profile.displayName || '',
    placeholder: 'Your name',
  });
  body.appendChild(field('Profile name', nameInput, 'Optional. This app keeps one local profile on this device.'));

  const radioGroup = h('div', { class: 'radio-group' });
  PROVIDERS.forEach((p) => {
    const radio = h('input', { type: 'radio', name: 'onboarding-provider', value: p, checked: provider === p });
    const badge = h('span', { class: `rc-badge ${providers[p] ? 'ok' : 'no'}`, text: providers[p] ? 'Key set' : 'No key' });
    const card = h('label', { class: `radio-card ${provider === p ? 'sel' : ''}` }, [
      radio,
      h('span', { class: 'rc-name', text: providerLabel(p) }),
      badge,
    ]);
    radio.addEventListener('change', () => {
      provider = p;
      Object.values(cards).forEach((c) => c.card.classList.remove('sel'));
      card.classList.add('sel');
    });
    cards[p] = { card, badge };
    radioGroup.appendChild(card);
  });
  body.appendChild(field('Default AI provider', radioGroup, 'AI tasks will use this provider first. Both Claude and OpenAI can be configured.'));

  PROVIDERS.forEach((p) => {
    const modelInput = h('input', { class: 'input mono', type: 'text', value: models[p] || '', placeholder: MODEL_PLACEHOLDERS[p] });
    modelInput.addEventListener('input', () => { models[p] = modelInput.value.trim(); });
    const keyInput = h('input', {
      class: 'input',
      type: 'password',
      placeholder: providers[p] ? 'Stored key - enter a new one to replace' : `Paste ${providerLabel(p)} API key`,
    });
    keyInputs[p] = keyInput;
    body.appendChild(field(`${providerLabel(p)} setup`, h('div', { class: 'provider-setup-row' }, [
      modelInput,
      keyInput,
    ])));
  });

  async function finish(skipKeys) {
    profile.displayName = nameInput.value.trim();
    await actions.setSettings({
      profile: { ...profile },
      aiProvider: provider,
      models: { ...models },
      onboardingComplete: true,
    });
    if (!skipKeys) {
      for (const p of PROVIDERS) {
        const key = keyInputs[p].value.trim();
        if (key) await actions.setKey(p, key);
      }
    }
    toast(skipKeys ? 'Profile setup skipped' : 'Profile ready', skipKeys ? 'info' : 'success');
  }

  modal({
    title: 'Welcome',
    width: 600,
    body,
    actions: [
      { label: 'Skip for now', kind: 'ghost', onClick: () => finish(true) },
      { label: 'Start using Chrome AI OS', kind: 'primary', onClick: () => finish(false) },
    ],
  });
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field-label', text: label }),
    control,
    hint ? h('div', { class: 'field-hint', text: hint }) : null,
  ]);
}

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}
