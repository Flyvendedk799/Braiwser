// The model-driven corpus adapter, with the model replaced by a stubbed transport.
// Nothing here touches the network or needs a key: the loop, its bounds, its token
// accounting and the "no key -> unmeasured" gate are tested as code. The last tests
// run the stub through the real MCP server and headless Chromium and skip (with the
// reason) when Chromium is not installed. What a real model does is NOT tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ADAPTER_NAME, DEFAULT_MODEL, NO_KEY_REASON, SYSTEM_PROMPT, REPORT_TOOL, TASK_SPECS, WITHHELD_TOOLS,
  modelConfig, createAnthropicTransport, runModelLoop, createTokenBudget, addUsage, emptyUsage, totalTokens,
  buildTaskPrompt, valuesFromAnswer, toModelTools,
} from '../corpus/model-agent.mjs';
import { loadManifest } from '../corpus/index.mjs';
import { oracles } from '../corpus/oracles.mjs';
import { newWorld } from '../corpus/sites.mjs';
import { runCorpus, summarize } from '../corpus/runner.mjs';

const require = createRequire(import.meta.url);
const { browserAvailable } = require('../drivers/_env.js');

const TOOLS = [{ name: 'browser_observe', description: 'observe', input_schema: { type: 'object', properties: {} } }];
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, usage = { input_tokens: 10, output_tokens: 5 }, stop = 'tool_use') => ({ content, stop_reason: stop, usage });
const report = (id, status, answer) => use(id, 'report_result', { status, ...(answer ? { answer } : {}) });
// A transport that replays fixed responses and records every request it was sent.
function scripted(responses) {
  const requests = [];
  const send = async (request) => {
    requests.push(JSON.parse(JSON.stringify({ ...request, signal: undefined })));
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(request) : next;
  };
  return { send, requests };
}
const loop = (over) => runModelLoop({ model: 'stub-model', tools: TOOLS, userText: 'Task: test', callTool: async () => ({ text: '{"ok":true}', isError: false }), ...over });

