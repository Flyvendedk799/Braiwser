// Feature-flag toggle for the agent runtime, injected into the existing Settings
// modal WITHOUT editing it: a MutationObserver notices the settings dialog open
// and appends one "Agent runtime" section. Everything else about the feature
// stays hidden while the flag is off — this toggle is the only way in.
//
// The toggle does not claim success it cannot see: after writing the setting it
// reads it back, and if the store did not keep it the switch reverts and says so.
// Flag changes take effect after a restart (the broker is created at launch).
import { h } from '../lib/dom.js';

const SECTION_TESTID = 'agent-settings-section';

export function buildAgentSettingsSection({ readSetting, writeSetting, getStatus }) {
  const hint = h('div', { class: 'field-hint', id: 'agent-flag-hint' });
  const result = h('div', { class: 'field-hint agent-flag-result', role: 'status', 'aria-live': 'polite', 'data-testid': 'agent-flag-result' });
  const input = h('input', {
    type: 'checkbox', role: 'switch', id: 'agent-flag-input', 'aria-describedby': 'agent-flag-hint', 'data-testid': 'agent-flag-toggle',
  });
  const track = h('span', { class: 'track', 'aria-hidden': 'true' });
  const sw = h('label', { class: 'switch', title: 'Enable the agent runtime' }, [input, track]);
  const label = h('label', { class: 'field-label', for: 'agent-flag-input', text: 'Enable agent runtime (experimental)' });

  const section = h('section', { class: 'settings-section', 'data-testid': SECTION_TESTID }, [
    h('h3', { class: 'settings-h', text: 'Agent runtime' }),
    h('div', { class: 'toggle-row' }, [h('div', {}, [label, hint]), sw]),
    result,
  ]);

  async function load() {
    let enabled = false;
    let source = 'setting';
    try {
      const st = await getStatus();
      if (st && typeof st === 'object') { enabled = st.enabled === true; source = st.source || 'setting'; }
    } catch (_e) { /* status unavailable: fall through to the stored setting */ }
    let stored = false;
    try { stored = (await readSetting()) === true; } catch (_e) { /* ignore */ }
    input.checked = source === 'env' ? true : stored;
    input.disabled = source === 'env';
    hint.textContent = source === 'env'
      ? 'Turned on by the BRAIWSER_AGENT_RUNTIME environment variable. Unset it to control this here.'
      : 'Lets connected agents and skills use Braiwser to run browser tasks. Off by default. Enabling it grants no client any access: each client still needs its own scope. Takes effect after you restart Braiwser.';
    if (enabled !== stored && source !== 'env') {
      result.textContent = stored ? 'Saved. Restart Braiwser to turn the runtime on.' : 'Saved. Restart Braiwser to turn the runtime off.';
    }
  }

  input.addEventListener('change', async () => {
    const want = input.checked;
    input.disabled = true;
    result.textContent = 'Saving…';
    let kept = null;
    try {
      kept = await writeSetting(want);
    } catch (_e) { kept = null; }
    input.disabled = false;
    if (kept === want) {
      result.textContent = want ? 'Saved. Restart Braiwser to turn the runtime on.' : 'Saved. Restart Braiwser to turn the runtime off.';
    } else {
      // The store did not keep it: show the truth.
      input.checked = kept === true;
      result.textContent = 'Could not save this setting, so it is unchanged.';
    }
  });

  return { section, load, input, result };
}

// Watches for the Settings dialog and adds the section once per dialog.
export function installAgentSettingsSection({ readSetting, writeSetting, getStatus, doc = document }) {
  const attach = (backdrop) => {
    if (!backdrop || !backdrop.querySelector) return;
    const title = backdrop.querySelector('.modal-title');
    if (!title || title.textContent !== 'Profile and Settings') return;
    if (backdrop.querySelector(`[data-testid="${SECTION_TESTID}"]`)) return;
    const host = backdrop.querySelector('.modal-body > div') || backdrop.querySelector('.modal-body');
    if (!host) return;
    const built = buildAgentSettingsSection({ readSetting, writeSetting, getStatus });
    host.appendChild(built.section);
    built.load();
  };
  const scan = () => doc.querySelectorAll('.modal-backdrop').forEach(attach);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType === 1 && (n.matches('.modal-backdrop') || n.querySelector('.modal-backdrop'))) {
          if (n.matches('.modal-backdrop')) attach(n); else n.querySelectorAll('.modal-backdrop').forEach(attach);
        }
      });
    }
  });
  mo.observe(doc.body, { childList: true });
  scan();
  return { disconnect: () => mo.disconnect(), scan };
}
