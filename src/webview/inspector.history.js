// Braiwser — inspector.history.js
// Size budget for the undo / redo stacks. Each entry holds live DOM references
// (the edited element, closures over snapshots, text states), so an unbounded
// stack on a long editing session — or on a single-page app that keeps running
// for hours — is a slow leak. Limits are per document: the preload runs once per
// document, so a full navigation drops everything with it; same-document
// navigations are handled by pruneDisconnected().
//
// Pure functions over plain arrays, so they unit-test without a DOM.

'use strict';

const DEFAULT_LIMITS = { maxEntries: 100, maxBytes: 1024 * 1024 };

// A rough cost: the annotation as it would be shipped, plus whatever the entry
// says it retains (text states, snapshots).
function entrySize(entry) {
  if (!entry) return 0;
  if (typeof entry.size === 'number') return entry.size;
  let size = 256; // closures + element reference overhead
  try {
    size += JSON.stringify(entry.ann || {}).length * 2;
  } catch (_e) {
    /* circular / unserialisable — ignore */
  }
  size += Number(entry.cost) || 0;
  entry.size = size;
  return size;
}

function totalSize(stack) {
  let total = 0;
  for (const e of stack) total += entrySize(e);
  return total;
}

// Drop the OLDEST entries (front of the stack) until the stack is within both
// limits. The newest entry is always kept, so the last edit stays undoable even
// when it alone is over budget. Returns the dropped entries (oldest first).
function trimStack(stack, limits) {
  const l = Object.assign({}, DEFAULT_LIMITS, limits || {});
  const dropped = [];
  let total = totalSize(stack);
  while (stack.length > 1 && (stack.length > l.maxEntries || total > l.maxBytes)) {
    const e = stack.shift();
    total -= entrySize(e);
    dropped.push(e);
  }
  return dropped;
}

// Remove entries whose element is gone from the document (an SPA route change
// re-rendered it away): there is nothing left for undo to act on.
function pruneDisconnected(stack, isAlive) {
  const dropped = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!isAlive(stack[i])) dropped.unshift(stack.splice(i, 1)[0]);
  }
  return dropped;
}

module.exports = { DEFAULT_LIMITS, entrySize, totalSize, trimStack, pruneDisconnected };
