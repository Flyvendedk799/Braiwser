// OpenAI client. Uses the built-in global fetch — no SDK dependency. Returns the
// assistant's text.
//
// Two wires, because a ChatGPT subscription is not just an API key with a
// different host: Codex speaks the Responses API at chatgpt.com, while a metered
// key speaks Chat Completions at api.openai.com. Same provider, different request
// shape and different reply shape, so they are kept as two paths rather than one
// path with a swapped base URL.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

async function post(url, headers, body, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000); // 120s cap
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`${label} request timed out after 120s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${label} API error ${res.status}: ${text}`);
    err.status = res.status;
    err.headers = res.headers;
    throw err;
  }
  return res.json();
}

// { headers, baseUrl, model, system, user } -> Promise<string>
// baseUrl set = a Codex subscription; null = a metered OpenAI key.
async function complete({ headers, baseUrl, model, system, user }) {
  if (baseUrl) {
    const data = await post(`${baseUrl}/responses`, headers, {
      model,
      instructions: typeof system === 'string' ? system : '',
      input: user,
    }, 'Codex');
    return responsesText(data);
  }

  const data = await post(CHAT_URL, headers, {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 4096,
  }, 'OpenAI');

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

module.exports = { complete };
