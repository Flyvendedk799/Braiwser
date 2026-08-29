// Anthropic (Claude) Messages API client. Uses the built-in global fetch — no SDK
// dependency. Returns the assistant's text content.
//
// Authentication is not this file's business: it receives ready-made headers and
// a `system` that is either a string or the block array a subscription call needs
// (see services/ai/auth.js). That split keeps the one-header-too-many trap in one
// place instead of spread across every call site.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// { headers, model, system, user } -> Promise<string>
async function complete({ headers, model, system, user }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000); // 120s cap
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        ...headers,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Claude request timed out after 120s');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Carry the status and headers on the error: the library reads the rate-limit
    // headers off it to tell "your plan is busy" apart from "your key is wrong".
    const err = new Error(`Claude API error ${res.status}: ${text}`);
    err.status = res.status;
    err.headers = res.headers;
    throw err;
  }

  const data = await res.json();
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
