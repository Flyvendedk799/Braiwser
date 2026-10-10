'use strict';
// Compact semantic observation builder shared by BOTH drivers (playwright,
// electron-embedded). Pure Node: no browser, no Electron.
//
// The drivers collect raw candidate items in the page (src/webview/probe.js) and
// hand them here. This module owns every bound and every honesty rule:
//   * hard caps: <= 200 nodes, <= 64 KiB serialized, bounded strings
//   * page-controlled strings are sanitized (control / bidi / zero-width) and
//     the whole observation carries trust:'untrusted-page'
//   * truncation is explicit (`truncated`, opaque `nextCursor`), never silent
//   * delta observations are only produced when a server-side base is available
//     AND both snapshots are complete; otherwise a full bounded snapshot is
//     returned with the reason (a partial delta never masquerades as complete)
//   * coverage says what was NOT seen (closed shadow roots, canvases, frames)
//
// Also hosts the driver error helper so both drivers throw one shape.

const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  maxNodes: 200,
  defaultNodes: 100,
  maxBytes: 64 * 1024,
  // Reserved for the envelope (url, coverage, ids) so the WHOLE observation stays <= maxBytes.
  envelopeBytes: 8 * 1024,
  nameChars: 120,
  statusChars: 240,
  contextChars: 60,
  urlChars: 512,
  maxFrames: 16,
  maxSnapshots: 6,
  minViewport: 240,
  maxViewport: 4096,
  // One table/list payload inside an observation. Probe-side caps (50 rows x 12 columns, 80 chars per cell,
  // 30 list items) are tightened here until the payload fits, with explicit truncation markers.
  structBytes: 20 * 1024,
  tableRows: 50,
  tableCols: 12,
  cellChars: 80,
  listItems: 30,
});

// ---- errors -----------------------------------------------------------------
const PUBLIC_CODES = Object.freeze(['STALE_REF', 'AMBIGUOUS_TARGET', 'DENIED', 'TIMEOUT', 'CANCELLED',
  'UNSUPPORTED', 'UNAVAILABLE', 'INTERNAL']);

// code: one of PUBLIC_CODES. extra: { detail, dispatched, effectUnknown, retry, cause }.
// `detail` is the fine-grained reason (TARGET_CHANGED, NOT_ACTIONABLE, ...) and is
// ALWAYS driver-authored text, never page-controlled.
function driverError(code, message, extra) {
  const x = extra || {};
  const err = new Error(message || code);
  err.code = PUBLIC_CODES.includes(code) ? code : 'INTERNAL';
  err.detail = x.detail || code;
  err.dispatched = x.dispatched === true;
  err.effectUnknown = x.effectUnknown === true;
  err.retry = x.retry === true;
  if (x.cause) err.cause = x.cause;
  err.publicError = {
    code: err.code,
    message: err.message,
    dispatched: err.dispatched,
    effectUnknown: err.effectUnknown,
    retry: err.retry,
  };
  return err;
}

// ---- strings ----------------------------------------------------------------
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function clipText(value, max) {
  let s = String(value == null ? '' : value).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, Math.max(0, max - 1)) + '\u2026';
  return s;
}

function sanitizeFilename(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop().replace(UNSAFE_CHARS, '');
  const cleaned = base.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 100);
  return cleaned || 'download';
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? u.protocol : u.origin;
  } catch (_e) { return ''; }
}

function sha(value, len) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, len || 32);
}

// Semantic identity of a node. Excludes volatile state (enabled/checked/value) so
// a node that merely changed state is still "the same node"; that state is
// re-validated at dispatch by the actionability trial.
function fingerprintOf(item) {
  return sha(JSON.stringify([item.tag || '', item.role || '', item.type || '', item.name || '', item.ctx || '']));
}

