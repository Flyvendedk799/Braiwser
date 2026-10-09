// Turns guest-page replies into user feedback. Pure: no DOM, no toast.

const REASONS = {
  'parent-not-found': 'the destination no longer exists on the page',
  'source-not-found': 'that element changed or was removed, so it could not be identified',
  'destination-not-found': 'the drop position no longer exists',
  'bad-index': 'the target position is out of range',
  'cycle': 'an element cannot be moved inside itself',
  'not-a-container': 'that element cannot hold other elements',
  error: 'the page reported an error',
};
// The panel's view of the page is out of date for these: say so and re-read the tree.
const LOST_IDENTITY = new Set(['source-not-found', 'parent-not-found', 'destination-not-found']);

// caos:structure-result { op, ok, reason }
//  -> { refresh:boolean, toast:{ text, tone }|null }
export function describeStructureResult(payload) {
  if (!payload) return { refresh: false, toast: null };
  if (payload.ok) return { refresh: true, toast: null };
  const reason = payload.reason || '';
  if (reason === 'no-change') return { refresh: true, toast: null }; // resync the panel's optimistic order silently
  const why = REASONS[reason] || (reason ? String(reason) : '');
  const verb = payload.op === 'move-into' ? 'move' : 'reorder';
  const lost = LOST_IDENTITY.has(reason);
  return {
    refresh: true, // the panel may show a move that did not happen
    toast: {
      text: `Could not ${verb} that element${why ? ' — ' + why : ''}${lost ? '. The structure list was refreshed.' : ''}`,
      tone: 'warn',
    },
  };
}

// caos:edit-stacks { undo, redo, dropped }: `dropped` is cumulative per document.
//  -> { dropped:number (new baseline), toast:{ text, tone }|null }
export function describeDroppedHistory(payload, previouslyDropped) {
  const before = Number(previouslyDropped) || 0;
  const now = payload && Number.isFinite(payload.dropped) ? payload.dropped : before;
  if (now <= before) return { dropped: before, toast: null };
  const n = now - before;
  return {
    dropped: now,
    toast: { text: `${n} older page edit${n === 1 ? '' : 's'} can no longer be undone (edit history is limited)`, tone: 'warn' },
  };
}
