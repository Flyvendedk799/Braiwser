// Sections tab (left sidebar): the live page as a tree of sections and the
// layers nested inside them — the shape a Shopify-style editor shows, not tag
// soup. Hovering a row outlines it on the page (quietly — no flash, no scroll),
// clicking selects and jumps to it, the grip drags it to a new place (among its
// siblings or into another section), and the eye hides it. Every structural
// change goes through the same edit-note pipeline as a drag on the canvas.
//
// Structural identity (RF-08): the tree the guest serializes already EXCLUDES
// script/style/noscript/inspector nodes, so a position in this list is not a DOM
// child index. Every reorder / moveInto payload therefore also names the nodes
// involved by selector (and by `domIndex` when the serializer provides one):
//
//   actions.reorder({ parentSelector, parentId,   // the container (nid from the tree)
//                     nodeId, selector,           // the node being moved (nid wins)
//                     fromIndex, toIndex,         // content indexes: toIndex is the FINAL slot
//                     fromDomIndex?,              // real DOM child index, when known
//                     destSelector, destId, placement })   // informational: the sibling it lands next to
//   actions.moveInto({ nodeId, selector, parentSelector, parentId,
//                      index,                      // content index among the target's children
//                      beforeId?, beforeSelector? })  // the sibling it is inserted before (absent = append)
//
// These are exactly the fields the guest's caos:reorder-sibling / caos:move-into
// handlers read (see the header of src/webview/inspector.js): identity — nid, then
// selector — wins, indexes only count when no identity was sent, and a lost
// identity is REJECTED by the guest (caos:structure-result { ok:false, reason }).
// Nodes without `nid` (older guests) still work: selector/index are sent alone.
//
// Keyboard (RF-09): the tree uses roving focus. Row keys act only on the row
// itself (never on keydown bubbling from its eye/toggle buttons); Up/Down/Home/End
// move, Right/Left expand-or-descend / collapse-or-ascend, Enter/Space select,
// Alt+Up/Down reorders among siblings. A re-render keeps focus on the same row.
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
    'aria-label': 'Re-read the page structure',
    html: icon('reload', 13),
    on: { click: () => actions.refresh() },
  });
  const search = h('input', {
    class: 'sec-search',
    type: 'search',
    placeholder: 'Filter sections…',
    'aria-label': 'Filter sections',
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
      tabindex: '-1', // keyboard users expand with Right/Left on the row
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
      'aria-label': (node.hidden ? 'Show on the page: ' : 'Hide on the page: ') + displayName(node),
      tabindex: '-1', // reachable from its row (see setStop); not a tab stop of its own
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
        tabindex: '-1', // roving: setStop() gives exactly one row tabindex 0
        'aria-level': String(depth + 1),
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
          focus: () => { setStop(row); actions.hover(node); },
          keydown: (e) => {
            // Keys that bubble up from the eye / toggle buttons are theirs.
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              actions.select(node);
            } else if (e.key === 'ArrowRight') {
              if (kids.length && !flat && !openNow) {
                e.preventDefault();
                setOpen(node, depth, true);
              } else if (kids.length && !flat && openNow) {
                const child = row.parentElement && row.parentElement.querySelector(':scope > .sec-group > .sec-item > .sec-row');
                if (child) { e.preventDefault(); child.focus(); }
              }
            } else if (e.key === 'ArrowLeft') {
              if (kids.length && !flat && openNow) {
                e.preventDefault();
                setOpen(node, depth, false);
              } else if (!flat) {
                const parentRow = row.parentElement && row.parentElement.parentElement && row.parentElement.parentElement.parentElement
                  && row.parentElement.parentElement.parentElement.querySelector(':scope > .sec-row');
                if (parentRow) { e.preventDefault(); parentRow.focus(); }
              }
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (e.altKey && !flat) keyboardMove(node, group, index, parentSelector, e.key === 'ArrowDown' ? 1 : -1);
              else stepFocus(row, e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              const rows = allRows();
              const to = e.key === 'Home' ? rows[0] : rows[rows.length - 1];
              if (to) to.focus();
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

  // ---- roving focus helpers ------------------------------------------------
  const allRows = () => Array.from(listWrap.querySelectorAll('.sec-row'));

  // Exactly one row (and its eye button) is a tab stop; the rest are reached
  // with the arrow keys, like any tree.
  function setStop(rowEl) {
    allRows().forEach((r) => {
      const on = r === rowEl;
      r.tabIndex = on ? 0 : -1;
      const eye = r.querySelector('.sec-eye');
      if (eye) eye.tabIndex = on ? 0 : -1;
    });
  }

  function stepFocus(fromRow, dir) {
    const rows = allRows();
    const to = rows[rows.indexOf(fromRow) + dir];
    if (to) to.focus();
  }

  // Rows that exist in the DOM but whose group is the one being keyboard-moved:
  // Alt+Up/Down is the keyboard equivalent of dragging a row among its siblings.
  function keyboardMove(node, group, index, parentSelector, dir) {
    const to = index + dir;
    const nodes = group._nodes || [];
    if (to < 0 || to >= nodes.length) return;
    emitReorder(node, group, parentSelector, index, to);
  }

  function emitReorder(node, group, parentSelector, from, to) {
    const nodes = group._nodes || [];
    const dest = nodes[to];
    const payload = {
      parentSelector,
      fromIndex: from,
      toIndex: to,
      // Stable identity, resolved by the guest independent of visual position.
      selector: node.selector,
      destSelector: dest ? dest.selector : null,
      placement: to > from ? 'after' : 'before',
    };
    if (group._parentNid != null) payload.parentId = group._parentNid;
    if (node.nid != null) payload.nodeId = node.nid;
    if (dest && dest.nid != null) payload.destId = dest.nid;
    if (typeof node.domIndex === 'number') payload.fromDomIndex = node.domIndex;
    actions.reorder(payload);
  }

  function emitMoveInto(node, target) {
    const nodes = (target.group && target.group._nodes) || [];
    // The slot is in the target's own list; the dragged node is never in it
    // (this is a cross-container move), so nodes[index] is what it lands before.
    const before = nodes[target.index] || null;
    const payload = {
      selector: node.selector,
      parentSelector: target.parentSelector,
      index: target.index,
    };
    if (node.nid != null) payload.nodeId = node.nid;
    if (target.group && target.group._parentNid != null) payload.parentId = target.group._parentNid;
    if (before) {
      payload.beforeSelector = before.selector;
      if (before.nid != null) payload.beforeId = before.nid;
    }
    actions.moveInto(payload);
  }

  function renderGroup(nodes, depth, parentSelector, parentNid) {
    const group = h('div', { class: 'sec-group', role: depth === 0 ? null : 'group' });
    group._parentSelector = parentSelector;
    group._parentNid = parentNid;
    group._nodes = nodes;
    nodes.forEach((node, i) => {
      const row = renderRow(node, group, i, depth, parentSelector, false);
      const item = h('div', { class: 'sec-item', role: 'none' }, [row]);
      item._row = row;
      item._node = node;
      if (isOpen(node, depth)) item.appendChild(renderGroup(node.children, depth + 1, node.selector, node.nid));
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

  // Re-rendering rebuilds every row, which would drop keyboard focus to <body>.
  // Remember which row (by selector) and control had it, and put it back.
  function render() {
    const active = document.activeElement;
    let saved = null;
    if (active && listWrap.contains(active)) {
      const rowEl = active.closest('.sec-row');
      if (rowEl && rowEl._node) {
        saved = { selector: rowEl._node.selector, which: active === rowEl ? 'row' : active.classList.contains('sec-eye') ? 'eye' : 'row' };
      }
    }
    renderTree();
    // One tab stop: the restored row, else the selected row, else the first.
    const rows = allRows();
    const stop = (saved && rows.find((r) => r._node.selector === saved.selector))
      || rows.find((r) => r.classList.contains('active'))
      || rows[0];
    if (stop) setStop(stop);
    if (saved && stop && (!document.activeElement || !listWrap.contains(document.activeElement))) {
      const hit = rows.find((r) => r._node.selector === saved.selector);
      if (hit) {
        const target = saved.which === 'eye' ? hit.querySelector('.sec-eye') || hit : hit;
        try { target.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
      }
    }
  }

  function renderTree() {
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
    listWrap.appendChild(renderGroup(sections, 0, tree.selector || 'body', tree.nid));
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
      emitReorder(d.node, d.group, d.parentSelector, d.index, to);
    } else if (d.target.parentSelector) {
      emitMoveInto(d.node, d.target);
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
