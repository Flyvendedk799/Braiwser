// Settings + onboarding modals: appearance, local profile, provider choice,
// per-provider model + API key management, replay delay, and the
// restore-annotations toggle.
import { h, modal, icon, toast } from '../lib/dom.js';

// Four ways to pay for a call. The two subscriptions are listed first because
// they need no key pasted anywhere: if `claude` or `codex` is signed in on this
// machine, the AI features already work.
const PROVIDERS = ['claude-code', 'anthropic', 'codex', 'openai'];
const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];
const PROVIDER_LABELS = {
  'claude-code': 'Claude subscription',
  anthropic: 'Anthropic API key',
  codex: 'ChatGPT subscription',
  openai: 'OpenAI API key',
};
const MODEL_PLACEHOLDERS = {
  'claude-code': 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  codex: 'gpt-5',
  openai: 'gpt-5',
};

const isSubscription = (p) => SUBSCRIPTION_PROVIDERS.includes(p);
// `providers` is the readiness map from the main process: per provider,
// { ready, via, hint, detail, plan }. Older shapes were a bare boolean.
const readiness = (providers, p) => (providers && providers[p]) || {};
const isReady = (providers, p) => !!readiness(providers, p).ready;

// A model field: a picker of known-good ids plus free text, so a model released
// after this build can still be typed in.
function modelField(provider, value, choices, onChange) {
  const known = (choices && choices[provider]) || [];
  const input = h('input', {
    class: 'input mono',
    type: 'text',
    value: value || '',
    placeholder: MODEL_PLACEHOLDERS[provider],
    list: `caos-models-${provider}`,
    'aria-label': `${PROVIDER_LABELS[provider] || provider} model id`,
  });
  const datalist = h('datalist', { id: `caos-models-${provider}` }, known.map((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.label = m.label;
    return opt;
  }));
  const picker = h('select', { class: 'select', 'aria-label': `Pick a ${PROVIDER_LABELS[provider] || provider} model` }, [
    h('option', { value: '', text: 'Choose a model…' }),
    ...known.map((m) => h('option', { value: m.id, text: m.label })),
  ]);
  picker.addEventListener('change', () => {
    if (!picker.value) return;
    input.value = picker.value;
    onChange(picker.value);
    picker.value = '';
  });
  input.addEventListener('change', () => onChange(input.value.trim()));
  return { root: h('div', { class: 'model-field' }, [picker, input, datalist]), input };
}

