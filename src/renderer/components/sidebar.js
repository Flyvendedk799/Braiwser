// Left sidebar. It owns navigation and page structure:
//   • Workspace — projects, sessions, recordings, bookmarks and history;
//   • Page — [Sections | Layers] for the live document.
// Pure-render component: the library re-renders fully from update()'s data, and
// row interactions are delegated to the controller via the `actions` bag.
//
// Keyboard model (RF-09): a row is a roving list item. Enter/Space/arrows act on
// the ROW only when the row itself has focus — a keydown that bubbles up from a
// nested action button (rename, delete, export…) is left alone so the button's
// native Enter/Space click fires instead of selecting the parent. Tablists use
// arrow/Home/End with a roving tabindex. update() rebuilds the lists, so it
// remembers which row/control had focus and puts it back (or on the nearest
// surviving neighbour when that row was just deleted).
import { h, icon, clear, timeAgo } from '../lib/dom.js';

// Wire WAI-ARIA tablist keys onto a set of tab buttons: Left/Right (wrapping),
// Home/End. Selecting moves focus with it (automatic activation).
function wireTablist(buttons, order, select) {
  order.forEach((id, i) => {
    const b = buttons[id];
    b.tabIndex = i === 0 ? 0 : -1;
    b.addEventListener('keydown', (e) => {
      if (e.target !== e.currentTarget) return;
      const at = order.indexOf(id);
      let to = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % order.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + order.length) % order.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = order.length - 1;
      if (to < 0) return;
      e.preventDefault();
      const next = order[to];
      select(next);
      buttons[next].focus();
    });
  });
}

