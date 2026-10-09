// AI orchestration entry point. Resolves the session, annotations, provider,
// model, and credential from the payload + repositories, builds provider-neutral
// messages, calls the selected provider, and returns a normalized result.
//
// Credentials come from services/ai/auth.js, which wraps `@flyvendedk799/ai-auth`.
// There are four providers and only two wires: `claude-code` and `anthropic` both
// talk to Anthropic, `codex` and `openai` both talk to OpenAI. What differs is who
// pays and how the request proves it — which is exactly what the auth module owns.

const { buildMessages } = require('./prompts');
const { synthesize } = require('./local');
const auth = require('./auth');
const claude = require('./claude');
const openai = require('./openai');
const { raceAbort, AiRequestCancelled } = require('./http');

// Used when neither the payload nor settings name a model. Kept in step with the
// library's catalogue rather than written out by hand.
const FALLBACK_MODELS = {
  'claude-code': 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  codex: 'gpt-5',
  openai: 'gpt-5',
};

const WIRES = { 'claude-code': 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai' };

// In-flight calls by caller-supplied requestId, so the renderer can cancel one.
// The renderer cannot hand over an AbortSignal across IPC; it hands over an id.
const inflight = new Map();

function cancelAiTask(requestId) {
  const controller = inflight.get(String(requestId));
  if (!controller) return false;
  controller.abort();
  return true;
}

// payload = { task, sessionId?, annotations?, context?, provider?, model?, timeoutMs?, requestId? }
// opts    = { signal?, fetchImpl? }   (signal: in-process cancellation, e.g. tests)
// returns Promise<
//   { ok:true, text, local?:true, reason?:'no-credential', provider, model }
// | { ok:false, error, cancelled?:true }>
async function runAiTask(payload, repos, opts = {}) {
  const settings = repos.settings.get();
  const provider = (payload && payload.provider) || settings.aiProvider;
  const model =
    (payload && payload.model) ||
    (settings.models && settings.models[provider]) ||
    FALLBACK_MODELS[provider];

  const controller = new AbortController();
  const requestId = payload && payload.requestId != null ? String(payload.requestId) : null;
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  if (requestId) inflight.set(requestId, controller);

  try {
    const { task } = payload || {};
    const sessionId = payload && payload.sessionId;

    // Resolve session + annotations from the store when not supplied directly.
    const session = sessionId ? repos.sessions.get(sessionId) : null;
    const annotations =
      (payload && payload.annotations) ||
      (sessionId ? repos.annotations.bySession(sessionId) : []);

    const wire = WIRES[provider];
    if (!wire) return { ok: false, error: `Unknown AI provider: ${provider}` };

    // Three outcomes, kept apart (see auth.credentialFor):
    //   no credential at all  -> synthesize locally and SAY so (below);
    //   a credential that is present but unusable (expired, unreadable, rejected)
    //                         -> a real error, because answering locally would
    //                            disguise a fixable fault as a normal result;
    //   a usable credential   -> call the provider.
    // There is no environment-specific shortcut here: the e2e harness gets the
    // same decision path, with credential sources that are disconnected.
    const timeoutMs = (payload && payload.timeoutMs) || settings.aiTimeoutMs || 120000;
    const startedAt = Date.now();
    let credential;
    try {
      credential = await resolveCredential(repos.dir, provider, controller.signal, timeoutMs);
    } catch (err) {
      if (err && err.cancelled) return cancelled();
      return { ok: false, error: (err && err.message) || String(err) };
    }
    if (controller.signal.aborted) return cancelled();
    if (!credential) {
      return {
        ok: true,
        local: true,
        reason: 'no-credential',
        provider,
        model,
        text: synthesize(task, { session, annotations }),
      };
    }

    // Build provider-neutral messages and dispatch.
    const { system, user } = buildMessages(task, {
      session,
      annotations,
      context: payload && payload.context,
    });

    // One deadline for the whole task: what credential resolution used is not
    // handed out again to the provider call.
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const call = { model, system, user, timeoutMs: remainingMs, signal: controller.signal, fetchImpl: opts.fetchImpl };
    const text = wire === 'anthropic'
      ? await callAnthropic(credential, call)
      : await callOpenAi(credential, call);

    return { ok: true, text, provider, model };
  } catch (err) {
    if (err && err.cancelled) return cancelled();
    // The library turns a provider's own status codes and rate-limit headers into
    // a sentence that says what to do about it — which beats surfacing a raw 429
    // that names a limit the user's plan is nowhere near.
    const described = await auth.describeError(err, provider, model);
    return { ok: false, error: described || (err && err.message) || String(err) };
  } finally {
    if (requestId && inflight.get(requestId) === controller) inflight.delete(requestId);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
  }
}

// Credential resolution can itself touch the network (a token refresh), so it
// runs under the same deadline and cancellation as the provider call.
async function resolveCredential(dir, provider, signal, timeoutMs) {
  const ms = Math.max(5000, Number(timeoutMs) || 120000);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ms);
  const onAbort = () => deadline.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await raceAbort(auth.credentialFor(dir, provider), deadline.signal);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (signal.aborted) throw new AiRequestCancelled('AI');
      throw new Error(`Checking the ${provider} sign-in timed out after ${Math.round(ms / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function cancelled() {
  return { ok: false, cancelled: true, error: 'AI request cancelled' };
}

async function callAnthropic(credential, { model, system, user, timeoutMs, signal, fetchImpl }) {
  const shaped = await auth.anthropicShape(credential, system);
  return claude.complete({ headers: shaped.headers, system: shaped.system, model, user, timeoutMs, signal, fetchImpl });
}

async function callOpenAi(credential, { model, system, user, timeoutMs, signal, fetchImpl }) {
  const shaped = auth.openaiShape(credential);
  return openai.complete({ headers: shaped.headers, baseUrl: shaped.baseUrl, system, model, user, timeoutMs, signal, fetchImpl });
}

module.exports = { runAiTask, cancelAiTask, FALLBACK_MODELS };