export function openSettingsModal({ settings, providers, actions }) {
  let provider = settings.aiProvider || 'claude-code';
  const profile = { ...(settings.profile || {}) };
  const models = { ...(settings.models || {}) };

  const body = h('div', {});

  // ---- Appearance ----
  const themes = (settings.availableThemes || []).length
    ? settings.availableThemes
    : [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'Match system' }];
  const themeGroup = h('div', { class: 'radio-group' });
  const themeCards = {};
  themes.forEach((t) => {
    const radio = h('input', { type: 'radio', name: 'theme', value: t.id, checked: (settings.theme || 'dark') === t.id });
    const card = h('label', { class: `radio-card ${(settings.theme || 'dark') === t.id ? 'sel' : ''}` }, [
      radio,
      h('span', { class: 'rc-name', text: t.label }),
    ]);
    radio.addEventListener('change', () => {
      Object.values(themeCards).forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      persist({ theme: t.id });
    });
    themeCards[t.id] = card;
    themeGroup.appendChild(card);
  });
  body.appendChild(field('Appearance', themeGroup, 'Applies to the whole app immediately. “Match system” follows your OS setting.'));

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
    const badge = h('span', { class: `rc-badge ${isReady(providers, p) ? 'ok' : 'no'}`, text: badgeText(providers, p) });
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

  body.appendChild(field('AI Provider', radioGroup, 'Who pays for an AI task. A subscription needs no key — if the `claude` or `codex` CLI is signed in on this machine, it is already usable.'));

  // Repaint every badge and status line from a fresh readiness map. Connecting a
  // subscription changes a row the user is not looking at, so re-rendering only
  // the row they touched would leave the others stale.
  const statusLines = {};
  function repaint(next) {
    if (next) Object.assign(providers, next);
    PROVIDERS.forEach((p) => {
      if (cards[p]) {
        cards[p].badge.className = `rc-badge ${isReady(providers, p) ? 'ok' : 'no'}`;
        cards[p].badge.textContent = badgeText(providers, p);
      }
      if (statusLines[p]) statusLines[p].textContent = readiness(providers, p).detail || '';
    });
  }

  // ---- Per-provider model + credential ----
  PROVIDERS.forEach((p) => {
    const model = modelField(p, models[p], settings.modelChoices, (v) => {
      models[p] = v;
      persist({ models: { ...models } });
    });

    const status = h('div', { class: 'field-hint', style: { margin: '6px 0 0' }, text: readiness(providers, p).detail || '' });
    statusLines[p] = status;

    const rows = [h('div', { style: { marginBottom: '8px' } }, [model.root])];
    rows.push(isSubscription(p)
      ? subscriptionRow(p, { providers, actions, repaint })
      : keyRow(p, { providers, actions, repaint }));
    rows.push(status);

    body.appendChild(field(`${providerLabel(p)} — model and credential`, h('div', {}, rows)));
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
  let provider = settings.aiProvider || 'claude-code';
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
    const badge = h('span', { class: `rc-badge ${isReady(providers, p) ? 'ok' : 'no'}`, text: badgeText(providers, p) });
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
  body.appendChild(field('Default AI provider', radioGroup, 'AI tasks use this first. A subscription already signed in on this machine needs nothing else; the API-key providers need a key below.'));

  PROVIDERS.forEach((p) => {
    const model = modelField(p, models[p], settings.modelChoices, (v) => { models[p] = v; });
    // A subscription has no key to collect. Offering an empty key box for one
    // would invite a paste that the save path is right to reject.
    if (isSubscription(p)) {
      body.appendChild(field(`${providerLabel(p)} setup`, h('div', { class: 'provider-setup-row' }, [
        model.root,
        h('div', { class: 'field-hint', style: { margin: '0' }, text: readiness(providers, p).detail || '' }),
      ])));
      return;
    }
    const keyInput = h('input', {
      class: 'input',
      type: 'password',
      placeholder: readiness(providers, p).hint ? `Saved (${readiness(providers, p).hint}) — enter a new one to replace` : `Paste ${providerLabel(p)}`,
    });
    keyInputs[p] = keyInput;
    body.appendChild(field(`${providerLabel(p)} setup`, h('div', { class: 'provider-setup-row' }, [
      model.root,
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
        if (!keyInputs[p]) continue; // a subscription — nothing was collected
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
      { label: 'Start using Braiwser', kind: 'primary', onClick: () => finish(false) },
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

// The badge has to distinguish four states, not two: a key that is saved here, a
// key inherited from the environment, a subscription that is signed in, and
// nothing at all. Showing "No key" over a working environment variable is what
// makes people paste a second key in.
function badgeText(providers, p) {
  const { ready, via } = readiness(providers, p);
  if (!ready) return isSubscription(p) ? 'Not signed in' : 'No key';
  if (via === 'environment') return 'From environment';
  if (via === 'cli') return 'CLI login';
  if (via === 'browser') return 'Signed in';
  return 'Key set';
}

// A metered provider: paste a key, or clear the stored one. The key is never read
// back — the placeholder shows the masked hint the main process supplies.
function keyRow(p, { providers, actions, repaint }) {
  const hint = readiness(providers, p).hint;
  const placeholder = () => (readiness(providers, p).hint ? `Saved (${readiness(providers, p).hint}) — enter a new one to replace` : 'Paste API key');
  const keyInput = h('input', { class: 'input', type: 'password', placeholder: hint ? `Saved (${hint}) — enter a new one to replace` : 'Paste API key' });

  const saveKeyBtn = h('button', { class: 'btn btn-sm', html: icon('save', 14) + '<span>Save key</span>', on: {
    click: async () => {
      const v = keyInput.value.trim();
      if (!v) { toast('Enter a key first', 'warn'); return; }
      try {
        repaint(await actions.setKey(p, v));
        keyInput.value = '';
        keyInput.placeholder = placeholder();
        toast(`${providerLabel(p)} saved`, 'success');
      } catch (err) { toast('Could not save that key: ' + errText(err), 'error', 5000); }
    },
  } });

  const clearKeyBtn = h('button', { class: 'btn btn-sm btn-danger', title: 'Clear stored key', html: icon('trash', 14), on: {
    click: async () => {
      try {
        repaint(await actions.clearKey(p));
        keyInput.value = '';
        keyInput.placeholder = placeholder();
        toast(`${providerLabel(p)} cleared`);
      } catch (err) { toast('Could not clear that key: ' + errText(err), 'error', 5000); }
    },
  } });

  return h('div', { class: 'input-row' }, [keyInput, saveKeyBtn, clearKeyBtn]);
}

// A subscription: nothing to paste. Codex is CLI-only, so it reports what it
// found and stops there. Claude can also be signed in from here, for a machine
// with no `claude` CLI on it — the browser shows a code to bring back.
function subscriptionRow(p, { providers, actions, repaint }) {
  if (p === 'codex') {
    return h('div', { class: 'input-row' }, [
      h('button', { class: 'btn btn-sm', text: 'Re-check', on: { click: async () => {
        repaint(await actions.refreshProviders());
        toast(isReady(providers, 'codex') ? 'Codex subscription found' : 'Still no Codex login found', isReady(providers, 'codex') ? 'success' : 'warn');
      } } }),
    ]);
  }

  const connectBtn = h('button', { class: 'btn btn-sm btn-primary', text: 'Sign in with Claude', on: { click: async () => {
    try {
      await actions.claudeLoginStart();
      openPasteCodeModal(actions, repaint);
    } catch (err) { toast('Could not start the sign-in: ' + errText(err), 'error', 5000); }
  } } });

  const recheckBtn = h('button', { class: 'btn btn-sm', text: 'Re-check', on: { click: async () => {
    repaint(await actions.refreshProviders());
  } } });

  const disconnectBtn = h('button', { class: 'btn btn-sm btn-danger', title: 'Forget the subscription signed in here', html: icon('trash', 14), on: {
    click: async () => {
      try {
        repaint(await actions.claudeDisconnect());
        toast('Signed out of the Claude subscription');
      } catch (err) { toast(errText(err), 'error', 5000); }
    },
  } });

  // A CLI login is not ours to revoke: it belongs to `claude`, and the honest
  // action there is to say so rather than offer a button that cannot work.
  const via = readiness(providers, p).via;
  return h('div', { class: 'input-row' }, via === 'cli' ? [recheckBtn] : [connectBtn, recheckBtn, disconnectBtn]);
}

// Step two of the sign-in: the authorize page shows a code rather than
// redirecting anywhere, so it has to be carried back by hand.
function openPasteCodeModal(actions, repaint) {
  const input = h('input', { class: 'input mono', type: 'text', placeholder: 'Paste the code from the browser' });
  const m = modal({
    title: 'Finish signing in',
    width: 460,
    body: h('div', {}, [
      h('div', { class: 'field-hint', style: { margin: '0 0 8px' }, text: 'Your browser is showing a sign-in code. Paste it here — the whole code, or the URL it is in.' }),
      input,
    ]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      // Returning true holds the modal open, so a bad or half-pasted code keeps
      // the field — and what the user pasted — in front of them to fix.
      { label: 'Connect', kind: 'primary', onClick: async () => {
        const v = input.value.trim();
        if (!v) { toast('Paste the code first', 'warn'); return true; }
        try {
          const result = await actions.claudeLoginFinish(v);
          repaint(result && result.status);
          toast(result && result.plan ? `Connected — ${result.plan} plan` : 'Claude subscription connected', 'success');
          return false;
        } catch (err) {
          toast(errText(err), 'error', 6000);
          return true;
        }
      } },
    ],
  });
  setTimeout(() => input.focus(), 50);
}

// IPC rejections arrive with Electron's channel prefix on the front; the sentence
// the main process wrote is the part worth showing.
function errText(err) {
  const raw = (err && err.message) || String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}
