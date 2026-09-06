// Agent hand-off templates and richer prompt context for Cursor / Claude / Codex.
const { HANDOFF_TEMPLATES } = require('../../config');
const { toPrompt } = require('../export/prompt');

function listTemplates() {
  return HANDOFF_TEMPLATES.slice();
}

function applyTemplate(templateId, { session, annotations, project, consoleErrors, recording }) {
  const base = toPrompt(session || {}, annotations || [], consoleErrors);
  const tpl = HANDOFF_TEMPLATES.find((t) => t.id === templateId) || HANDOFF_TEMPLATES[0];
  const lines = [
    `# Braiwser hand-off — ${tpl.label}`,
    '',
    `> ${tpl.description}`,
    '',
  ];

  if (project && project.path) {
    lines.push(`Project path: \`${project.path}\``);
    lines.push('');
  }

  if (templateId === 'a11y') {
    lines.push('Focus on accessibility: labels, contrast, keyboard, structure.');
    lines.push('');
  } else if (templateId === 'responsive') {
    lines.push('Focus on responsive / viewport-specific defects. Honour each note\'s viewport.');
    lines.push('');
  } else if (templateId === 'regression' && recording) {
    lines.push(`Regression source journey: **${recording.name || 'Journey'}**`);
    if (recording.lastRun) {
      const failed = (recording.lastRun.steps || []).filter((s) => s.ok === false);
      lines.push(`Last run: ${recording.lastRun.passed}/${recording.lastRun.total} passed.`);
      failed.slice(0, 20).forEach((s, i) => {
        lines.push(`${i + 1}. Step failed: ${s.type || s.kind || 'step'} — expected ${JSON.stringify(s.expected)} actual ${JSON.stringify(s.actual)}`);
      });
    }
    lines.push('');
  }

  lines.push(base);
  lines.push('');
  lines.push('## Verification');
  lines.push('After fixing, re-open the page in Braiwser and replay the related journey if one exists.');
  return lines.join('\n');
}

const AGENT_PRESETS = [
  { id: 'claude', label: 'Claude Code', command: 'claude -p "{promptPath}"' },
  { id: 'codex', label: 'Codex CLI', command: 'codex "{promptPath}"' },
  { id: 'cursor', label: 'Cursor Agent (shell)', command: 'cursor-agent -p "{promptPath}"' },
  { id: 'cat', label: 'Preview only (cat)', command: 'cat "{promptPath}"' },
];

module.exports = { listTemplates, applyTemplate, AGENT_PRESETS };
