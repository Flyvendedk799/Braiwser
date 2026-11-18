// Storage health dialog.
// A data file that is damaged or unreadable is held read-only (never overwritten)
// by the main process, so edits to it would not be saved. Say so up front and
// let the user choose how to continue. Dismissable, not hidden: it re-checks on
// the next launch.
//
// `api` is the preload bridge (store.status / store.recover); `reload` re-reads
// everything the shell shows after a recovery changed what is on disk.
import { h, toast, confirmDialog, modal } from '../lib/dom.js';
import { describeStorageHealth, describeRecovery } from '../controllers/storage-health.js';

export function createStorageHealthCheck({ api, reload }) {
  let healthModal = null;
  async function check() {
    let health;
    try { health = await api.store.status(); } catch (e) { console.warn('[store] status failed: ' + ((e && e.message) || e)); return; }
    const view = describeStorageHealth(health);
    if (!view.damaged) {
      if (view.maintenanceErrors.length) console.warn('[store] maintenance: ' + view.maintenanceErrors.join('; '));
      return;
    }
    openStorageHealthModal(view);
  }

  function openStorageHealthModal(view) {
    if (healthModal) { try { healthModal.close(); } catch (_e) { /* ignore */ } healthModal = null; }
    const body = h('div', { class: 'storage-health' }, [
      h('p', { text: 'Some of your saved data could not be loaded safely. Braiwser has not changed those files, and edits to them are not being saved until you choose how to continue.' }),
      ...view.items.map((it) => {
        const row = h('div', { class: 'storage-health-item', style: { margin: '10px 0', padding: '10px', border: '1px solid var(--border, #444)', borderRadius: '8px' } }, [
          h('div', { style: { fontWeight: '600' }, text: it.file + ' ' + it.title }),
          it.error ? h('div', { class: 'field-hint', text: it.error }) : null,
          h('div', { class: 'field-hint', text: it.advice }),
        ]);
        const btns = h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } });
        const run = async (mode, confirmText) => {
          if (confirmText && !(await confirmDialog({ title: 'Start with an empty file?', message: confirmText, confirmLabel: 'Start fresh', danger: true }))) return;
          let outcome;
          try { outcome = describeRecovery(it, mode, await api.store.recover(it.name, mode)); }
          catch (e) { outcome = { ok: false, text: 'Recovery failed: ' + ((e && e.message) || e) }; }
          toast(outcome.text, outcome.ok ? 'success' : 'error', 6000);
          await reload();
          const left = describeStorageHealth(await api.store.status().catch(() => null));
          if (left.damaged) openStorageHealthModal(left); else if (healthModal) { healthModal.close(); healthModal = null; }
        };
        if (it.canRestoreBackup) btns.appendChild(h('button', { class: 'btn btn-sm btn-primary', text: 'Restore from backup', on: { click: () => run('backup') } }));
        if (it.canStartFresh) {
          btns.appendChild(h('button', {
            class: 'btn btn-sm btn-danger',
            text: 'Start fresh',
            title: 'The damaged file is renamed and kept, not deleted',
            on: { click: () => run('empty', `This replaces ${it.file} with an empty file. The damaged copy is renamed and kept next to it, so it can still be recovered by hand.`) },
          }));
        }
        if (btns.childNodes.length) row.appendChild(btns);
        return row;
      }),
      view.maintenanceErrors.length ? h('div', { class: 'field-hint', text: 'Also: ' + view.maintenanceErrors.join('; ') }) : null,
    ]);
    healthModal = modal({
      title: 'Saved data needs attention',
      width: 520,
      body,
      actions: [{ label: 'Dismiss for now', kind: 'ghost' }],
      onClose: () => { healthModal = null; },
    });
  }

  return { check };
}
