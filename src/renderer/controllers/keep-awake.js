// Keep a guest webContents unthrottled while a long-running operation (replay,
// recording, audit) may run in a tab that is hidden.
//
// The preload API holds ONE guest at a time (`power.keepAwake(id)`, null
// releases), so overlapping operations are reference-counted here: the most
// recent hold wins, and releasing one re-holds the previous one instead of
// dropping everything. Release is idempotent and safe in `finally`.
export function createAwakeHolder(power) {
  const holds = new Map(); // token -> webContentsId (insertion order)
  let current = null;
  let chain = Promise.resolve();

  const apply = async () => {
    const ids = [...holds.values()];
    const want = ids.length ? ids[ids.length - 1] : null;
    if (want === current) return;
    current = want;
    try { if (power && typeof power.keepAwake === 'function') await power.keepAwake(want); } catch (_e) { /* best effort */ }
  };
  const sync = () => { chain = chain.then(apply, apply); return chain; };

  return {
    // getId: () => webContentsId. Returns a release() function.
    acquire(getId) {
      let id;
      try { id = getId(); } catch (_e) { return () => Promise.resolve(); }
      if (!Number.isInteger(id)) return () => Promise.resolve();
      const token = Symbol('hold');
      holds.set(token, id);
      sync();
      let released = false;
      return () => {
        if (released) return chain;
        released = true;
        holds.delete(token);
        return sync();
      };
    },
    size: () => holds.size,
    settled: () => chain,
  };
}
