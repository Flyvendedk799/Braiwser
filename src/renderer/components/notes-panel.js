// Notes tab: searchable, filterable list of annotations for the current
// session. Each note shows its action colour-stripe, target, note text
// (inline-editable), status toggle, priority, locate, and delete — plus a
// checkbox so several notes can be triaged in one go.
//
// Ordering. Notes are numbered by their position in the FULL list (that number is
// the pin number on the page), whatever filter is active. Dragging while a filter
// is on therefore reorders within the full list: the dragged note lands next to
// the note it was dropped on, and every hidden note keeps its place. The full
// ordered id list is always what actions.reorder(ids, { filtered }) receives
// (never just the visible subset), and the panel renumbers immediately.
//
// Bulk actions may report partial failure: actions.bulkUpdate / bulkRemove can
// resolve to { failed: [note | id | { id, error }] } (or reject). Failed notes stay
// selected and a visible "N of M failed - Retry" bar remains until it succeeds or
// is dismissed.
import { h, icon, clear, timeAgo, esc, guarded, toast } from '../lib/dom.js';
import { emptyNotesMessage } from '../lib/persona.js';

export function createNotesPanel(config, actions) {
  const actionMap = {};
  config.actionTags.forEach((t) => (actionMap[t.id] = t));

  let actionFilter = new Set(); // empty = all
  let statusFilter = 'all'; // 'all' | 'open' | 'resolved'
  let query = '';
  let annotations = [];
  let editingId = null;
  let selected = new Set();
  let bulkFailure = null; // { label, total, ids:Set, retry:() => Promise, error? }

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search notes, selectors, pages…',
    'aria-label': 'Search notes',
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      query = '';
      render();
    }
  });
  const searchRow = h('div', { class: 'notes-search-row' }, [searchInput]);

  const bulkBar = h('div', { class: 'bulk-bar' });
  const filters = h('div', { class: 'filters' });
  const tally = h('span', { class: 'filter-tally' });
  const nextRail = h('div', { class: 'next-rail', hidden: 'hidden' });
  const list = h('div', { class: 'notes-list' });
  const dropLine = h('div', { class: 'note-drop-line' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'notes' } }, [searchRow, nextRail, bulkBar, filters, list, dropLine]);

  function hideDropLine() { dropLine.style.display = 'none'; }

  function placeDropLine(card, e) {
    const rect = card.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    dropLine.style.display = 'block';
    dropLine.style.left = rect.left + 'px';
    dropLine.style.width = rect.width + 'px';
    dropLine.style.top = (before ? rect.top : rect.bottom) + 'px';
  }

  function buildFilters() {
    clear(filters);
    filters.appendChild(h('div', { class: 'filter-label', text: 'Action' }));
    config.actionTags.forEach((t) => {
      const on = actionFilter.has(t.id);
      filters.appendChild(
        h('button', {
          class: `chip ${on ? 'on' : ''}`,
          'aria-pressed': on ? 'true' : 'false',
          html: `<span class="dot" style="background:${t.color}"></span>${esc(t.label)}`,
          on: {
            click: () => {
              if (actionFilter.has(t.id)) actionFilter.delete(t.id);
              else actionFilter.add(t.id);
              render();
            },
          },
        })
      );
    });
    filters.appendChild(h('div', { class: 'filter-label', text: 'Status' }));
    filters.appendChild(tally);
    [['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved']].forEach(([id, label]) => {
      filters.appendChild(
        h('button', {
          class: `chip ${statusFilter === id ? 'on' : ''}`,
          'aria-pressed': statusFilter === id ? 'true' : 'false',
          text: label,
          on: {
            click: () => {
              statusFilter = id;
              render();
            },
          },
        })
      );
    });
  }

  function buildBulkBar(items) {
    clear(bulkBar);
    const chosen = items.filter((a) => selected.has(a.id));
    // A failed bulk action stays on screen (even once its notes are gone from the
    // selection) until it is retried successfully or dismissed.
    if (bulkFailure && !annotations.some((a) => bulkFailure.ids.has(a.id))) bulkFailure = null;
    bulkBar.classList.toggle('show', chosen.length > 0 || !!bulkFailure);
    if (bulkFailure) {
      bulkBar.appendChild(h('div', { class: 'bulk-fail', role: 'alert' }, [
        h('span', { class: 'bulk-fail-text', text: `${bulkFailure.ids.size} of ${bulkFailure.total} could not be ${bulkFailure.label}.${bulkFailure.error ? ' ' + bulkFailure.error : ''}` }),
        h('button', { class: 'btn btn-sm bulk-retry', text: 'Retry', on: { click: () => bulkFailure && bulkFailure.retry() } }),
        h('button', { class: 'btn btn-sm btn-ghost', text: 'Dismiss', on: { click: () => { bulkFailure = null; render(); } } }),
      ]));
    }
    if (!chosen.length) return;

    const prio = h('select', { class: 'prio-select', 'aria-label': 'Set priority for selected notes' }, [
      h('option', { value: '', text: 'Set priority…' }),
      ...config.priorities.map((p) => h('option', { value: p, text: p[0].toUpperCase() + p.slice(1) })),
    ]);
    prio.addEventListener('change', () => {
      if (!prio.value) return;
      runBulk('update', chosen, { priority: prio.value });
      prio.value = '';
    });

    bulkBar.appendChild(h('span', { class: 'bulk-count', text: `${chosen.length} selected` }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm', text: 'Resolve', on: { click: () => runBulk('update', chosen, { status: 'resolved' }) } }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm', text: 'Reopen', on: { click: () => runBulk('update', chosen, { status: 'open' }) } }));
    bulkBar.appendChild(prio);
    bulkBar.appendChild(h('span', { class: 'bulk-grow' }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm btn-danger', text: 'Delete', on: { click: () => runBulk('remove', chosen) } }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm btn-ghost', text: 'Clear', on: { click: () => { selected.clear(); render(); } } }));
  }

  // Run a bulk action and keep any failure visible and retryable.
  async function runBulk(kind, notes, patch) {
    const label = kind === 'remove' ? 'deleted' : 'updated';
    const fn = kind === 'remove' ? actions.bulkRemove : actions.bulkUpdate;
    const total = notes.length;
    let failedIds = null;
    let error = '';
    try {
      const res = kind === 'remove' ? await fn(notes) : await fn(notes, patch);
      if (res && Array.isArray(res.failed) && res.failed.length) {
        failedIds = new Set(res.failed.map((f) => (f && typeof f === 'object' ? f.id : f)).filter(Boolean));
        const firstErr = res.failed.find((f) => f && typeof f === 'object' && f.error);
        if (firstErr) error = String(firstErr.error);
      } else if (res === false || (res && res.ok === false)) {
        failedIds = new Set(notes.map((n) => n.id));
        error = (res && res.error) || '';
      }
    } catch (err) {
      failedIds = new Set(notes.map((n) => n.id));
      error = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+':\s*/, '');
    }
    if (!failedIds || !failedIds.size) {
      bulkFailure = null;
      render();
      return;
    }
    // Leave exactly the failed notes selected, so Retry (or the user) can act on them.
    selected = new Set(failedIds);
    bulkFailure = {
      label,
      total,
      ids: failedIds,
      error,
      retry: () => runBulk(kind, annotations.filter((a) => failedIds.has(a.id)), patch),
    };
    render();
    toast(`${failedIds.size} of ${total} notes could not be ${label}`, 'error', 5000);
  }

  function targetLabel(a) {
    const t = a.target || {};
    // Only true region notes read as a box — element/edit targets also carry a
    // box (from describe()) but their selector is the meaningful label.
    if (a.kind === 'region') {
      const b = t.box || {};
      return `region · ${Math.round(b.w || 0)}×${Math.round(b.h || 0)} @ ${Math.round(b.x || 0)},${Math.round(b.y || 0)}`;
    }
    if (a.kind === 'edit') {
      const type = (a.edit && a.edit.type) || 'edit';
      return `${type} · ${t.selector || (t.tag ? `<${t.tag}>` : 'element')}`;
    }
    return t.selector || (t.tag ? `<${t.tag}>` : 'element');
  }

  function matchesQuery(a) {
    if (!query) return true;
    const t = a.target || {};
    const haystack = [
      a.note,
      t.selector,
      t.text,
      t.id,
      Array.isArray(t.classes) ? t.classes.join(' ') : '',
      a.title,
      a.url,
      a.action,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  function filtered() {
    return annotations.filter((a) => {
      if (actionFilter.size && !actionFilter.has(a.action)) return false;
      if (statusFilter !== 'all' && (a.status || 'open') !== statusFilter) return false;
      return matchesQuery(a);
    });
  }

  // Move fromId next to targetId in the FULL order (before it, or after it).
  // Notes hidden by a filter are not touched: they keep their slots.
  function moveNote(fromId, targetId, before) {
    const ids = annotations.map((n) => n.id);
    const from = ids.indexOf(fromId);
    if (from < 0 || ids.indexOf(targetId) < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(before ? to : to + 1, 0, fromId);
    if (ids.every((id, i) => id === annotations[i].id)) return; // dropped where it was
    const prev = annotations;
    const byId = new Map(annotations.map((n) => [n.id, n]));
    annotations = ids.map((id) => byId.get(id));
    render(); // renumber at once so the list matches the pins the app is about to redraw
    const undo = (err) => {
      annotations = prev;
      render();
      if (err !== false) toast('Could not reorder notes' + (err && err.message ? ': ' + err.message : ''), 'error', 5000);
    };
    try {
      const out = actions.reorder(ids, { filtered: !!(actionFilter.size || statusFilter !== 'all' || query) });
      if (out && typeof out.then === 'function') {
        out.then((res) => { if (res === false || (res && res.ok === false)) undo(res && res.error ? new Error(res.error) : null); }, undo);
      }
    } catch (err) {
      undo(err);
    }
  }

  function noteCard(a, index) {
    const color = (actionMap[a.action] && actionMap[a.action].color) || 'var(--comment)';
    const resolved = (a.status || 'open') === 'resolved';
    const prio = a.priority || 'normal';
    const isSelected = selected.has(a.id);

    const card = h('div', {
      class: `note ${resolved ? 'resolved' : ''} ${isSelected ? 'selected' : ''}`,
      draggable: true,
      on: {
        click: (e) => {
          // Ignore clicks on interactive children — they have their own handlers.
          if (e.target.closest('.note-actions, .note-edit, .prio-select, .note-check, .vis-select')) return;
          actions.locate(a);
        },
        dragstart: (e) => {
          e.dataTransfer.setData('text/braiwser-note', a.id);
          e.dataTransfer.effectAllowed = 'move';
          card.classList.add('dragging');
        },
        dragend: () => { card.classList.remove('dragging'); hideDropLine(); },
        dragover: (e) => {
          e.preventDefault();
          card.classList.add('drag-over');
          placeDropLine(card, e);
        },
        dragleave: () => card.classList.remove('drag-over'),
        drop: (e) => {
          e.preventDefault();
          card.classList.remove('drag-over');
          hideDropLine();
          const fromId = e.dataTransfer.getData('text/braiwser-note');
          if (!fromId || fromId === a.id || !actions.reorder) return;
          const rect = card.getBoundingClientRect();
          moveNote(fromId, a.id, e.clientY < rect.top + rect.height / 2);
        },
      },
    });
    card.style.setProperty('--stripe', color);

    const check = h('input', {
      class: 'note-check',
      type: 'checkbox',
      checked: isSelected,
      title: 'Select for bulk actions',
      'aria-label': 'Select note #' + (index + 1),
    });
    check.addEventListener('change', () => {
      if (check.checked) selected.add(a.id);
      else selected.delete(a.id);
      render();
    });

    const hasSelector = !!(a.target && a.target.selector);
    const actsRow = h('div', { class: 'note-actions' }, [
      h('button', { class: 'note-act', title: 'Locate on page', 'aria-label': 'Locate on page', html: icon('locate', 15), on: { click: guarded(() => actions.locate(a), 'Locate') } }),
      hasSelector ? h('button', { class: 'note-act', title: 'Copy selector', 'aria-label': 'Copy selector', html: icon('copy', 15), on: { click: guarded(() => actions.copySelector(a), 'Copy selector') } }) : null,
      actions.suggestFix ? h('button', { class: 'note-act', title: 'AI: suggest a fix', 'aria-label': 'Suggest a fix with AI', html: icon('ai', 15), on: { click: guarded(() => actions.suggestFix(a), 'Suggest a fix') } }) : null,
      h('button', { class: 'note-act', title: 'Edit note', 'aria-label': 'Edit note', html: icon('edit', 15), on: { click: () => startEdit(a) } }),
      h('button', { class: `note-act ${resolved ? 'on' : ''}`, title: resolved ? 'Reopen' : 'Mark resolved', 'aria-label': resolved ? 'Reopen note' : 'Mark note resolved', html: icon('check', 15), on: { click: guarded(() => actions.toggleStatus(a), 'Update note') } }),
      h('button', { class: 'note-act danger', title: 'Delete', 'aria-label': 'Delete note', html: icon('trash', 15), on: { click: guarded(() => actions.remove(a), 'Delete note') } }),
    ]);

    const top = h('div', { class: 'note-top' }, [
      check,
      h('span', {
        class: 'note-action',
        text: (actionMap[a.action] && actionMap[a.action].label) || a.action || 'comment',
        style: { color, background: color + '22' },
      }),
      h('span', { class: 'note-kind', text: a.kind === 'region' ? 'region' : a.kind === 'edit' ? 'edit' : 'element' }),
      h('span', { class: 'note-grow' }),
      actsRow,
      h('span', { class: 'note-num', text: '#' + (index + 1) }),
    ]);

    let textNode;
    if (editingId === a.id) {
      const ta = h('textarea', { class: 'note-edit', value: a.note });
      const finish = (save) => {
        editingId = null;
        if (save) guarded(() => actions.editNote(a, ta.value.trim()), 'Save note')();
        else render();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finish(true);
        if (e.key === 'Escape') finish(false);
      });
      ta.addEventListener('blur', () => finish(true));
      textNode = ta;
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 10);
    } else {
      textNode = h('div', { class: 'note-text', text: a.note || '(no description)' });
    }

    const prioSelect = h('select', { class: `prio-select prio-${prio}`, 'aria-label': 'Priority' }, config.priorities.map((p) =>
      h('option', { value: p, text: p[0].toUpperCase() + p.slice(1), ...(p === prio ? { selected: 'selected' } : {}) })
    ));
    prioSelect.value = prio;
    prioSelect.addEventListener('change', guarded(() => actions.setPriority(a, prioSelect.value), 'Set priority'));

    const vis = a.visibility === 'client' ? 'client' : 'internal';
    const visSelect = h('select', { class: 'vis-select', 'aria-label': 'Visibility' }, [
      h('option', { value: 'internal', text: 'Internal' }),
      h('option', { value: 'client', text: 'Client-facing' }),
    ]);
    visSelect.value = vis;
    visSelect.addEventListener('change', guarded(() => {
      if (actions.setVisibility) return actions.setVisibility(a, visSelect.value);
    }, 'Set visibility'));

    const currentUrl = actions.currentUrl ? actions.currentUrl() : null;
    const offPage = !!(currentUrl && a.url && a.url !== currentUrl);

    const foot = h('div', { class: 'note-foot' }, [
      prioSelect,
      visSelect,
      a.viewport && a.viewport.label && a.viewport.label !== 'Fit to window'
        ? h('span', { class: 'note-kind', title: `Captured at ${a.viewport.w}×${a.viewport.h}`, text: a.viewport.label })
        : null,
      offPage ? h('span', { class: 'note-kind', title: a.url, text: 'other page' }) : null,
      h('span', { class: 'note-time', text: timeAgo(a.createdAt) }),
    ]);

    card.appendChild(top);
    card.appendChild(textNode);
    card.appendChild(h('div', { class: 'note-target', title: targetLabel(a), text: targetLabel(a) }));
    card.appendChild(foot);
    return card;
  }

  function render() {
    buildFilters();
    clear(list);
    const items = filtered();
    // Selections must never survive the notes they pointed at.
    const live = new Set(annotations.map((a) => a.id));
    for (const id of Array.from(selected)) if (!live.has(id)) selected.delete(id);
    buildBulkBar(items);
    actions.onCount(annotations.length, items.length);
    tally.textContent = annotations.length
      ? items.length === annotations.length
        ? annotations.length + (annotations.length === 1 ? ' note' : ' notes')
        : items.length + ' of ' + annotations.length
      : '';
    if (!annotations.length) {
      const persona = (actions.getPersona && actions.getPersona()) || 'agent';
      const sub = emptyNotesMessage(persona);
      const ph = placeholder('inspect', 'No notes yet', sub);
      if (persona === 'reviewer' && actions.startChecklist) {
        ph.appendChild(h('button', {
          class: 'btn btn-sm btn-primary',
          text: 'Start accessibility pass',
          on: { click: () => actions.startChecklist('a11y-pass') },
        }));
      }
      list.appendChild(ph);
      return;
    }
    if (!items.length) {
      list.appendChild(placeholder('inspect', 'No matching notes', query ? `Nothing matches “${query}”.` : 'Adjust the action or status filters above.'));
      return;
    }
    // Index is by full annotation order (matches restored pin numbers).
    items.forEach((a) => list.appendChild(noteCard(a, annotations.indexOf(a))));
  }

  function setNextAction(opts) {
    const show = !!(opts && opts.show);
    nextRail.toggleAttribute('hidden', !show);
    clear(nextRail);
    if (!show) return;
    const persona = (opts.persona || (actions.getPersona && actions.getPersona()) || 'agent');
    nextRail.appendChild(h('div', { class: 'next-rail-copy' }, [
      h('strong', { text: 'First note captured.' }),
      h('span', { text: ' Ship it while the issue is still in your head.' }),
    ]));
    const acts = h('div', { class: 'next-rail-acts' });
    const mk = (id, label, primary) => h('button', {
      class: `btn btn-sm ${primary ? 'btn-primary' : ''}`,
      text: label,
      on: { click: () => opts.onAction && opts.onAction(id) },
    });
    acts.appendChild(mk('copy', 'Copy prompt', false));
    acts.appendChild(mk('handoff', 'Hand off', persona === 'agent'));
    acts.appendChild(mk('audit', 'Run audit', persona === 'reviewer'));
    acts.appendChild(mk('client-pack', 'Client pack', persona === 'agency'));
    acts.appendChild(h('button', { class: 'btn btn-sm btn-ghost', text: 'Dismiss', on: { click: () => opts.onDismiss && opts.onDismiss() } }));
    nextRail.appendChild(acts);
  }

  function placeholder(ic, title, sub) {
    return h('div', { class: 'placeholder empty-state' }, [
      h('div', { class: 'ph-icon', html: icon(ic, 30) }),
      h('div', { class: 'ph-title', text: title }),
      h('div', { class: 'ph-sub', text: sub }),
    ]);
  }

  function startEdit(a) {
    editingId = a.id;
    render();
  }

  function setAnnotations(list_) {
    annotations = Array.isArray(list_) ? list_ : [];
    editingId = null;
    render();
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  // Paint the filters and the empty state immediately — before this, the Notes
  // tab was blank until the first session was opened.
  render();

  return { root, setAnnotations, render, focusSearch, selectedIds: () => Array.from(selected), setNextAction };
}