// ---- nodes ------------------------------------------------------------------
// ---- bounded structures (tables / lists) ------------------------------------------------
// The probe already limits what it reads; this is the authority on what leaves the driver. Page text is clipped and
// sanitised again, a cell is a string or null (null = withheld, never a secret value), and rows are dropped from the
// end - with truncated.rows set - until the payload fits its byte budget.
function boundCell(c) { return c === null ? null : clipText(c, LIMITS.cellChars); }
function boundTable(t) {
  const src = t && typeof t === 'object' ? t : {};
  const headers = (Array.isArray(src.headers) ? src.headers : []).slice(0, LIMITS.tableCols).map((h) => clipText(h, LIMITS.cellChars));
  let cells = (Array.isArray(src.cells) ? src.cells : []).slice(0, LIMITS.tableRows)
    .map((row) => (Array.isArray(row) ? row.slice(0, LIMITS.tableCols).map(boundCell) : []));
  const truncated = { rows: src.truncated && src.truncated.rows === true, columns: src.truncated && src.truncated.columns === true,
    cells: Number.isInteger(src.truncated && src.truncated.cells) ? src.truncated.cells : 0 };
  const rowCount = Number.isInteger(src.rowCount) && src.rowCount >= 0 ? src.rowCount : cells.length;
  const out = { rowCount, rowsExact: src.rowsExact !== false, columnCount: Number.isInteger(src.columnCount) ? src.columnCount : headers.length,
    hasHeader: src.hasHeader === true, headers, cells, truncated, merged: src.merged === true,
    withheld: (Array.isArray(src.withheld) ? src.withheld : []).filter((x) => Number.isInteger(x) && x >= 0 && x < LIMITS.tableCols).slice(0, LIMITS.tableCols) };
  if (src.cells && src.cells.length > cells.length) out.truncated.rows = true;
  while (cells.length > 1 && Buffer.byteLength(JSON.stringify(out)) > LIMITS.structBytes) {
    cells = cells.slice(0, Math.max(1, Math.floor(cells.length * 0.8)));
    out.cells = cells;
    out.truncated.rows = true;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > LIMITS.structBytes) { out.cells = []; out.truncated.rows = true; }
  return out;
}
function boundList(l) {
  const src = l && typeof l === 'object' ? l : {};
  let items = (Array.isArray(src.items) ? src.items : []).slice(0, LIMITS.listItems).map(boundCell);
  const out = { ordered: src.ordered === true, itemCount: Number.isInteger(src.itemCount) ? src.itemCount : items.length, itemsExact: src.itemsExact !== false,
    items, truncated: { items: src.truncated && src.truncated.items === true, cells: Number.isInteger(src.truncated && src.truncated.cells) ? src.truncated.cells : 0 } };
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(out)) > LIMITS.structBytes) {
    items = items.slice(0, Math.max(1, Math.floor(items.length * 0.8)));
    out.items = items;
    out.truncated.items = true;
  }
  return out;
}

// ---- pagination hints ---------------------------------------------------------------------------
// By ACCESSIBLE NAME only (closed English vocabulary) on links/buttons that are in this observation. Page markup,
// classes and hrefs are never consulted. Two candidates for one direction => no ref, listed as ambiguous.
const NEXT_NAME = /^(?:next(?: page)?|older|forward)(?: ?[›»>→])?$|^[›»>→]$/i;
const PREV_NAME = /^(?:prev(?:ious)?(?: page)?|newer|back)$|^[‹«<←] ?(?:prev(?:ious)?)?$|^(?:prev(?:ious)?) ?[‹«<←]$/i;
function paginationHints(nodes) {
  const found = { next: [], prev: [] };
  for (const n of nodes) {
    if (!n || !n.refId || (n.role !== 'link' && n.role !== 'button')) continue;
    const name = String(n.name || '').replace(/\s+/g, ' ').trim();
    if (NEXT_NAME.test(name)) found.next.push(n);
    else if (PREV_NAME.test(name)) found.prev.push(n);
  }
  const out = {};
  const ambiguous = [];
  for (const dir of ['next', 'prev']) {
    if (found[dir].length === 1) out[dir] = { refId: found[dir][0].refId, name: found[dir][0].name, enabled: found[dir][0].enabled !== false };
    else if (found[dir].length > 1) ambiguous.push(dir);
  }
  if (ambiguous.length) out.ambiguous = ambiguous;
  return Object.keys(out).length ? out : null;
}

