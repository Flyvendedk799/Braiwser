// Prompt exporter — turns a review session + its annotations into a ready-to-
// paste instruction prompt for a CODING AGENT. Imperative and precise so the
// agent can act on each item directly. Pure function, no I/O, no AI.

const { consoleLines } = require('../format/console');
const { truncate } = require('../format/text');

// Imperative verb per action tag — phrasing meant for an agent to execute.
const ACTION_VERBS = {
  remove: 'Remove',
  change: 'Change',
  fix: 'Fix',
  add: 'Add',
  question: 'Answer / investigate',
  comment: 'Address',
};

// A precise, single-line description of where a change applies.
function describeTargetInline(annotation) {
  const t = annotation.target || {};

  if (annotation.kind === 'region') {
    const box = t.box || {};
    return `region at x=${box.x ?? '?'}, y=${box.y ?? '?'}, w=${box.w ?? '?'}, h=${box.h ?? '?'}`;
  }

  const parts = [];
  if (t.selector) parts.push(`selector \`${t.selector}\``);
  else if (t.id) parts.push(`element \`#${t.id}\``);
  else if (t.tag) parts.push(`\`<${t.tag}>\``);

  if (t.text) parts.push(`with text "${truncate(t.text, 120)}"`);

  const attrs = t.attrs || {};
  if (attrs.href) parts.push(`(href: ${attrs.href})`);
  else if (attrs.src) parts.push(`(src: ${attrs.src})`);

  return parts.length ? parts.join(' ') : 'the target element';
}

// Order by priority (critical>high>normal>low) on a COPY — never mutate the
// input array, since pin numbering relies on insertion order elsewhere.
const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
function byPriority(list) {
  return list
    .map((a, i) => [a, i])
    .sort((x, y) => (PRIORITY_RANK[x[0].priority] ?? 2) - (PRIORITY_RANK[y[0].priority] ?? 2) || x[1] - y[1])
    .map((pair) => pair[0]);
}

function toPrompt(session, annotations, consoleLog) {
  const list = byPriority(Array.isArray(annotations) ? annotations : []);
  const out = [];

  const pageTitle = (session && (session.title || session.name)) || 'the page';
  const pageUrl = (session && session.url) || '(unknown URL)';

  // Role / intro for the coding agent.
  out.push(
    'You are a senior frontend engineer. Implement the UI change requests below ' +
      'exactly as specified. Each item names an action, a precise target ' +
      '(CSS selector and element text, or a region box), and a note describing ' +
      'the intent. Make the smallest, cleanest change that satisfies each ' +
      'request, and keep existing behavior and styling intact unless told ' +
      'otherwise.'
  );
  out.push('');
  out.push(`Page: ${pageTitle}`);
  out.push(`URL: ${pageUrl}`);
  out.push('');

  if (list.length === 0) {
    out.push('No change requests were provided.');
    return out.join('\n');
  }

  out.push('Change requests:');
  out.push('');

  let index = 1;
  for (const a of list) {
    const verb = ACTION_VERBS[a.action] || 'Address';
    const target = describeTargetInline(a);
    const note = (a.note || '').trim();

    // One numbered, self-contained instruction per annotation.
    let line = `${index}. ${verb}: ${target}.`;
    if (note) line += ` ${note}`;

    // Rearrange edits were previewed live — pass the agent the exact change.
    if (a.edit && a.edit.css) {
      line += ` Implement it in the source styles as: \`${a.edit.css}\` (previewed live on the page).`;
    }
    if (a.edit && a.edit.type === 'reorder' && a.edit.details && a.edit.details.parentSelector != null) {
      const d = a.edit.details;
      line += ` Reorder the element in the markup from index ${d.fromIndex} to index ${d.toIndex} (0-based) inside \`${d.parentSelector}\`.`;
    }
    if (a.edit && a.edit.type === 'text' && a.edit.details && a.edit.details.after != null) {
      const d = a.edit.details;
      line += ' Replace the copy "' + String(d.before || '').trim() + '" with "' + String(d.after).trim() + '".';
    }
    if (a.edit && a.edit.type === 'reparent' && a.edit.details && a.edit.details.parentSelector != null) {
      const d = a.edit.details;
      line += ` Move the element in the markup out of \`${d.fromParentSelector}\` (index ${d.fromIndex}) and into \`${d.parentSelector}\` at index ${d.toIndex} (0-based).`;
    }

    // Surface priority when it is above the baseline so the agent can order work.
    if (a.priority && a.priority !== 'normal') {
      line += ` [priority: ${a.priority}]`;
    }

    out.push(line);
    index += 1;
  }

  const cl = consoleLines(consoleLog);
  if (cl.length) {
    out.push('');
    out.push('Console / load errors observed on the page (may be related):');
    out.push(...cl);
  }

  out.push('');
  out.push(
    'When done, summarize the files you changed and any decisions you made ' +
      'where the request was ambiguous.'
  );

  return out.join('\n');
}

module.exports = { toPrompt };