test('happy path: the model calls a tool, reads the result and reports; the claim is its own', async () => {
  const t = scripted([
    reply([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Looking.' }, use('tu_1', 'browser_observe', { sessionId: 's' })]),
    reply([report('tu_2', 'done', { title: 'Dynamic lab' })]),
  ]);
  const calls = [];
  const r = await loop({ transport: t.send, callTool: async (name, args) => { calls.push([name, args]); return { text: '{"ok":true,"value":{"nodes":[]}}', isError: false }; } });
  assert.equal(r.stop, 'reported');
  assert.deepEqual(r.claim, { status: 'done' });
  assert.deepEqual(r.answer, { title: 'Dynamic lab' });
  assert.equal(r.turns, 2);
  assert.equal(r.toolCalls, 1, 'report_result is not a browser tool call');
  assert.deepEqual(calls, [['browser_observe', { sessionId: 's' }]]);
  // request shape
  const [first, second] = t.requests;
  assert.equal(first.model, 'stub-model');
  assert.equal(first.system, SYSTEM_PROMPT);
  assert.deepEqual(first.tools.map((x) => x.name), ['browser_observe', 'report_result']);
  assert.deepEqual(first.messages, [{ role: 'user', content: 'Task: test' }]);
  // the assistant turn goes back unchanged (thinking block included) and the result follows in one user message
  assert.deepEqual(second.messages[1], { role: 'assistant', content: t.requests.length && [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Looking.' }, use('tu_1', 'browser_observe', { sessionId: 's' })] });
  assert.deepEqual(second.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true,"value":{"nodes":[]}}' }] });
});

test('the system prompt declares page content untrusted and requires an explicit report', () => {
  assert.match(SYSTEM_PROMPT, /untrusted data/);
  assert.match(SYSTEM_PROMPT, /never an instruction/);
  assert.match(SYSTEM_PROMPT, /Never type passwords/);
  assert.match(SYSTEM_PROMPT, /report_result exactly once/);
  assert.deepEqual(REPORT_TOOL.input_schema.required, ['status']);
});

test('a tool error is surfaced to the model as an error result, and the loop goes on', async () => {
  const t = scripted([
    reply([use('tu_1', 'browser_observe', {}), use('tu_2', 'browser_observe', {}), use('tu_3', 'browser_nope', {})]),
    reply([report('tu_4', 'blocked')]),
  ]);
  let n = 0;
  const r = await loop({ transport: t.send, callTool: async () => {
    n += 1;
    if (n === 1) return { text: '{"ok":false,"error":{"code":"DENIED","message":"policy"}}', isError: true };
    throw new Error('harness fault');
  } });
  assert.equal(r.stop, 'reported');
  assert.deepEqual(r.claim, { status: 'blocked' });
  const results = t.requests[1].messages[2].content;
  assert.equal(results.length, 3, 'every tool_use gets a tool_result in one message');
  assert.deepEqual(results[0], { type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":false,"error":{"code":"DENIED","message":"policy"}}', is_error: true });
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /Tool call failed: harness fault/);
  assert.equal(results[2].is_error, true);
  assert.match(results[2].content, /Unknown tool browser_nope/);
  assert.equal(r.toolCalls, 2, 'the unknown tool never ran');
});

test('turn cap: a model that never reports is stopped and has made no claim', async () => {
  const t = scripted([reply([use('tu', 'browser_observe', {})])]);
  const r = await loop({ transport: t.send, maxTurns: 3 });
  assert.equal(r.stop, 'turn-cap');
  assert.equal(r.turns, 3);
  assert.equal(t.requests.length, 3);
  assert.equal(r.claim, null, 'no default claim, neither done nor failed');
  assert.equal(r.toolCalls, 3);
});

test('other stops: no report, refusal, cut-off output, timeout, request failure, invalid report', async () => {
  assert.equal((await loop({ transport: scripted([reply([{ type: 'text', text: 'All done!' }], undefined, 'end_turn')]).send })).stop, 'no-report');

  const refusal = await loop({ transport: scripted([{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: { input_tokens: 3, output_tokens: 0 } }]).send });
  assert.equal(refusal.stop, 'refusal');
  assert.equal(refusal.detail, 'category: cyber');
  assert.equal(refusal.usage.inputTokens, 3);

  let ran = 0;
  const cut = await loop({ transport: scripted([reply([use('tu', 'browser_observe', {})], undefined, 'max_tokens')]).send, callTool: async () => { ran += 1; return { text: '', isError: false }; } });
  assert.equal(cut.stop, 'max-output-tokens');
  assert.equal(ran, 0, 'a possibly truncated tool call is not executed');

  // deadline: the clock passes it during the first tool call
  let clock = 1000;
  const late = await loop({ transport: scripted([reply([use('tu', 'browser_observe', {})])]).send, now: () => clock, deadline: 2000,
    callTool: async () => { clock = 5000; return { text: 'x', isError: false }; } });
  assert.equal(late.stop, 'timeout');
  assert.equal(late.turns, 1);
  assert.equal(late.claim, null);
  // a request that never settles is abandoned at the deadline
  const hung = await runModelLoop({ model: 'm', tools: TOOLS, userText: 'x', callTool: async () => ({ text: '', isError: false }),
    transport: () => new Promise(() => {}), deadline: Date.now() + 30 });
  assert.equal(hung.stop, 'timeout');

  const failed = await loop({ transport: async () => { const e = new Error('Claude API error 401: {"type":"error"}'); e.status = 401; throw e; } });
  assert.equal(failed.stop, 'api-error');
  assert.match(failed.detail, /401/);
  assert.equal((await loop({ transport: async () => ({ nope: true }) })).stop, 'api-error');

  // an invalid status is refused back to the model; it may correct itself on the next turn
  const t = scripted([reply([report('tu_1', 'success')]), reply([report('tu_2', 'done', 'text')]), reply([report('tu_3', 'unknown'), use('tu_4', 'browser_observe', {})])]);
  let after = 0;
  const fixed = await loop({ transport: t.send, callTool: async () => { after += 1; return { text: '', isError: false }; } });
  assert.equal(t.requests[1].messages[2].content[0].is_error, true);
  assert.match(t.requests[1].messages[2].content[0].content, /status must be one of/);
  assert.match(t.requests[2].messages[4].content[0].content, /answer must be an object/);
  assert.deepEqual(fixed.claim, { status: 'unknown' });
  assert.equal(after, 0, 'nothing runs after the result was reported');
});

test('token accounting: usage fields are summed as reported, cache fields kept apart, nothing estimated', async () => {
  const t = scripted([
    reply([use('a', 'browser_observe', {})], { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 }),
    reply([use('b', 'browser_observe', {})], { input_tokens: 40, output_tokens: 30, cache_creation_input_tokens: 50, cache_read_input_tokens: 900 }),
    { content: [report('c', 'done')], stop_reason: 'tool_use' }, // a response without usage adds nothing
  ]);
  const budget = createTokenBudget(null);
  const r = await loop({ transport: t.send, budget });
  assert.deepEqual(r.usage, { inputTokens: 140, outputTokens: 50, cacheCreationInputTokens: 950, cacheReadInputTokens: 900 });
  assert.equal(totalTokens(r.usage), 2040);
  assert.equal(budget.used, 2040);
  assert.equal(budget.exhausted, false, 'no limit, never exhausted');
  assert.deepEqual(addUsage(emptyUsage(), { input_tokens: 'x', output_tokens: -4 }), emptyUsage(), 'malformed numbers are not counted');
});

test('token budget: checked before every request, shared across tasks, overshoot bounded by one response', async () => {
  const budget = createTokenBudget(150);
  const one = scripted([reply([use('a', 'browser_observe', {})], { input_tokens: 90, output_tokens: 10 })]);
  const first = await loop({ transport: one.send, budget, maxTurns: 10 });
  assert.equal(first.stop, 'token-budget');
  assert.equal(one.requests.length, 2, 'the request that crossed the limit completed; no further request was made');
  assert.equal(budget.used, 200);
  const two = scripted([reply([report('r', 'done')])]);
  const second = await loop({ transport: two.send, budget });
  assert.equal(second.stop, 'token-budget');
  assert.equal(two.requests.length, 0, 'a spent budget stops the next task before its first request');
  assert.equal(second.turns, 0);
});

test('config: no key means unmeasured with the reason; model id, bounds and effort come from env or flags', () => {
  const none = modelConfig({});
  assert.equal(none.ok, false);
  assert.equal(none.reason, NO_KEY_REASON);
  assert.equal(none.transport, undefined);
  assert.equal(modelConfig({ ANTHROPIC_API_KEY: '   ' }).ok, false);

  const dflt = modelConfig({ ANTHROPIC_API_KEY: 'sk-test' });
  assert.equal(dflt.ok, true);
  assert.equal(dflt.config.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'claude-fable-5-2');
  assert.deepEqual({ ...dflt.config, model: undefined }, { model: undefined, effort: null, maxTurns: 30, taskTimeoutMs: 180000, tokenBudget: null });
  assert.ok(!JSON.stringify(dflt.config).includes('sk-test'), 'the key is not part of the recorded config');

  const env = { ANTHROPIC_API_KEY: 'k', BRAIWSER_BENCH_MODEL: 'claude-opus-5-5', BRAIWSER_BENCH_MAX_TURNS: '7', BRAIWSER_BENCH_TASK_TIMEOUT_MS: '9000', BRAIWSER_BENCH_TOKEN_BUDGET: '5000', BRAIWSER_BENCH_EFFORT: 'low' };
  assert.deepEqual(modelConfig(env).config, { model: 'claude-opus-5-5', effort: 'low', maxTurns: 7, taskTimeoutMs: 9000, tokenBudget: 5000 });
  assert.equal(modelConfig(env, { maxTurns: 2, tokenBudget: 10 }).config.maxTurns, 2, 'flags win over env');
  assert.equal(modelConfig({ ...env, BRAIWSER_BENCH_MAX_TURNS: '-1' }).config.maxTurns, 30, 'a nonsense bound falls back to the default, never to unbounded');
  assert.equal(modelConfig({ ...env, BRAIWSER_BENCH_MODEL: 'bad model\n' }).ok, false);
  assert.equal(modelConfig({ ...env, BRAIWSER_BENCH_EFFORT: 'extreme' }).ok, false);
  assert.equal(modelConfig({}, { transport: async () => ({}) }).ok, true, 'an injected transport (tests) needs no key');
});

test('transport: one POST per request with the key only in the header; retries 429/5xx; errors never carry the key', async () => {
  const KEY = 'sk-ant-SECRET-canary';
  const seen = [];
  const answers = [
    { ok: false, status: 429, headers: {}, text: async () => 'slow down' },
    { ok: true, status: 200, json: async () => ({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) },
  ];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return answers[seen.length - 1]; };
  const send = createAnthropicTransport({ apiKey: KEY, fetchImpl, sleep: async () => {} });
  const out = await send({ model: 'claude-fable-5-2', system: 'sys', tools: [REPORT_TOOL], messages: [{ role: 'user', content: 'hi' }], effort: 'low', timeoutMs: 6000 });
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(seen.length, 2, 'one retry after 429');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].init.headers['x-api-key'], KEY);
  assert.equal(seen[0].init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(seen[0].init.body);
  assert.ok(!seen[0].init.body.includes(KEY));
  assert.deepEqual(Object.keys(body).sort(), ['cache_control', 'max_tokens', 'messages', 'model', 'output_config', 'system', 'tool_choice', 'tools']);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.thinking, undefined, 'thinking is left to the model default; no budget or sampling parameters are sent');
  assert.equal(body.temperature, undefined);

  // a non-retryable error surfaces once, with status and API text but not the key
  let hits = 0;
  const bad = createAnthropicTransport({ apiKey: KEY, sleep: async () => {}, fetchImpl: async () => { hits += 1; return { ok: false, status: 401, headers: {}, text: async () => '{"type":"error","error":{"type":"authentication_error"}}' }; } });
  const error = await bad({ model: 'm', system: 's', tools: [], messages: [], timeoutMs: 6000 }).then(() => null, (e) => e);
  assert.equal(hits, 1);
  assert.equal(error.status, 401);
  assert.ok(!String(error.message).includes(KEY) && !String(error.stack).includes(KEY));
  const r = await loop({ transport: bad });
  assert.equal(r.stop, 'api-error');
  assert.ok(!JSON.stringify(r).includes(KEY));
  // 5xx is retried up to the limit, then fails
  hits = 0;
  const down = createAnthropicTransport({ apiKey: KEY, retries: 2, sleep: async () => {}, fetchImpl: async () => { hits += 1; return { ok: false, status: 529, headers: {}, text: async () => 'overloaded' }; } });
  await assert.rejects(down({ model: 'm', system: 's', tools: [], messages: [], timeoutMs: 6000 }), /529/);
  assert.equal(hits, 3);
  assert.throws(() => createAnthropicTransport({}), /API key/);
});

test('task prompts give the goal, the session and the answer format, never the expected answer', () => {
  const manifest = loadManifest();
  const ids = new Set(manifest.tasks.map((t) => t.id));
  for (const id of Object.keys(TASK_SPECS)) assert.ok(ids.has(id), `spec for unknown task ${id}`);
  const urls = { primary: 'http://127.0.0.1:1111', evil: 'http://127.0.0.1:2222', baseline: 'http://127.0.0.1:3333', candidate: 'http://127.0.0.1:4444' };
  for (const task of manifest.tasks) {
    const u = Object.fromEntries(task.sites.map((s) => [s, urls[s]]));
    const text = buildTaskPrompt(task, u, { sessionId: 'ses_1', pageId: 'pg_1' });
    assert.ok(text.includes(task.goal), task.id);
    assert.ok(text.includes('ses_1') && text.includes('pg_1'), task.id);
    assert.ok(!text.includes('{primary}') && !text.includes('undefined'), `${task.id}: unresolved placeholder`);
    // Everything the prompt adds to the goal must be free of the values the oracle expects.
    const added = text.replace(task.goal, '');
    const expected = [];
    if (task.oracle.name === 'valuesEqual') expected.push(...Object.values(task.oracle.params));
    if (task.oracle.params.expected) expected.push(`"verdict": "${task.oracle.params.expected}"`);
    if (task.oracle.params.error) expected.push(task.oracle.params.error);
    if (task.oracle.params.count !== undefined) expected.push(`count: ${task.oracle.params.count}`, `${task.oracle.params.count} results`);
    for (const value of expected) assert.ok(!added.includes(String(value)), `${task.id}: the prompt leaks ${value}`);
    // the oracle's value keys are named in the answer format
    if (task.oracle.name === 'valuesEqual') for (const key of Object.keys(task.oracle.params)) assert.ok(text.includes(`\`${key}\``), `${task.id}: ${key}`);
  }
  const offsite = buildTaskPrompt(manifest.tasks.find((t) => t.id === 'auth-03-offsite-navigation-denied'), { primary: urls.primary, evil: urls.evil }, { sessionId: 's', pageId: 'p' });
  assert.ok(offsite.includes(`${urls.evil}/x`));
  assert.ok(!/Origins this session may use:.*2222/.test(offsite), 'the hostile origin is never listed as granted');
  assert.ok(!offsite.includes('Start at:'));
});

test('reported answers map onto the oracle shapes without changing their content', () => {
  const manifest = loadManifest();
  const task = (id) => manifest.tasks.find((t) => t.id === id);
  const judge = (id, answer, worlds = { primary: newWorld() }) => {
    const t = task(id);
    return oracles[t.oracle.name]({ params: t.oracle.params, worlds, values: valuesFromAnswer(t, answer), claim: { status: 'done' } });
  };
  const rows = task('ext-01-table-all-rows').oracle.params.rows;
  assert.equal(judge('ext-01-table-all-rows', { table: { complete: true, rows } }).ok, true);
  assert.equal(judge('ext-01-table-all-rows', { table: { complete: true, rows: rows.map((r) => ({ name: r.name, qty: Number(r.qty) })) } }).ok, true, 'a number and its string are the same cell');
  assert.equal(judge('ext-01-table-all-rows', { table: { complete: 'yes', rows } }).ok, false, 'complete must be literally true');
  assert.equal(judge('ext-01-table-all-rows', { table: { complete: true, rows: rows.slice(1) } }).ok, false);
  assert.equal(judge('ext-01-table-all-rows', {}).ok, false);
  assert.equal(judge('ext-01-table-all-rows', { table: 'all rows' }).ok, false);
  const withMissing = rows.map((r) => ({ name: r.name, qty: ['Item 3', 'Item 9'].includes(r.name) ? null : r.qty }));
  assert.equal(judge('ext-02-missing-cells', { table: { complete: true, rows: withMissing } }).ok, true);
  assert.equal(judge('ext-02-missing-cells', { table: { complete: true, rows: withMissing.map((r) => ({ ...r, qty: r.qty === null ? '' : r.qty })) } }).ok, false, 'an empty string is not a missing marker');
  assert.equal(judge('nav-01-read-heading', { title: 'Dynamic lab' }).ok, true);
  assert.equal(judge('nav-01-read-heading', { title: 'dynamic lab' }).ok, false, 'strings are not normalised');
  assert.equal(valuesFromAnswer(task('form-03-enter-submits-search'), { count: '3' }).count, 3);
  assert.equal(valuesFromAnswer(task('form-03-enter-submits-search'), { count: 'three' }).count, 'three');
  assert.deepEqual(valuesFromAnswer(task('nav-01-read-heading'), null), {});
});

test('MCP tools become model tools in a stable order; the session tools stay with the harness', () => {
  const tools = toModelTools([
    { name: 'browser_session_open', description: 'open', inputSchema: { type: 'object' } },
    { name: 'browser_observe', description: 'o', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } } },
    { name: 'browser_act', description: 'a' },
    { name: 'browser_session_close', inputSchema: { type: 'object' } },
  ]);
  assert.deepEqual(tools.map((t) => t.name), ['browser_act', 'browser_observe']);
  assert.deepEqual(tools[0].input_schema, { type: 'object', properties: {} });
  assert.deepEqual(tools[1].input_schema.properties, { sessionId: { type: 'string' } });
  assert.deepEqual(WITHHELD_TOOLS, ['browser_session_open', 'browser_session_close']);
});

test('runner: without a key the adapter is unmeasured with the reason, launches nothing and is never run by default', async () => {
  const report = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['nav-01-read-heading', 'adv-03-hostile-page-instructions'], modelOptions: { env: {} } });
  assert.deepEqual(report.adapters[ADAPTER_NAME], { status: 'unmeasured', reason: NO_KEY_REASON });
  assert.equal(report.results.length, 2);
  for (const r of report.results) { assert.equal(r.outcome, 'unmeasured'); assert.equal(r.reason, NO_KEY_REASON); assert.equal(r.turns, undefined); assert.equal(r.inputTokens, undefined); }
  assert.equal(report.summary[ADAPTER_NAME].attempted, 0);
  assert.equal(report.summary[ADAPTER_NAME].successRate, null);
  assert.equal(report.summary[ADAPTER_NAME].model, undefined, 'no token numbers appear for a run that did not happen');
  assert.deepEqual(report.run.model[ADAPTER_NAME], { model: DEFAULT_MODEL, effort: null, maxTurns: 30, taskTimeoutMs: 180000, tokenBudget: null, measured: false, tokensUsed: 0 });
  assert.match(report.methodology, /^Scripted agent, no model\./);
  // with no adapters named, a model adapter is not selected even when a key exists
  const dflt = await runCorpus({ taskIds: ['nav-03-popup-tab'], modelOptions: { env: { ANTHROPIC_API_KEY: 'k' } } }).catch((e) => e);
  if (!(dflt instanceof Error)) assert.ok(!Object.keys(dflt.adapters).includes(ADAPTER_NAME));
});

