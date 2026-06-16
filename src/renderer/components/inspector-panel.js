// Inspector tab: a "Refresh DOM tree" button requests the tree from the webview,
// then renders it as a collapsible indented tree. Hovering or clicking a node
// highlights it on the page via 'caos:highlight-target' { selector }.
import { h, icon, clear, esc } from '../lib/dom.js';

export function createInspectorPanel(actions) {
  const treeWrap = h('div', { class: 'tree' });

  const refreshBtn = h('button', {
    class: 'btn btn-sm',
    html: icon('reload', 14) + '<span>Refresh DOM tree</span>',
    on: { click: () => { setLoading(); actions.requestTree(); } },
  });

  const root = h('div', { class: 'tab-body', dataset: { tab: 'inspector' } }, [
    h('div', { class: 'inspector-bar' }, [refreshBtn]),
    treeWrap,
  ]);

  let hotNode = null;

  function setLoading() {
    clear(treeWrap);
    treeWrap.appendChild(h('div', { class: 'ai-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'Reading DOM…' })]));
  }

  function empty() {
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
    const self = h('div', { class: 'tree-self', html: nodeLabel(node) });
    self.insertBefore(toggle, self.firstChild);

    const highlight = () => actions.highlight({ selector: node.selector });
    self.addEventListener('mouseenter', highlight);
    self.addEventListener('click', (e) => {
      if (e.target === toggle || toggle.contains(e.target)) return;
      if (hotNode) hotNode.classList.remove('hot');
      hotNode = self;
      self.classList.add('hot');
      highlight();
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

  empty();
  return { root, setTree, setLoading };
}
