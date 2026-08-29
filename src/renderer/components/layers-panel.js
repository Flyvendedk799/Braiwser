// Layers tab (left sidebar): where Sections shows the whole page, Layers zooms
// in on ONE container — how it lays its children out, and the stack those
// children form. Re-lay-out the container in a click (row / column / grid /
// tidy), drag a layer to reorder it, raise or lower an overlapping one, hide
// one. Everything here is a real change to the page, captured as an edit note.
import { h, icon, clear } from '../lib/dom.js';
import { displayName, shortName, selectorLabel, ICON_FOR } from '../lib/naming.js';

const KIND_LABEL = { row: 'Row', column: 'Column', grid: 'Grid', block: 'Stacked' };
const LAYOUTS = [
  ['row', 'Row', 'Lay the children out in a horizontal flex row'],
  ['column', 'Column', 'Stack the children in a vertical flex column'],
  ['grid', 'Grid', 'Lay the children out in a responsive grid'],
  ['tidy', 'Tidy', 'Keep the current axis, normalise gaps and alignment'],
];

export function createLayersPanel(actions) {
  let current = null; // last caos:layout-picked payload
  let fullCrumbs = false; // a deep chain is folded until you ask for it
  let drag = null;
  let suppressClick = false;

  const crumbBar = h('div', { class: 'layers-crumbs' });
  const summary = h('div', { class: 'layers-summary' });
  const list = h('div', {
    class: 'layers-list',
    on: { mouseleave: () => actions.hoverClear() },
  });
  const dropLine = h('div', { class: 'sec-drop-line' });
  const root = h('div', { class: 'tab-body side-body', dataset: { tab: 'layers' } }, [crumbBar, summary, list, dropLine]);

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
          text: 'Pick a row in Sections, or click an element on the page, to see its container’s layout and the stack of layers inside it.',
        }),
      ])
    );
  }

  // ---- breadcrumb ------------------------------------------------------------
  const CRUMB_MAX = 4; // beyond this the middle folds — three wrapped lines of
  // breadcrumb is not navigation, it is wallpaper.

  function renderCrumbs(info) {
    clear(crumbBar);
    const all = info.breadcrumb || [];
    const parent = all[all.length - 2];
    const folded = !fullCrumbs && all.length > CRUMB_MAX;
    const chain = folded ? [all[0]].concat(all.slice(-(CRUMB_MAX - 1))) : all;
    const hidden = folded ? all.slice(1, -(CRUMB_MAX - 1)) : [];
    crumbBar.appendChild(
      h('button', {
        class: 'crumb-up',
        title: parent ? 'Select the parent (' + selectorLabel(parent) + ')' : 'No parent to select',
        disabled: !parent,
        html: icon('chevron', 12),
        on: { click: () => parent && actions.selectLayout(parent) },
      })
    );
    // Nested wrappers all inherit the same heading, so a raw chain reads
    // "Hero › Hero › Hero". Repeats fall back to the selector.
    let prev = '';
    chain.forEach((n, i) => {
      const isLast = i === chain.length - 1;
      let label = shortName(n, 14);
      if (label.toLowerCase() === prev.toLowerCase()) {
        const sel = selectorLabel(n);
        if (sel) label = sel.length > 14 ? sel.slice(0, 14) + '…' : sel;
      }
      prev = label;
      crumbBar.appendChild(
        h('button', {
          class: `crumb ${isLast ? 'current' : ''}`,
          text: label,
          title: n.selector || '',
          disabled: isLast,
          on: {
            click: () => actions.selectLayout(n),
            mouseenter: () => actions.hover(n),
          },
        })
      );
      if (!isLast) crumbBar.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
      if (folded && i === 0) {
        crumbBar.appendChild(
          h('button', {
            class: 'crumb-more',
            text: '…',
            title: hidden.length + ' more: ' + hidden.map((n) => shortName(n, 20)).join(' › '),
            on: {
              click: () => {
                fullCrumbs = true;
                renderCrumbs(info);
              },
            },
          })
        );
        crumbBar.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
      }
    });
  }

  // ---- the container it lives in ---------------------------------------------
  function renderSummary(info) {
    clear(summary);
    const c = info.container;
    if (!c) {
      summary.appendChild(h('div', { class: 'layers-summary-empty', text: 'Top-level element — no parent container to lay out.' }));
      return;
    }
    summary.appendChild(
      h('div', { class: 'layers-container-card' }, [
        h('span', { class: `layers-kind kind-${c.kind}`, text: KIND_LABEL[c.kind] || c.kind }),
        h('span', { class: 'layers-detail', text: c.detail || '' }),
        h('span', { class: 'layers-grow' }),
        h('span', { class: 'layers-count', text: `${c.childCount} ${c.childCount === 1 ? 'layer' : 'layers'}` }),
      ])
    );
    summary.appendChild(
      h('button', {
        class: 'layers-container-sel',
        title: 'Select this container',
        text: shortName(c, 22) + ' · ' + selectorLabel(c),
        on: {
          click: () => actions.selectLayout(c),
          mouseenter: () => actions.hover(c),
        },
      })
    );
    const buttons = LAYOUTS.map(([kind, label, title]) =>
      h('button', {
        class: `layers-layout-btn ${c.kind === kind ? 'on' : ''}`,
        text: label,
        title,
        on: { click: () => actions.smartLayout(kind, c.selector) },
      })
    );
    summary.appendChild(h('div', { class: 'layers-layout-row' }, [h('span', { class: 'layers-layout-label', text: 'Lay out as' })].concat(buttons)));
  }

  // ---- the layers themselves ----------------------------------------------------
  function sizeLabel(s) {
    const b = s.box || {};
    if (!b.w && !b.h) return '';
    return Math.round(b.w) + '×' + Math.round(b.h);
  }

  function renderLayers(info) {
    clear(list);
    const sibs = info.siblings || [];
    if (!sibs.length) {
      list.appendChild(
        h('div', { class: 'placeholder' }, [
          h('div', { class: 'ph-title', text: 'No layers' }),
          h('div', { class: 'ph-sub', text: 'This element has no parent container, so there is no stack to order.' }),
        ])
      );
      return;
    }
    const group = h('div', { class: 'layer-group' });
    const stacked = sibs.some((s) => s.overlapping);
    sibs.forEach((s, i) => {
      const z = s.zIndex && s.zIndex !== 'auto' ? s.zIndex : null;
      const canRaise = stacked || (s.position && s.position !== 'static');
      const row = h(
        'div',
        {
          class: `layer-row ${s.isTarget ? 'is-target' : ''} ${s.hidden ? 'is-hidden' : ''}`,
          title: s.selector || '',
          role: 'option',
          tabindex: '0',
          'aria-selected': s.isTarget ? 'true' : 'false',
          on: {
            click: (e) => {
              if (suppressClick || e.target.closest('.layer-acts')) return;
              actions.selectLayout(s);
            },
            mouseenter: () => { if (!drag) actions.hover(s); },
            // Keyboard focus highlights the layer on the page, the same way
            // hovering it does — otherwise the list is mouse-only.
            focus: () => { if (!drag) actions.hover(s); },
            keydown: (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              actions.selectLayout(s);
            },
          },
        },
        [
          h('span', { class: 'layer-grip', title: 'Drag to reorder this layer', html: icon('move', 12) }),
          h('span', { class: 'layer-n', text: String(i + 1) }),
          h('span', { class: 'layer-ico', html: icon(ICON_FOR[s.tag] || 'layers', 13) }),
          h('span', { class: 'layer-label', text: displayName(s) }),
          sizeLabel(s) ? h('span', { class: 'layer-size', text: sizeLabel(s) }) : null,
          s.overlapping ? h('span', { class: 'layer-badge stack', title: 'Overlaps another layer', text: 'stack' }) : null,
          z ? h('span', { class: 'layer-badge z', title: 'z-index: ' + z, text: 'z' + z }) : null,
          s.position && s.position !== 'static' ? h('span', { class: 'layer-badge pos', title: `position: ${s.position}`, text: s.position }) : null,
          h('div', { class: 'layer-acts' }, [
            canRaise
              ? h('button', {
                  class: 'layer-act',
                  title: 'Bring to front',
                  html: icon('chevron', 12),
                  style: { transform: 'rotate(-90deg)' },
                  on: { click: () => actions.zOrder(s, 'front') },
                })
              : null,
            canRaise
              ? h('button', {
                  class: 'layer-act',
                  title: 'Send to back',
                  html: icon('chevron', 12),
                  style: { transform: 'rotate(90deg)' },
                  on: { click: () => actions.zOrder(s, 'back') },
                })
              : null,
            h('button', {
              class: 'layer-act',
              title: s.hidden ? 'Show on the page' : 'Hide on the page',
              html: icon(s.hidden ? 'eye-off' : 'eye', 12),
              on: { click: () => actions.toggleHidden(s) },
            }),
          ]),
        ]
      );
      row.addEventListener('pointerdown', (e) => startDrag(e, i, group, row));
      const item = h('div', { class: 'layer-item' }, [row]);
      item._row = row;
      group.appendChild(item);
    });
    list.appendChild(group);
  }

  // ---- drag to reorder ------------------------------------------------------
  function startDrag(e, index, group, rowEl) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.layer-acts')) return;
    const fromGrip = !!(e.target.closest && e.target.closest('.layer-grip'));
    drag = { index, group, rowEl, y: e.clientY, x: e.clientX, fromGrip, moved: false, to: index };
    if (fromGrip) e.preventDefault();
    const onMove = (ev) => dragMove(ev);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      dragEnd(ev);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  function dragMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) + Math.abs(e.clientX - drag.x) < (drag.fromGrip ? 2 : 5)) return;
      drag.moved = true;
      drag.rowEl.classList.add('dragging');
      actions.hoverClear();
    }
    const items = Array.from(drag.group.children);
    let slot = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i]._row.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        slot = i;
        break;
      }
    }
    drag.to = slot > drag.index ? slot - 1 : slot;
    const at = Math.min(slot, items.length - 1);
    const ref = items[at]._row.getBoundingClientRect();
    const wrap = root.getBoundingClientRect();
    dropLine.style.display = 'block';
    dropLine.style.left = ref.left - wrap.left + 'px';
    dropLine.style.width = ref.width + 'px';
    dropLine.style.top = (slot >= items.length ? ref.bottom : ref.top) - wrap.top + 'px';
  }

  function dragEnd() {
    const d = drag;
    drag = null;
    dropLine.style.display = 'none';
    if (!d) return;
    d.rowEl.classList.remove('dragging');
    if (!d.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (d.to === d.index) return;
    reorder(d.index, d.to);
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
    fullCrumbs = false; // a new selection starts folded again
    renderCrumbs(info);
    renderSummary(info);
    renderLayers(info);
  }

  layoutEmpty();
  return { root, setLayout };
}
