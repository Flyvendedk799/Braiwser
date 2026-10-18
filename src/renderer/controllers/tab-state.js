// Per-tab derived UI state. The Style, Layers, Sections and Audit panels, the
// edit-history counters and the audit baseline all describe ONE guest document.
// They used to be global, so selecting an element in tab B left it in the Style
// panel while actions went to tab A. Each tab now owns a record; the host
// repaints the panels from the active tab's record when tabs switch and drops
// the parts that no longer describe the page when a new document loads.
import { sameAuditedPage } from './audit-controller.js';

export function createTabDerived() {
  return {
    styleInfo: null,            // last caos:style-picked payload
    styleTarget: null,          // its selector
    textEditing: false,
    layout: null,               // last caos:layout-picked payload
    tree: null,                 // last caos:dom-tree payload
    editStacks: { undo: 0, redo: 0 },
    droppedEdits: 0,            // history entries the guest evicted (can no longer be undone)
    audit: null,                // { report, outcome, source, promoted:Set<string> }
  };
}

// A new document replaced the old one: selection, layers, structure and the
// guest's edit history are gone with it. (Audit is judged separately because a
// reload of the same URL still describes the same page.)
export function resetForNewDocument(d) {
  d.styleInfo = null;
  d.styleTarget = null;
  d.textEditing = false;
  d.layout = null;
  d.tree = null;
  d.editStacks = { undo: 0, redo: 0 };
  d.droppedEdits = 0;
  return d;
}

// Drop the stored audit when the tab now shows a different page. Returns true
// if it was dropped (the caller then clears the Audit panel).
export function dropStaleAudit(d, current) {
  if (!d.audit) return false;
  if (sameAuditedPage(d.audit.source, current)) return false;
  d.audit = null;
  return true;
}

// What to paint into the panels for this tab.
export function panelSnapshot(d) {
  return {
    style: d.styleInfo,
    textEditing: d.textEditing,
    layout: d.layout,
    tree: d.tree,
    editStacks: d.editStacks,
    auditReport: d.audit ? d.audit.report : null,
    promoted: d.audit ? [...d.audit.promoted] : [],
  };
}
