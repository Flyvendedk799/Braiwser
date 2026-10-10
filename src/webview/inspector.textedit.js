// Braiwser — inspector.textedit.js
// Text editing that does not destroy the page (CE-09).
//
// Three separate problems lived in the old "snapshot textContent" approach:
//   1. An element with inline children (<p>Hello <strong>world</strong></p>) was
//      flattened to a single text node by Undo and by the panel's text field, so
//      the <strong>, nested links, and any listeners on them were gone.
//   2. Entering and leaving text mode without typing removed an existing
//      contenteditable attribute and the element's own outline / outline-offset /
//      user-select inline styles.
//   3. The panel path replaced textContent wholesale.
//
// So:
//   • captureTextState / restoreTextState  remember the EXACT child nodes of the
//     element and of every element below it, plus the data of each text node, and
//     put those very nodes (same identity, same listeners) back.
//   • applyTextDiff  turns "the new text of this element" into the smallest edit
//     of the existing text nodes — child elements are never removed or recreated.
//   • beginEditing / endEditing  save the editing-related attributes before the
//     temporary overrides and restore them verbatim, priorities included.
//
// Pure DOM, no IPC, CommonJS.

'use strict';

const MAX_STATE_NODES = 2000;

function isCharData(n) {
  return n.nodeType === 3 || n.nodeType === 4 || n.nodeType === 7 || n.nodeType === 8;
}

// Snapshot the subtree under `el`. Returns null when the subtree is too big to
// snapshot safely (the caller then refuses to edit rather than risk a lossy undo).
function captureTextState(el, opts) {
  const max = (opts && opts.maxNodes) || MAX_STATE_NODES;
  const elements = [];
  const texts = [];
  let count = 0;
  let bytes = 0;
  const stack = [el];
  while (stack.length) {
    const node = stack.pop();
    const kids = Array.prototype.slice.call(node.childNodes);
    elements.push({ el: node, children: kids });
    count += kids.length;
    if (count > max) return null;
    for (const k of kids) {
      if (k.nodeType === 1) stack.push(k);
      else if (isCharData(k)) {
        texts.push({ node: k, data: k.data });
        bytes += k.data.length;
      }
    }
  }
  return { el, elements, texts, bytes, text: el.textContent };
}

// Put the exact nodes back. Untouched nodes are left alone (no detach/re-attach,
// so iframes, media and custom elements are not disturbed unless they were
// really displaced).
function restoreTextState(state) {
  if (!state) return;
  for (const rec of state.elements) {
    const parent = rec.el;
    const want = rec.children;
    for (let i = 0; i < want.length; i++) {
      if (parent.childNodes[i] !== want[i]) parent.insertBefore(want[i], parent.childNodes[i] || null);
    }
    while (parent.childNodes.length > want.length) parent.removeChild(parent.lastChild);
  }
  for (const t of state.texts) {
    if (t.node.data !== t.data) t.node.data = t.data;
  }
}

// ---- panel path: new text in, existing nodes edited in place ----------------------
function collectTextNodes(el) {
  const out = [];
  (function walk(n) {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) out.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  })(el);
  return out;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

// Word-level diff of two strings -> hunks in OLD-string offsets:
// [{ at, del, ins }] meaning "delete `del` characters at `at`, insert `ins`".
// Words are diffed (so "world" -> "WORLD" stays inside the <strong> that holds it
// instead of the whole changed range collapsing into one text node); each hunk is
// then trimmed to the characters that really differ. Falls back to a single hunk
// when the inputs are too big for the table.
const MAX_DIFF_CELLS = 1000000;

function tokenize(s) {
  return s.match(/\s+|[^\s]+/g) || [];
}

function trimHunk(oldText, at, del, ins) {
  let p = 0;
  const max = Math.min(del, ins.length);
  while (p < max && oldText.charCodeAt(at + p) === ins.charCodeAt(p)) p++;
  if (p > 0 && isHighSurrogate(ins.charCodeAt(p - 1))) p--; // never split a pair
  let q = 0;
  const maxQ = max - p;
  while (q < maxQ && oldText.charCodeAt(at + del - 1 - q) === ins.charCodeAt(ins.length - 1 - q)) q++;
  if (q > 0 && isLowSurrogate(ins.charCodeAt(ins.length - q))) q--;
  return { at: at + p, del: del - p - q, ins: ins.slice(p, ins.length - q) };
}

