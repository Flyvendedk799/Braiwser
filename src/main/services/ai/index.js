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

// Used when neither the payload nor settings name a model. Kept in step with the
// library's catalogue rather than written out by hand.
const FALLBACK_MODELS = {
  'claude-code': 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  codex: 'gpt-5',
  openai: 'gpt-5',
};

const WIRES = { 'claude-code': 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai' };

// payload = { task, sessionId?, annotations?, context?, provider?, model? }
// returns Promise<{ ok:true, text, local?, provider, model } | { ok:false, error }>
async function runAiTask(payload, repos) {
  const settings = repos.settings.get();
  const provider = (payload && payload.provider) || settings.aiProvider;
  const model =
    (payload && payload.model) ||
    (settings.models && settings.models[provider]) ||
    FALLBACK_MODELS[provider];

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

    // No credential at all → synthesize a useful result locally rather than
    // failing. A missing *subscription*, by contrast, is a state the user can fix
    // and should hear about, so that path throws and is described below.
    //
    // The harness never spends a credential. Now that a `claude` login on the
    // machine is enough to make real calls, an unguarded suite would bill the
    // developer's own subscription on every run and turn a local-synthesis test
    // into a network test.
    let credential = null;
    try {
      credential = process.env.CAOS_E2E === '1' ? null : await auth.credentialFor(repos.dir, provider);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    if (!credential) {
      return { ok: true, local: true, provider, model, text: synthesize(task, { session, annotations }) };
    }

    // Build provider-neutral messages and dispatch.
    const { system, user } = buildMessages(task, {
      session,
      annotations,
      context: payload && payload.context,
    });

    const text = wire === 'anthropic'
      ? await callAnthropic(credential, { model, system, user })
      : await callOpenAi(credential, { model, system, user });

    return { ok: true, text, provider, model };
  } catch (err) {
    // The library turns a provider's own status codes and rate-limit headers into
    // a sentence that says what to do about it — which beats surfacing a raw 429
    // that names a limit the user's plan is nowhere near.
    const described = await auth.describeError(err, provider, model);
    return { ok: false, error: described || (err && err.message) || String(err) };
  }
}

async function callAnthropic(credential, { model, system, user }) {
  const shaped = await auth.anthropicShape(credential, system);
  return claude.complete({ headers: shaped.headers, system: shaped.system, model, user });
}

async function callOpenAi(credential, { model, system, user }) {
  const shaped = auth.openaiShape(credential);
  return openai.complete({ headers: shaped.headers, baseUrl: shaped.baseUrl, system, model, user });
}

module.exports = { runAiTask, FALLBACK_MODELS };
