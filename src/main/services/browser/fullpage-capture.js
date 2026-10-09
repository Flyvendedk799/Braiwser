'use strict';
// Full-page screenshot of a guest webContents via the shared debugger broker.
//
// Evidence grade matters downstream (verdicts, reports):
//   * mode 'viewport'  / transformed:false — pixels exactly as the page shows
//     right now (wc.capturePage). Usable as unmodified evidence.
//   * mode 'fullpage'  / transformed:true  — the viewport is grown to the
//     document and sticky/fixed elements are flattened to absolute, so the image
//     shows a layout the user never saw. It is an EXPORT, not evidence of what
//     was rendered. Callers must not treat it as an unmodified observation.
//
// Electron-free: takes a webContents-like object and a broker, so it is unit
// testable with fakes.

const { getSharedBroker } = require('./debugger-broker');

const FIXED_FLATTEN_JS = `(() => {
  if (window.__braiwserFixedRestore) return;
  const nodes = Array.from(document.querySelectorAll('*'));
  const changed = [];
  for (const el of nodes) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      changed.push({ el, position: el.style.position, top: el.style.top });
      el.style.position = 'absolute';
    }
  }
  window.__braiwserFixedRestore = () => {
    for (const c of changed) {
      c.el.style.position = c.position;
      c.el.style.top = c.top;
    }
    delete window.__braiwserFixedRestore;
  };
})()`;

const RESTORE_JS = 'window.__braiwserFixedRestore && window.__braiwserFixedRestore()';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function viewportFallback(wc) {
  try {
    const img = await wc.capturePage();
    const size = img.getSize();
    return {
      ok: true,
      dataUrl: img.toDataURL(),
      cssWidth: size.width,
      cssHeight: size.height,
      viewportOnly: true,
      transformed: false,
      mode: 'viewport',
    };
  } catch (_e) {
    return null;
  }
}

async function captureFullPage(wc, options) {
  const o = options || {};
  const broker = o.broker || getSharedBroker();
  const sleep = o.sleep || delay;
  let lease = null;
  try {
    // exclusive: viewport emulation must not interleave with driver input.
    // allowBorrow keeps the previous behaviour of working next to a foreign client.
    lease = broker.acquire(wc, { owner: 'capture-fullpage', exclusive: true, allowBorrow: true });
  } catch (err) {
    const fallback = await viewportFallback(wc);
    if (fallback) return { ...fallback, note: `full-page capture unavailable (${err.code || err.message})` };
    return { ok: false, error: String((err && err.message) || err) };
  }

  let overrode = false;
  let flattened = false;
  const restore = async () => {
    if (flattened) {
      flattened = false;
      try { await wc.executeJavaScript(RESTORE_JS, true); } catch (_e) { /* ignore */ }
    }
    if (overrode) {
      overrode = false;
      try { await lease.send('Emulation.clearDeviceMetricsOverride'); } catch (_e) { /* ignore */ }
    }
  };

  try {
    try { await wc.executeJavaScript('window.scrollTo(0, 0)', true); } catch (_e) { /* ignore */ }
    await sleep(60);
    const metrics = await lease.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize || { width: 1200, height: 800 };
    // Grow the VIEWPORT to the document and take an ordinary screenshot.
    // 'captureBeyondViewport' is the tidier API, but on this Chromium it takes
    // the renderer down outright (a NOTREACHED, not a catchable error) often
    // enough to lose the app — and a crash is a worse screenshot than a
    // slightly reflowed one. Height is capped so a runaway page cannot ask for
    // a surface nothing can allocate.
    const width = Math.max(320, Math.min(4000, Math.ceil(size.width)));
    const full = Math.ceil(size.height);
    const height = Math.max(240, Math.min(12000, full));
    await lease.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    overrode = true;
    // Soften sticky/fixed chrome so full-page shots don't stamp the same
    // header onto every band of a long document.
    flattened = true; // attempted: restore even if the script threw midway
    try { await wc.executeJavaScript(FIXED_FLATTEN_JS, true); } catch (_e) { /* ignore */ }
    await sleep(140); // let it lay out at the new size
    if (lease.lost) throw new Error('debugger detached during capture');
    const shot = await lease.send('Page.captureScreenshot', { format: 'png' });
    return {
      ok: true,
      dataUrl: 'data:image/png;base64,' + shot.data,
      cssWidth: width,
      cssHeight: height,
      truncated: height < full,
      transformed: true,
      mode: 'fullpage',
      transforms: ['viewport-resized-to-document', 'fixed-and-sticky-flattened'],
    };
  } catch (e) {
    // Last resort: whatever is on screen right now — but undo our changes first
    // so the fallback really is the unmodified viewport.
    await restore();
    const fallback = await viewportFallback(wc);
    if (fallback) return fallback;
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await restore();
    lease.release();
  }
}

module.exports = { captureFullPage };
