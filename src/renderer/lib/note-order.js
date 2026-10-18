// Reorder helpers for the Notes list.

// A filtered view only shows some notes, so its drag-reorder yields the new
// order of the VISIBLE ids. Merge that into the full order: the slots the
// visible notes occupy are refilled in their new order and hidden notes stay
// exactly where they were. Always returns every id in `fullIds` once.
export function mergeFilteredOrder(fullIds, visibleOrder) {
  const full = Array.from(fullIds || []);
  const present = new Set(full);
  const seen = new Set();
  const queue = [];
  for (const id of visibleOrder || []) {
    if (present.has(id) && !seen.has(id)) { seen.add(id); queue.push(id); }
  }
  let k = 0;
  return full.map((id) => (seen.has(id) ? queue[k++] : id));
}
