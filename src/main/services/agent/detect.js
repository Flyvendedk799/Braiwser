// Probe PATH for known coding-agent CLIs and map them onto AGENT_PRESETS.
// Lookups use an argument array (never a shell) and report what would really be
// launched: a real executable, or a .cmd shim on Windows.
const { AGENT_PRESETS } = require('./templates');
const { whichAll, pickExecutable } = require('./command');

function which(bin) {
  if (!bin || bin === 'cat') return '';
  const picked = pickExecutable(whichAll(bin));
  return picked ? picked.path : '';
}

function detectAgents() {
  return AGENT_PRESETS.map((preset) => {
    const bin = preset.exe || '';
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
