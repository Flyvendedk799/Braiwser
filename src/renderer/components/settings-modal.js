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
  const general = h('section', { class: 'settings-section' }, [h('h3', { class: 'settings-h', text: 'General' })]);
  const agentSec = h('section', { class: 'settings-section' }, [h('h3', { class: 'settings-h', text: 'Agent' })]);
  const privacy = h('section', { class: 'settings-section' }, [h('h3', { class: 'settings-h', text: 'Privacy' })]);
  const advanced = h('section', { class: 'settings-section' }, [h('h3', { class: 'settings-h', text: 'Advanced' })]);

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
  general.appendChild(field('Appearance', themeGroup, 'Applies to the whole app immediately. “Match system” follows your OS setting.'));

  general.appendChild(
    h('div', { class: 'profile-callout' }, [
      h('div', {}, [
        h('div', { class: 'profile-kicker', text: 'Local profile' }),
        h('div', { class: 'profile-title', text: profile.displayName || 'You' }),
        h('div', { class: 'profile-sub', text: 'Provider choices and API keys stay on this machine.' }),
      ]),
      h('span', { class: 'profile-provider-pill', text: providerLabel(provider) }),
    ])
  );
  const profileTitle = general.querySelector('.profile-title');

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
  general.appendChild(field('Profile name', nameInput, 'Optional, used only to label this local workspace.'));

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
      general.querySelector('.profile-provider-pill').textContent = providerLabel(provider);
      persist({ aiProvider: provider });
    });
    cards[p] = { card, badge };
    radioGroup.appendChild(card);
  });

  agentSec.appendChild(field('AI Provider', radioGroup, 'Who pays for an AI task. A subscription needs no key — if the `claude` or `codex` CLI is signed in on this machine, it is already usable.'));

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

    agentSec.appendChild(field(`${providerLabel(p)} — model and credential`, h('div', {}, rows)));
  });

  // ---- Replay delay ----
  const delayInput = h('input', { class: 'input', type: 'number', min: '0', step: '50', value: String(settings.replayDelayMs ?? 600) });
  delayInput.addEventListener('change', () => {
    const v = Math.max(0, parseInt(delayInput.value, 10) || 0);
    delayInput.value = String(v);
    persist({ replayDelayMs: v });
  });
  advanced.appendChild(field('Replay delay (ms)', delayInput, 'Minimum pause between steps. Replay also honours the real gaps from recording (capped), so journeys stay watchable. Video export uses a higher floor automatically.'));

  const timeoutInput = h('input', { class: 'input', type: 'number', min: '5', step: '5', value: String(Math.round((settings.aiTimeoutMs || 120000) / 1000)) });
  timeoutInput.addEventListener('change', () => {
    const secs = Math.max(5, parseInt(timeoutInput.value, 10) || 120);
    timeoutInput.value = String(secs);
    persist({ aiTimeoutMs: secs * 1000 });
  });
  advanced.appendChild(field('AI timeout (seconds)', timeoutInput, 'Abort a provider call after this many seconds.'));

  const personas = settings.personas || [
    { id: 'agent', label: 'Agent builder' },
    { id: 'reviewer', label: 'Design / QA' },
    { id: 'agency', label: 'Agency / freelance' },
  ];
  const personaSelect = h('select', { class: 'select', 'aria-label': 'Persona' }, personas.map((p) =>
    h('option', { value: p.id, text: p.label, ...(p.id === (settings.persona || 'agent') ? { selected: 'selected' } : {}) })
  ));
  personaSelect.value = settings.persona || 'agent';
  personaSelect.addEventListener('change', () => persist({ persona: personaSelect.value }));
  general.appendChild(field('Workflow persona', personaSelect, 'Tunes empty states and tips. Features stay the same.'));

  const agencyName = h('input', { class: 'input', type: 'text', value: (settings.agency && settings.agency.name) || '', placeholder: 'Studio or agency name' });
  agencyName.addEventListener('change', () => persist({ agency: { ...(settings.agency || {}), name: agencyName.value.trim() } }));
  general.appendChild(field('Agency / studio name', agencyName, 'Used on client packs and HTML reports.'));

  const licenseInput = h('input', { class: 'input mono', type: 'text', value: settings.licenseKey || '', placeholder: 'BRW1.… Pro license key' });
  const licenseStatus = h('div', { class: 'field-hint', text: 'Free tier active until a Pro key is activated.' });
  if (actions.licenseStatus) {
    actions.licenseStatus().then((st) => {
      if (st && st.pro) licenseStatus.textContent = `Pro active (${st.tier})`;
    }).catch(() => {});
  }
  const licenseRow = h('div', { class: 'provider-setup-row' }, [
    licenseInput,
    h('button', {
      class: 'btn btn-sm',
      text: 'Activate',
      on: {
        click: async () => {
          if (!actions.activateLicense) return;
          const res = await actions.activateLicense(licenseInput.value.trim());
          if (res && res.ok) {
            toast('Pro license activated', 'success');
            licenseStatus.textContent = `Pro active (${res.tier})`;
            persist({ licenseKey: licenseInput.value.trim() });
          } else toast((res && res.error) || 'Invalid license', 'error');
        },
      },
    }),
  ]);
  advanced.appendChild(field('Pro license', licenseRow, null));
  advanced.appendChild(licenseStatus);

  const analyticsToggle = h('input', { type: 'checkbox', checked: !!settings.analyticsOptIn });
  analyticsToggle.addEventListener('change', () => persist({ analyticsOptIn: analyticsToggle.checked }));
  privacy.appendChild(switchField('Anonymous product analytics', 'Opt-in only. Events stay local unless you later enable a sync endpoint.', analyticsToggle));

  const crashToggle = h('input', { type: 'checkbox', checked: !!settings.crashReportsOptIn });
  crashToggle.addEventListener('change', () => persist({ crashReportsOptIn: crashToggle.checked }));
  privacy.appendChild(switchField('Crash breadcrumbs', 'Opt-in. Stores local crash notes to include in diagnostics you choose to share.', crashToggle));

  const syncEmail = h('input', { class: 'input', type: 'email', value: (settings.sync && settings.sync.accountEmail) || '', placeholder: 'you@company.com' });
  const syncRow = h('div', { class: 'provider-setup-row' }, [
    syncEmail,
    h('button', {
      class: 'btn btn-sm',
      text: 'Sign in',
      on: {
        click: async () => {
          if (!actions.syncSignIn) return;
          const res = await actions.syncSignIn(syncEmail.value.trim());
          toast(res && res.ok ? 'Sync account saved' : (res && res.error) || 'Sign-in failed', res && res.ok ? 'success' : 'error');
        },
      },
    }),
    h('button', {
      class: 'btn btn-sm btn-ghost',
      text: 'Sign out',
      on: {
        click: async () => {
          if (actions.syncSignOut) await actions.syncSignOut();
          syncEmail.value = '';
          toast('Signed out of sync', 'info');
        },
      },
    }),
  ]);
  advanced.appendChild(field('Optional cloud sync (experimental)', syncRow, 'Local-first. Sign-in queues encrypted snapshots — there is no hosted sync endpoint yet.'));

  // ---- Agent hand-off command ----
  const agentInput = h('input', { class: 'input mono', type: 'text', value: settings.agentCommand || '', placeholder: 'e.g. claude -p "Apply the changes in {promptPath}"' });
  agentInput.addEventListener('change', () => persist({ agentCommand: agentInput.value.trim() }));
  const presetRow = h('div', { class: 'preset-row' });
  const presets = actions.agentPresets || [];
  presets.filter((p) => p.id !== 'cat').forEach((p) => {
    presetRow.appendChild(h('button', {
      class: `btn btn-sm ${p.available ? '' : 'btn-ghost'}`,
      text: p.available ? p.label : p.label,
      title: p.command + (p.available ? '' : ' (not found on PATH)'),
      on: {
        click: async () => {
          agentInput.value = p.command;
          await persist({ agentCommand: p.command });
          toast('Agent command set to ' + p.label, 'success');
        },
      },
    }));
  });
  agentSec.appendChild(field('Agent command (hand-off)', h('div', {}, [presetRow, agentInput]), 'Optional. Runs in the project folder when you hand off a session. Placeholders: {promptPath}, {projectPath}. Leave empty to only write the request file. Presets fill the command if that CLI is on your PATH.'));

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
  privacy.appendChild(h('div', { class: 'field' }, [toggleRow]));

  body.appendChild(general);
  body.appendChild(agentSec);
  body.appendChild(privacy);
  body.appendChild(advanced);

  async function persist(patch) {
    const next = await actions.setSettings(patch);
    if (next) Object.assign(settings, next);
  }

  modal({ title: 'Profile and Settings', width: 560, body, actions: [{ label: 'Done', kind: 'primary' }] });
}

