// AI-02: the deadline covers body consumption; cancellation settles the call.
const test = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../../src/main/services/ai/claude');
const openai = require('../../src/main/services/ai/openai');

const never = () => new Promise(() => {});

function response({ ok = true, status = 200, json, text }) {
  return {
    ok,
    status,
    headers: new Map([['retry-after', '3']]),
    json: json || (async () => ({})),
    text: text || (async () => ''),
  };
}

const CLAUDE_BASE = { headers: { 'x-api-key': 'k' }, model: 'claude-sonnet-5', system: 's', user: 'u' };
const OPENAI_BASE = { headers: { authorization: 'Bearer k' }, baseUrl: null, model: 'gpt-5', system: 's', user: 'u' };

const CLIENTS = [
  ['claude', (extra) => claude.complete({ ...CLAUDE_BASE, ...extra }), 'Claude'],
  ['openai', (extra) => openai.complete({ ...OPENAI_BASE, ...extra }), 'OpenAI'],
  ['codex', (extra) => openai.complete({ ...OPENAI_BASE, baseUrl: 'https://chatgpt.test/backend', ...extra }), 'Codex'],
];

for (const [name, call, label] of CLIENTS) {
  test(`${name}: a stalled SUCCESS body settles at the deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = call({ timeoutMs: 5000, fetchImpl: async () => response({ json: never }) });
    const settled = assert.rejects(p, new RegExp(`${label} request timed out after 5s`));
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(5000);
    await settled;
  });

  test(`${name}: a stalled ERROR body still reports the status`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = call({ timeoutMs: 5000, fetchImpl: async () => response({ ok: false, status: 429, text: never }) });
    const settled = assert.rejects(p, (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, new RegExp(`${label} API error 429`));
      assert.match(err.message, /error body timed out/);
      assert.ok(err.headers);
      return true;
    });
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(5000);
    await settled;
  });

  test(`${name}: a stalled fetch (no headers) times out`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = call({ timeoutMs: 5000, fetchImpl: never });
    const settled = assert.rejects(p, /timed out/);
    t.mock.timers.tick(5000);
    await settled;
  });

  test(`${name}: aborting the signal during a stalled body cancels the call`, async () => {
    const controller = new AbortController();
    let started;
    const fetched = new Promise((r) => { started = r; });
    const p = call({
      timeoutMs: 60000,
      signal: controller.signal,
      fetchImpl: async () => { started(); return response({ json: never }); },
    });
    const settled = assert.rejects(p, (err) => err.cancelled === true && /cancelled/.test(err.message));
    await fetched;
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await settled;
  });

  test(`${name}: an already-aborted signal never calls fetch`, async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await assert.rejects(call({ signal: controller.signal, fetchImpl: async () => { called = true; return response({}); } }), (e) => e.cancelled);
    assert.equal(called, false);
  });

  test(`${name}: non-2xx with a readable body keeps status, headers and text`, async () => {
    await assert.rejects(
      call({ fetchImpl: async () => response({ ok: false, status: 401, text: async () => '{"error":"bad key"}' }) }),
      (err) => err.status === 401 && /bad key/.test(err.message) && err.headers.get('retry-after') === '3',
    );
  });
}

test('claude: a normal response still returns concatenated text and clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const out = await claude.complete({
    ...CLAUDE_BASE,
    timeoutMs: 5000,
    fetchImpl: async (url, init) => {
      assert.match(url, /api\.anthropic\.com/);
      assert.equal(JSON.parse(init.body).max_tokens, 4096);
      return response({ json: async () => ({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) });
    },
  });
  assert.equal(out, 'ab');
  // Ticking past the deadline afterwards must not abort or throw anything.
  t.mock.timers.tick(10000);
});
