// Composite annotation overlays onto a captured screenshot. Draws a colored
// box + numbered badge + truncated note for each annotation that has a target
// box, scaled from CSS pixels to the captured image's pixels.
//
// COORDINATE SPACES (CE-13). A box is either in `viewport` space (relative to
// the visible window: what getBoundingClientRect returns) or in `page` space
// (document coordinates: viewport + scroll origin). A screenshot is one of:
//   'viewport'  the visible window only, taken at some scroll origin
//   'fullpage'  the whole document from (0,0)
// placeBoxes() converts every box into the target screenshot's CSS-pixel space
// using the scroll origin MEASURED at capture time; compositeAnnotations then
// applies the image/CSS scale. The pure functions below have no DOM dependency.

const ACTION_COLORS = {
  remove: '#ff6b6b', change: '#ffb454', fix: '#5b8cff',
  add: '#3ddc97', question: '#c792ea', comment: '#9aa2b1',
};

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function asBox(b) {
  if (!b || typeof b !== 'object') return null;
  const x = num(b.x), y = num(b.y), w = num(b.w), h = num(b.h);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

// Normalise whatever the guest answered to `caos:request-page-boxes` into
//   { boxes:[{x,y,w,h,space,source}|null], scroll:{x,y}|null, dpr:number|null, viewport:{w,h}|null,
//     page:{w,h}|null, documentId:string|null, requestId:any }
// Accepts the legacy bare array (page-space boxes), the tagged object form and
// the guest's caos:boxes reply ({requestId, space, documentId, scroll, dpr, viewport, page, boxes})
//   { boxes:[...], space:'page'|'viewport', scroll|origin:{x,y}, dpr, viewport:{w,h} }
// where each box may carry its own `space`.
export function normalizeBoxReply(reply, count) {
  let list = [], space = 'page', scroll = null, dpr = null, viewport = null, page = null, documentId = null, requestId = null;
  if (Array.isArray(reply)) {
    list = reply;
  } else if (reply && typeof reply === 'object') {
    list = Array.isArray(reply.boxes) ? reply.boxes : [];
    if (reply.space === 'viewport' || reply.space === 'page') space = reply.space;
    const o = reply.scroll || reply.origin || (reply.scrollX !== undefined ? { x: reply.scrollX, y: reply.scrollY } : null);
    if (o && num(o.x) !== null && num(o.y) !== null) scroll = { x: o.x, y: o.y };
    dpr = num(reply.dpr) || num(reply.devicePixelRatio) || null;
    const v = reply.viewport || (reply.innerWidth !== undefined ? { w: reply.innerWidth, h: reply.innerHeight } : null);
    if (v && num(v.w) !== null && num(v.h) !== null) viewport = { w: v.w, h: v.h };
    if (reply.page && num(reply.page.w) !== null && num(reply.page.h) !== null) page = { w: reply.page.w, h: reply.page.h };
    if (typeof reply.documentId === 'string') documentId = reply.documentId;
    if (reply.requestId !== undefined) requestId = reply.requestId;
  }
  const n = typeof count === 'number' ? count : list.length;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const raw = list[i];
    const b = asBox(raw);
    boxes.push(b ? { ...b, space: raw && (raw.space === 'viewport' || raw.space === 'page') ? raw.space : space, source: raw && raw.source === 'stored' ? 'stored' : 'live' } : null);
  }
  return { boxes, scroll, dpr, viewport, page, documentId, requestId };
}

// Convert tagged boxes into the screenshot's own CSS-pixel space.
//   items: [{ action, note, box:{x,y,w,h,space} }]
//   shot:  { kind:'viewport'|'fullpage', scroll:{x,y}, size:{w,h} }  (size = CSS size of the image)
// Returns { placed:[{...item, box:{x,y,w,h}}], skipped:number } where skipped
// counts boxes missing, or entirely outside the captured area.
export function placeBoxes(items, shot) {
  const sx = (shot.scroll && num(shot.scroll.x)) || 0;
  const sy = (shot.scroll && num(shot.scroll.y)) || 0;
  const placed = [];
  let skipped = 0;
  for (const it of items) {
    const b = it && it.box;
    if (!b) { skipped++; continue; }
    const space = b.space === 'viewport' ? 'viewport' : 'page';
    let { x, y } = b;
    if (shot.kind === 'viewport' && space === 'page') { x -= sx; y -= sy; }
    else if (shot.kind === 'fullpage' && space === 'viewport') { x += sx; y += sy; }
    const out = { x, y, w: b.w, h: b.h };
    if (shot.size && (out.x + out.w <= 0 || out.y + out.h <= 0 || out.x >= shot.size.w || out.y >= shot.size.h)) { skipped++; continue; }
    placed.push({ ...it, box: out });
  }
  return { placed, skipped };
}

// Did the page move between two measurements taken around a capture?
export function sameMeasure(a, b) {
  if (!a || !b) return false;
  const eq = (p, q) => Math.abs((p || 0) - (q || 0)) < 0.5;
  return eq(a.scroll && a.scroll.x, b.scroll && b.scroll.x) && eq(a.scroll && a.scroll.y, b.scroll && b.scroll.y)
    && eq(a.viewport && a.viewport.w, b.viewport && b.viewport.w) && eq(a.viewport && a.viewport.h, b.viewport && b.viewport.h)
    && eq(a.dpr, b.dpr);
}

export function compositeAnnotations(dataUrl, annotations, { cssWidth, colors } = {}) {

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const scale = cssWidth ? img.naturalWidth / cssWidth : 1;
      ctx.font = `${Math.round(13 * scale)}px -apple-system, sans-serif`;
      ctx.textBaseline = 'top';

      annotations.forEach((a, i) => {
        // The box must already be in this image's CSS-pixel space (placeBoxes).
        // Stored target boxes are never used here: they are stale and unlabelled.
        const box = a.box;
        if (!box) return;
        const color = (colors && colors[a.action]) || ACTION_COLORS[a.action] || '#9aa2b1';
        const x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;

        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, 2 * scale);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = hexA(color, 0.12);
        ctx.fillRect(x, y, w, h);

        // numbered badge
        const r = 11 * scale;
        ctx.beginPath();
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#0e0f13';
        ctx.textAlign = 'center';
        ctx.fillText(String(a.num || i + 1), x + r, y + r - 7 * scale);
        ctx.textAlign = 'left';

        // note label
        const label = `${a.action}: ${a.note}`.slice(0, 48);
        const ty = y + h + 3 * scale;
        const tw = ctx.measureText(label).width + 10 * scale;
        ctx.fillStyle = 'rgba(14,15,19,0.85)';
        ctx.fillRect(x, ty, tw, 18 * scale);
        ctx.fillStyle = color;
        ctx.fillText(label, x + 5 * scale, ty + 2 * scale);
      });

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
