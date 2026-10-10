// Bulk operations that count what really happened. A failure is kept (with its
// error) so the UI can show it and offer a retry instead of announcing
// `list.length` successes.

// Run `fn(item)` for each item sequentially; never throws.
//   -> { ok:[{item,result}], failed:[{item,error}] }
export async function runBulk(list, fn) {
  const ok = [];
  const failed = [];
  for (const item of list || []) {
    try {
      ok.push({ item, result: await fn(item) });
    } catch (e) {
      failed.push({ item, error: (e && e.message) || String(e) });
    }
  }
  return { ok, failed };
}

// Message + tone for a bulk result, e.g. verb "Updated" / noun "note".
export function describeBulk(verb, noun, res) {
  const n = res.ok.length;
  const f = res.failed.length;
  const plural = (c) => `${c} ${noun}${c === 1 ? '' : 's'}`;
  if (!f) return { tone: 'success', text: `${verb} ${plural(n)}` };
  if (!n) return { tone: 'error', text: `${verb} none — ${plural(f)} failed` };
  return { tone: 'warn', text: `${verb} ${plural(n)}; ${f} failed` };
}

// The shape the Notes panel reads back from bulkUpdate / bulkRemove:
// { failed: [{ id, error }] } (empty when everything succeeded). Keeps the full
// run result alongside for callers that want it.
export function toPanelResult(res) {
  const failed = (res.failed || []).map((f) => ({ id: f.item && f.item.id, error: f.error }));
  return { failed, ok: res.ok, total: res.ok.length + res.failed.length };
}
