// One request/response cycle against a provider, with a single deadline that
// covers the WHOLE exchange: connection, headers and the body. The previous
// clients cleared their timer as soon as `fetch` resolved (headers), so a server
// that sent headers and then stalled left the call pending forever and the AI
// panel's Run button disabled.
//
// Two ways out besides success:
//   - the deadline passes        -> Error "<label> request timed out after Ns"
//   - the caller's signal fires  -> Error with `.cancelled = true`
//
// Body reads are RACED against the abort signal rather than trusting the fetch
// implementation to reject them: real undici does, but a wrapped or mocked
// response may not, and the guarantee here is "this promise settles".

const MAX_ERROR_BODY = 4000;

class AiRequestCancelled extends Error {
  constructor(label) {
    super(`${label} request cancelled`);
    this.name = 'AiRequestCancelled';
    this.cancelled = true;
  }
}

function abortReason(signal) {
  const e = new Error('aborted');
  e.name = 'AbortError';
  e.reason = signal.reason;
  return e;
}

// Settles with `promise`, or rejects as soon as `signal` aborts - whichever is
// first. The losing branch is silenced so it cannot become an unhandled rejection.
function raceAbort(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// { url, headers, body, label, timeoutMs, signal } -> Promise<parsed JSON>
// Non-2xx responses reject with an Error carrying `.status` and `.headers` (the
// provider library reads rate-limit headers off it).
async function postJson({ url, headers, body, label, timeoutMs, signal: external, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const ms = Math.max(5000, Number(timeoutMs) || 120000);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) { clearTimeout(timer); throw new AiRequestCancelled(label); }
    external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const classify = (err) => {
    if (timedOut) return new Error(`${label} request timed out after ${Math.round(ms / 1000)}s`);
    if (external && external.aborted) return new AiRequestCancelled(label);
    return err;
  };

  try {
    const res = await raceAbort(doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }), controller.signal);

    if (!res.ok) {
      let text = '';
      let bodyNote = '';
      try {
        text = String(await raceAbort(res.text(), controller.signal)).slice(0, MAX_ERROR_BODY);
      } catch (_e) {
        // The status is already known and is what matters; say honestly that the
        // explanation never arrived rather than hanging or pretending it was empty.
        if (external && external.aborted) throw new AiRequestCancelled(label);
        bodyNote = timedOut ? ' (error body timed out)' : ' (error body unreadable)';
      }
      const err = new Error(`${label} API error ${res.status}: ${text}${bodyNote}`);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }

    return await raceAbort(res.json(), controller.signal);
  } catch (err) {
    if (err && (err.status || err.cancelled)) throw err;
    if (timedOut || (external && external.aborted) || (err && err.name === 'AbortError')) throw classify(err);
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

module.exports = { postJson, raceAbort, AiRequestCancelled };