export function openOnboardingModal({ settings, actions, onComplete }) {
  const profile = { ...(settings.profile || {}) };

  const body = h('div', { class: 'onboarding-body' }, [
    h('div', { class: 'onboarding-hero' }, [
      h('div', { class: 'onboarding-mark', html: icon('ai', 24) }),
      h('div', {}, [
        h('div', { class: 'onboarding-title', text: 'Welcome to Braiwser' }),
        h('div', { class: 'onboarding-copy', text: 'Pick how you work. AI keys are optional — local synthesis and a signed-in CLI already work. Next: a sample page with real issues to capture.' }),
      ]),
    ]),
  ]);

  let persona = settings.persona || 'agent';
  const personas = (settings.personas || [
    { id: 'agent', label: 'Agent builder', tip: 'Inspect → hand off to your coding agent.' },
    { id: 'reviewer', label: 'Design / QA', tip: 'Audit, breakpoints, export Markdown.' },
    { id: 'agency', label: 'Agency / freelance', tip: 'Client packs, PDF, journey video.' },
  ]);
  const personaTip = h('div', { class: 'field-hint', text: (personas.find((p) => p.id === persona) || {}).tip || '' });
  const personaGroup = h('div', { class: 'radio-group' });
  const personaCards = {};
  personas.forEach((p) => {
    const radio = h('input', { type: 'radio', name: 'onboarding-persona', value: p.id, checked: persona === p.id });
    const card = h('label', { class: `radio-card ${persona === p.id ? 'sel' : ''}` }, [
      radio,
      h('span', { class: 'rc-name', text: p.label }),
    ]);
    radio.addEventListener('change', () => {
      persona = p.id;
      Object.values(personaCards).forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      personaTip.textContent = p.tip || '';
    });
    personaCards[p.id] = card;
    personaGroup.appendChild(card);
  });
  body.appendChild(field('How will you use Braiwser?', personaGroup, null));
  body.appendChild(personaTip);

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: profile.displayName || '',
    placeholder: 'Your name',
  });
  body.appendChild(field('Profile name', nameInput, 'Optional. This app keeps one local profile on this device.'));

  async function finish(skipped) {
    profile.displayName = nameInput.value.trim();
    await actions.setSettings({
      profile: { ...profile },
      persona,
      onboardingComplete: true,
    });
    if (skipped) toast('Open the sample page from Help whenever you want a tour', 'info');
    else toast('Let’s capture one issue', 'success');
    if (onComplete) onComplete({ persona, skipped: !!skipped });
  }

  modal({
    title: 'Welcome',
    width: 560,
    body,
    actions: [
      { label: 'Skip', kind: 'ghost', onClick: () => finish(true) },
      { label: 'Open sample page', kind: 'primary', onClick: () => finish(false) },
    ],
  });
  const skipBtn = Array.from(document.querySelectorAll('.modal-footer button')).find((b) => b.textContent === 'Skip');
  const sampleBtn = Array.from(document.querySelectorAll('.modal-footer button')).find((b) => b.textContent === 'Open sample page');
  if (skipBtn) skipBtn.setAttribute('data-testid', 'onboarding-skip');
  if (sampleBtn) sampleBtn.setAttribute('data-testid', 'onboarding-sample');
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field-label', text: label }),
    control,
    hint ? h('div', { class: 'field-hint', text: hint }) : null,
  ]);
}

function switchField(label, hint, input) {
  return h('div', { class: 'field' }, [
    h('div', { class: 'toggle-row' }, [
      h('div', {}, [
        h('div', { style: { fontWeight: '600', marginBottom: '3px' }, text: label }),
        hint ? h('div', { class: 'field-hint', style: { margin: '0' }, text: hint }) : null,
      ]),
      h('label', { class: 'switch' }, [input, h('span', { class: 'track' })]),
    ]),
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
