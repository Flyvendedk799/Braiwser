// Probe PATH for known coding-agent CLIs and map them onto AGENT_PRESETS.
const { spawnSync } = require('child_process');
const { AGENT_PRESETS } = require('./templates');

function which(bin) {
  if (!bin || bin === 'cat') return '';
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [bin], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (r.status !== 0) return '';
    const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line || '';
  } catch (_e) {
    return '';
  }
}

function binOf(command) {
  const token = String(command || '').trim().split(/\s+/)[0] || '';
  return token.replace(/^["']|["']$/g, '');
}

function detectAgents() {
  return AGENT_PRESETS.map((preset) => {
    const bin = binOf(preset.command);
    const found = which(bin);
    return {
      id: preset.id,
      label: preset.label,
      command: preset.command,
      bin,
      available: !!found,
      path: found || '',
    };
  });
}

function suggestedCommand(detected) {
  const list = Array.isArray(detected) ? detected : detectAgents();
  const hit = list.find((p) => p.available && p.id !== 'cat');
  return hit ? hit.command : '';
}

module.exports = { detectAgents, suggestedCommand, which };
