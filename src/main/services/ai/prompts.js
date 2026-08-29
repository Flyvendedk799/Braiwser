// Prompt builder for AI tasks. Produces provider-neutral { system, user }
// string pairs that either the Claude or OpenAI client can consume directly.
//
// Tasks:
//   transcribe   — polish raw annotations into a structured Markdown review
//   prompt       — produce a precise change-request prompt for a coding agent
//   cluster      — group related annotations into themes, ordered by importance
//   summary      — concise executive summary of UI state + top issues
//   suggest-fix  — propose a concrete code fix for a single annotation

// Strong shared persona for all tasks.
const BASE_SYSTEM =
  'You are an expert frontend and UX engineer reviewing a web user interface. ' +
  'You write clearly and precisely, ground every statement in the provided ' +
  'annotations, and never invent UI details that are not present in the input. ' +
  'You think in terms of concrete, actionable changes (CSS selectors, ' +
  'component edits, copy changes) rather than vague advice.';

// Per-task system addendum.
const TASK_SYSTEM = {
  transcribe:
    'Task: rewrite the raw review annotations into a polished, well-structured ' +
    'Markdown document. Group related items under clear headings, fix grammar ' +
    'and phrasing, and preserve every distinct point. Output Markdown only.',
  prompt:
    'Task: turn the review annotations into a precise, imperative change-request ' +
    'prompt addressed to a coding agent. Number each change, state the action, ' +
    'the exact target (CSS selector with element text, or region box), and what ' +
    'to do. The output must be directly actionable by an engineer.',
  cluster:
    'Task: group the related annotations into a small number of coherent themes. ' +
    'Return Markdown with one heading per theme, ordered from most to least ' +
    'important, and list the relevant items under each heading.',
  summary:
    'Task: write a concise executive summary (a few short paragraphs or a tight ' +
    'bullet list) of the overall state of the UI and the top issues, prioritized ' +
    'by impact. Be specific and avoid filler.',
  'suggest-fix':
    'Task: for the single annotation provided, propose a concrete code fix. Give ' +
    'a short explanation of the cause and the fix, then a fenced code block with ' +
    'the suggested change. If page HTML is provided, ground the fix in it.',
};

// Human label per action tag, reused when rendering annotations into text.
const ACTION_LABELS = {
  remove: 'Remove',
  change: 'Change',
  fix: 'Fix',
  add: 'Add',
  question: 'Question',
  comment: 'Comment',
};

function truncate(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Render a single annotation as a readable, compact text block.
function renderAnnotation(a, index) {
  const lines = [];
  const label = ACTION_LABELS[a.action] || a.action || 'Note';
  lines.push(`${index}. [${label}] (${a.kind || 'element'})`);

  const t = a.target || {};
  if (a.kind === 'region') {
    const box = t.box || {};
    lines.push(
      `   Region: x=${box.x ?? '?'}, y=${box.y ?? '?'}, w=${box.w ?? '?'}, h=${box.h ?? '?'}`
    );
  } else {
    if (t.selector) lines.push(`   Selector: ${t.selector}`);
    if (t.tag) lines.push(`   Tag: <${t.tag}>`);
    if (t.id) lines.push(`   Id: #${t.id}`);
    if (Array.isArray(t.classes) && t.classes.length) {
      lines.push(`   Classes: ${t.classes.join(' ')}`);
    }
    if (t.text) lines.push(`   Text: "${truncate(t.text, 160)}"`);
    const attrs = t.attrs || {};
    if (attrs.href) lines.push(`   href: ${attrs.href}`);
    if (attrs.src) lines.push(`   src: ${attrs.src}`);
    if (attrs.alt) lines.push(`   alt: ${attrs.alt}`);
    if (attrs.role) lines.push(`   role: ${attrs.role}`);
    if (attrs.ariaLabel) lines.push(`   aria-label: ${attrs.ariaLabel}`);
  }

  if (a.viewport && a.viewport.w && a.viewport.id !== 'fit') {
    lines.push(`   Viewport: ${a.viewport.label} ${a.viewport.w}x${a.viewport.h}`);
  }
  if (a.note) lines.push(`   Note: ${a.note.trim()}`);
  lines.push(`   Status: ${a.status || 'open'} · Priority: ${a.priority || 'normal'}`);
  return lines.join('\n');
}

// Render the session header lines used by most tasks.
function renderSessionHeader(session) {
  const lines = [];
  const title = (session && (session.title || session.name)) || 'UI Review';
  lines.push(`Page: ${title}`);
  if (session && session.url) lines.push(`URL: ${session.url}`);
  return lines.join('\n');
}

// Render the full annotation list as a numbered text block.
function renderAnnotations(annotations) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (list.length === 0) return '(no annotations)';
  return list.map((a, i) => renderAnnotation(a, i + 1)).join('\n\n');
}

// task: string id
// context: { session, annotations, context }
//   context.annotation — single annotation (suggest-fix)
//   context.html       — optional page HTML (suggest-fix)
// returns { system, user }
function buildMessages(task, { session, annotations, context } = {}) {
  const addendum = TASK_SYSTEM[task];
  if (!addendum) throw new Error(`Unknown AI task: ${task}`);

  const system = `${BASE_SYSTEM}\n\n${addendum}`;

  // suggest-fix operates on a single annotation, with optional HTML context.
  if (task === 'suggest-fix') {
    const annotation = (context && context.annotation) || null;
    const parts = [];
    parts.push(renderSessionHeader(session));
    parts.push('');
    parts.push('Annotation to fix:');
    parts.push(
      annotation ? renderAnnotation(annotation, 1) : '(no annotation provided)'
    );
    if (context && context.html) {
      parts.push('');
      parts.push('Relevant page HTML:');
      parts.push('```html');
      parts.push(truncate(context.html, 12000));
      parts.push('```');
    }
    parts.push('');
    parts.push(
      'Explain the cause and the fix briefly, then provide the code change in a ' +
        'fenced code block.'
    );
    return { system, user: parts.join('\n') };
  }

  // All other tasks operate over the full annotation set.
  const parts = [];
  parts.push(renderSessionHeader(session));
  parts.push('');
  parts.push('Annotations:');
  parts.push(renderAnnotations(annotations));

  return { system, user: parts.join('\n') };
}

module.exports = { buildMessages };
