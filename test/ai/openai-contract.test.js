// OpenAI Chat Completions request contract per model.
const test = require('node:test');
const assert = require('node:assert/strict');

const openai = require('../../src/main/services/ai/openai');

function body(model) {
  return openai.chatRequestBody({ model, system: 'SYS', user: 'USER' });
}

test('models offered by the app use max_completion_tokens and never max_tokens', () => {
  for (const model of ['gpt-5', 'gpt-5-mini', 'o4-mini', 'gpt-4.1']) {
    const b = body(model);
    assert.ok(Number.isInteger(b.max_completion_tokens) && b.max_completion_tokens > 0, model);
    assert.equal('max_tokens' in b, false, model);
    assert.deepEqual(b.messages.map((m) => m.role), ['system', 'user'], model);
  }
});

test('reasoning models get a larger completion budget than chat models', () => {
  assert.ok(body('o4-mini').max_completion_tokens > body('gpt-4.1').max_completion_tokens);
  assert.ok(body('gpt-5').max_completion_tokens > body('gpt-4o').max_completion_tokens);
});

test('legacy models keep max_tokens', () => {
  for (const model of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4-0613']) {
    const b = body(model);
    assert.equal(b.max_tokens, 4096, model);
    assert.equal('max_completion_tokens' in b, false, model);
  }
});

test('gpt-4.1 / gpt-4o are not mistaken for legacy gpt-4', () => {
  assert.equal(openai.chatContractFor('gpt-4.1').tokenParam, 'max_completion_tokens');
  assert.equal(openai.chatContractFor('gpt-4o-mini').tokenParam, 'max_completion_tokens');
});

test('o1-mini / o1-preview fold instructions into the user turn (no system role)', () => {
  const b = body('o1-mini');
  assert.deepEqual(b.messages.map((m) => m.role), ['user']);
  assert.match(b.messages[0].content, /^SYS\n\nUSER$/);
});

test('unknown future model ids follow the current documented parameter', () => {
  const b = body('gpt-9-ultra');
  assert.ok(b.max_completion_tokens > 0);
  assert.equal('max_tokens' in b, false);
});

test('complete() sends the table row on the wire', async () => {
  let sent;
  await openai.complete({
    headers: { authorization: 'Bearer k' },
    baseUrl: null,
    model: 'o4-mini',
    system: 's',
    user: 'u',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: 'hi' } }] }), text: async () => '' };
    },
  }).then((text) => assert.equal(text, 'hi'));
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.ok(sent.body.max_completion_tokens);
  assert.equal('max_tokens' in sent.body, false);
});
