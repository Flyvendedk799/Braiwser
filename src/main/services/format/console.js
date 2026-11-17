// Render captured guest console / load-error entries into Markdown bullet lines.
// Shared by the prompt and markdown exporters so the agent sees runtime errors
// alongside the change requests. consoleLog: [{ level, message, kind? }].
//
// This is the single place captured console output becomes text that leaves the
// app (prompt + markdown exports, the agent hand-off file, prompt templates), so
// it is also where the capture is redacted and bounded (src/shared/redact.js).

const { redactConsoleLog } = require('../../../shared/redact');

function levelLabel(l) {
  return l >= 3 ? 'error' : l === 2 ? 'warning' : 'log';
}

function consoleLines(consoleLog) {
  return redactConsoleLog(consoleLog, { maxMessage: 300 })
    .map((c) => `- [${c.kind || levelLabel(c.level)}] ${c.message}`);
}

module.exports = { consoleLines };
