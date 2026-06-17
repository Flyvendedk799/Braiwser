// OpenAI Chat Completions client. Uses the built-in global fetch (Node 18+) —
// no SDK dependency. Returns the assistant message content.

const API_URL = 'https://api.openai.com/v1/chat/completions';

// { apiKey, model, system, user } -> Promise<string>
async function complete({ apiKey, model, system, user }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000); // 120s cap
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('OpenAI request timed out after 120s');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return (
    (data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    ''
  );
}

module.exports = { complete };
