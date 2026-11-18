'use strict';
// The review an agent may read and report on: the desktop store backend, the
// scopes the broker enforces, and the rules for what an agent can change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepositories } = require('../../src/main/store/repositories');
const { createStoreSource, createFileSource } = require('../../src/main/services/review/source');
const { createBroker } = require('../../src/main/services/browser/broker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-review-'));
const principal = (scopes) => ({ id: 'agent-1', kind: 'mcp', scopes });
const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return `${e.publicError && e.publicError.code}:${e.publicError && e.publicError.message}`; } };

function seed() {
  const dir = tmp();
  const repos = createRepositories(dir);
  const project = repos.projects.create({ name: 'Shop', kind: 'url', url: 'https://shop.test/' });
  const session = repos.sessions.create({ projectId: project.id, name: 'Home', url: 'https://shop.test/' });
  const styled = repos.annotations.create({ sessionId: session.id, url: 'https://shop.test/', kind: 'edit', action: 'change', note: 'Restyle',
    target: { selector: '#cta', tag: 'button', text: 'Buy', locator: { by: 'testId', value: 'cta' } },
    edit: { type: 'style', css: 'color: red;', details: { props: { color: 'red' } } } });
  const written = repos.annotations.create({ sessionId: session.id, url: 'https://shop.test/', kind: 'element', action: 'fix', note: 'Feels cramped', target: { selector: 'p' } });
  const journey = repos.recordings.create({ projectId: project.id, name: 'Checkout', startUrl: 'https://shop.test/', steps: [
    { type: 'click', selector: '#cta', locator: { by: 'testId', value: 'cta' } },
    { type: 'assert', kind: 'exists', selector: 'h1', locator: { by: 'role', role: 'heading', name: 'Thanks' } }] });
  const brittle = repos.recordings.create({ projectId: project.id, name: 'Old', startUrl: 'https://shop.test/', steps: [{ type: 'click', selector: 'div > span:nth-of-type(2)' }] });
  return { dir, repos, session, styled, written, journey, brittle, source: createStoreSource({ repos }) };
}

test('store source: notes are projected with their checks; journeys say whether they can run verified', () => {
  const s = seed();
  const { notes, total, truncated } = s.source.listNotes({});
  assert.equal(total, 2); assert.equal(truncated, false);
  const styled = notes.find((n) => n.id === s.styled.id);
  assert.deepEqual(styled.checks, [{ kind: 'style', expected: 'color: red' }]);
  assert.equal(styled.verifiable, true);
  assert.deepEqual(styled.change, { type: 'style', css: 'color: red;' });
  const written = notes.find((n) => n.id === s.written.id);
  assert.equal(written.verifiable, false);
  assert.equal(s.source.listNotes({ status: 'resolved' }).total, 0);
  assert.equal(s.source.listNotes({ sessionId: 'nope' }).total, 0);
  const journeys = s.source.listJourneys();
  assert.equal(journeys.find((j) => j.id === s.journey.id).migratable, true);
  const old = journeys.find((j) => j.id === s.brittle.id);
  assert.equal(old.migratable, false);
  assert.ok(old.refused.some((r) => r.code === 'NO_SEMANTIC_LOCATOR'));
  assert.equal(s.source.loadRecording(s.journey.id).steps.length, 2);
});

test('store source: only a verification resolves; a claim and a proposal change nothing else', () => {
  const s = seed();
  assert.equal(s.source.claim(s.styled.id, 'agent-1').agent.claimedBy, 'agent-1');
  assert.equal(s.source.propose(s.written.id, { message: 'done, please look', who: 'agent-1' }).status, 'open');
  assert.equal(s.repos.annotations.get(s.styled.id).note, 'Restyle');
  assert.equal(s.source.recordVerification(s.styled.id, { verdict: 'unknown', runId: 'r1', by: 'agent-1' }).status, 'open');
  const fixed = s.source.recordVerification(s.styled.id, { verdict: 'fixed', runId: 'r2', runState: 'passed', by: 'agent-1', checks: 1 });
  assert.equal(fixed.status, 'resolved');
  assert.equal(fixed.agent.claimedBy, 'agent-1', 'earlier agent state is kept');
  assert.equal(s.repos.annotations.get(s.styled.id).status, 'resolved', 'the desktop store itself was updated');
  assert.equal(s.source.recordVerification(s.styled.id, { verdict: 'regressed', runId: 'r3', by: 'agent-1' }).status, 'open');
  assert.equal(s.source.recordVerification(s.styled.id, { verdict: 'made-up', runId: 'r4', by: 'x' }).agent.verification.verdict, 'unknown');
  assert.throws(() => s.source.claim('missing', 'agent-1'), { code: 'NOTE_NOT_FOUND' });
});