// raw probe item -> public node (no refId yet). frameId is only attached for
// nodes that live in a child frame.
function publicNode(item, frameId) {
  const n = { kind: item.kind, role: String(item.role || ''), name: clipText(item.name, item.kind === 'error' || item.kind === 'status' ? LIMITS.statusChars : LIMITS.nameChars) };
  if (item.kind === 'interactable') {
    n.enabled = item.enabled !== false;
    if (item.editable) n.editable = true;
    if (item.checked !== undefined) n.checked = item.checked;
    if (item.expanded !== undefined) n.expanded = item.expanded;
    if (item.invalid) n.invalid = true;
    if (item.secret) n.secret = true;
    if (item.traits && item.traits.length) n.traits = item.traits.slice(0, 8);
    if (item.ambiguous) { n.ambiguous = true; n.dupCount = item.dupCount; }
    if (item.occluded) n.occluded = true;
    if (item.offscreen) n.offscreen = true;
    if (item.ctx) n.context = clipText(item.ctx, LIMITS.contextChars);
  } else if (item.kind === 'canvas') {
    n.limitation = item.limitation;
    if (item.occluded) n.occluded = true;
  } else if (item.kind === 'table') {
    n.table = boundTable(item.table);
  } else if (item.kind === 'list') {
    n.list = boundList(item.list);
  }
  if (item.testId) n.testId = clipText(item.testId, 80);
  if (item.text) n.text = clipText(item.text, LIMITS.statusChars);
  if (frameId) n.frameId = frameId;
  return n;
}

// ---- semantic locators (assertion targets) -------------------------------------------------
// Closed vocabulary shared with plans: { by:'role', role, name } | { by:'label', value } | { by:'testId', value }.
function normalizeLocator(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const s = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
  if (t.by === 'role') {
    const role = s(t.role, 40);
    if (!role || !/^[a-z]+$/i.test(role)) return null;
    // A role locator without a name means "any name" (count / exists / visible); an empty string means "no accessible name".
    if (t.name === undefined) return { by: 'role', role: role.toLowerCase() };
    const name = s(t.name, 200);
    return name !== null ? { by: 'role', role: role.toLowerCase(), name } : null;
  }
  if (t.by === 'label' || t.by === 'testId') {
    const value = s(t.value, 200);
    return value ? { by: t.by, value } : null;
  }
  return null;
}

function locatorLabel(l) {
  if (l.by === 'role') return l.name === undefined ? `role=${l.role}` : `role=${l.role}[name="${clipText(l.name, 80)}"]`;
  return `${l.by}=${clipText(l.value, 80)}`;
}

function stateSig(node) {
  return JSON.stringify([node.enabled, node.editable, node.checked, node.expanded, node.invalid, node.ambiguous,
    node.occluded, node.offscreen, node.name, node.text, node.table, node.list]);
}

// Stable-per-document key for delta matching: fingerprint + frame + ordinal among identical fingerprints.
function assignKeys(entries) {
  const seen = new Map();
  for (const e of entries) {
    const base = `${e.frameId || ''}|${e.fingerprint}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    e.key = `${base}#${n}`;
  }
  return entries;
}

// ---- cursors ----------------------------------------------------------------
function encodeCursor({ epoch, offset, focus }) {
  return Buffer.from(JSON.stringify({ v: 1, e: epoch, o: offset, f: focus ? sha(JSON.stringify(focus), 8) : '' }))
    .toString('base64url');
}

// Returns { epoch, offset, focusHash } or throws STALE_REF/UNSUPPORTED style errors.
function decodeCursor(cursor, { epoch, focus } = {}) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch (_e) { parsed = null; }
  if (!parsed || parsed.v !== 1 || !Number.isInteger(parsed.o) || parsed.o < 0 || !Number.isInteger(parsed.e)) {
    throw driverError('UNSUPPORTED', 'Invalid observation cursor.', { detail: 'INVALID_CURSOR' });
  }
  if (epoch !== undefined && parsed.e !== epoch) {
    throw driverError('STALE_REF', 'The document changed since this cursor was issued; observe again.', { detail: 'CURSOR_STALE' });
  }
  const f = focus ? sha(JSON.stringify(focus), 8) : '';
  if (parsed.f !== f) {
    throw driverError('UNSUPPORTED', 'Cursor does not match the requested focus.', { detail: 'CURSOR_FOCUS_MISMATCH' });
  }
  return { epoch: parsed.e, offset: parsed.o };
}

