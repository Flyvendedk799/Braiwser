// AI orchestration entry point. Resolves the session, annotations, provider,
// model, and API key from the payload + repositories, builds provider-neutral
// messages, calls the selected provider, and returns a normalized result.

const { buildMessages } = require('./prompts');
const { synthesize } = require('./local');
const claude = require('./claude');
const openai = require('./openai');

// Fallback model ids if settings/payload don't supply one. These are current
// model ids; the resolved value prefers payload.model then settings.models.
const FALLBACK_MODELS = {
  claude: 'claude-opus-4-8',
  openai: 'gpt-4o',
};

const PROVIDERS = { claude, openai };

// payload = { task, sessionId?, annotations?, context?, provider?, model? }
// returns Promise<{ ok:true, text } | { ok:false, error }>
async function runAiTask(payload, repos) {
  try {
    const { task } = payload || {};
    const sessionId = payload && payload.sessionId;

    // Resolve session + annotations from the store when not supplied directly.
    const session = sessionId ? repos.sessions.get(sessionId) : null;
    const annotations =
      (payload && payload.annotations) ||
      (sessionId ? repos.annotations.bySession(sessionId) : []);

    // Resolve provider, model, and key.
    const settings = repos.settings.get();
    const provider = (payload && payload.provider) || settings.aiProvider;
    const model =
      (payload && payload.model) ||
      (settings.models && settings.models[provider]) ||
      FALLBACK_MODELS[provider];

    const client = PROVIDERS[provider];
    if (!client) {
      return { ok: false, error: `Unknown AI provider: ${provider}` };
    }

    const apiKey = repos.secrets.getKey(provider);
    if (!apiKey) {
      // No key → synthesize a useful result locally rather than failing.
      return { ok: true, local: true, text: synthesize(task, { session, annotations }) };
    }

    // Build provider-neutral messages and dispatch.
    const { system, user } = buildMessages(task, {
      session,
      annotations,
      context: payload && payload.context,
    });

    const text = await client.complete({ apiKey, model, system, user });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { runAiTask };
