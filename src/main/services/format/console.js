// Render captured guest console / load-error entries into Markdown bullet lines.
// Shared by the prompt and markdown exporters so the agent sees runtime errors
// alongside the change requests. consoleLog: [{ level, message, kind? }].

function levelLabel(l) {
  return l >= 3 ? 'error' : l === 2 ? 'warning' : 'log';
}

function consoleLines(consoleLog) {
  const arr = Array.isArray(consoleLog) ? consoleLog : [];
  return arr
    .filter(Boolean)
    .map((c) => `- [${c.kind || levelLabel(c.level)}] ${String(c.message || '').slice(0, 300)}`);
}

module.exports = { consoleLines };
