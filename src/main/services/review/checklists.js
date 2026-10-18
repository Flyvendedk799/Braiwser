// Reviewer checklists and agency client-pack / static HTML report builders.
const { REVIEW_CHECKLISTS } = require('../../config');
const { toMarkdown } = require('../export/markdown');

function listChecklists() {
  return REVIEW_CHECKLISTS.slice();
}

function checklistSessionNotes(checklistId) {
  const cl = REVIEW_CHECKLISTS.find((c) => c.id === checklistId);
  if (!cl) return [];
  return cl.items.map((item, i) => ({
    kind: 'element',
    action: 'comment',
    note: `[Checklist: ${cl.label}] ${item}`,
    priority: 'normal',
    status: 'open',
    sortOrder: i,
    target: { selector: 'body', text: item },
  }));
}

// Notes may reach a client only when the reviewer explicitly marked them 'client'.
// Anything else - 'internal', missing (legacy), or unrecognised - is private: the
// repository stores every non-'client' value as 'internal', and a private note must
// never be published by default. There is deliberately NO fallback to "all notes".
function isClientVisible(annotation) {
  return !!annotation && typeof annotation === 'object' && annotation.visibility === 'client';
}

// The ONE canonical client-visible list. Every client deliverable (Markdown pack,
// HTML report rows, counts) is derived from this and nothing else.
function clientVisibleAnnotations(annotations) {
  return (Array.isArray(annotations) ? annotations : []).filter(isClientVisible);
}

function buildClientPack({ session, annotations, project, settings, recordingMeta }) {
  const agency = (settings && settings.agency) || {};
  const notes = clientVisibleAnnotations(annotations);
  const md = toMarkdown(session || {}, notes, null);
  const title = `${agency.name ? agency.name + ' — ' : ''}${session && session.name ? session.name : 'Review'}`;
  return {
    title,
    markdown: [
      `# ${title}`,
      '',
      agency.name ? `Prepared by **${agency.name}**` : '',
      session && session.url ? `URL: ${session.url}` : '',
      recordingMeta ? `Journey: ${recordingMeta.name || 'Recording'}` : '',
      '',
      md,
    ].filter(Boolean).join('\n'),
    noteCount: notes.length,
    agencyName: agency.name || '',
    hasLogo: !!(agency.logoDataUrl),
  };
}

// A viewport dimension is shown only when it is a finite, bounded number; anything
// else (strings, objects, NaN, huge values) renders as nothing rather than as markup.
const MAX_DIMENSION = 20000;
function viewportLabel(viewport) {
  if (!viewport || typeof viewport !== 'object') return '';
  const dim = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_DIMENSION ? String(Math.round(v)) : '');
  const w = dim(viewport.w);
  const h = dim(viewport.h);
  return w && h ? `${w}×${h}` : '';
}

function buildHtmlReport({ session, annotations, project, settings }) {
  const pack = buildClientPack({ session, annotations, project, settings });
  const notes = clientVisibleAnnotations(annotations);
  const rows = notes.map((a, i) => {
    const sel = (a.target && (a.target.selector || a.target.id)) || '';
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(a.action || '')}</td>
      <td>${escapeHtml(a.priority || '')}</td>
      <td>${escapeHtml(a.visibility)}</td>
      <td>${escapeHtml(a.note || '')}</td>
      <td><code>${escapeHtml(sel)}</code></td>
      <td>${escapeHtml(viewportLabel(a.viewport))}</td>
    </tr>`;
  }).join('\n');

  // The report is static: no script, no remote loads. The CSP keeps it that way even
  // if a metadata field ever slipped past escaping.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/>
<title>${escapeHtml(pack.title)}</title>
<style>
  :root { color-scheme: light; --ink:#14201a; --muted:#5c6b63; --line:#d7e0d9; --bg:#f4f7f4; --accent:#1f6f4a; }
  body { margin:0; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; color:var(--ink); background:var(--bg); }
  header { padding:48px 7vw 28px; background:linear-gradient(160deg,#1f6f4a 0%,#0e3d2a 100%); color:#f4f7f4; }
  h1 { margin:0 0 8px; font-size:clamp(28px,4vw,44px); letter-spacing:-0.03em; }
  .sub { opacity:.85; }
  main { padding:28px 7vw 64px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  code { font-size:12px; }
  footer { padding:24px 7vw; color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(pack.title)}</h1>
  <div class="sub">${escapeHtml((session && session.url) || '')} · ${pack.noteCount} ${pack.noteCount === 1 ? 'finding' : 'findings'}</div>
</header>
<main>
  <table>
    <thead><tr><th>#</th><th>Action</th><th>Priority</th><th>Visibility</th><th>Note</th><th>Selector</th><th>Viewport</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No client-visible notes</td></tr>'}</tbody>
  </table>
</main>
<footer>Generated by Braiwser · read-only client report</footer>
</body>
</html>`;

  return {
    defaultName: `${slug(pack.title)}.html`,
    content: html,
    mime: 'text/html',
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slug(s) {
  return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
}

module.exports = {
  listChecklists, checklistSessionNotes, buildClientPack, buildHtmlReport,
  clientVisibleAnnotations, isClientVisible, viewportLabel, escapeHtml,
};
