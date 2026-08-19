// Layers tab: pick a UI section on the page (Layers mode) and see where it
// sits in the layout — the ancestor breadcrumb, the immediate container's
// layout kind (row / column / grid / stacked), and its children as a
// reorderable list. Reordering moves the DOM node, which is what actually
// drives row/column/paint order for that container.
import { h, icon, clear } from '../lib/dom.js';

export function createLayersPanel(actions) {
  let current = null; // last caos:layout-picked payload

  const crumbBar = h('div', { class: 'layers-crumbs' });
  const summary = h('div', { class: 'layers-summary' });
  const list = h('div', { class: 'layers-list' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'layers' } }, [crumbBar, summary, list]);

  function empty() {
    clear(crumbBar);
    clear(summary);
    clear(list);
    list.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('layers', 30) }),
        h('div', { class: 'ph-title', text: 'No element selected' }),
        h('div', {
          class: 'ph-sub',
          text: 'Toggle Layers mode, then click a UI section on the page to see how it’s laid out — rows, columns, or stacked layers — and reorder its children.',
        }),
      ])
    );
  }

  function crumbLabel(n) {
    let s = n.tag || '';
    if (n.id) s += '#' + n.id;
    else if (n.classes && n.classes.length) s += '.' + n.classes[0];
    return s;
  }

  function renderCrumbs(info) {
    clear(crumbBar);
    const chain = info.breadcrumb || [];
    chain.forEach((n, i) => {
      const isLast = i === chain.length - 1;
      crumbBar.appendChild(
        h('button', {
          class: `crumb ${isLast ? 'current' : ''}`,
          text: crumbLabel(n),
          title: n.selector || '',
          disabled: isLast,
          on: { click: () => actions.select(n) },
        })
      );
      if (!isLast) crumbBar.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
    });
  }

  const KIND_LABEL = { row: 'Row', column: 'Column', grid: 'Grid', block: 'Stacked' };

  function renderSummary(info) {
    clear(summary);
    const c = info.container;
    if (!c) {
      summary.appendChild(h('div', { class: 'layers-summary-empty', text: 'Top-level element — no parent container.' }));
      return;
    }
    summary.appendChild(
      h('div', { class: 'layers-container-card' }, [
        h('span', { class: `layers-kind kind-${c.kind}`, text: KIND_LABEL[c.kind] || c.kind }),
        h('span', { class: 'layers-detail', text: c.detail || '' }),
        h('span', { class: 'layers-grow' }),
        h('span', { class: 'layers-count', text: `${c.childCount} ${c.childCount === 1 ? 'child' : 'children'}` }),
      ])
    );
    const selLabel = (c.tag || '') + (c.id ? '#' + c.id : (c.classes && c.classes[0] ? '.' + c.classes[0] : ''));
    summary.appendChild(h('div', { class: 'layers-container-sel', text: selLabel }));
  }

  function siblingLabel(s) {
    let label = s.tag || '';
    if (s.id) label += '#' + s.id;
    if (s.classes && s.classes.length) label += '.' + s.classes.slice(0, 2).join('.');
    return label;
  }

  function renderList(info) {
    clear(list);
    const sibs = info.siblings || [];
    if (!sibs.length) {
      list.appendChild(
        h('div', { class: 'placeholder' }, [
          h('div', { class: 'ph-title', text: 'No siblings' }),
          h('div', { class: 'ph-sub', text: 'This element has no parent container to compare it against.' }),
        ])
      );
      return;
    }
    sibs.forEach((s, i) => {
      const row = h(
        'div',
        {
          class: `layer-row ${s.isTarget ? 'is-target' : ''}`,
          on: {
            click: (e) => {
              if (e.target.closest('.layer-acts')) return;
              actions.select(s);
            },
          },
        },
        [
          h('span', { class: 'layer-n', text: String(i + 1) }),
          h('span', { class: 'layer-label', text: siblingLabel(s) }),
          s.overlapping ? h('span', { class: 'layer-badge stack', title: 'Overlaps another sibling — stacked layer', text: 'stack' }) : null,
          s.position && s.position !== 'static' ? h('span', { class: 'layer-badge pos', title: `position: ${s.position}`, text: s.position }) : null,
          h('span', { class: 'layers-grow' }),
          h('div', { class: 'layer-acts' }, [
            h('button', {
              class: 'layer-act',
              title: 'Move up',
              disabled: i === 0,
              html: icon('chevron', 13),
              style: { transform: 'rotate(-90deg)' },
              on: { click: () => reorder(i, i - 1) },
            }),
            h('button', {
              class: 'layer-act',
              title: 'Move down',
              disabled: i === sibs.length - 1,
              html: icon('chevron', 13),
              style: { transform: 'rotate(90deg)' },
              on: { click: () => reorder(i, i + 1) },
            }),
          ]),
        ]
      );
      list.appendChild(row);
    });
  }

  function reorder(from, to) {
    if (!current || !current.container) return;
    actions.reorder({ parentSelector: current.container.selector, fromIndex: from, toIndex: to });
  }

  function setLayout(info) {
    if (!info) {
      empty();
      return;
    }
    current = info;
    renderCrumbs(info);
    renderSummary(info);
    renderList(info);
  }

  empty();
  return { root, setLayout };
}
