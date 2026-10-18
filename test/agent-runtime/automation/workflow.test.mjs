import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkflow, safeValidateWorkflow, workflowDigest, digestOf, canonicalJson, diffWorkflows, describeEffects,
  recordingToWorkflow, locateStep, inputDigest,
} from '../../../src/main/services/automation/workflow.mjs';

const plan = (over = {}) => ({
  schemaVersion: 1, skillId: 'verify-journey', version: '1.0.0', inputKeys: ['name'], maxDurationMs: 60000,
  steps: [
    { id: 'a', type: 'navigate', url: 'https://example.test/settings' },
    { id: 'b', type: 'fill', target: { by: 'label', value: 'Display name' }, inputKey: 'name' },
    { id: 'c', type: 'click', target: { by: 'role', role: 'button', name: 'Save' } },
    { id: 'd', type: 'assert', target: { by: 'testId', value: 'toast' }, kind: 'text', op: 'contains', expected: 'Saved' },
  ], ...over });

test('a valid plan parses and is deterministic to digest', () => {
  const p = validateWorkflow(plan());
  assert.equal(workflowDigest(p), workflowDigest(JSON.parse(JSON.stringify(p))));
  assert.match(workflowDigest(p), /^sha256:[a-f0-9]{64}$/);
  // key order and whitespace do not matter
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ n: NaN }), TypeError);
  assert.equal(inputDigest({ x: '1' }), inputDigest({ x: '1' }));
});

test('the closed language rejects everything outside it', () => {
  const rejects = (mutate, why) => {
    const p = plan(); mutate(p);
    assert.equal(safeValidateWorkflow(p).ok, false, why);
  };
  rejects((p) => p.steps.push({ id: 'z', type: 'evaluate', script: '1' }), 'arbitrary script step');
  rejects((p) => { p.steps[2].selector = '#save'; }, 'css selector key');
  rejects((p) => { p.steps[2].target = { by: 'css', value: '#save' }; }, 'css locator');
  rejects((p) => { p.steps[0].url = 'file:///etc/passwd'; }, 'file scheme');
  rejects((p) => { p.steps[0].url = 'https://u:p@example.test/'; }, 'url credentials');
  rejects((p) => { p.steps[3].op = 'matches'; }, 'regex assertion');
  rejects((p) => { p.steps[1].inputKey = 'undeclared'; }, 'undeclared input');
  rejects((p) => { p.steps[1].id = 'a'; }, 'duplicate id');
  rejects((p) => { p.steps = p.steps.filter((s) => s.type !== 'assert'); }, 'no assertion');
  rejects((p) => { p.steps.push({ id: 'e', type: 'click', target: { by: 'role', role: 'button', name: 'Delete' } }); }, 'trailing action after the last assertion');
  rejects((p) => { p.extra = true; }, 'unknown top-level key');
  rejects((p) => { p.schemaVersion = 2; }, 'unsupported schema version');
  rejects((p) => { p.version = '1.0'; }, 'bad semver');
  rejects((p) => { p.steps[3] = { id: 'd', type: 'assert', kind: 'visible', op: 'contains', expected: 'visible', target: { by: 'testId', value: 't' } }; }, 'visibility must be equals visible');
  rejects((p) => { p.steps[3] = { id: 'd', type: 'assert', kind: 'count', op: 'equals', expected: 'many', target: { by: 'testId', value: 't' } }; }, 'count must be an integer');
  rejects((p) => { p.steps[3] = { id: 'd', type: 'assert', kind: 'url', op: 'equals', expected: 'x', target: { by: 'testId', value: 't' } }; }, 'url takes no target');
  rejects((p) => { p.steps[2].target = { by: 'role', role: 'button' }; }, 'role target needs a name for actions');
  rejects((p) => { p.origins = ['https://other.test']; }, 'origins is not part of the broker-compatible plan shape');
  rejects((p) => { p.steps[1].inputKey = '__proto__'; }, 'unsafe input key');
});

