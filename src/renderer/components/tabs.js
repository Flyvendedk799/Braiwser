// Browser tab strip above the webview stage. Renders one chip per open tab plus
// a "+" to open a new one. All actions delegate to the controller.
//
// Keyboard (RF-09): roving tabindex — only the active chip is a tab stop. Arrow
// keys / Home / End move between chips, Enter/Space activate, Delete closes. Those
// keys act ONLY when the chip itself has focus: a key pressed on the nested
// "Close tab" button belongs to that button (its native Enter/Space click), not
// to the chip. The strip re-renders on every update, so focus is put back on the
// chip (or its close button) that had it.
import { h, icon, clear } from '../lib/dom.js';

export function createTabStrip(actions) {
  const list = h('div', { class: 'tabstrip-list' });
  const newBtn = h('button', { class: 'tabstrip-new', title: 'New tab', 'aria-label': 'New tab', html: icon('plus', 14), on: { click: () => actions.newTab() } });
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Browser tabs');
  const root = h('div', { class: 'tabstrip' }, [list, newBtn]);

  function update(tabs, activeId) {
    // What had focus before the rebuild? (`which` is 'chip' or 'close'.)
    const active = document.activeElement;
    let refocus = null;
    if (active && list.contains(active)) {
      const chipEl = active.closest('.tab-chip');
      if (chipEl) refocus = { id: chipEl.dataset.tabId, which: active === chipEl ? 'chip' : 'close' };
    }
    clear(list);
    // Without any active match, keep one tab stop so the strip is reachable.
    const hasActive = tabs.some((t) => t.id === activeId);
    tabs.forEach((t, idx) => {
      const title = t.title || prettyTitle(t.url) || 'New tab';
      const isActive = t.id === activeId;
      const chip = h('div', {
        class: `tab-chip ${isActive ? 'active' : ''}`,
        title: t.url || '',
        role: 'tab',
        dataset: { tabId: t.id },
        'aria-selected': isActive ? 'true' : 'false',
        // Roving tabindex: only the active chip is a tab stop; arrow keys move
        // between chips the way a real tab strip behaves.
        tabindex: isActive || (!hasActive && idx === 0) ? '0' : '-1',
        on: {
          click: () => actions.selectTab(t.id),
          keydown: (e) => {
            if (e.target !== e.currentTarget) return; // a nested control's key
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.selectTab(t.id); return; }
            if (e.key === 'Delete') { e.preventDefault(); actions.closeTab(t.id); return; }
            const i = tabs.findIndex((x) => x.id === t.id);
            let to = -1;
            if (e.key === 'ArrowRight') to = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') to = (i + tabs.length - 1) % tabs.length;
            else if (e.key === 'Home') to = 0;
            else if (e.key === 'End') to = tabs.length - 1;
            if (to < 0) return;
            e.preventDefault();
            const next = tabs[to];
            if (next) {
              refocusId = next.id; // the rebuild this triggers should land here
              actions.selectTab(next.id);
              focusChip(next.id);
            }
          },
        },
      }, [
        t.loading ? h('span', { class: 'tc-spin' }) : null,
        h('span', { class: 'tc-title', text: title }),
        h('button', {
          class: 'tc-close', title: 'Close tab', 'aria-label': 'Close tab: ' + title, text: '×',
          // Roving: the chip is the tab stop; the close button is reachable by
          // Tab from the focused chip but not a stop of its own on inactive tabs.
          on: { click: (e) => { e.stopPropagation(); actions.closeTab(t.id); } },
        }),
      ]);
      list.appendChild(chip);
    });
    if (refocus) restore(refocus, tabs, activeId);
    refocusId = null;
  }

  // Set while an arrow-key move is in flight, so the update() it triggers
  // doesn't send focus back to the previous chip.
  let refocusId = null;

  function chipFor(id) {
    return Array.from(list.children).find((c) => c.dataset.tabId === id) || null;
  }

  function focusChip(id) {
    const c = chipFor(id);
    if (c) try { c.focus(); } catch (_e) { /* ignore */ }
  }

  function restore(saved, tabs, activeId) {
    if (document.activeElement && list.contains(document.activeElement)) return;
    if (refocusId && chipFor(refocusId)) { focusChip(refocusId); return; }
    const same = chipFor(saved.id);
    if (same) {
      const target = saved.which === 'close' ? same.querySelector('.tc-close') : same;
      try { (target || same).focus(); } catch (_e) { /* ignore */ }
      return;
    }
    // The focused tab was closed: land on the active tab, else the first one.
    focusChip(tabs.some((t) => t.id === activeId) ? activeId : (tabs[0] && tabs[0].id));
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