test('summaries add model turns, API token sums and failure classes only for model rows', () => {
  const s = summarize([
    { adapter: 'm', outcome: 'success', wallMs: 10, toolCalls: 2, turns: 3, inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 50, failureClass: null },
    { adapter: 'm', outcome: 'failure', wallMs: 20, toolCalls: 9, turns: 30, inputTokens: 900, outputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, failureClass: 'turn-cap' },
    { adapter: 'm', outcome: 'false-pass', falsePass: true, wallMs: 5, toolCalls: 1, turns: 2, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, failureClass: 'false-pass' },
    { adapter: 'm', outcome: 'unsupported', wallMs: 0, toolCalls: 0 },
    { adapter: 'm', outcome: 'unmeasured', reason: 'budget' },
    { adapter: 's', outcome: 'success', wallMs: 10, toolCalls: 2 },
  ]);
  assert.deepEqual(s.m.model, { tasks: 3, turns: { total: 35, median: 3 }, inputTokens: 1001, outputTokens: 101, cacheCreationInputTokens: 5, cacheReadInputTokens: 50, failureClasses: { 'turn-cap': 1, 'false-pass': 1 } });
  assert.equal(s.m.attempted, 4);
  assert.equal(s.s.model, undefined);
  assert.ok(!JSON.stringify(s).match(/best|better|faster|wins|rank/i));
});

