// Persona-aware empty-state copy and primary CTAs for the shell.
export function personaCopy(persona, personas) {
  const list = personas || [];
  const p = list.find((x) => x.id === persona) || list[0] || {
    id: 'agent',
    tip: 'Inspect issues, then hand off to your coding agent.',
    primaryAction: 'handoff',
  };
  const actions = {
    handoff: { label: 'Hand off to agent', command: 'agent-handoff' },
    audit: { label: 'Run page audit', command: 'audit-run' },
    'client-pack': { label: 'Export client pack', command: 'export-client-pack' },
  };
  return {
    tip: p.tip || '',
    primary: actions[p.primaryAction] || actions.handoff,
    personaId: p.id,
  };
}

export function emptyNotesMessage(persona) {
  if (persona === 'reviewer') return 'No notes yet — run an audit or inspect an element.';
  if (persona === 'agency') return 'No findings yet — capture client-facing notes for the pack.';
  return 'No notes yet — inspect an element or draw a region.';
}
