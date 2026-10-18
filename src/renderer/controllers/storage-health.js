// Storage-health presentation (pure). Input is caos.store.status():
//   { ok, problems:[{ name, file, state:'corrupt'|'unreadable'|..., readOnly, error:{message}|string|null,
//                     backupAvailable }], maintenance:{ errors:[{step,message}] } }
// A damaged file is read-only and never overwritten; the user chooses how to go on.

const baseName = (p) => String(p || '').split('\\').join('/').split('/').pop();
const errText = (e) => (e && typeof e === 'object' ? e.message : e) || '';

export function describeStorageHealth(health) {
  const problems = health && Array.isArray(health.problems) ? health.problems : [];
  const items = problems.map((p) => {
    const unreadable = p.state === 'unreadable';
    return {
      name: p.name,
      file: baseName(p.file) || String(p.name || ''),
      state: p.state || 'unknown',
      title: unreadable ? 'could not be read' : 'is damaged',
      error: String(errText(p.error)),
      // 'unreadable' means a lock or permissions problem: recovery would not be safe.
      canRestoreBackup: !unreadable && !!p.backupAvailable,
      canStartFresh: !unreadable,
      advice: unreadable
        ? 'The file may be fine but locked or not readable right now. Close other programs using it and restart Braiwser. Nothing was changed.'
        : p.backupAvailable
          ? 'Changes to it are not being saved. A recent backup exists.'
          : 'Changes to it are not being saved and there is no backup.',
    };
  });
  const maintenanceErrors = health && health.maintenance && Array.isArray(health.maintenance.errors)
    ? health.maintenance.errors.map((e) => `${e.step}: ${e.message}`)
    : [];
  return { damaged: items.length > 0, items, maintenanceErrors };
}

// caos.store.recover() result -> { ok, text }
export function describeRecovery(item, mode, result) {
  const what = item && item.file ? item.file : 'The file';
  if (result && result.recovered) {
    const src = result.from === 'backup' ? 'the last backup' : 'an empty file';
    return { ok: true, text: `${what} was restored from ${src}. The damaged copy was kept next to it.` };
  }
  const reason = result && result.reason;
  const text = reason === 'no-backup' ? `${what} has no backup to restore from.`
    : reason === 'unreadable' ? `${what} is locked or unreadable; nothing was changed.`
      : reason === 'already-ok' ? `${what} is already fine.`
        : `${what} could not be recovered${result && result.error ? ': ' + errText(result.error) : '.'}`;
  return { ok: reason === 'already-ok', text };
}
