// Braiwser — inspector.dom.js
// DOM identity helpers shared by the inspector's serializer and every handler
// that mutates structure (drag reorder, Layers/Sections reorder, move-into).
//
// The point of this module (RF-08, CE-11): there is exactly ONE definition of
// "which children count". The DOM-tree serializer, the Layers list, the arrange
// drag and the host-driven reorder handlers all index children through
// contentChildren(), so an index that the panel read off the tree means the same
// node when it comes back — however many <script>/<style>/<noscript> nodes or
// Braiwser overlay nodes sit among the siblings.
//
// Pure DOM, no IPC, CommonJS (the webview preload requires it by relative path).

'use strict';

// Tags that never appear in the tree and are never reorder targets.
const NON_CONTENT_TAGS = /^(script|style|noscript)$/i;

function isOwnUI(el) {
  try {
    return !!(el && el.closest && el.closest('[data-caos], #__caos_root'));
  } catch (_e) {
    return false;
  }
}

// One canonical "does this element count as a content child".
function isContentElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (NON_CONTENT_TAGS.test(el.nodeName || '')) return false;
  return !isOwnUI(el);
}

function contentChildren(parent, excludeEl) {
  if (!parent || !parent.children) return [];
  return Array.prototype.filter.call(parent.children, (c) => c !== excludeEl && isContentElement(c));
}

// Index among contentChildren (what the Sections / Layers panels display).
function contentIndex(parent, el) {
  return contentChildren(parent).indexOf(el);
}

// Real index among ALL element children (script/style/overlay nodes included).
function domIndex(parent, el) {
  return parent && parent.children ? Array.prototype.indexOf.call(parent.children, el) : -1;
}

// Insert `el` so it ends up at content index `index` of `parent` (the index it
// has once it is in place, i.e. counted over the children WITHOUT `el`), or
// at the end when `index` is past the last content child. The anchor is always
// a content child, so leading scripts never shift the result.
function insertAtContentIndex(parent, el, index) {
  const kids = contentChildren(parent, el);
  const i = Math.max(0, Math.min(kids.length, Number.isFinite(index) ? Math.floor(index) : kids.length));
  parent.insertBefore(el, kids[i] || null);
  return i;
}

// ---- stable node ids ----------------------------------------------------------
// The serializer stamps every node it reports with an opaque id (`nid`). A host
// that sends the id back is naming the exact node it saw, which a selector (an
// nth-of-type path that shifts under reordering) or an index cannot promise.
// Ids are per-document, never persisted, and held by WeakRef so they cannot keep
// removed nodes alive.
function createNodeRegistry() {
  const ids = new WeakMap();
  const byId = new Map();
  let counter = 0;
  const PRUNE_AT = 20000;

  function prune() {
    for (const [id, ref] of byId) {
      if (!ref.deref()) byId.delete(id);
    }
  }
  return {
    idFor(el) {
      let id = ids.get(el);
      if (id) return id;
      if (byId.size > PRUNE_AT) prune();
      id = 'n' + ++counter;
      ids.set(el, id);
      byId.set(id, new WeakRef(el));
      return id;
    },
    lookup(id) {
      if (typeof id !== 'string') return null;
      const ref = byId.get(id);
      const el = ref && ref.deref();
      return el && el.isConnected ? el : null;
    },
    size: () => byId.size,
  };
}

// Resolve a node the host named. Identity wins over position:
//   1. `<prefix>Id` / `nodeId` for the source (stamped by the serializer)
//   2. `<prefix>Selector` (`selector` for the source), accepted only if it is a
//      direct content child of `parent` when a parent is given
//   3. a real DOM index (`<prefix>DomIndex`) or content index (`<prefix>Index`)
//      — ONLY when the host sent no identity at all (legacy protocol).
// A named identity that no longer resolves is a rejection, never an index guess:
// a stale index is exactly how the wrong node used to get moved.
function resolveChild(doc, registry, parent, ref, prefix) {
  const idKey = prefix + 'Id';
  const selKey = prefix + 'Selector';
  // the source node is also spelled `nodeId` / `selector` in the host protocol
  const id = ref[idKey] != null ? ref[idKey] : prefix === 'from' ? ref.nodeId : null;
  const sel = ref[selKey] != null ? ref[selKey] : prefix === 'from' ? ref.selector : null;
  const named = id != null || sel != null;
  const ok = (el) => (el && isContentElement(el) && (!parent || el.parentElement === parent) ? el : null);
  if (id != null) {
    const el = ok(registry.lookup(id));
    if (el) return el;
  }
  if (sel) {
    try {
      const el = ok(doc.querySelector(sel));
      if (el) return el;
    } catch (_e) {
      /* invalid selector */
    }
  }
  if (named) return null;
  if (parent && Number.isInteger(ref[prefix + 'DomIndex'])) {
    return ok(parent.children[ref[prefix + 'DomIndex']]);
  }
  if (parent && Number.isInteger(ref[prefix + 'Index'])) {
    return contentChildren(parent)[ref[prefix + 'Index']] || null;
  }
  return null;
}

module.exports = {
  NON_CONTENT_TAGS,
  isOwnUI,
  isContentElement,
  contentChildren,
  contentIndex,
  domIndex,
  insertAtContentIndex,
  createNodeRegistry,
  resolveChild,
};
