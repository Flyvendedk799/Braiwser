// Notes tab: filterable list of annotations for the current session. Each note
// shows action color-stripe, target, note text (inline-editable), status toggle,
// priority select, locate, and delete. Filters by action and by status.
import { h, icon, clear, timeAgo, esc } from '../lib/dom.js';

export function createNotesPanel(config, actions) {
  const actionMap = {};
  config.actionTags.forEach((t) => (actionMap[t.id] = t));

  let actionFilter = new Set(); // empty = all
  let statusFilter = 'all'; // 'all' | 'open' | 'resolved'
  let annotations = [];
  let editingId = null;

  const filters = h('div', { class: 'filters' });
  const list = h('div', { class: 'notes-list' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'notes' } }, [filters, list]);

  function buildFilters() {
    clear(filters);
    filters.appendChild(h('div', { class: 'filter-label', text: 'Action' }));
    config.actionTags.forEach((t) => {
      const on = actionFilter.has(t.id);
      filters.appendChild(
        h('button', {
          class: `chip ${on ? 'on' : ''}`,
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
    [['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved']].forEach(([id, label]) => {
      filters.appendChild(
        h('button', {
          class: `chip ${statusFilter === id ? 'on' : ''}`,
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

  function filtered() {
    return annotations.filter((a) => {
      if (actionFilter.size && !actionFilter.has(a.action)) return false;
      if (statusFilter !== 'all' && (a.status || 'open') !== statusFilter) return false;
      return true;
    });
  }

  function noteCard(a, index) {
    const color = (actionMap[a.action] && actionMap[a.action].color) || 'var(--comment)';
    const resolved = (a.status || 'open') === 'resolved';
    const prio = a.priority || 'normal';

    const card = h('div', {
      class: `note ${resolved ? 'resolved' : ''}`,
      on: {
        click: (e) => {
          // Ignore clicks on interactive children — they have their own handlers.
          if (e.target.closest('.note-actions, .note-edit, .prio-select')) return;
          actions.locate(a);
        },
      },
    });
    card.style.setProperty('--stripe', color);

    const hasSelector = !!(a.target && a.target.selector);
    const actsRow = h('div', { class: 'note-actions' }, [
      h('button', { class: 'note-act', title: 'Locate on page', html: icon('locate', 15), on: { click: () => actions.locate(a) } }),
      hasSelector ? h('button', { class: 'note-act', title: 'Copy selector', html: icon('copy', 15), on: { click: () => actions.copySelector(a) } }) : null,
      actions.suggestFix ? h('button', { class: 'note-act', title: 'AI: suggest a fix', html: icon('ai', 15), on: { click: () => actions.suggestFix(a) } }) : null,
      h('button', { class: 'note-act', title: 'Edit note', html: icon('edit', 15), on: { click: () => startEdit(a) } }),
      h('button', { class: `note-act ${resolved ? 'on' : ''}`, title: resolved ? 'Reopen' : 'Mark resolved', html: icon('check', 15), on: { click: () => actions.toggleStatus(a) } }),
      h('button', { class: 'note-act danger', title: 'Delete', html: icon('trash', 15), on: { click: () => actions.remove(a) } }),
    ]);

    const top = h('div', { class: 'note-top' }, [
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

    const prioSelect = h('select', { class: `prio-select prio-${prio}` }, config.priorities.map((p) =>
      h('option', { value: p, text: p[0].toUpperCase() + p.slice(1), ...(p === prio ? { selected: 'selected' } : {}) })
    ));
    prioSelect.value = prio;
    prioSelect.addEventListener('change', () => actions.setPriority(a, prioSelect.value));

    const foot = h('div', { class: 'note-foot' }, [
      prioSelect,
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
    actions.onCount(annotations.length, items.length);
    if (!annotations.length) {
      list.appendChild(placeholder('inspect', 'No notes yet', 'Toggle Inspect or Draw, then click an element on the page to capture it and leave a note.'));
      return;
    }
    if (!items.length) {
      list.appendChild(placeholder('inspect', 'No matching notes', 'Adjust the action or status filters above.'));
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

  return { root, setAnnotations, render };
}
