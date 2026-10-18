import { DEFAULT_TIMERS } from './timers.js';
// One request/reply exchange with ONE guest webview. Listeners are attached to
// (and removed from) the element passed in, never a mutable "active webview"
// global, so a tab switch mid-request can neither misroute the reply nor leak
// the listener onto another tab.

// Resolves with the first `replyChannel` payload, or `fallback` after timeoutMs
// (or immediately if the send throws).
export function requestFromGuest(wv, { channel, payload, replyChannel, timeoutMs = 3000, fallback = null, accept, timers = DEFAULT_TIMERS }) {
  return new Promise((resolve) => {
    if (!wv) { resolve(fallback); return; }
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { wv.removeEventListener('ipc-message', onMsg); } catch (_e) { /* gone */ }
      if (timer) timers.clearTimeout(timer);
      resolve(value);
    };
    function onMsg(e) {
      if (!e || e.channel !== replyChannel) return;
      const data = e.args ? e.args[0] : undefined;
      if (accept && !accept(data)) return;
      finish(data);
    }
    wv.addEventListener('ipc-message', onMsg);
    timer = timers.setTimeout(() => finish(fallback), timeoutMs);
    try {
      if (payload === undefined) wv.send(channel); else wv.send(channel, payload);
    } catch (_e) { finish(fallback); }
  });
}
