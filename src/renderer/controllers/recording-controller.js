// Recording ownership + re-arming.
//
// A recording belongs to the tab that started it. Policy (RF-02):
//  - steps are accepted only from the OWNER tab; other tabs are ignored, so
//    switching tabs neither transfers nor corrupts a recording;
//  - the guest recorder lives in the document's preload, so a full navigation
//    produces a fresh, inactive recorder. The host therefore re-sends
//    `caos:start-recording` (idempotent in the guest) on EVERY dom-ready of the
//    owner tab, and re-sends it when the guest reports `caos:recording-status`
//    with active:false while the host still expects recording (bounded retries);
//  - stopping sends `caos:stop-recording` to EVERY guest that was ever armed
//    for this recording, not just whichever tab is in front.
//
// The buffer is a plain object kept in state.recordingBuffer:
//   { startUrl, steps, ownerTabId, armed:Set<tabId>, rearms:number, docStatus:{} }
// Pure over (buffer, tab, send) so it is unit-testable with fakes.

const MAX_REARM_PER_DOC = 3;

let recSeq = 0;

export function createRecordingBuffer({ startUrl, ownerTabId, now = Date.now }) {
  return {
    recordingId: 'rec-' + (++recSeq) + '-' + now().toString(36),
    seen: new Set(), // documentId:generation:seq of steps already taken (dedupe)
    startUrl,
    steps: [{ type: 'navigate', url: startUrl, ts: now() }],
    ownerTabId: ownerTabId || null,
    armed: new Set(),
    rearms: 0,
    lastStatus: null,
  };
}

// Arm (or re-arm) a tab's guest. Safe to call repeatedly.
export function arm(buffer, tab, send) {
  if (!buffer || !tab || tab.id !== buffer.ownerTabId) return false;
  // Guest protocol: idempotent for the same recordingId.
  send(tab, 'caos:start-recording', { recordingId: buffer.recordingId, ownerTabId: buffer.ownerTabId });
  buffer.armed.add(tab.id);
  return true;
}

// A new document finished loading in `tab`.
export function onDomReady(buffer, tab, send) {
  if (!buffer) return false;
  if (tab.id !== buffer.ownerTabId) return false;
  buffer.rearms = 0; // fresh document: fresh retry budget
  buffer.lastStatus = null;
  return arm(buffer, tab, send);
}

// The guest answered with its recorder state. Returns true if it re-armed.
export function onStatus(buffer, tab, payload, send) {
  if (!buffer || !tab || tab.id !== buffer.ownerTabId) return false;
  buffer.lastStatus = payload || null;
  if (payload && payload.active === false && buffer.rearms < MAX_REARM_PER_DOC) {
    buffer.rearms += 1;
    return arm(buffer, tab, send);
  }
  return false;
}

export const accepts = (buffer, tab) => !!(buffer && tab && tab.id === buffer.ownerTabId);

// Add a guest step with typing coalescing (replace the previous input on the
// same field so replay shows one typed value). Returns the stored step or null.
const GUEST_META = ['documentId', 'recordingId', 'ownerTabId', 'generation', 'seq'];

export function pushGuestStep(buffer, payload) {
  if (!buffer || !payload) return null;
  // Steps stamped for a different recording (a stale guest from an earlier
  // recording) or already taken (re-sent) are dropped; the stamps are provenance,
  // not part of the saved step.
  if (payload.recordingId != null && buffer.recordingId && payload.recordingId !== buffer.recordingId) return null;
  if (payload.documentId != null && payload.seq != null) {
    const key = payload.documentId + ':' + payload.generation + ':' + payload.seq;
    if (buffer.seen && buffer.seen.has(key)) return null;
    if (buffer.seen) buffer.seen.add(key);
  }
  payload = { ...payload };
  for (const k of GUEST_META) delete payload[k];
  const steps = buffer.steps;
  if (payload.replaceLast && payload.type === 'input' && steps.length) {
    const prev = steps[steps.length - 1];
    if (prev && prev.type === 'input' && prev.selector === payload.selector) {
      const next = { ...payload };
      delete next.replaceLast;
      steps[steps.length - 1] = next;
      return next;
    }
  }
  const step = { ...payload };
  delete step.replaceLast;
  steps.push(step);
  return step;
}

// Record a main-frame navigation of the owner tab (deduped against the last step).
export function pushNavigation(buffer, tab, url, now = Date.now) {
  if (!accepts(buffer, tab) || !url) return false;
  const last = buffer.steps[buffer.steps.length - 1];
  if (last && last.type === 'navigate' && last.url === url) return false;
  buffer.steps.push({ type: 'navigate', url, ts: now() });
  return true;
}

// Stop every armed guest (plus the owner, even if it never got armed).
// `tabs` is the current tab list; closed tabs are skipped by send().
export function stopAll(buffer, tabs, send) {
  if (!buffer) return [];
  const ids = new Set(buffer.armed);
  if (buffer.ownerTabId) ids.add(buffer.ownerTabId);
  const stopped = [];
  for (const tab of tabs) {
    if (!ids.has(tab.id)) continue;
    send(tab, 'caos:stop-recording');
    stopped.push(tab.id);
  }
  buffer.armed.clear();
  return stopped;
}