export function createSidebar(actions, panels) {
  const projectsList = h('div', { class: 'side-list' });
  const sessionsList = h('div', { class: 'side-list' });
  const recordingsList = h('div', { class: 'side-list' });
  const bookmarksList = h('div', { class: 'side-list' });
  const historyList = h('div', { class: 'side-list' });

  const clearHistoryBtn = h('button', { class: 'side-add', title: 'Clear history', 'aria-label': 'Clear history', html: icon('trash', 13), on: { click: () => actions.clearHistory && actions.clearHistory() } });
  const importBtn = h('button', { class: 'side-add', title: 'Import a project bundle', 'aria-label': 'Import a project bundle', html: icon('upload', 13), on: { click: () => actions.importBundle && actions.importBundle() } });
  const newProjectBtn = h('button', { class: 'side-add', title: 'New project', 'aria-label': 'New project', html: icon('plus', 14), on: { click: actions.newProject } });

  const contextTitle = h('div', { class: 'workspace-context-title', text: 'No session' });
  const contextMeta = h('div', { class: 'workspace-context-meta', text: 'Open a page to start reviewing' });
  const contextCount = h('span', { class: 'workspace-context-count', text: '0 notes' });
  const context = h('div', { class: 'workspace-context' }, [
    h('div', { class: 'workspace-context-copy' }, [contextTitle, contextMeta]),
    contextCount,
  ]);

  // ---- primary left-rail destinations ---------------------------------------
  const viewButtons = {};
  const collapseBtn = h('button', {
    class: 'side-collapse',
    title: 'Collapse workspace sidebar',
    'aria-label': 'Collapse workspace sidebar',
    html: icon('back', 15),
    on: { click: () => actions.toggleCollapsed && actions.toggleCollapsed() },
  });
  const viewNav = h('div', { class: 'side-view-nav', role: 'tablist', 'aria-label': 'Left sidebar' });
  [
    ['workspace', 'folder', 'Workspace'],
    ['page', 'layers', 'Page'],
  ].forEach(([id, ic, label]) => {
    const b = h('button', {
      class: 'side-view-tab',
      role: 'tab',
      'aria-selected': 'false',
      html: icon(ic, 15) + `<span>${label}</span>`,
      on: { click: () => actions.selectView && actions.selectView(id) },
    });
    viewButtons[id] = b;
    viewNav.appendChild(b);
  });
  wireTablist(viewButtons, ['workspace', 'page'], (id) => actions.selectView && actions.selectView(id));
  const top = h('div', { class: 'side-top' }, [viewNav, collapseBtn]);

  // ---- page tabs -------------------------------------------------------------
  const tabButtons = {};
  const tabBar = h('div', { class: 'side-tabs', role: 'tablist', 'aria-label': 'Page structure' });
  [
    ['sections', 'Sections', 'The page as a tree of sections and layers'],
    ['layers', 'Layers', 'The selected element’s container and stacking order'],
  ].forEach(([id, label, title]) => {
    const b = h('button', {
      class: 'side-tab',
      role: 'tab',
      id: 'side-tab-' + id,
      'aria-selected': 'false',
      text: label,
      title,
      on: { click: () => actions.selectTab(id) },
    });
    tabButtons[id] = b;
    tabBar.appendChild(b);
  });
  wireTablist(tabButtons, ['sections', 'layers'], (id) => actions.selectTab(id));

  const stack = h('div', { class: 'side-stack' }, [panels.sections, panels.layers]);
  const pageView = h('div', { class: 'side-page' }, [tabBar, stack]);

  // ---- library drawer --------------------------------------------------------
  const library = h('div', { class: 'side-library' }, [
    context,
    section('Projects', projectsList, null, h('div', { class: 'side-head-acts' }, [importBtn, newProjectBtn])),
    section('Sessions', sessionsList, actions.newSession),
    section('Recordings', recordingsList, null),
    section('Bookmarks', bookmarksList, null),
    section('History', historyList, null, clearHistoryBtn),
  ]);

  const expandBtn = h('button', {
    class: 'side-expand',
    title: 'Expand workspace sidebar',
    'aria-label': 'Expand workspace sidebar',
    html: icon('forward', 16),
    on: { click: () => actions.toggleCollapsed && actions.toggleCollapsed() },
  });
  const collapsedRail = h('div', { class: 'side-collapsed-rail' }, [
    expandBtn,
    h('button', {
      class: 'side-rail-btn',
      title: 'Open workspace',
      'aria-label': 'Open workspace',
      html: icon('folder', 16),
      on: { click: () => { if (actions.selectView) actions.selectView('workspace'); if (actions.toggleCollapsed) actions.toggleCollapsed(false); } },
    }),
    h('button', {
      class: 'side-rail-btn',
      title: 'Open page structure',
      'aria-label': 'Open page structure',
      html: icon('layers', 16),
      on: { click: () => { if (actions.selectView) actions.selectView('page'); if (actions.toggleCollapsed) actions.toggleCollapsed(false); } },
    }),
  ]);

  const root = h('aside', { class: 'sidebar' }, [top, library, pageView, collapsedRail]);

  function section(title, list, onAdd, customBtn) {
    const label = 'New ' + title.slice(0, -1).toLowerCase();
    const add = customBtn || (onAdd
      ? h('button', { class: 'side-add', title: label, 'aria-label': label, html: icon('plus', 14), on: { click: onAdd } })
      : null);
    return h('div', { class: 'side-section' }, [
      h('div', { class: 'side-head' }, [h('h3', { text: title }), add]),
      list,
    ]);
  }

  function urlLabel(u) {
    if (!u) return '';
    try { const x = new URL(u); return x.protocol === 'file:' ? decodeURIComponent(x.pathname.split('/').pop()) : x.hostname.replace(/^www\./, '') + x.pathname; } catch (_e) { return u; }
  }

  function row({ icon: ic, name, meta, active, count, onClick, rowActions, id, key }) {
    const acts = h('div', { class: 'sr-actions' });
    (rowActions || []).forEach((a) =>
      acts.appendChild(
        h('button', {
          class: `sr-act ${a.danger ? 'danger' : ''}`,
          title: a.title,
          'aria-label': name ? `${a.title}: ${name}` : a.title,
          dataset: { act: a.title },
          html: icon(a.icon, 13),
          on: {
            click: (e) => {
              e.stopPropagation();
              a.onClick();
            },
          },
        })
      )
    );
    // Rows are clickable divs (they contain their own buttons, so a <button>
    // wrapper would nest interactive elements). Give them button semantics and
    // keyboard operation by hand instead.
    return h('div', {
      class: `side-row ${active ? 'active' : ''}`,
      dataset: Object.assign({}, id ? { rowId: id } : {}, key ? { focusKey: key } : {}),
      role: 'button',
      tabindex: '0',
      'aria-pressed': active ? 'true' : 'false',
      on: {
        click: onClick,
        keydown: (e) => {
          // Only the row's own key presses count. A bubbled Enter/Space from a
          // nested action button must reach that button untouched.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (onClick) onClick();
            return;
          }
          const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (dir || e.key === 'Home' || e.key === 'End') {
            const rows = Array.from(e.currentTarget.parentElement.querySelectorAll(':scope > .side-row'));
            const at = rows.indexOf(e.currentTarget);
            const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : at + dir;
            if (rows[to]) {
              e.preventDefault();
              rows[to].focus();
            }
          }
        },
      },
    }, [
      h('span', { class: 'sr-icon', html: icon(ic, 15) }),
      h('div', { class: 'sr-body' }, [
        h('div', { class: 'sr-name', text: name }),
        meta ? h('div', { class: 'sr-meta', text: meta }) : null,
      ]),
      count != null ? h('span', { class: 'sr-count', text: String(count) }) : null,
      acts,
    ]);
  }

  function setTab(id) {
    Object.entries(tabButtons).forEach(([k, b]) => {
      const on = k === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    panels.sections.classList.toggle('active', id === 'sections');
    panels.layers.classList.toggle('active', id === 'layers');
  }

  function setView(id) {
    const next = id === 'page' ? 'page' : 'workspace';
    root.dataset.view = next;
    Object.entries(viewButtons).forEach(([key, button]) => {
      const active = key === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
  }

  // ---- focus retention across a full re-render --------------------------------
  const LISTS = { projects: projectsList, sessions: sessionsList, recordings: recordingsList, bookmarks: bookmarksList, history: historyList };
  Object.entries(LISTS).forEach(([name, el]) => { el.dataset.list = name; });

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const rowEl = active.closest && active.closest('.side-row');
    if (!rowEl || !rowEl.parentElement) return null;
    const listEl = rowEl.parentElement;
    const siblings = Array.from(listEl.querySelectorAll(':scope > .side-row'));
    return {
      list: listEl.dataset.list,
      key: rowEl.dataset.focusKey || null,
      index: siblings.indexOf(rowEl),
      act: active === rowEl ? null : (active.dataset && active.dataset.act) || null,
    };
  }

  function restoreFocus(saved) {
    if (!saved || (document.activeElement && root.contains(document.activeElement))) return;
    const listEl = LISTS[saved.list];
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll(':scope > .side-row'));
    let rowEl = saved.key ? rows.find((r) => r.dataset.focusKey === saved.key) : null;
    const exact = !!rowEl;
    if (!rowEl && rows.length) rowEl = rows[Math.min(Math.max(saved.index, 0), rows.length - 1)];
    if (!rowEl) {
      // The list emptied (last row deleted): land on the section's add button.
      const add = listEl.parentElement && listEl.parentElement.querySelector('.side-add');
      if (add) add.focus();
      return;
    }
    let target = rowEl;
    if (exact && saved.act) {
      target = Array.from(rowEl.querySelectorAll('.sr-act')).find((b) => b.dataset.act === saved.act) || rowEl;
    }
    try { target.focus(); } catch (_e) { /* ignore */ }
  }

  function update(state) {
    const { projects, currentProject, sessions, currentSession, recordings, selectedRecording, sessionCounts, history, bookmarks } = state;
    const savedFocus = captureFocus();

    const currentCount = currentSession && sessionCounts ? sessionCounts[currentSession.id] || 0 : 0;
    contextTitle.textContent = currentSession ? currentSession.name : (currentProject && currentProject.name) || 'No session';
    contextMeta.textContent = currentProject
      ? currentProject.name + ((recordings || []).length ? ` · ${recordings.length} journeys` : '')
      : 'Open a page to start reviewing';
    contextCount.textContent = currentCount + (currentCount === 1 ? ' note' : ' notes');

    // Projects
    clear(projectsList);
    if (!projects.length) {
      projectsList.appendChild(h('div', { class: 'empty', text: 'No projects yet. Open a file or folder, or browse a URL — notes still save to a scratch session.' }));
    }
    for (const p of projects) {
      projectsList.appendChild(
        row({
          key: 'project:' + p.id,
          icon: p.kind === 'url' ? 'reload' : 'folder',
          name: p.name,
          meta: p.path || p.kind,
          active: currentProject && currentProject.id === p.id,
          onClick: () => actions.openProject(p),
          rowActions: [
            { icon: 'download', title: 'Export project bundle', onClick: () => actions.exportBundle(p) },
            { icon: 'edit', title: 'Rename', onClick: () => actions.renameProject(p) },
            { icon: 'trash', title: 'Delete', danger: true, onClick: () => actions.deleteProject(p) },
          ],
        })
      );
    }

    // Sessions
    clear(sessionsList);
    if (!sessions.length) {
      sessionsList.appendChild(h('div', { class: 'empty', text: currentProject ? 'No sessions in this project.' : 'No sessions yet.' }));
    }
    for (const s of sessions) {
      sessionsList.appendChild(
        row({
          key: 'session:' + s.id,
          icon: 'file',
          name: s.name,
          meta: s.title || s.url || timeAgo(s.updatedAt),
          active: currentSession && currentSession.id === s.id,
          count: sessionCounts ? sessionCounts[s.id] : null,
          onClick: () => actions.openSession(s),
          rowActions: [
            { icon: 'edit', title: 'Rename', onClick: () => actions.renameSession(s) },
            { icon: 'trash', title: 'Delete', danger: true, onClick: () => actions.deleteSession(s) },
          ],
        })
      );
    }

    // Recordings
    clear(recordingsList);
    if (!recordings.length) {
      recordingsList.appendChild(h('div', { class: 'empty', text: 'No recordings. Hit ● Record to capture a journey.' }));
    }
    for (const r of recordings) {
      const lr = r.lastRun;
      const runMeta = lr ? ` · ${lr.failed === 0 ? '✓' : '✗'} ${lr.passed}/${lr.total}` : '';
      recordingsList.appendChild(
        row({
          id: r.id,
          key: 'recording:' + r.id,
          icon: 'replay',
          name: r.name,
          meta: (r.steps ? r.steps.length : 0) + ' steps · ' + timeAgo(r.updatedAt) + runMeta,
          active: selectedRecording && selectedRecording.id === r.id,
          onClick: () => actions.selectRecording(r),
          rowActions: [
            { icon: 'replay', title: 'Replay', onClick: () => actions.replayRecording(r) },
            { icon: 'download', title: 'Export as video, PDF, Markdown, a Playwright test or JSON', onClick: () => actions.exportRecording(r) },
            { icon: 'edit', title: 'Edit steps & assertions', onClick: () => actions.editRecording(r) },
            { icon: 'trash', title: 'Delete', danger: true, onClick: () => actions.deleteRecording(r) },
          ],
        })
      );
    }

    // Bookmarks
    clear(bookmarksList);
    const bms = bookmarks || [];
    if (!bms.length) {
      bookmarksList.appendChild(h('div', { class: 'empty', text: 'No bookmarks. Tap the star in the address bar.' }));
    }
    for (const b of bms) {
      bookmarksList.appendChild(
        row({
          key: 'bookmark:' + (b.id || b.url),
          icon: 'locate',
          name: b.title || urlLabel(b.url),
          meta: urlLabel(b.url),
          onClick: () => actions.openUrl(b.url),
          rowActions: [{ icon: 'trash', title: 'Remove', danger: true, onClick: () => actions.removeBookmark(b) }],
        })
      );
    }

    // History
    clear(historyList);
    const hist = history || [];
    if (!hist.length) {
      historyList.appendChild(h('div', { class: 'empty', text: 'No history yet.' }));
    }
    for (const e of hist.slice(0, 50)) {
      historyList.appendChild(
        row({
          key: 'history:' + e.url + '@' + (e.visitedAt || ''),
          icon: 'reload',
          name: e.title || urlLabel(e.url),
          meta: urlLabel(e.url) + ' · ' + timeAgo(e.visitedAt),
          onClick: () => actions.openUrl(e.url),
        })
      );
    }
    restoreFocus(savedFocus);
  }

  // Point at a row that just appeared — the drawer is no use if you cannot see
  // what landed in it.
  function revealRow(id) {
    setView('workspace');
    const el = root.querySelector('[data-row-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
    return true;
  }

  return { root, update, setTab, setView, revealRow };
}
