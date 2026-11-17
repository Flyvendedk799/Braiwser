// Dialogs that say what an import or export did NOT carry over. Both are pure
// views of the result object the main process returned.
import { h, modal } from '../lib/dom.js';

function noteList(items) {
  return h('ul', {}, items.map((t) => h('li', { text: t })));
}

// What a bundle import dropped or altered (import is validated, never silent).
export function showImportReport(res) {
  const dropped = (res.dropped || []).map((d) => `${d.type} #${(d.index || 0) + 1}: ${d.reason}`);
  if ((res.droppedCount || 0) > dropped.length) dropped.push(`…and ${res.droppedCount - dropped.length} more`);
  const parts = [];
  if (dropped.length) parts.push(h('h4', { text: 'Not imported' }), noteList(dropped));
  if (res.warnings && res.warnings.length) parts.push(h('h4', { text: 'Changed on import' }), noteList(res.warnings));
  modal({ title: 'Import was partial', width: 520, body: h('div', {}, parts), actions: [{ label: 'Close', kind: 'primary' }] });
}

// Playwright export: say which steps could not be exported and that secrets
// are supplied at runtime, never written into the file.
export function showPlaywrightExportNotes(out) {
  const skipped = (out && out.skipped) || [];
  const secrets = (out && out.secrets) || [];
  if (!skipped.length && !secrets.length) return;
  const parts = [];
  if (skipped.length) {
    parts.push(h('h4', { text: `${skipped.length} step${skipped.length === 1 ? '' : 's'} not exported — the test fails at each` }),
      noteList(skipped.slice(0, 12).map((s2) => (s2.index < 0 ? 'Start URL' : `Step ${s2.index + 1}${s2.type ? ' (' + s2.type + ')' : ''}`) + ': ' + s2.reason)));
  }
  if (secrets.length) {
    parts.push(h('h4', { text: 'Secrets are not in the file' }),
      h('p', { class: 'field-hint', text: 'Set these environment variables before running the test:' }), noteList(secrets));
  }
  modal({ title: 'Playwright export notes', width: 520, body: h('div', {}, parts), actions: [{ label: 'Close', kind: 'primary' }] });
}
