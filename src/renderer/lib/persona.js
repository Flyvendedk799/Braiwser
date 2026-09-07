// Persona-aware empty-state copy, primary CTAs, and chrome disclosure.
export function personaCopy(persona, personas) {
  const list = personas || [];
  const p = list.find((x) => x.id === persona) || list[0] || {
    id: 'agent',
    tip: 'Inspect issues, then hand off to your coding agent.',
    primaryAction: 'handoff',
  };
  const actions = {
    handoff: { label: 'Hand off to agent', command: 'agent.handoff' },
    audit: { label: 'Run page audit', command: 'audit.run' },
    'client-pack': { label: 'Export client pack', command: 'export.clientPack' },
  };
  return {
    tip: p.tip || '',
    primary: actions[p.primaryAction] || actions.handoff,
    personaId: p.id,
  };
}

export function emptyNotesMessage(persona) {
  if (persona === 'reviewer') return 'Run a page audit and promote findings, or inspect an element to leave a note.';
  if (persona === 'agency') return 'Capture client-facing findings, then export a client pack or HTML report.';
  return 'Toggle Inspect, then click an element. When ready, copy the agent prompt or hand off.';
}

// Which toolbar tools stay in the primary strip vs the overflow menu, and
// which right-panel tabs are emphasized. Every command remains in the native
// menu — this only hides chrome, it never removes capability.
export function chromeForPersona(persona) {
  const agent = {
    id: 'agent',
    tools: ['inspect', 'audit'],
    more: ['draw', 'edit', 'arrange', 'assert', 'record', 'replay'],
    tabs: ['notes', 'ai', 'style', 'audit', 'verify'],
    footerPrimary: 'handoff',
    defaultVisibility: 'internal',
  };
  const reviewer = {
    id: 'reviewer',
    tools: ['inspect', 'audit', 'device'],
    more: ['draw', 'edit', 'arrange', 'assert', 'record', 'replay'],
    tabs: ['notes', 'audit', 'style', 'ai', 'verify'],
    footerPrimary: 'audit',
    defaultVisibility: 'internal',
  };
  const agency = {
    id: 'agency',
    tools: ['inspect', 'record', 'device'],
    more: ['draw', 'edit', 'arrange', 'assert', 'audit', 'replay'],
    tabs: ['notes', 'audit', 'style', 'ai', 'verify'],
    footerPrimary: 'client-pack',
    defaultVisibility: 'client',
  };
  if (persona === 'reviewer') return reviewer;
  if (persona === 'agency') return agency;
  return agent;
}

export function isWelcomeUrl(url) {
  return /welcome\.html($|\?|#)/i.test(String(url || ''));
}

export function isPlaygroundUrl(url) {
  return /playground\.html($|\?|#)/i.test(String(url || ''));
}
