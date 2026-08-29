// Browser tab strip above the webview stage. Renders one chip per open tab plus
// a "+" to open a new one. All actions delegate to the controller.
import { h, icon, clear } from '../lib/dom.js';

export function createTabStrip(actions) {
  const list = h('div', { class: 'tabstrip-list' });
  const newBtn = h('button', { class: 'tabstrip-new', title: 'New tab', 'aria-label': 'New tab', html: icon('plus', 14), on: { click: () => actions.newTab() } });
  list.setAttribute('role', 'tablist');
  const root = h('div', { class: 'tabstrip' }, [list, newBtn]);

  function update(tabs, activeId) {
    clear(list);
    for (const t of tabs) {
      const title = t.title || prettyTitle(t.url) || 'New tab';
      const isActive = t.id === activeId;
      const chip = h('div', {
        class: `tab-chip ${isActive ? 'active' : ''}`,
        title: t.url || '',
        role: 'tab',
        'aria-selected': isActive ? 'true' : 'false',
        // Roving tabindex: only the active chip is a tab stop; arrow keys move
        // between chips the way a real tab strip behaves.
        tabindex: isActive ? '0' : '-1',
        on: {
          click: () => actions.selectTab(t.id),
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.selectTab(t.id); return; }
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const i = tabs.findIndex((x) => x.id === t.id);
              const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              if (next) actions.selectTab(next.id);
            }
          },
        },
      }, [
        t.loading ? h('span', { class: 'tc-spin' }) : null,
        h('span', { class: 'tc-title', text: title }),
        h('button', {
          class: 'tc-close', title: 'Close tab', 'aria-label': 'Close tab', text: '×',
          on: { click: (e) => { e.stopPropagation(); actions.closeTab(t.id); } },
        }),
      ]);
      list.appendChild(chip);
    }
  }

  return { root, update };
}

function prettyTitle(url) {
  if (!url) return '';
  if (/welcome\.html$/.test(url)) return 'Braiwser';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop()) || 'file';
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch (_e) {
    return url;
  }
}