test('role target without a name is allowed only for count/exists/visible assertions', () => {
  const ok = plan({ steps: [
    { id: 'a', type: 'navigate', url: 'https://example.test/' },
    { id: 'b', type: 'assert', target: { by: 'role', role: 'main' }, kind: 'exists', op: 'equals', expected: 'exists' },
    { id: 'c', type: 'assert', target: { by: 'role', role: 'row' }, kind: 'count', op: 'equals', expected: '3' },
  ], inputKeys: [] });
  assert.equal(safeValidateWorkflow(ok).ok, true);
});

test('setViewport/capture are allowed after the last assertion, navigation is not', () => {
  const base = [
    { id: 'a', type: 'navigate', url: 'https://example.test/' },
    { id: 'b', type: 'assert', kind: 'url', op: 'contains', expected: 'example' },
  ];
  assert.equal(safeValidateWorkflow(plan({ inputKeys: [], steps: [...base, { id: 'c', type: 'capture', label: 'evidence' }] })).ok, true);
  assert.equal(safeValidateWorkflow(plan({ inputKeys: [], steps: [...base, { id: 'c', type: 'navigate', url: 'https://example.test/x' }] })).ok, false);
});

test('effects summary and upgrade diff flag scope expansion and weakened assertions', () => {
  const a = validateWorkflow(plan());
  const e = describeEffects(a);
  assert.deepEqual(e.origins, ['https://example.test']);
  assert.equal(e.mutating, true);
  assert.equal(e.assertions, 1);

  assert.equal(diffWorkflows(a, a).identical, true);
  const widened = validateWorkflow(plan({ version: '1.1.0', steps: [
    ...a.steps.slice(0, 3),
    { id: 'n', type: 'navigate', url: 'https://evil.test/' },
    a.steps[3],
  ] }));
  const d = diffWorkflows(a, widened);
  assert.deepEqual(d.steps.added, ['n']);
  assert.deepEqual(d.scopeExpansion.newOrigins, ['https://evil.test']);
  assert.equal(d.expandsScope, true);
  assert.equal(d.requiresReapproval, true);

  const weakened = validateWorkflow(plan({ version: '1.1.0', steps: [
    ...a.steps.slice(0, 3),
    { id: 'd2', type: 'assert', kind: 'url', op: 'contains', expected: 'settings' },
  ] }));
  const w = diffWorkflows(a, weakened);
  assert.deepEqual(w.assertions.removed, ['d']);

  const sameVersion = validateWorkflow(plan({ steps: [...a.steps.slice(0, 3), { ...a.steps[3], expected: 'Anything' }] }));
  assert.equal(diffWorkflows(a, sameVersion).sameVersionDifferentBytes, true);
});

test('locateStep pairs a step with its viewport, URL and preceding steps', () => {
  const p = validateWorkflow(plan({ inputKeys: [], steps: [
    { id: 'v', type: 'setViewport', width: 375, height: 812 },
    { id: 'n', type: 'navigate', url: 'https://example.test/m' },
    { id: 'x', type: 'assert', target: { by: 'role', role: 'main', name: 'Content' }, kind: 'visible', op: 'equals', expected: 'visible' },
  ] }));
  const where = locateStep(p, 'x');
  assert.deepEqual(where.viewport, { width: 375, height: 812 });
  assert.equal(where.url, 'https://example.test/m');
  assert.deepEqual(where.precedingStepIds, ['v', 'n']);
  assert.equal(locateStep(p, 'missing'), null);
});

// ------------------------------------------------------------------ recording migration

const recording = (steps, over = {}) => ({ name: 'Settings', startUrl: 'https://example.test/settings', steps, ...over });
const T = { navigate: { type: 'navigate', url: 'https://example.test/settings' } };