function diffHunks(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  let aOff = 0;
  for (let i = 0; i < pre; i++) aOff += ta[i].length;
  let bOff = aOff; // identical prefixes
  const hunks = [];
  const push = (at, del, ins) => {
    if (del || ins) hunks.push(trimHunk(a, at, del, ins));
  };
  if (!ma.length || !mb.length || ma.length * mb.length > MAX_DIFF_CELLS) {
    push(aOff, ma.join('').length, mb.join(''));
    return hunks.filter((h) => h.del || h.ins);
  }
  // LCS table over the middle tokens
  const n = ma.length;
  const m = mb.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let at = aOff;
  let del = 0;
  let ins = '';
  const flush = () => {
    push(at, del, ins);
    at += del;
    del = 0;
    ins = '';
  };
  while (i < n || j < m) {
    if (i < n && j < m && ma[i] === mb[j]) {
      flush();
      at += ma[i].length;
      i++;
      j++;
    } else if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) {
      ins += mb[j++];
    } else {
      del += ma[i++].length;
    }
  }
  flush();
  return hunks.filter((h) => h.del || h.ins);
}

// Apply one hunk to the text nodes. `spans` carry the ORIGINAL offsets.
function applyHunk(spans, at, del, ins) {
  const delEnd = at + del;
  let host = null;
  if (del > 0) host = spans.find((sp) => sp.start <= at && at < sp.end) || null;
  else if (at > 0) host = spans.find((sp) => sp.start < at && at <= sp.end) || null;
  else host = spans[0];
  if (!host) host = spans[spans.length - 1];
  let inserted = false;
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i];
    const a = Math.max(at, sp.start);
    const b = Math.min(delEnd, sp.end);
    if (b <= a) continue;
    if (sp === host) {
      sp.node.replaceData(a - sp.start, b - a, ins);
      inserted = true;
    } else {
      sp.node.deleteData(a - sp.start, b - a);
    }
  }
  if (!inserted && ins) {
    const off = Math.max(0, Math.min(host.node.data.length, at - host.start));
    host.node.insertData(off, ins);
  }
}

// Replace the text content of `el` with `newText` by editing only the text nodes
// that cover what changed. Child elements are never removed or recreated.
// Returns true if anything changed.
function applyTextDiff(el, newText) {
  const nodes = collectTextNodes(el);
  const oldText = nodes.map((n) => n.data).join('');
  if (oldText === newText) return false;
  if (!nodes.length) {
    el.appendChild(el.ownerDocument.createTextNode(newText));
    return true;
  }
  const spans = [];
  let at = 0;
  for (const n of nodes) {
    spans.push({ node: n, start: at, end: at + n.data.length });
    at += n.data.length;
  }
  const hunks = diffHunks(oldText, newText);
  // last hunk first: earlier offsets stay valid
  for (let i = hunks.length - 1; i >= 0; i--) applyHunk(spans, hunks[i].at, hunks[i].del, hunks[i].ins);
  return true;
}

// ---- the temporary "you are typing here" overrides ---------------------------------
const EDIT_PROPS = ['outline', 'outline-offset', 'user-select'];

// Remember every attribute / inline declaration the editing mode is about to
// override, then apply the overrides. The returned token restores them exactly.
function beginEditing(el, opts) {
  const color = (opts && opts.color) || '#c792ea';
  const token = {
    contenteditable: el.getAttribute('contenteditable'),
    style: el.getAttribute('style'),
    props: {},
    applied: null,
  };
  for (const p of EDIT_PROPS) {
    token.props[p] = { value: el.style.getPropertyValue(p), priority: el.style.getPropertyPriority(p) };
  }
  el.setAttribute('contenteditable', 'plaintext-only');
  el.style.setProperty('outline', '2px solid ' + color);
  el.style.setProperty('outline-offset', '1px');
  el.style.setProperty('user-select', 'text'); // the page-wide lock stops here
  token.applied = el.getAttribute('style');
  return token;
}

function endEditing(el, token) {
  if (!token) return;
  if (token.contenteditable == null) el.removeAttribute('contenteditable');
  else el.setAttribute('contenteditable', token.contenteditable);

  if (el.getAttribute('style') === token.applied) {
    // Nobody touched the style while we were typing: put the attribute back
    // byte-for-byte (including declarations the CSSOM would reformat).
    if (token.style == null) el.removeAttribute('style');
    else el.setAttribute('style', token.style);
    return;
  }
  // Somebody else changed the style meanwhile — undo only our own overrides.
  for (const p of EDIT_PROPS) {
    const orig = token.props[p];
    if (orig.value) el.style.setProperty(p, orig.value, orig.priority);
    else el.style.removeProperty(p);
  }
  if (token.style == null && !el.getAttribute('style')) el.removeAttribute('style');
}

module.exports = {
  MAX_STATE_NODES,
  captureTextState,
  restoreTextState,
  applyTextDiff,
  beginEditing,
  endEditing,
  EDIT_PROPS,
};