// ---- budgets ----------------------------------------------------------------
const REF_PLACEHOLDER = 'r_xxxxxxxxxxxxxxxx';

function nodeBytes(node) {
  return Buffer.byteLength(JSON.stringify({ refId: REF_PLACEHOLDER, ...node })) + 1;
}

function clampNodes(maxNodes) {
  const n = Number.isFinite(maxNodes) ? Math.floor(maxNodes) : LIMITS.defaultNodes;
  return Math.max(1, Math.min(LIMITS.maxNodes, n));
}

// entries: [{ key, node, sig }] in document order. Returns what fits.
function fitBudget(entries, { maxNodes, maxBytes }) {
  const cap = clampNodes(maxNodes);
  const bytesCap = Math.min(LIMITS.maxBytes, Number.isFinite(maxBytes) ? maxBytes : LIMITS.maxBytes) - LIMITS.envelopeBytes;
  let bytes = 0;
  let count = 0;
  for (const e of entries) {
    if (count >= cap) break;
    const b = nodeBytes(e.node);
    if (count > 0 && bytes + b > bytesCap) break;
    bytes += b;
    count += 1;
  }
  return { count, bytes, byteCapped: count < entries.length && count < cap, nodeCapped: count >= cap && count < entries.length };
}

// ---- snapshots + delta --------------------------------------------------------
class SnapshotStore {
  constructor(max) {
    this.max = max || LIMITS.maxSnapshots;
    this.map = new Map();
  }

  remember(observationId, snapshot) {
    this.map.set(observationId, snapshot);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  get(observationId) { return this.map.get(observationId) || null; }

  has(observationId) { return this.map.has(observationId); }

  clear() { this.map.clear(); }
}

// kept: entries that fit the budget, each { key, node, sig }.
// ctx: { offset, truncated, documentEpoch }; base: snapshot|null (from SnapshotStore)
// Returns { delta, returnIdx, unchanged: Map(idx -> baseRefId), removedRefIds }
function planDelta(kept, { requested, baseId, base, offset, truncated, documentEpoch }) {
  const all = { delta: requested ? { baseObservationId: baseId, available: false, reason: 'NONE' } : null,
    returnIdx: kept.map((_, i) => i), unchanged: new Map(), removedRefIds: [] };
  if (!requested) return all;
  const fail = (reason) => { all.delta.reason = reason; return all; };
  if (!base) return fail('BASE_UNAVAILABLE');
  if (base.documentEpoch !== documentEpoch) return fail('BASE_EPOCH_CHANGED');
  if (offset !== 0 || base.offset !== 0) return fail('PAGED');
  if (truncated || base.truncated) return fail('TRUNCATED');
  const returnIdx = [];
  const unchanged = new Map();
  let added = 0;
  let changed = 0;
  const seen = new Set();
  kept.forEach((e, i) => {
    const prev = base.entries.get(e.key);
    seen.add(e.key);
    if (prev && prev.sig === e.sig) {
      if (prev.refId) unchanged.set(i, prev.refId);
      else returnIdx.push(i); // landmarks etc. have no ref; resend is cheap and keeps the delta self-contained
      return;
    }
    returnIdx.push(i);
    if (prev) changed += 1; else added += 1;
  });
  const removedRefIds = [];
  let removed = 0;
  for (const [key, prev] of base.entries) {
    if (seen.has(key)) continue;
    removed += 1;
    if (prev.refId) removedRefIds.push(prev.refId);
  }
  return {
    delta: { baseObservationId: baseId, available: true, added, changed, removed, unchanged: unchanged.size },
    returnIdx, unchanged, removedRefIds,
  };
}

// ---- coverage ---------------------------------------------------------------
// frames: [{ frameId, parentFrameId?, origin, crossOrigin, nodes, available }]
function buildCoverage({ frames, stats, nodesReturned, nodesTotal, closedShadowReported = true }) {
  const fs = frames || [];
  const unavailable = fs.filter((f) => f.available === false);
  const limitations = ['closed-shadow-roots-not-observable'];
  if (stats.possibleClosedShadowHosts > 0) limitations.push('possible-closed-shadow-hosts');
  if (stats.canvases > 0) limitations.push('canvas-content-not-observable');
  if (unavailable.length) limitations.push('frames-unavailable');
  if (stats.candidatesCapped) limitations.push('candidate-scan-capped');
  if (stats.structuresCapped) limitations.push('table-list-scan-capped');
  if (stats.framesCapped) limitations.push('frame-scan-capped');
  void closedShadowReported;
  return {
    framesSeen: fs.length,
    framesObserved: fs.length - unavailable.length,
    framesUnavailable: unavailable.length,
    crossOriginFrames: fs.filter((f) => f.crossOrigin).length,
    nodesReturned,
    nodesTotal,
    shadowRootsOpen: stats.shadowRootsOpen,
    possibleClosedShadowHosts: stats.possibleClosedShadowHosts,
    canvases: stats.canvases,
    limitations,
    frames: fs.slice(0, LIMITS.maxFrames).map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId || null,
      origin: clipText(f.origin, 120),
      crossOrigin: !!f.crossOrigin,
      nodes: f.nodes || 0,
      available: f.available !== false,
    })),
  };
}

