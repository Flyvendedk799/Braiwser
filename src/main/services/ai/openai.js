// OpenAI client. Uses the built-in global fetch — no SDK dependency. Returns the
// assistant's text.
//
// Two wires, because a ChatGPT subscription is not just an API key with a
// different host: Codex speaks the Responses API at chatgpt.com, while a metered
// key speaks Chat Completions at api.openai.com. Same provider, different request
// shape and different reply shape, so they are kept as two paths rather than one
// path with a swapped base URL.

const { postJson } = require('./http');

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// Chat Completions request contract per model family. `max_tokens` is deprecated
// and rejected by the o-series and newer models, which take
// `max_completion_tokens` (a budget that also covers hidden reasoning tokens, so
// reasoning models get a larger one). Legacy models predate that parameter. The
// first matching row wins; the last row is the default for ids we do not know,
// which follows the current documented API.
//
//   tokenParam    name of the output-limit field
//   maxTokens     the limit sent
//   systemInstructions  'system' = a system message; 'user' = the model rejects
//                 system messages, so the instructions are prepended to the user turn
const CHAT_CONTRACTS = [
  { match: /^o1-(mini|preview)/, tokenParam: 'max_completion_tokens', maxTokens: 16384, systemInstructions: 'user' },
  { match: /^(o\d|gpt-5)/, tokenParam: 'max_completion_tokens', maxTokens: 16384, systemInstructions: 'system' },
  { match: /^gpt-(4\.1|4o|4\.5)/, tokenParam: 'max_completion_tokens', maxTokens: 4096, systemInstructions: 'system' },
  { match: /^gpt-3\.5/, tokenParam: 'max_tokens', maxTokens: 4096, systemInstructions: 'system' },
  { match: /^gpt-4(-|$)/, tokenParam: 'max_tokens', maxTokens: 4096, systemInstructions: 'system' },
  { match: /./, tokenParam: 'max_completion_tokens', maxTokens: 4096, systemInstructions: 'system' },
];

function chatContractFor(model) {
  const id = String(model || '').toLowerCase();
  return CHAT_CONTRACTS.find((row) => row.match.test(id));
}

function chatRequestBody({ model, system, user }) {
  const contract = chatContractFor(model);
  const sys = typeof system === 'string' ? system : '';
  const messages = contract.systemInstructions === 'user'
    ? [{ role: 'user', content: sys ? `${sys}\n\n${user}` : user }]
    : [{ role: 'system', content: sys }, { role: 'user', content: user }];
  return { model, messages, [contract.tokenParam]: contract.maxTokens };
}

// { headers, baseUrl, model, system, user, timeoutMs?, signal?, fetchImpl? } -> Promise<string>
// baseUrl set = a Codex subscription; null = a metered OpenAI key.
async function complete({ headers, baseUrl, model, system, user, timeoutMs, signal, fetchImpl }) {
  const json = { 'content-type': 'application/json' };
  if (baseUrl) {
    const data = await postJson({
      url: `${baseUrl}/responses`,
      headers: { ...headers, ...json },
      body: {
        model,
        instructions: typeof system === 'string' ? system : '',
        input: user,
      },
      label: 'Codex',
      timeoutMs,
      signal,
      fetchImpl,
    });
    return responsesText(data);
  }

  const data = await postJson({
    url: CHAT_URL,
    headers: { ...headers, ...json },
    body: chatRequestBody({ model, system, user }),
    label: 'OpenAI',
    timeoutMs,
    signal,
    fetchImpl,
  });

  return (
    (data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    ''
  );
}

// The Responses API returns output items rather than a message. Only the text
// parts are wanted; anything else in there is not an answer.
function responsesText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  if (!Array.isArray(data.output)) return '';
  return data.output
    .flatMap((item) => (item && Array.isArray(item.content) ? item.content : []))
    .filter((c) => c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text'))
    .map((c) => c.text)
    .join('');
}

module.exports = { complete, chatContractFor, chatRequestBody, CHAT_CONTRACTS };
