// A replay driver bound to ONE webview. Everything a replay does to a page —
// navigating, sending a step, reading the URL, waiting for acknowledgements —
// goes through the guest element captured in the operation context, never
// through the mutable "active webview" global. Because listeners are attached
// to that element, an ack from any other tab cannot satisfy a waiter, and a
// late ack from an earlier step or run cannot satisfy a later one (every
// request carries a unique wire index plus the run id).
//
// Navigation resolves with an explicit outcome:
//   ready | failed | timeout | cancelled
// and is only "ready" for a document that began loading AFTER the request, so
// an unrelated late dom-ready of the previous page cannot report success.

let wireSeq = 0;

// Options the guest replay engine understands (src/webview/replay.js).
function guestOptions(opts) {
  const o = { fast: !!opts.fast, forVideo: !!opts.forVideo };
  if (opts.actionTimeoutMs) o.actionTimeoutMs = opts.actionTimeoutMs;
  if (opts.allowSuggested) o.allowSuggested = true;
  if (opts.secrets) o.secrets = opts.secrets;
  return o;
}

function addAbort(signal, fn) {
  if (!signal) return () => {};
  if (signal.aborted) { fn(); return () => {}; }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

export function createReplayDriver({ ctx, getUrl, timers = { setTimeout, clearTimeout } }) {
  const wv = ctx.wv;
  const urlNow = () => {
    let u = '';
    try { u = (typeof getUrl === 'function' && getUrl()) || ''; } catch (_e) { /* ignore */ }
    if (!u) { try { u = wv.getURL ? wv.getURL() : ''; } catch (_e) { /* ignore */ } }
    return u || '';
  };

  function navigate(url, { signal, timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      let started = false;
      const events = [];
      const listen = (name, fn) => { wv.addEventListener(name, fn); events.push([name, fn]); };
      let timer = null;
      let unabort = () => {};
      const finish = (outcome, extra) => {
        if (done) return;
        done = true;
        for (const [n, f] of events) { try { wv.removeEventListener(n, f); } catch (_e) { /* ignore */ } }
        if (timer) timers.clearTimeout(timer);
        unabort();
        resolve({ outcome, url: urlNow(), requested: url, ...(extra || {}) });
      };

      const mainFrame = (e) => !e || e.isMainFrame !== false;
      listen('did-start-loading', () => { started = true; });
      listen('did-start-navigation', (e) => { if (mainFrame(e) && !(e && e.isInPlace)) started = true; });
      listen('did-navigate', () => { started = true; });
      listen('dom-ready', () => { if (started) finish('ready'); });
      listen('did-navigate-in-page', (e) => { if (mainFrame(e)) finish('ready'); });
      listen('did-fail-load', (e) => {
        if (!mainFrame(e)) return;
        // -3 is ERR_ABORTED: a superseded navigation. Something else is loading;
        // keep waiting (the timeout still bounds it).
        if (e && e.errorCode === -3) return;
        finish('failed', { error: `${(e && e.errorDescription) || 'load failed'} (${e && e.errorCode})` });
      });
      listen('render-process-gone', (e) => finish('failed', { error: `page crashed (${(e && e.reason) || 'gone'})` }));

      unabort = addAbort(signal, () => finish('cancelled'));
      if (done) return;
      timer = timers.setTimeout(() => finish('timeout'), timeoutMs);
      try {
        wv.src = url;
      } catch (err) {
        finish('failed', { error: (err && err.message) || String(err) });
      }
    });
  }

  // Send one replay step to the guest and wait for ITS acknowledgement.
  function step(stepDef, stepIndex, opts = {}, { signal } = {}) {
    return new Promise((resolve) => {
      const wire = ++wireSeq; // unique per request, echoed back by the guest as `index`
      let done = false;
      let timer = null;
      let unabort = () => {};
      const onMsg = (e) => {
        if (!e || e.channel !== 'caos:replay-ack') return;
        const p = e.args && e.args[0];
        if (!p || p.index !== wire) return;
        if (p.runId !== undefined && p.runId !== ctx.runId) return;
        finish({
          ok: !!p.ok, error: p.error, actual: p.actual,
          status: p.status, effect: p.effect, reason: p.reason,
          needsPostcondition: p.needsPostcondition, targetConfidence: p.targetConfidence, suggestion: p.suggestion,
        });
      };
      const finish = (res) => {
        if (done) return;
        done = true;
        try { wv.removeEventListener('ipc-message', onMsg); } catch (_e) { /* ignore */ }
        if (timer) timers.clearTimeout(timer);
        unabort();
        resolve(res);
      };
      wv.addEventListener('ipc-message', onMsg);
      unabort = addAbort(signal, () => finish({ ok: false, cancelled: true, error: 'cancelled' }));
      if (done) return;
      // Typing + cursor travel can exceed a short budget on long fields.
      const timeoutMs = opts.timeoutMs || (opts.fast ? 5000 : 20000);
      timer = timers.setTimeout(() => finish({ ok: false, timedOut: true, error: 'no response (timeout)' }), timeoutMs);
      try {
        wv.send('caos:replay-step', { step: stepDef, index: wire, stepIndex, runId: ctx.runId, opts: guestOptions(opts) });
      } catch (err) {
        finish({ ok: false, dispatched: false, error: 'could not reach the page: ' + ((err && err.message) || err) });
      }
    });
  }

  function setCursor(show) {
    try { wv.send('caos:replay-cursor', { show: !!show }); } catch (_e) { /* guest gone */ }
  }

  return { navigate, step, currentUrl: urlNow, setCursor };
}
