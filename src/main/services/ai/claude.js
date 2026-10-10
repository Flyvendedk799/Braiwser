// Anthropic (Claude) Messages API client. Uses the built-in global fetch — no SDK
// dependency. Returns the assistant's text content.
//
// Authentication is not this file's business: it receives ready-made headers and
// a `system` that is either a string or the block array a subscription call needs
// (see services/ai/auth.js). That split keeps the one-header-too-many trap in one
// place instead of spread across every call site.
//
// The deadline (`timeoutMs`) and the caller's `signal` cover the whole exchange,
// body included - see services/ai/http.js.

const { postJson } = require('./http');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// { headers, model, system, user, timeoutMs?, signal?, fetchImpl? } -> Promise<string>
async function complete({ headers, model, system, user, timeoutMs, signal, fetchImpl }) {
  const data = await postJson({
    url: API_URL,
    headers: {
      ...headers,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: {
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    },
    label: 'Claude',
    timeoutMs,
    signal,
    fetchImpl,
  });

  // Concatenate any text blocks; the common case is a single block.
  if (Array.isArray(data.content)) {
    const text = data.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (text) return text;
  }
  // Fallback to the first block's text if present.
  return (data.content && data.content[0] && data.content[0].text) || '';
}

module.exports = { complete };
