// Local, offline synthesis used when no API key is configured. It produces a
// genuinely useful result from the annotations alone (no model call) so the AI
// tab works fully offline. Output is clearly labelled as locally generated.
const { toMarkdown } = require('../export/markdown');
const { toPrompt } = require('../export/prompt');

const NOTE = '> ⚙️ Generated locally (no API key). Add a key in Settings for AI-quality output.\n';

function byTag(annotations) {
  const groups = {};
  for (const a of annotations) (groups[a.action] = groups[a.action] || []).push(a);
  return groups;
}

function summary(session, annotations) {
  const groups = byTag(annotations);
  const open = annotations.filter((a) => (a.status || 'open') === 'open').length;
  const high = annotations.filter((a) => a.priority === 'high' || a.priority === 'critical').length;
  const lines = [];
  lines.push(`# Summary — ${session ? session.title || session.name : 'Review'}`);
  lines.push('');
  lines.push(`**${annotations.length}** notes · **${open}** open · **${high}** high/critical priority.`);
  lines.push('');
  lines.push('By action:');
  for (const [tag, items] of Object.entries(groups)) lines.push(`- **${tag}** — ${items.length}`);
  lines.push('');
  lines.push('Top items:');
  annotations
    .slice()
    .sort((a, b) => prRank(b.priority) - prRank(a.priority))
    .slice(0, 8)
    .forEach((a, i) => lines.push(`${i + 1}. [${a.action}] ${a.note}`));
  return lines.join('\n');
}

function cluster(session, annotations) {
  const groups = byTag(annotations);
  const lines = [`# Notes grouped by theme — ${session ? session.title || session.name : 'Review'}`, ''];
  for (const [tag, items] of Object.entries(groups)) {
    lines.push(`## ${tag} (${items.length})`);
    items.forEach((a) => {
      const where = a.kind === 'element' ? a.target && a.target.selector : 'region';
      lines.push(`- ${a.note} — \`${where || '?'}\``);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function prRank(p) {
  return { critical: 3, high: 2, normal: 1, low: 0 }[p] ?? 1;
}

function synthesize(task, { session, annotations }) {
  let body;
  switch (task) {
    case 'transcribe': body = toMarkdown(session, annotations); break;
    case 'prompt': body = toPrompt(session, annotations); break;
    case 'summary': body = summary(session, annotations); break;
    case 'cluster': body = cluster(session, annotations); break;
    case 'suggest-fix': body = 'Local mode cannot propose code fixes — add an API key in Settings to use suggest-fix.'; break;
    default: body = toMarkdown(session, annotations);
  }
  return NOTE + '\n' + body;
}

module.exports = { synthesize };
