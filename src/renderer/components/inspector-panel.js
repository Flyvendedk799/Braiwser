// Inspector tab: click an element in Inspect mode (or a node in the DOM tree
// below) to see its spot in the layout — ancestor breadcrumb, its parent
// container's layout kind (row/column/grid/stacked), and the container's
// children as a reorderable list — plus a "Refresh DOM tree" browser of the
// live page structure. Hovering or clicking a tree node highlights it on the
// page via 'caos:highlight-target' { selector }.
import { h, icon, clear, esc } from '../lib/dom.js';

export function createInspectorPanel(actions) {
  // ---- Layout hierarchy section ---------------------------------------------
  const crumbBar = h('div', { class: 'layers-crumbs' });
  const summary = h('div', { class: 'layers-summary' });
  const list = h('div', { class: 'layers-list' });
  let current = null; // last caos:layout-picked payload

  function layoutEmpty() {
    clear(crumbBar);
    clear(summary);
    clear(list);
    list.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('layers', 26) }),
        h('div', { class: 'ph-title', text: 'No element selected' }),
        h('div', {
          class: 'ph-sub',
          text: 'Click an element in Inspect mode, or a node in the DOM tree below, to see how it’s laid out — row, column, grid, or stacked — and reorder its siblings.',
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
          on: { click: () => actions.selectLayout(n) },
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
    let lbl = s.tag || '';
    if (s.id) lbl += '#' + s.id;
    if (s.classes && s.classes.length) lbl += '.' + s.classes.slice(0, 2).join('.');
    return lbl;
  }

  function renderSiblings(info) {
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
              actions.selectLayout(s);
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
      current = null;
      layoutEmpty();
      return;
    }
    current = info;
    renderCrumbs(info);
    renderSummary(info);
    renderSiblings(info);
  }

  // ---- DOM tree section -------------------------------------------------------
  const treeWrap = h('div', { class: 'tree' });

  const refreshBtn = h('button', {
    class: 'btn btn-sm',
    html: icon('reload', 14) + '<span>Refresh DOM tree</span>',
    on: { click: () => { setLoading(); actions.requestTree(); } },
  });

  let hotNode = null;

  function setLoading() {
    clear(treeWrap);
    treeWrap.appendChild(h('div', { class: 'ai-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'Reading DOM…' })]));
  }

  function treeEmpty() {
    clear(treeWrap);
    treeWrap.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('inspect', 30) }),
        h('div', { class: 'ph-title', text: 'No DOM loaded' }),
        h('div', { class: 'ph-sub', text: 'Click “Refresh DOM tree” to read the live structure of the current page.' }),
      ])
    );
  }

  function nodeLabel(node) {
    let html = `<span class="tree-tag">${esc(node.tag)}</span>`;
    if (node.id) html += `<span class="tree-id">#${esc(node.id)}</span>`;
    if (node.classes && node.classes.length) html += `<span class="tree-cls">.${node.classes.slice(0, 3).map(esc).join('.')}</span>`;
    if (node.text) html += `<span class="tree-text">${esc(node.text)}</span>`;
    return html;
  }

  function renderNode(node, depth) {
    const hasChildren = node.children && node.children.length;
    const toggle = h('span', { class: `tree-toggle ${hasChildren ? '' : 'leaf'} ${depth < 2 ? 'open' : ''}`, html: icon('chevron', 10) });
    const self = h('div', {
      class: 'tree-self',
      html: nodeLabel(node),
      role: 'treeitem',
      tabindex: '0',
      ...(hasChildren ? { 'aria-expanded': depth < 2 ? 'true' : 'false' } : {}),
    });
    self.insertBefore(toggle, self.firstChild);
    if (node.selector && actions.copySelector) {
      const copyBtn = h('button', { class: 'tree-copy', title: 'Copy selector', 'aria-label': 'Copy selector', html: icon('copy', 12), on: { click: (e) => { e.stopPropagation(); actions.copySelector(node.selector); } } });
      self.appendChild(copyBtn);
    }

    const highlight = () => actions.highlight({ selector: node.selector });
    self.addEventListener('mouseenter', highlight);
    self.addEventListener('focus', highlight);
    self.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      self.click();
    });
    self.addEventListener('click', (e) => {
      if (e.target === toggle || toggle.contains(e.target)) return;
      if (hotNode) hotNode.classList.remove('hot');
      hotNode = self;
      self.classList.add('hot');
      highlight();
      actions.selectLayout({ selector: node.selector });
    });

    const wrap = h('div', { class: 'tree-node' }, [self]);
    if (hasChildren) {
      const childBox = h('div', { class: 'tree-children' }, node.children.map((c) => renderNode(c, depth + 1)));
      if (depth >= 2) childBox.style.display = 'none';
      else toggle.classList.add('open');
      const sync = () => {
        const open = toggle.classList.contains('open');
        childBox.style.display = open ? '' : 'none';
      };
      childBox.style.display = depth < 2 ? '' : 'none';
      toggle.classList.toggle('open', depth < 2);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle.classList.toggle('open');
        self.setAttribute('aria-expanded', toggle.classList.contains('open') ? 'true' : 'false');
        sync();
      });
      wrap.appendChild(childBox);
    }
    return wrap;
  }

  function setTree(tree) {
    clear(treeWrap);
    if (!tree) {
      treeWrap.appendChild(h('div', { class: 'empty', text: 'Could not read the DOM tree for this page.' }));
      return;
    }
    hotNode = null;
    treeWrap.appendChild(renderNode(tree, 0));
  }

  const root = h('div', { class: 'tab-body', dataset: { tab: 'inspector' } }, [
    h('div', { class: 'inspector-section-label', text: 'Layout' }),
    crumbBar,
    summary,
    list,
    h('div', { class: 'inspector-section-label', text: 'DOM tree' }),
    h('div', { class: 'inspector-bar' }, [refreshBtn]),
    treeWrap,
  ]);

  layoutEmpty();
  treeEmpty();
  return { root, setTree, setLoading, setLayout };
}