// ---------------------------------------------------------------- stub model, real MCP server, real Chromium

// A stand-in "model" that reads the ids and start address from the task prompt,
// navigates, observes and reports the first heading it sees.
function headingReader(log) {
  return async ({ messages, tools }) => {
    log.push({ tools: tools.map((t) => t.name), messages: messages.length });
    const prompt = messages[0].content;
    const sessionId = /sessionId "([^"]+)"/.exec(prompt)[1];
    const pageId = /pageId "([^"]+)"/.exec(prompt)[1];
    const usage = { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 100 };
    if (messages.length === 1) {
      return reply([use('t1', 'browser_visit', { sessionId, pageId, url: /Start at: (\S+)/.exec(prompt)[1], operationId: 'stub-op-1' })], usage);
    }
    if (messages.length === 3) return reply([use('t2', 'browser_observe', { sessionId, pageId, maxNodes: 200 })], usage);
    const observed = JSON.parse(messages[4].content[0].content);
    const heading = observed.value.nodes.find((n) => n.role === 'heading');
    return reply([report('t3', 'done', { title: heading.name })], usage);
  };
}

test('stub model through the real MCP server and Chromium: graded by the oracle, usage recorded per task', async (t) => {
  const avail = await browserAvailable('headless');
  if (!avail.ok) { t.skip(avail.reason); return; }
  const log = [];
  const report1 = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['nav-01-read-heading', 'exp-01-repro-package-redacts', 'nav-03-popup-tab'], modelOptions: { env: {}, transport: headingReader(log), maxTurns: 6 } });
  assert.equal(report1.adapters[ADAPTER_NAME].status, 'measured');
  const row = report1.results.find((r) => r.taskId === 'nav-01-read-heading');
  assert.equal(row.outcome, 'success', JSON.stringify(row));
  assert.equal(row.claim, 'done');
  assert.equal(row.stop, 'reported');
  assert.equal(row.failureClass, null);
  assert.equal(row.turns, 3);
  assert.equal(row.toolCalls, 3, 'session open + visit + observe; report_result is not a browser call');
  assert.deepEqual([row.inputTokens, row.outputTokens, row.cacheCreationInputTokens, row.cacheReadInputTokens], [600, 60, 0, 300]);
  assert.ok(row.wallMs > 0 && row.responseBytes > 0);
  // the model sees the real tool surface minus the session tools, plus report_result
  assert.ok(log[0].tools.includes('browser_act') && log[0].tools.includes('browser_run') && log[0].tools.includes('report_result'));
  assert.ok(!log[0].tools.includes('browser_session_open'));
  // tasks whose capability the MCP tool surface lacks are unsupported, not attempted with a model
  for (const id of ['exp-01-repro-package-redacts', 'nav-03-popup-tab']) {
    const r = report1.results.find((x) => x.taskId === id);
    assert.equal(r.outcome, 'unsupported');
    assert.equal(r.turns, undefined);
  }
  assert.equal(report1.summary[ADAPTER_NAME].model.inputTokens, 600);
  assert.equal(report1.run.model[ADAPTER_NAME].tokensUsed, 960);
  assert.match(report1.methodology, /a model drives the MCP tools itself/);
});