function serializedBytes(observation) {
  return Buffer.byteLength(JSON.stringify(observation));
}

// ---- evidence ---------------------------------------------------------------------
// The broker only treats driver evidence as proof when `kind` is one of its closed set
// (visible, text, exists, count, url, navigation, state-change, value, focus, checked, selected,
// clicked) AND `observed === true` (a fact the driver itself read back from the page). A click
// alone never produces proof. `matches` says whether the observed fact equals what was asked for;
// drivers only report status 'verified' when every observed fact matches.
const evidence = {
  // a trusted click event was observed reaching the exact target (not that the business effect happened)
  clicked: (matches, trusted, epoch) => ({ kind: 'clicked', observed: true, matches: !!matches, trusted, documentEpoch: epoch }),
  value: (matches, length, epoch) => ({ kind: 'value', observed: true, matches: !!matches, length, documentEpoch: epoch }),
  selected: (matches, count, epoch) => ({ kind: 'selected', observed: true, matches: !!matches, count, documentEpoch: epoch }),
  checked: (matches, checked, epoch) => ({ kind: 'checked', observed: true, matches: !!matches, checked, documentEpoch: epoch }),
  navigation: ({ url, outcome, matches, fromEpoch, documentEpoch }) => ({ kind: 'navigation', observed: true, url: clipText(url, LIMITS.urlChars),
    outcome, matches: !!matches, fromEpoch, documentEpoch }),
  // the engine and the page both reported the requested size after a resize
  viewport: (width, height, matches, epoch) => ({ kind: 'state-change', observed: true, change: 'viewport', width, height, matches: !!matches, documentEpoch: epoch }),
  dialog: (dialogType, dialogId, epoch) => ({ kind: 'state-change', observed: true, change: 'dialog_opened', dialogType: clipText(dialogType, 20),
    dialogId: clipText(dialogId, 40), documentEpoch: epoch }),
  // a = normalized assertion; status = passed | failed | unknown
  assertion: (a, status, actual, epoch, extra) => ({ kind: a.kind, observed: status !== 'unknown', status, op: a.op,
    selector: a.selector === undefined ? undefined : clipText(a.selector, 200),
    expected: a.expected === undefined ? undefined : (typeof a.expected === 'string' ? clipText(a.expected, 200) : a.expected),
    actual: typeof actual === 'string' ? clipText(actual, 200) : actual, documentEpoch: epoch, ...(extra || {}) }),
};

