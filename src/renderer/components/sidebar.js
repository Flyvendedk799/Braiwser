// Left sidebar. Two faces:
//   • the page — [Sections | Layers] tabs, which is what you work in all day;
//   • the library — Projects, Sessions, Recordings, Bookmarks and History,
//     folded away behind one button at the bottom and expanded on demand.
// Pure-render component: the library re-renders fully from update()'s data, and
// row interactions are delegated to the controller via the `actions` bag.
import { h, icon, clear, timeAgo } from '../lib/dom.js';

export function createSidebar(actions, panels) {
  const projectsList = h('div', { class: 'side-list' });
  const sessionsList = h('div', { class: 'side-list' });
  const recordingsList = h('div', { class: 'side-list' });
  const bookmarksList = h('div', { class: 'side-list' });
  const historyList = h('div', { class: 'side-list' });

  const clearHistoryBtn = h('button', { class: 'side-add', title: 'Clear history', 'aria-label': 'Clear history', html: icon('trash', 13), on: { click: () => actions.clearHistory && actions.clearHistory() } });
  const importBtn = h('button', { class: 'side-add', title: 'Import a project bundle', 'aria-label': 'Import a project bundle', html: icon('upload', 13), on: { click: () => actions.importBundle && actions.importBundle() } });
  const newProjectBtn = h('button', { class: 'side-add', title: 'New project', 'aria-label': 'New project', html: icon('plus', 14), on: { click: actions.newProject } });

  // ---- page tabs -------------------------------------------------------------
  const tabButtons = {};
  const tabBar = h('div', { class: 'side-tabs' });
  [
    ['sections', 'Sections', 'The page as a tree of sections and layers'],
    ['layers', 'Layers', 'The selected element’s container and stacking order'],
  ].forEach(([id, label, title]) => {
    const b = h('button', {
      class: 'side-tab',
      text: label,
      title,
      on: { click: () => actions.selectTab(id) },
    });
    tabButtons[id] = b;
    tabBar.appendChild(b);
  });

  const stack = h('div', { class: 'side-stack' }, [panels.sections, panels.layers]);

  // ---- library drawer --------------------------------------------------------
  const library = h('div', { class: 'side-library' }, [
    section('Projects', projectsList, null, h('div', { class: 'side-head-acts' }, [importBtn, newProjectBtn])),
    section('Sessions', sessionsList, actions.newSession),
    section('Recordings', recordingsList, null),
    section('Bookmarks', bookmarksList, null),
    section('History', historyList, null, clearHistoryBtn),
  ]);

  const libChevron = h('span', { class: 'lib-chevron', html: icon('chevron', 12) });
  const libMeta = h('span', { class: 'lib-meta' });
  const libPill = h('span', { class: 'lib-pill' });
  const libraryBtn = h(
    'button',
    {
      class: 'side-library-btn',
      title: 'Projects, sessions, recordings, bookmarks and history',
      on: { click: () => actions.toggleLibrary() },
    },
    [libChevron, h('span', { class: 'lib-title', text: 'Library' }), libPill, h('span', { class: 'sec-grow' }), libMeta]
  );

  const root = h('aside', { class: 'sidebar' }, [tabBar, stack, library, libraryBtn]);

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

  function row({ icon: ic, name, meta, active, count, onClick, rowActions, id }) {
    const acts = h('div', { class: 'sr-actions' });
    (rowActions || []).forEach((a) =>
      acts.appendChild(
        h('button', {
          class: `sr-act ${a.danger ? 'danger' : ''}`,
          title: a.title,
          'aria-label': a.title,
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
      dataset: id ? { rowId: id } : null,
      role: 'button',
      tabindex: '0',
      'aria-pressed': active ? 'true' : 'false',
      on: {
        click: onClick,
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (onClick) onClick();
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
    Object.entries(tabButtons).forEach(([k, b]) => b.classList.toggle('active', k === id));
    panels.sections.classList.toggle('active', id === 'sections');
    panels.layers.classList.toggle('active', id === 'layers');
  }

  function setLibraryOpen(open) {
    root.classList.toggle('library-open', !!open);
    libraryBtn.classList.toggle('open', !!open);
    libraryBtn.title = open ? 'Back to the page' : 'Projects, sessions, recordings, bookmarks and history';
  }

  function update(state) {
    const { projects, currentProject, sessions, currentSession, recordings, selectedRecording, sessionCounts, history, bookmarks } = state;

    // The button carries the context you lose by folding the library away.
    const recCount = (recordings || []).length;
    libPill.textContent = recCount ? recCount + (recCount === 1 ? ' recording' : ' recordings') : '';
    libPill.style.display = recCount ? '' : 'none';
    libMeta.textContent = currentSession
      ? currentSession.name + (currentProject ? ' · ' + currentProject.name : '')
      : (currentProject && currentProject.name) || 'No session';

    // Projects
    clear(projectsList);
    if (!projects.length) {
      projectsList.appendChild(h('div', { class: 'empty', text: 'No projects yet. Open a file or folder, or browse a URL — notes still save to a scratch session.' }));
    }
    for (const p of projects) {
      projectsList.appendChild(
        row({
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
      bookmarksList.appendChild(h('div', { class: 'empty', text: 'No bookmarks. Tap the ☆ in the address bar.' }));
    }
    for (const b of bms) {
      bookmarksList.appendChild(
        row({
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
          icon: 'reload',
          name: e.title || urlLabel(e.url),
          meta: urlLabel(e.url) + ' · ' + timeAgo(e.visitedAt),
          onClick: () => actions.openUrl(e.url),
        })
      );
    }
  }

  // Point at a row that just appeared — the drawer is no use if you cannot see
  // what landed in it.
  function revealRow(id) {
    const el = root.querySelector('[data-row-id="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
    return true;
  }

  return { root, update, setTab, setLibraryOpen, revealRow };
}