test('broker: review access is its own scope, separate from browsing', async () => {
  const s = seed();
  const broker = createBroker({ featureFlag: true, dataDir: path.join(s.dir, 'rt'), drivers: {}, review: s.source });
  const none = broker.forPrincipal(principal(['class:observe', 'class:navigate', 'origin:https://shop.test']));
  const reader = broker.forPrincipal(principal(['review:read']));
  const writer = broker.forPrincipal(principal(['review:write']));
  assert.match(await codeOf(none.reviewNotes({})), /^DENIED/);
  assert.match(await codeOf(none.reviewNote({ noteId: s.styled.id })), /^DENIED/);
  assert.equal((await reader.reviewNotes({})).total, 2);
  assert.equal((await reader.reviewNote({ noteId: s.styled.id })).id, s.styled.id);
  assert.equal((await reader.reviewJourneys({})).journeys.length, 2);
  assert.match(await codeOf(reader.reviewClaim({ noteId: s.styled.id })), /^DENIED/, 'read does not imply write');
  assert.equal((await writer.reviewClaim({ noteId: s.styled.id })).agent.claimedBy, 'agent-1');
  assert.equal((await writer.reviewNotes({})).total, 2, 'write implies read');
  // Unknown and malformed ids: never a different answer that would confirm existence.
  assert.match(await codeOf(reader.reviewNote({ noteId: 'does-not-exist' })), /^DENIED:unknown note/);
  assert.match(await codeOf(reader.reviewNote({ noteId: '../../etc/passwd' })), /^UNSUPPORTED/);
  assert.match(await codeOf(writer.reviewPropose({ noteId: s.written.id, message: '   ' })), /^UNSUPPORTED/);
  assert.match(await codeOf(writer.reviewReport({ noteId: s.styled.id, runId: 'run_nope' })), /^DENIED/);
  await broker.close();
});

test('broker: with no review source every review call is UNAVAILABLE, and a disabled runtime stays disabled', async () => {
  const dir = tmp();
  const broker = createBroker({ featureFlag: true, dataDir: dir, drivers: {} });
  assert.match(await codeOf(broker.forPrincipal(principal(['review:read'])).reviewNotes({})), /^UNAVAILABLE/);
  await broker.close();
  const off = createBroker({ featureFlag: false });
  assert.match(await codeOf(off.forPrincipal(principal(['review:read'])).reviewNotes({})), /^UNAVAILABLE/);
});

test('file source: bundles are read-only input, ids are namespaced per bundle, a broken bundle is skipped', () => {
  const dir = tmp();
  const reviewDir = path.join(dir, 'review'); fs.mkdirSync(reviewDir);
  const bundle = (name) => JSON.stringify({ format: 'braiwser-bundle', kind: 'braiwser.project-bundle', version: 1, project: { name, kind: 'url' },
    sessions: [{ id: 's1', name: 'Home', url: 'https://shop.test/' }],
    annotations: [{ sessionId: 's1', kind: 'edit', action: 'change', note: name, target: { locator: { by: 'testId', value: 'cta' } }, edit: { type: 'style', css: 'color: red;', details: { props: { color: 'red' } } } }],
    recordings: [{ name: 'J', startUrl: 'https://shop.test/', steps: [{ type: 'click', selector: '#a', locator: { by: 'testId', value: 'a' } }, { type: 'assert', kind: 'url', expected: 'shop' }] }] });
  fs.writeFileSync(path.join(reviewDir, 'a.braiwser.json'), bundle('A'));
  fs.writeFileSync(path.join(reviewDir, 'b.braiwser.json'), bundle('B'));
  fs.writeFileSync(path.join(reviewDir, 'broken.braiwser.json'), '{not json');
  fs.writeFileSync(path.join(reviewDir, 'notes.txt'), 'ignored');
  const source = createFileSource({ dir: reviewDir, stateFile: path.join(dir, 'state.json') });
  const { notes } = source.listNotes({});
  assert.deepEqual(notes.map((n) => n.id), ['a_1', 'b_1']);
  assert.equal(notes[0].url, 'https://shop.test/', 'a note without its own address takes its session\'s');
  assert.deepEqual(source.listJourneys().map((j) => [j.id, j.migratable]), [['a_j1', true], ['b_j1', true]]);
  assert.equal(source.recordVerification('a_1', { verdict: 'fixed', runId: 'r', by: 'x' }).status, 'resolved');
  assert.equal(source.getNote('b_1').status, 'open');
  assert.ok(!fs.readFileSync(path.join(reviewDir, 'a.braiwser.json'), 'utf8').includes('resolved'));
  // A second source over the same state file sees what was reported (a restarted owner).
  assert.equal(createFileSource({ dir: reviewDir, stateFile: path.join(dir, 'state.json') }).getNote('a_1').status, 'resolved');
  // No state file configured: reads work, reports are refused rather than lost.
  assert.throws(() => createFileSource({ dir: reviewDir }).claim('a_1', 'x'), { code: 'REVIEW_READ_ONLY' });
});
