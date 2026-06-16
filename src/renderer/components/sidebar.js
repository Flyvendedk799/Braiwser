// Left sidebar: Projects, Sessions (for the active project), and Recordings.
// Pure-render component — it re-renders fully from the data passed to update().
// Row interactions are delegated to the controller via the `actions` bag.
import { h, icon, clear, timeAgo } from '../lib/dom.js';

export function createSidebar(actions) {
  const projectsList = h('div', { class: 'side-list' });
  const sessionsList = h('div', { class: 'side-list' });
  const recordingsList = h('div', { class: 'side-list' });
  const bookmarksList = h('div', { class: 'side-list' });
  const historyList = h('div', { class: 'side-list' });

  const clearHistoryBtn = h('button', { class: 'side-add', title: 'Clear history', html: icon('trash', 13), on: { click: () => actions.clearHistory && actions.clearHistory() } });

  const root = h('aside', { class: 'sidebar' }, [
    section('Projects', projectsList, actions.newProject),
    section('Sessions', sessionsList, actions.newSession),
    section('Recordings', recordingsList, null),
    section('Bookmarks', bookmarksList, null),
    section('History', historyList, null, clearHistoryBtn),
  ]);

  function section(title, list, onAdd, customBtn) {
    const add = customBtn || (onAdd
      ? h('button', { class: 'side-add', title: 'New ' + title.slice(0, -1).toLowerCase(), html: icon('plus', 14), on: { click: onAdd } })
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

  function row({ icon: ic, name, meta, active, count, onClick, rowActions }) {
    const acts = h('div', { class: 'sr-actions' });
    (rowActions || []).forEach((a) =>
      acts.appendChild(
        h('button', {
          class: `sr-act ${a.danger ? 'danger' : ''}`,
          title: a.title,
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
    return h('div', { class: `side-row ${active ? 'active' : ''}`, on: { click: onClick } }, [
      h('span', { class: 'sr-icon', html: icon(ic, 15) }),
      h('div', { class: 'sr-body' }, [
        h('div', { class: 'sr-name', text: name }),
        meta ? h('div', { class: 'sr-meta', text: meta }) : null,
      ]),
      count != null ? h('span', { class: 'sr-count', text: String(count) }) : null,
      acts,
    ]);
  }

  function update(state) {
    const { projects, currentProject, sessions, currentSession, recordings, selectedRecording, sessionCounts, history, bookmarks } = state;

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
          icon: 'replay',
          name: r.name,
          meta: (r.steps ? r.steps.length : 0) + ' steps · ' + timeAgo(r.updatedAt) + runMeta,
          active: selectedRecording && selectedRecording.id === r.id,
          onClick: () => actions.selectRecording(r),
          rowActions: [
            { icon: 'replay', title: 'Replay', onClick: () => actions.replayRecording(r) },
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

  return { root, update };
}