// Combine per-action facts into the driver result. 'verified' only if at least one observed
// fact matched and none contradicted; a document change must be reported as navigation evidence.
function composeResult({ evidence: list, expectOutcome, epochBefore, epochNow, url, dialogOpened, navigateAction }) {
  const out = list.slice();
  let verified = out.some((e) => e.matches === true) && !out.some((e) => e.matches === false) && !dialogOpened;
  if (expectOutcome) {
    out.push(expectOutcome.evidence);
    verified = expectOutcome.status === 'passed';
  }
  if (epochNow !== epochBefore && !navigateAction) {
    // Reported so the broker can validate the transition; it is evidence of a change, never of success by itself.
    out.push(evidence.navigation({ url, outcome: 'ready', matches: true, fromEpoch: epochBefore, documentEpoch: epochNow }));
  }
  return { status: verified ? 'verified' : 'dispatched', evidence: out };
}

// ---- input policy (shared by both drivers) -------------------------------------------------
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
  'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8',
  'F9', 'F10', 'F11', 'F12']);
const MODIFIERS = new Set(['Shift', 'Alt', 'Control', 'Meta']);

// Parse "Shift+Tab" / "a" / "Control+a". Returns { printable } or throws UNSUPPORTED.
function parseKey(key) {
  if (typeof key !== 'string' || !key || key.length > 40) {
    throw driverError('UNSUPPORTED', 'Unsupported key.', { detail: 'KEY_UNSUPPORTED' });
  }
  const parts = key.split('+');
  const main = parts.pop();
  if (!parts.every((p) => MODIFIERS.has(p))) {
    throw driverError('UNSUPPORTED', 'Unsupported key modifier.', { detail: 'KEY_UNSUPPORTED' });
  }
  const single = Array.from(main).length === 1;
  if (!single && !NAMED_KEYS.has(main)) {
    throw driverError('UNSUPPORTED', 'Unsupported key.', { detail: 'KEY_UNSUPPORTED' });
  }
  // Control/Alt/Meta chords are only allowed with a single character (Control+a, Meta+c): never with
  // named keys (Control+Alt+Delete, Alt+F4) which act on the browser or OS rather than the page.
  if (!single && parts.some((p) => p !== 'Shift')) {
    throw driverError('UNSUPPORTED', 'Unsupported key chord.', { detail: 'KEY_UNSUPPORTED' });
  }
  const printable = (single || main === 'Space') && !parts.some((p) => p === 'Control' || p === 'Meta' || p === 'Alt');
  return { printable };
}

function validateNavigationUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) {
    throw driverError('DENIED', 'Navigation URL is missing or too long.', { detail: 'URL_INVALID' });
  }
  let u;
  try { u = new URL(raw); } catch (_e) { throw driverError('DENIED', 'Navigation URL is not valid.', { detail: 'URL_INVALID' }); }
  if (u.protocol === 'about:' && u.href === 'about:blank') return u.href;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw driverError('DENIED', `Navigation scheme ${u.protocol} is not allowed.`, { detail: 'URL_SCHEME_DENIED' });
  }
  if (u.username || u.password) {
    throw driverError('DENIED', 'Navigation URLs may not embed credentials.', { detail: 'URL_CREDENTIALS_DENIED' });
  }
  return u.href;
}

function normalizeFocus(focus) {
  if (focus == null) return null;
  // The broker passes `focus` as a plain string (a text search over names / context).
  if (typeof focus === 'string') return focus.trim() ? { text: clipText(focus, 200) } : null;
  if (typeof focus !== 'object' || Array.isArray(focus)) {
    throw driverError('UNSUPPORTED', 'focus must be an object.', { detail: 'FOCUS_INVALID' });
  }
  const out = {};
  if (focus.role != null) out.role = clipText(focus.role, 40).toLowerCase();
  if (focus.name != null) out.name = clipText(focus.name, 200);
  if (focus.text != null) out.text = clipText(focus.text, 200);
  if (focus.exact === true) out.exact = true;
  return Object.keys(out).length ? out : null;
}

