// Sections tab (left sidebar): the live page as a tree of sections and the
// layers nested inside them — the shape a Shopify-style editor shows, not tag
// soup. Hovering a row outlines it on the page (quietly — no flash, no scroll),
// clicking selects and jumps to it, the grip drags it to a new place (among its
// siblings or into another section), and the eye hides it. Every structural
// change goes through the same edit-note pipeline as a drag on the canvas.
import { h, icon, clear } from '../lib/dom.js';
import { displayName, selectorLabel, ICON_FOR } from '../lib/naming.js';

const DRAG_THRESHOLD = 5; // px before a press on a row body counts as a drag
const SPRING_MS = 600; // hover-to-open delay for a collapsed row mid-drag
const EDGE = 28; // px band at the list edges that auto-scrolls while dragging

export function createSectionsPanel(actions) {
  let tree = null;
  let activeSelector = null;
  let filter = '';
  const opened = new Set(); // explicitly expanded
  const closed = new Set(); // explicitly collapsed
  let drag = null;
  let springTimer = null;
  let suppressClick = false;
  let pendingActive = null; // a selection we could not place until the tree catches up
  let pendingKey = null; // …and the chain it came from, so we ask for the tree ONCE

  const count = h('span', { class: 'sec-count' });
  const refreshBtn = h('button', {
    class: 'sec-icon-btn',
    title: 'Re-read the page structure',
    html: icon('reload', 13),
    on: { click: () => actions.refresh() },
  });
  const search = h('input', {
    class: 'sec-search',
    type: 'search',
    placeholder: 'Filter sections…',
    on: {
      input: () => {
        filter = search.value.trim().toLowerCase();
        render();
      },
    },
  });
  const bar = h('div', { class: 'sec-bar' }, [search, count, refreshBtn]);
  const listWrap = h('div', {
    class: 'sec-list',
    role: 'tree',
    'aria-label': 'Page sections',
    on: { mouseleave: () => actions.hoverClear() },
  });
  const dropLine = h('div', { class: 'sec-drop-line' });
  const root = h('div', { class: 'tab-body side-body', dataset: { tab: 'sections' } }, [bar, listWrap, dropLine]);

  function empty(title, message) {
    clear(listWrap);
    listWrap.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('layers', 26) }),
        h('div', { class: 'ph-title', text: title }),
        h('div', { class: 'ph-sub', text: message }),
      ])
    );
  }

  // Sections (depth 0) start expanded; the layers inside them stay folded until
  // asked for, so a deep page still reads as a short list.
  function isOpen(node, depth) {
    if (!node.children || !node.children.length) return false;
    if (closed.has(node.selector)) return false;
    if (opened.has(node.selector)) return true;
    return depth === 0;
  }

  function setOpen(node, depth, want) {
    if (want) {
      opened.add(node.selector);
      closed.delete(node.selector);
    } else {
      closed.add(node.selector);
      opened.delete(node.selector);
    }
    render();
  }

  // ---- rows --------------------------------------------------------------
  function renderRow(node, group, index, depth, parentSelector, flat) {
    const kids = node.children || [];
    const openNow = !flat && isOpen(node, depth);

    const grip = h('span', {
      class: 'sec-grip',
      title: 'Drag to move this section',
      html: icon('move', 12),
    });

    const toggle = h('button', {
      class: `sec-toggle ${kids.length && !flat ? '' : 'leaf'} ${openNow ? 'open' : ''}`,
      title: kids.length ? (openNow ? 'Collapse' : 'Expand') : '',
      'aria-label': kids.length ? (openNow ? 'Collapse' : 'Expand') : '',
      'aria-hidden': kids.length && !flat ? null : 'true',
      tabindex: kids.length && !flat ? '0' : '-1',
      html: icon('chevron', 11),
      on: {
        click: (e) => {
          e.stopPropagation();
          if (kids.length && !flat) setOpen(node, depth, !openNow);
        },
      },
    });

    const eye = h('button', {
      class: 'sec-eye',
      title: node.hidden ? 'Show on the page' : 'Hide on the page (records a removal note)',
      'aria-label': node.hidden ? 'Show on the page' : 'Hide on the page',
      html: icon(node.hidden ? 'eye-off' : 'eye', 13),
      on: {
        click: (e) => {
          e.stopPropagation();
          actions.toggleHidden(node);
        },
      },
    });

    const row = h(
      'div',
      {
        class:
          'sec-row' +
          (node.selector && node.selector === activeSelector ? ' active' : '') +
          (node.hidden ? ' is-hidden' : ''),
        title: node.selector || '',
        role: 'treeitem',
        tabindex: '0',
        'aria-selected': node.selector && node.selector === activeSelector ? 'true' : 'false',
        ...(kids.length && !flat ? { 'aria-expanded': openNow ? 'true' : 'false' } : {}),
        on: {
          click: () => {
            if (suppressClick) return;
            actions.select(node);
          },
          mouseenter: () => {
            if (drag) springLoad(node, depth);
            else actions.hover(node);
          },
          // Keyboard focus should highlight the element on the page just like
          // hovering does, or the tree is unusable without a mouse.
          focus: () => actions.hover(node),
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              actions.select(node);
            } else if (e.key === 'ArrowRight' && kids.length && !flat && !openNow) {
              e.preventDefault();
              setOpen(node, depth, true);
            } else if (e.key === 'ArrowLeft' && kids.length && !flat && openNow) {
              e.preventDefault();
              setOpen(node, depth, false);
            }
          },
        },
      },
      [
        grip,
        toggle,
        h('span', { class: 'sec-ico', html: icon(ICON_FOR[node.tag] || 'layers', 13) }),
        // The name gets the room: the exact selector lives in the row's tooltip
        // (and in Layers), because clipped to "div.fm…" it told you nothing.
        h('span', { class: 'sec-name', text: displayName(node) }),
        kids.length && !openNow ? h('span', { class: 'sec-kids', text: String(kids.length) }) : null,
        eye,
      ]
    );
    if (!flat) {
      row.addEventListener('pointerdown', (e) => startDrag(e, node, group, index, parentSelector, row, depth));
    }
    row._node = node;
    return row;
  }

  function renderGroup(nodes, depth, parentSelector) {
    const group = h('div', { class: 'sec-group' });
    group._parentSelector = parentSelector;
    nodes.forEach((node, i) => {
      const row = renderRow(node, group, i, depth, parentSelector, false);
      const item = h('div', { class: 'sec-item' }, [row]);
      item._row = row;
      item._node = node;
      if (isOpen(node, depth)) item.appendChild(renderGroup(node.children, depth + 1, node.selector));
      group.appendChild(item);
    });
    return group;
  }

  // Filtering flattens: matches only, each with the path it came from, so a
  // 300-node page is still one glance away from the row you want.
  function collectMatches(nodes, path, out) {
    for (const n of nodes) {
      const hay = (displayName(n) + ' ' + selectorLabel(n)).toLowerCase();
      if (hay.indexOf(filter) !== -1) out.push({ node: n, path: path.map(displayName).join(' › ') });
      collectMatches(n.children || [], path.concat([n]), out);
    }
    return out;
  }

  function render() {
    clear(listWrap);
    if (!tree) {
      count.textContent = '';
      empty('No sections yet', 'Load a page and its sections show up here.');
      return;
    }
    const sections = (tree.children || []).filter((n) => n.tag !== 'script' && n.tag !== 'style');
    if (!sections.length) {
      count.textContent = '';
      empty('No sections yet', 'This page has no top-level sections to show.');
      return;
    }
    if (filter) {
      const hits = collectMatches(sections, [], []);
      count.textContent = hits.length + (hits.length === 1 ? ' match' : ' matches');
      if (!hits.length) {
        empty('Nothing matches', 'No section or selector contains “' + filter + '”.');
        return;
      }
      const group = h('div', { class: 'sec-group' });
      hits.slice(0, 200).forEach((hit, i) => {
        const row = renderRow(hit.node, group, i, 0, null, true);
        const item = h('div', { class: 'sec-item' }, [row]);
        if (hit.path) item.appendChild(h('div', { class: 'sec-path', text: hit.path }));
        item._row = row;
        group.appendChild(item);
      });
      listWrap.appendChild(group);
      return;
    }
    count.textContent = sections.length + (sections.length === 1 ? ' section' : ' sections');
    listWrap.appendChild(renderGroup(sections, 0, tree.selector || 'body'));
  }

  // ---- drag: reorder among siblings, or into another section ---------------
  function startDrag(e, node, group, index, parentSelector, rowEl, depth) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.sec-toggle, .sec-eye')) return;
    const fromGrip = !!(e.target.closest && e.target.closest('.sec-grip'));
    drag = {
      node,
      group,
      index,
      parentSelector,
      rowEl,
      depth,
      x: e.clientX,
      y: e.clientY,
      fromGrip,
      moved: false,
      target: null,
      raf: 0,
    };
    if (fromGrip) e.preventDefault(); // the grip is a handle, not text
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
      const far = Math.abs(e.clientY - drag.y) + Math.abs(e.clientX - drag.x);
      if (far < (drag.fromGrip ? 2 : DRAG_THRESHOLD)) return;
      drag.moved = true;
      drag.rowEl.classList.add('dragging');
      root.classList.add('dragging');
      actions.hoverClear();
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    edgeScroll();
    resolveDrop(e.clientY);
  }

  // Where would it land? Relative to whichever row the pointer is over — which
  // is what makes dropping into a different section work at all.
  function resolveDrop(y) {
    const items = Array.from(listWrap.querySelectorAll('.sec-item')).filter((it) => it._row && !it._row.classList.contains('dragging'));
    if (!items.length) return;
    let best = null;
    let bestD = Infinity;
    for (const it of items) {
      const r = it._row.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    if (!best) return;
    const r = best._row.getBoundingClientRect();
    const after = y > r.top + r.height / 2;
    const group = best.parentElement;
    const siblings = Array.from(group.children);
    const at = siblings.indexOf(best) + (after ? 1 : 0);
    drag.target = { group, index: at, parentSelector: group._parentSelector };
    const wrap = root.getBoundingClientRect();
    dropLine.style.display = 'block';
    dropLine.style.left = r.left - wrap.left + 'px';
    dropLine.style.width = r.width + 'px';
    dropLine.style.top = (after ? r.bottom : r.top) - wrap.top + 'px';
  }

  // Hovering a collapsed row mid-drag opens it, so you can drop inside.
  function springLoad(node, depth) {
    clearTimeout(springTimer);
    if (!node.children || !node.children.length || isOpen(node, depth)) return;
    springTimer = setTimeout(() => {
      if (drag) setOpen(node, depth, true);
    }, SPRING_MS);
  }

  function edgeScroll() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    const r = listWrap.getBoundingClientRect();
    const up = drag.y < r.top + EDGE;
    const down = drag.y > r.bottom - EDGE;
    if (!up && !down) return;
    const step = () => {
      if (!drag) return;
      listWrap.scrollTop += up ? -8 : 8;
      resolveDrop(drag.y);
      drag.raf = requestAnimationFrame(step);
    };
    drag.raf = requestAnimationFrame(step);
  }

  function dragEnd() {
    const d = drag;
    drag = null;
    clearTimeout(springTimer);
    dropLine.style.display = 'none';
    root.classList.remove('dragging');
    if (!d) return;
    cancelAnimationFrame(d.raf);
    d.rowEl.classList.remove('dragging');
    if (!d.moved || !d.target) return;
    // A click fires after the pointer sequence — it must not re-select and
    // scroll the page right after a drop.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);

    const sameParent = d.target.parentSelector === d.parentSelector;
    if (sameParent) {
      const to = d.target.index > d.index ? d.target.index - 1 : d.target.index;
      if (to === d.index) return;
      actions.reorder({ parentSelector: d.parentSelector, fromIndex: d.index, toIndex: to });
    } else if (d.target.parentSelector) {
      actions.moveInto({
        selector: d.node.selector,
        parentSelector: d.target.parentSelector,
        index: d.target.index,
      });
    }
  }

  // ---- api -----------------------------------------------------------------
  function setTree(next) {
    tree = next || null;
    if (pendingActive) {
      const retry = pendingActive;
      pendingActive = null;
      setActive(retry); // the selection that arrived before the structure did
      return;
    }
    render();
  }

  // Follow the page's selection, unfolding whatever it is buried under.
  // Takes the whole ancestor chain (root first, the element itself last): the
  // exact element may be past the tree's depth or node budget, and then the
  // honest answer is to light up the deepest ancestor we do have rather than
  // nothing at all.
  function setActive(sel) {
    const chain = (Array.isArray(sel) ? sel : [sel]).filter(Boolean);
    if (!chain.length) {
      activeSelector = null;
      render();
      return;
    }
    let hit = null;
    let path = null;
    if (tree) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const p = findPath(tree.children || [], chain[i], []);
        if (p) {
          hit = chain[i];
          path = p;
          break;
        }
      }
    }
    const key = chain.join('|');
    if (!hit) {
      // The tree is stale (or was never fetched) — pull it again and retry ONCE.
      // Keyed on the chain, not the array: a fresh array for the same selection
      // used to look like a new request and re-ask forever.
      if (pendingKey !== key) {
        pendingKey = key;
        pendingActive = chain;
        actions.refresh();
      }
      return;
    }
    pendingActive = null;
    pendingKey = null;
    activeSelector = hit;
    path.forEach((n) => {
      opened.add(n.selector);
      closed.delete(n.selector);
    });
    render();
    const el = listWrap.querySelector('.sec-row.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function findPath(nodes, selector, acc) {
    for (const n of nodes) {
      if (n.selector === selector) return acc;
      const deeper = findPath(n.children || [], selector, acc.concat([n]));
      if (deeper) return deeper;
    }
    return null;
  }

  render();
  return { root, setTree, setActive };
}
