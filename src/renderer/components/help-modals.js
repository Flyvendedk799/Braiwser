// Help dialogs: the keyboard shortcut sheet and About. Both are read-only views
// of the app config (shortcut groups, platform, version) handed in by the shell.
import { h, modal, icon } from '../lib/dom.js';

export function keyLabel(combo, config) {
  const mac = (config && config.platform) === 'darwin';
  return String(combo)
    .replace(/Mod/g, mac ? '\u2318' : 'Ctrl')
    .replace(/Alt/g, mac ? '\u2325' : 'Alt')
    .replace(/Shift/g, mac ? '\u21e7' : 'Shift')
    .split('+')
    .map((s2) => s2.trim())
    .filter(Boolean);
}

export function showShortcuts(config) {
  const body = h('div', {});
  for (const group of (config && config.shortcuts) || []) {
    const rows = group.items.map(([label, combo]) =>
      h('div', { class: 'shortcut-row' }, [
        h('span', { text: label }),
        h('span', { class: 'shortcut-keys' }, keyLabel(combo, config).map((k) => h('kbd', { text: k }))),
      ])
    );
    body.appendChild(h('div', { class: 'shortcut-group' }, [h('h4', { text: group.group }), ...rows]));
  }
  modal({ title: 'Keyboard shortcuts', width: 520, body, actions: [{ label: 'Close', kind: 'primary' }] });
}

export function showAbout(config) {
  const version = (config && config.appVersion) || '';
  const body = h('div', {}, [
    h('div', { class: 'about-hero' }, [
      h('div', { class: 'about-mark', html: icon('inspect', 24) }),
      h('div', {}, [
        h('div', { class: 'about-name', text: 'Braiwser' }),
        h('div', { class: 'about-version', text: 'v' + version }),
      ]),
    ]),
    h('p', { class: 'about-copy', text: 'An annotation-first inspector browser for reviewing web UIs and handing precise change requests to a coding agent. Open any project or URL, click elements to capture them, audit accessibility, record journeys as tests, and export the whole review as Markdown, an agent prompt, or a Playwright spec.' }),
    h('p', { class: 'about-copy', text: 'Everything — projects, notes, journeys, API keys — stays on this machine. Nothing is uploaded unless you run an AI task with your own key.' }),
  ]);
  modal({ title: 'About', width: 480, body, actions: [{ label: 'Close', kind: 'primary' }] });
}
