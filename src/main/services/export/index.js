// Export facade — picks the right exporter for a requested format and returns
// the content together with a sensible default filename for save dialogs.

const { toMarkdown } = require('./markdown');
const { toPrompt } = require('./prompt');
const { toJson } = require('./json');

// Derive a filesystem-friendly slug from a session title/name/url.
function slugify(session) {
  const raw =
    (session && (session.title || session.name || session.url)) || '';
  const slug = String(raw)
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'ui-review';
}

// format: 'markdown' | 'prompt' | 'json'
// data:   { session, annotations }
// returns { format, defaultName, content }
function buildExport(format, { session, annotations } = {}) {
  const slug = slugify(session);

  switch (format) {
    case 'markdown':
      return {
        format,
        defaultName: `${slug}.md`,
        content: toMarkdown(session, annotations),
      };
    case 'prompt':
      return {
        format,
        defaultName: `${slug}-fix-prompt.txt`,
        content: toPrompt(session, annotations),
      };
    case 'json':
      return {
        format,
        defaultName: `${slug}.json`,
        content: toJson(session, annotations),
      };
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

module.exports = { buildExport };