test('migrates a saved journey: semantic locators, parameterized inputs, explicit assertion', () => {
  const r = recordingToWorkflow(recording([
    T.navigate,
    { type: 'input', selector: 'input[aria-label="Display name"]', tag: 'input', text: 'Display name', value: 'Ada Lovelace' },
    { type: 'click', selector: 'button[data-testid="save"]', tag: 'button', text: 'Save' },
    { type: 'scroll', x: 0, y: 400 },
    { type: 'assert', kind: 'text', op: 'contains', selector: 'div[data-testid="toast"]', expected: 'Saved' },
  ]));
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.deepEqual(r.plan.steps.map((s) => s.type), ['navigate', 'fill', 'click', 'assert']);
  assert.deepEqual(r.plan.steps[1].target, { by: 'label', value: 'Display name' });
  assert.deepEqual(r.plan.steps[2].target, { by: 'testId', value: 'save' });
  assert.deepEqual(r.plan.inputKeys, ['input_1']);
  assert.deepEqual(r.suggestedInputs, { input_1: 'Ada Lovelace' });
  assert.ok(!JSON.stringify(r.plan).includes('Ada Lovelace'), 'typed values are inputs, never plan bytes');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].type, 'scroll');
  assert.match(r.digest, /^sha256:/);
  assert.deepEqual(describeEffects(r.plan).origins, ['https://example.test']);
  assert.equal(JSON.stringify(r.plan).includes('.first'), false);
  // The migrated plan passes the same validator the broker uses.
  assert.equal(safeValidateWorkflow(r.plan).ok, true);
});

test('same recording -> same digest; different recording -> different digest', () => {
  const steps = [T.navigate, { type: 'assert', kind: 'url', op: 'contains', expected: 'settings' }];
  assert.equal(recordingToWorkflow(recording(steps)).digest, recordingToWorkflow(recording(steps)).digest);
  assert.notEqual(recordingToWorkflow(recording(steps)).digest,
    recordingToWorkflow(recording([T.navigate, { type: 'assert', kind: 'url', op: 'contains', expected: 'other' }])).digest);
});

