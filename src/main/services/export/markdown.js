// Markdown exporter — turns a review session + its annotations into a clean,
// human-readable review document. Pure function, no I/O, no AI.

// Human labels for the fixed action tag set (see ../config ACTION_TAGS).
const ACTION_LABELS = {
  remove: 'Remove',
  change: 'Change',
  fix: 'Fix',
  add: 'Add',
  question: 'Question',
  comment: 'Comment',
};

// A short, stable header for an annotation: "#3 — Fix".
function annotationHeading(index, annotation) {
  const label = ACTION_LABELS[annotation.action] || annotation.action || 'Note';
  return `${index}. ${label}`;
}

// Describe the target of an annotation (element selector or region box) as a
// list of Markdown bullet lines. Only emits fields that are actually present.
function describeTarget(annotation) {
  const lines = [];
  const t = annotation.target || {};

  if (annotation.kind === 'region') {
    const box = t.box || {};
    lines.push(
      `- **Region:** x=${box.x ?? '?'}, y=${box.y ?? '?'}, ` +
        `w=${box.w ?? '?'}, h=${box.h ?? '?'}`
    );
    return lines;
  }

  // Element target.
  if (t.selector) lines.push(`- **Selector:** \`${t.selector}\``);
  if (t.tag) lines.push(`- **Tag:** \`${t.tag}\``);
  if (t.id) lines.push(`- **Element id:** \`#${t.id}\``);
  if (Array.isArray(t.classes) && t.classes.length) {
    lines.push(`- **Classes:** \`${t.classes.join(' ')}\``);
  }
  if (t.text) lines.push(`- **Text:** "${truncate(t.text, 200)}"`);

  const attrs = t.attrs || {};
  if (attrs.href) lines.push(`- **href:** ${attrs.href}`);
  if (attrs.src) lines.push(`- **src:** ${attrs.src}`);
  if (attrs.alt) lines.push(`- **alt:** ${attrs.alt}`);
  if (attrs.role) lines.push(`- **role:** ${attrs.role}`);
  if (attrs.ariaLabel) lines.push(`- **aria-label:** ${attrs.ariaLabel}`);

  const box = t.box;
  if (box) {
    lines.push(
      `- **Box:** x=${box.x ?? '?'}, y=${box.y ?? '?'}, ` +
        `w=${box.w ?? '?'}, h=${box.h ?? '?'}`
    );
  }
  return lines;
}

function truncate(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Build the document title from the session's title or URL.
function documentTitle(session) {
  const s = session || {};
  if (s.title) return s.title;
  if (s.name) return s.name;
  if (s.url) return s.url;
  return 'UI Review';
}

function toMarkdown(session, annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  const out = [];

  out.push(`# UI Review — ${documentTitle(session)}`);
  out.push('');

  // Metadata block.
  if (session && session.url) out.push(`**URL:** ${session.url}`);
  out.push(`**Annotations:** ${list.length}`);
  out.push(`**Exported:** ${new Date().toISOString()}`);
  out.push('');

  if (list.length === 0) {
    out.push('_No annotations in this session yet._');
    out.push('');
    return out.join('\n');
  }

  // Group annotations by action so related notes sit together, while still
  // numbering every item globally for easy reference.
  const order = ['remove', 'change', 'fix', 'add', 'question', 'comment'];
  const groups = new Map();
  for (const a of list) {
    const key = a.action || 'comment';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  // Stable group ordering: known tags first (in canonical order), then any
  // unknown tags alphabetically.
  const groupKeys = [
    ...order.filter((k) => groups.has(k)),
    ...[...groups.keys()].filter((k) => !order.includes(k)).sort(),
  ];

  let index = 1;
  for (const key of groupKeys) {
    const label = ACTION_LABELS[key] || key;
    out.push(`## ${label}`);
    out.push('');

    for (const a of groups.get(key)) {
      out.push(`### ${annotationHeading(index, a)}`);
      out.push('');

      // Target description.
      const targetLines = describeTarget(a);
      for (const line of targetLines) out.push(line);
      if (targetLines.length) out.push('');

      // The note itself.
      if (a.note) {
        out.push(a.note.trim());
        out.push('');
      }

      // Status & priority footer.
      out.push(
        `_Status: ${a.status || 'open'} · Priority: ${a.priority || 'normal'}_`
      );
      out.push('');

      index += 1;
    }
  }

  return out.join('\n').replace(/\n+$/, '\n');
}

module.exports = { toMarkdown };
