// Braiwser — inspector.layers.js
// Overlap detection for the Layers list. The old code compared every sibling
// with every other sibling (O(n^2) per pick); on a flat list of a few thousand
// nodes that froze the page.
//
// This is a sweep over the boxes sorted by left edge: a box is only ever tested
// against the boxes whose horizontal span still reaches it. Work is also capped
// (maxSteps) and the result says honestly whether the cap was hit, so a caller
// can tell "no overlap" from "stopped looking".
//
// Semantics match the previous rectsOverlap(): two boxes "overlap" when their
// intersection is more than `minRatio` of the smaller box's area.

'use strict';

const DEFAULT_MAX_STEPS = 400000;

function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;
  return inter / minArea;
}

// rects: [{left,right,top,bottom,width,height}] -> { overlapping: boolean[], complete, steps }
function computeOverlaps(rects, opts) {
  const o = opts || {};
  const minRatio = o.minRatio != null ? o.minRatio : 0.3;
  const maxSteps = o.maxSteps != null ? o.maxSteps : DEFAULT_MAX_STEPS;
  const n = rects.length;
  const overlapping = new Array(n).fill(false);
  const order = [];
  for (let i = 0; i < n; i++) {
    const r = rects[i];
    // zero-area (display:none, collapsed) boxes can never intersect anything
    if (r && r.right > r.left && r.bottom > r.top) order.push(i);
  }
  order.sort((a, b) => rects[a].left - rects[b].left);

  let steps = 0;
  let complete = true;
  let active = [];
  outer: for (const i of order) {
    const r = rects[i];
    // drop boxes that end before this one starts: they cannot touch it, and
    // (sorted by left) cannot touch any later box either
    if (active.length) {
      const keep = [];
      for (const j of active) if (rects[j].right > r.left) keep.push(j);
      active = keep;
    }
    for (const j of active) {
      if (++steps > maxSteps) {
        complete = false;
        break outer;
      }
      if (overlapping[i] && overlapping[j]) continue;
      if (overlapRatio(r, rects[j]) > minRatio) {
        overlapping[i] = true;
        overlapping[j] = true;
      }
    }
    active.push(i);
  }
  return { overlapping, complete, steps };
}

module.exports = { computeOverlaps, overlapRatio, DEFAULT_MAX_STEPS };
