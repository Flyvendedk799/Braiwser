// Screenshot + annotation overlay orchestration (CE-13), pure over injected deps.
//
// The identity of the page (tab, document, viewport, scroll origin, scale) is
// snapshotted around the async capture. Overlay boxes are FRESH: requested from
// the guest right after the pixels (`caos:request-boxes`, in the coordinate
// space of the screenshot being taken), converted if a box is tagged with
// another space, and omitted — with a visible count — rather than drawn in the
// wrong place if the page moved, was replaced, or a box could only be taken from
// stale stored data.
import { normalizeBoxReply, placeBoxes, sameMeasure } from '../lib/screenshots.js';

// deps:
//   staleReason(ctx, opts)       -> string|null
//   measure(ctx)                 -> { scroll:{x,y}, dpr, viewport:{w,h} } | null  (live, from the guest)
//   captureViewport(ctx)         -> dataUrl
//   captureFull(ctx)             -> { ok, dataUrl, cssWidth, cssHeight, error }
//   requestBoxes(ctx, items, space) -> raw caos:boxes reply (space: 'viewport' | 'page')
//   annotationsFor(ctx)          -> annotations on ctx's page ({action,note,target,kind,...})
//   documentIdOf(ctx)            -> current guest document id or ''
//   composite(dataUrl, items, { cssWidth })
//   fallbackWidth(ctx)
export async function captureScreenshot(ctx, { full }, deps) {
  const abort = (why) => ({ ok: false, error: `Screenshot cancelled — ${why}` });
  const stale = () => deps.staleReason(ctx, full ? { doc: true } : { doc: true, active: true });

  const m1 = await deps.measure(ctx);
  let pre = stale();
  if (pre) return abort(pre);

  let dataUrl, cssWidth, cssHeight;
  const kind = full ? 'fullpage' : 'viewport';
  if (full) {
    const cap = await deps.captureFull(ctx);
    if (!cap || !cap.ok) return { ok: false, error: 'Full-page capture failed: ' + ((cap && cap.error) || '?') };
    dataUrl = cap.dataUrl; cssWidth = cap.cssWidth; cssHeight = cap.cssHeight;
  } else {
    dataUrl = await deps.captureViewport(ctx);
  }

  // Fresh boxes, requested right after the pixels were taken, in the shot's space.
  const wanted = deps.annotationsFor(ctx);
  let reply = null;
  if (wanted.length) reply = await deps.requestBoxes(ctx, wanted, full ? 'page' : 'viewport');
  const m2 = wanted.length ? await deps.measure(ctx) : null;
  pre = stale();
  if (pre) return abort(pre);

  if (!wanted.length) return { ok: true, dataUrl, count: 0, skipped: 0, kind };

  const norm = normalizeBoxReply(reply, wanted.length);
  // The reply must come from the document that was captured.
  const wantDoc = deps.documentIdOf ? deps.documentIdOf(ctx) : '';
  if (norm.documentId && wantDoc && norm.documentId !== wantDoc) return abort('the page was replaced');

  // What the guest saw when it measured the boxes (falls back to our own probe).
  const after = norm.scroll || norm.viewport || norm.dpr
    ? { scroll: norm.scroll || (m2 && m2.scroll), viewport: norm.viewport || (m2 && m2.viewport), dpr: norm.dpr || (m2 && m2.dpr) }
    : m2;
  // A viewport shot is only trustworthy if the window did not scroll, resize or
  // rescale between the pixels and the boxes. Full-page shots are origin (0,0)
  // by construction, so only a replaced document invalidates them (checked above).
  const stable = kind === 'fullpage' || !m1 || !after || sameMeasure(m1, after);
  if (!stable) return { ok: true, dataUrl, count: 0, skipped: wanted.length, kind, note: 'The page moved while capturing, so notes were not drawn.' };

  const scroll = (after && after.scroll) || (m1 && m1.scroll) || { x: 0, y: 0 };
  if (kind === 'viewport') {
    cssWidth = (after && after.viewport && after.viewport.w) || (m1 && m1.viewport && m1.viewport.w) || deps.fallbackWidth(ctx);
    cssHeight = (after && after.viewport && after.viewport.h) || (m1 && m1.viewport && m1.viewport.h) || 0;
  }
  const items = wanted.map((a, i) => {
    const b = norm.boxes[i];
    // A stored element box (could not be re-resolved) is stale viewport data:
    // never drawn. Stored drawn-region boxes are page-space by definition.
    const isRegion = a.kind === 'region' || (a.target && a.target.space === 'page');
    const usable = b && !(b.source === 'stored' && !isRegion);
    return { action: a.action, note: a.note, num: a.pinNum || undefined, box: usable ? b : null };
  });
  const { placed, skipped } = placeBoxes(items, { kind, scroll, size: cssWidth && cssHeight ? { w: cssWidth, h: cssHeight } : null });
  const out = placed.length ? await deps.composite(dataUrl, placed, { cssWidth }) : dataUrl;
  return { ok: true, dataUrl: out, count: placed.length, skipped, kind };
}