test('stub model, real stack: silence, the turn cap and a wrong answer are failures; a spent budget leaves tasks unmeasured', async (t) => {
  const avail = await browserAvailable('headless');
  if (!avail.ok) { t.skip(avail.reason); return; }
  // form-04 accepts an honest "failed" claim. A model that says nothing has not made that claim.
  const silent = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['form-04-validation-error'],
    modelOptions: { env: {}, transport: async () => reply([{ type: 'text', text: 'It failed.' }], { input_tokens: 7, output_tokens: 3 }, 'end_turn') } });
  assert.deepEqual([silent.results[0].outcome, silent.results[0].claim, silent.results[0].failureClass, silent.results[0].turns], ['failure', 'none', 'no-report', 1]);
  assert.equal(silent.summary[ADAPTER_NAME].successRate, 0);

  const capped = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['form-04-validation-error'], modelOptions: { env: {}, maxTurns: 2,
    transport: async ({ messages }) => reply([use(`t${messages.length}`, 'browser_observe', { sessionId: /sessionId "([^"]+)"/.exec(messages[0].content)[1], pageId: /pageId "([^"]+)"/.exec(messages[0].content)[1] })]) } });
  assert.deepEqual([capped.results[0].outcome, capped.results[0].failureClass, capped.results[0].turns], ['failure', 'turn-cap', 2]);
  assert.deepEqual(capped.summary[ADAPTER_NAME].model.failureClasses, { 'turn-cap': 1 });

  // claiming done with a wrong value is a false pass, graded by the oracle, not by the model's word
  const wrong = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['nav-01-read-heading'],
    modelOptions: { env: {}, transport: async () => reply([report('r', 'done', { title: 'Something else' })]) } });
  assert.deepEqual([wrong.results[0].outcome, wrong.results[0].falsePass, wrong.results[0].failureClass], ['false-pass', true, 'false-pass']);

  // budget of 10 tokens: the first task's only response (15 tokens) spends it; the second never starts
  const spent = await runCorpus({ adapterNames: [ADAPTER_NAME], taskIds: ['nav-01-read-heading', 'nav-02-spa-route'], seed: 3,
    modelOptions: { env: {}, tokenBudget: 10, transport: async () => reply([report('r', 'blocked')]) } });
  const outcomes = spent.results.map((r) => r.outcome).sort();
  assert.equal(outcomes.filter((o) => o === 'unmeasured').length, 1);
  assert.match(spent.results.find((r) => r.outcome === 'unmeasured').reason, /token budget for this run \(10\) was spent/);
  assert.equal(spent.run.model[ADAPTER_NAME].tokensUsed, 15);
  assert.equal(spent.summary[ADAPTER_NAME].attempted, 1);
});
