// Notes tab: searchable, filterable list of annotations for the current
// session. Each note shows its action colour-stripe, target, note text
// (inline-editable), status toggle, priority, locate, and delete — plus a
// checkbox so several notes can be triaged in one go.
import { h, icon, clear, timeAgo, esc } from '../lib/dom.js';

export function createNotesPanel(config, actions) {
  const actionMap = {};
  config.actionTags.forEach((t) => (actionMap[t.id] = t));

  let actionFilter = new Set(); // empty = all
  let statusFilter = 'all'; // 'all' | 'open' | 'resolved'
  let query = '';
  let annotations = [];
  let editingId = null;
  let selected = new Set();

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
  const list = h('div', { class: 'notes-list' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'notes' } }, [searchRow, bulkBar, filters, list]);

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
    bulkBar.classList.toggle('show', chosen.length > 0);
    if (!chosen.length) return;

    const prio = h('select', { class: 'prio-select', 'aria-label': 'Set priority for selected notes' }, [
      h('option', { value: '', text: 'Set priority…' }),
      ...config.priorities.map((p) => h('option', { value: p, text: p[0].toUpperCase() + p.slice(1) })),
    ]);
    prio.addEventListener('change', () => {
      if (!prio.value) return;
      actions.bulkUpdate(chosen, { priority: prio.value });
      prio.value = '';
    });

    bulkBar.appendChild(h('span', { class: 'bulk-count', text: `${chosen.length} selected` }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm', text: 'Resolve', on: { click: () => actions.bulkUpdate(chosen, { status: 'resolved' }) } }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm', text: 'Reopen', on: { click: () => actions.bulkUpdate(chosen, { status: 'open' }) } }));
    bulkBar.appendChild(prio);
    bulkBar.appendChild(h('span', { class: 'bulk-grow' }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm btn-danger', text: 'Delete', on: { click: () => actions.bulkRemove(chosen) } }));
    bulkBar.appendChild(h('button', { class: 'btn btn-sm btn-ghost', text: 'Clear', on: { click: () => { selected.clear(); render(); } } }));
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

  function noteCard(a, index) {
    const color = (actionMap[a.action] && actionMap[a.action].color) || 'var(--comment)';
    const resolved = (a.status || 'open') === 'resolved';
    const prio = a.priority || 'normal';
    const isSelected = selected.has(a.id);

    const card = h('div', {
      class: `note ${resolved ? 'resolved' : ''} ${isSelected ? 'selected' : ''}`,
      on: {
        click: (e) => {
          // Ignore clicks on interactive children — they have their own handlers.
          if (e.target.closest('.note-actions, .note-edit, .prio-select, .note-check')) return;
          actions.locate(a);
        },
      },
    });
    card.style.setProperty('--stripe', color);

    const check = h('input', {
      class: 'note-check',
      type: 'checkbox',
      checked: isSelected,
      title: 'Select for bulk actions',
      'aria-label': 'Select this note',
    });
    check.addEventListener('change', () => {
      if (check.checked) selected.add(a.id);
      else selected.delete(a.id);
      render();
    });

    const hasSelector = !!(a.target && a.target.selector);
    const actsRow = h('div', { class: 'note-actions' }, [
      h('button', { class: 'note-act', title: 'Locate on page', 'aria-label': 'Locate on page', html: icon('locate', 15), on: { click: () => actions.locate(a) } }),
      hasSelector ? h('button', { class: 'note-act', title: 'Copy selector', 'aria-label': 'Copy selector', html: icon('copy', 15), on: { click: () => actions.copySelector(a) } }) : null,
      actions.suggestFix ? h('button', { class: 'note-act', title: 'AI: suggest a fix', 'aria-label': 'Suggest a fix with AI', html: icon('ai', 15), on: { click: () => actions.suggestFix(a) } }) : null,
      h('button', { class: 'note-act', title: 'Edit note', 'aria-label': 'Edit note', html: icon('edit', 15), on: { click: () => startEdit(a) } }),
      h('button', { class: `note-act ${resolved ? 'on' : ''}`, title: resolved ? 'Reopen' : 'Mark resolved', 'aria-label': resolved ? 'Reopen note' : 'Mark note resolved', html: icon('check', 15), on: { click: () => actions.toggleStatus(a) } }),
      h('button', { class: 'note-act danger', title: 'Delete', 'aria-label': 'Delete note', html: icon('trash', 15), on: { click: () => actions.remove(a) } }),
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
        if (save) actions.editNote(a, ta.value.trim());
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
    prioSelect.addEventListener('change', () => actions.setPriority(a, prioSelect.value));

    const currentUrl = actions.currentUrl ? actions.currentUrl() : null;
    const offPage = !!(currentUrl && a.url && a.url !== currentUrl);

    const foot = h('div', { class: 'note-foot' }, [
      prioSelect,
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
      list.appendChild(placeholder('inspect', 'No notes yet', 'Toggle Inspect or Draw, then click an element on the page to capture it and leave a note. Or run a page audit and promote its findings.'));
      return;
    }
    if (!items.length) {
      list.appendChild(placeholder('inspect', 'No matching notes', query ? `Nothing matches “${query}”.` : 'Adjust the action or status filters above.'));
      return;
    }
    // Index is by full annotation order (matches restored pin numbers).
    items.forEach((a) => list.appendChild(noteCard(a, annotations.indexOf(a))));
  }

  function placeholder(ic, title, sub) {
    return h('div', { class: 'placeholder' }, [
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

  return { root, setAnnotations, render, focusSearch, selectedIds: () => Array.from(selected) };
}