test('secret steps are refused with an explicit reason and the value never survives', () => {
  const r = recordingToWorkflow(recording([
    T.navigate,
    { type: 'input', selector: 'input[data-testid="pw"]', tag: 'input', text: 'Password', value: 'CANARY-hunter2', secret: true },
    { type: 'assert', kind: 'url', op: 'contains', expected: 'settings' },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.plan, null);
  assert.equal(r.refused[0].code, 'SECRET_STEP');
  assert.equal(r.refused[0].stepIndex, 1);
  assert.ok(!JSON.stringify(r).includes('CANARY-hunter2'));
  // Legacy record: password only inferable from hints (no secret flag).
  const legacy = recordingToWorkflow(recording([
    T.navigate, { type: 'input', selector: 'input[name="password"]', tag: 'input', text: 'Password', value: 'CANARY-legacy' },
    { type: 'assert', kind: 'url', op: 'contains', expected: 'x' }]));
  assert.equal(legacy.ok, false);
  assert.equal(legacy.refused[0].code, 'SECRET_STEP');
  assert.ok(!JSON.stringify(legacy).includes('CANARY-legacy'));
});

test('a secret value repeated in an assertion is refused, not copied', () => {
  const r = recordingToWorkflow(recording([
    T.navigate,
    { type: 'input', selector: 'input[data-testid="pw"]', tag: 'input', value: 'CANARY-repeat-9', secret: true },
    { type: 'assert', kind: 'text', op: 'contains', selector: 'div[data-testid="x"]', expected: 'CANARY-repeat-9' },
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.refused.some((x) => x.code === 'SECRET_IN_ASSERTION'));
  assert.ok(!JSON.stringify(r).includes('CANARY-repeat-9'));
});

test('steps without a semantic locator are refused; it never falls back to the first match', () => {
  const r = recordingToWorkflow(recording([
    T.navigate,
    { type: 'click', selector: 'div > ul > li:nth-of-type(3) > a', tag: 'a', text: 'Docs' },
    { type: 'assert', kind: 'url', op: 'contains', expected: 'docs' },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.refused[0].code, 'NO_SEMANTIC_LOCATOR');
  assert.match(r.refused[0].reason, /first match/);
});

test('every unsupported thing is listed, not just the first', () => {
  const r = recordingToWorkflow(recording([
    { type: 'navigate', url: 'javascript:alert(1)' },
    { type: 'navigate', url: 'https://example.test/cb?access_token=abc' },
    { type: 'navigate', url: 'https://user:pw@example.test/' },
    { type: 'input', selector: 'select[data-testid="s"]', tag: 'select', control: 'multiselect', value: ['a', 'b'] },
    { type: 'key', selector: 'input[aria-label="Q"]', tag: 'input', key: 'Control+Shift+K' },
    { type: 'assert', kind: 'text', op: 'matches', selector: 'p[data-testid="p"]', expected: 'a.*b' },
    { type: 'upload', selector: 'input[data-testid="f"]' },
    { type: 'assert', kind: 'wiggle', selector: 'p[data-testid="p"]' },
  ]));
  assert.equal(r.ok, false);
  const codes = r.refused.map((x) => x.code);
  for (const code of ['UNSUPPORTED_URL_SCHEME', 'SENSITIVE_URL_QUERY', 'URL_HAS_CREDENTIALS', 'UNSUPPORTED_CONTROL', 'UNSUPPORTED_KEY', 'REGEX_ASSERTION', 'UNKNOWN_STEP_TYPE', 'ASSERTION_INVALID']) {
    assert.ok(codes.includes(code), `missing ${code}: ${codes}`);
  }
});

test('journeys must end with an assertion; empty and malformed recordings are refused', () => {
  const noAssert = recordingToWorkflow(recording([T.navigate, { type: 'click', selector: 'button[data-testid="x"]', tag: 'button', text: 'X' }]));
  assert.equal(noAssert.ok, false);
  assert.ok(noAssert.refused.some((x) => x.code === 'PLAN_INVALID'));
  assert.equal(recordingToWorkflow(recording([])).refused[0].code, 'EMPTY_RECORDING');
  assert.equal(recordingToWorkflow(null).refused[0].code, 'INVALID_RECORDING');
  assert.equal(recordingToWorkflow({ steps: 'nope' }).refused[0].code, 'INVALID_RECORDING');
});

test('a journey that starts mid-page is anchored to startUrl; with no start it is refused', () => {
  const steps = [{ type: 'assert', kind: 'url', op: 'contains', expected: 'settings' }];
  const ok = recordingToWorkflow(recording(steps));
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.steps[0].type, 'navigate');
  assert.match(ok.warnings[0], /startUrl/);
  const none = recordingToWorkflow(recording(steps, { startUrl: undefined }));
  assert.equal(none.ok, false);
  assert.equal(none.refused[0].code, 'NO_START_URL');
});

test('checkbox, select, key and count assertions map to the closed steps', () => {
  const r = recordingToWorkflow(recording([
    T.navigate,
    { type: 'input', selector: 'input[data-testid="agree"]', tag: 'input', value: true },
    { type: 'input', selector: 'select[data-testid="plan"]', tag: 'select', value: 'pro' },
    { type: 'key', selector: 'input[aria-label="Search"]', tag: 'input', key: 'Enter' },
    { type: 'assert', kind: 'count', op: 'contains', selector: 'li[data-testid="row"]', expected: 2 },
    { type: 'assert', kind: 'visible', selector: 'div[data-testid="ok"]' },
  ]));
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.deepEqual(r.plan.steps.map((s) => s.type), ['navigate', 'check', 'select', 'press', 'assert', 'assert']);
  assert.equal(r.plan.steps[1].checked, true);
  assert.deepEqual(r.suggestedInputs, { input_1: 'pro' });
  assert.equal(r.plan.steps[4].expected, '2');
  assert.equal(r.plan.steps[5].expected, 'visible');
});