// ---- shared assembly -------------------------------------------------------------
// Both drivers collect `entries` ({ item, node, fingerprint, frameId?, handle-ish... }) and
// then need the SAME budgeting / delta / ref-binding / envelope logic. `refs` is the
// driver-specific part:
//   refs.mint(entry, observationId) -> refId | null   create a server-side ref for an interactable
//   refs.rebind(refId, observationId) -> boolean       keep an unchanged base ref alive under the new id
//   refs.kill(refId, reason)                           invalidate a ref that disappeared
//   refs.dispose(entry)                                release the driver resource held by an unused entry
// `ctx` carries: pageId, documentEpoch, url, title, snapshots (SnapshotStore), newId(prefix),
// plus the request (offset, want, focus, baseObservationId, maxBytes).
function assembleObservation(ctx, collected, refs) {
  const { entries, frames, stats, total } = collected;
  assignKeys(entries);
  for (const e of entries) e.sig = stateSig(e.node);
  const fit = fitBudget(entries, { maxNodes: ctx.want, maxBytes: ctx.maxBytes });
  const kept = entries.slice(0, fit.count);
  for (const e of entries.slice(fit.count)) refs.dispose(e);
  const truncated = ctx.offset + kept.length < total;
  const observationId = ctx.newId('ob');
  const base = ctx.baseObservationId ? ctx.snapshots.get(ctx.baseObservationId) : null;
  const plan = planDelta(kept, { requested: !!ctx.baseObservationId, baseId: ctx.baseObservationId, base,
    offset: ctx.offset, truncated, documentEpoch: ctx.documentEpoch });

  const refFor = new Array(kept.length).fill(null);
  kept.forEach((e, i) => {
    const baseRefId = plan.unchanged.get(i);
    if (baseRefId && refs.rebind(baseRefId, observationId)) {
      refFor[i] = baseRefId;
      refs.dispose(e);
      return;
    }
    refFor[i] = refs.mint(e, observationId);
  });
  const snapshotEntries = new Map();
  kept.forEach((e, i) => snapshotEntries.set(e.key, { sig: e.sig, refId: refFor[i] }));
  for (const refId of plan.removedRefIds) refs.kill(refId, 'REF_REMOVED');
  ctx.snapshots.remember(observationId, { documentEpoch: ctx.documentEpoch, offset: ctx.offset, truncated, entries: snapshotEntries });

  const nodes = plan.returnIdx.map((i) => (refFor[i] ? { refId: refFor[i], ...kept[i].node } : { ...kept[i].node }));
  const result = {
    pageId: ctx.pageId,
    observationId,
    documentEpoch: ctx.documentEpoch,
    url: clipText(ctx.url, LIMITS.urlChars),
    title: stats.title || '',
    trust: 'untrusted-page',
    nodes,
    coverage: buildCoverage({ frames, stats, nodesReturned: nodes.length, nodesTotal: total }),
    truncated,
    nextCursor: truncated ? encodeCursor({ epoch: ctx.documentEpoch, offset: ctx.offset + kept.length, focus: ctx.focus }) : null,
    delta: plan.delta,
    ...(ctx.extra || {}),
  };
  const pager = paginationHints(kept.map((e, i) => ({ ...e.node, refId: refFor[i] })));
  if (pager) result.pagination = pager;
  // Final guard: the WHOLE observation must respect the byte cap.
  const cap = Math.min(LIMITS.maxBytes, Number.isFinite(ctx.maxBytes) ? ctx.maxBytes : LIMITS.maxBytes);
  while (serializedBytes(result) > cap && result.nodes.length > 1) {
    result.nodes.pop();
    result.truncated = true;
    result.coverage.nodesReturned = result.nodes.length;
    result.nextCursor = encodeCursor({ epoch: ctx.documentEpoch, offset: ctx.offset + result.nodes.length, focus: ctx.focus });
  }
  return result;
}

module.exports = {
  LIMITS, PUBLIC_CODES, driverError, clipText, sanitizeFilename, originOf, sha, fingerprintOf,
  publicNode, stateSig, assignKeys, encodeCursor, decodeCursor, nodeBytes, clampNodes, fitBudget,
  paginationHints, boundTable, boundList, SnapshotStore, planDelta, buildCoverage, serializedBytes, assembleObservation, evidence, composeResult, normalizeLocator, locatorLabel, parseKey, validateNavigationUrl, normalizeFocus, NAMED_KEYS, MODIFIERS,
};
