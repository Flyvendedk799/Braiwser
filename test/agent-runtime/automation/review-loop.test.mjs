// The closed loop on a real browser, through the real stdio MCP sidecar and the standalone owner:
// read the notes a person left -> prove one is NOT fixed -> the page changes -> prove it IS fixed ->
// the note resolves on that proof -> the page regresses -> the note re-opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../../src/main/services/automation/server.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const candidates = [process.env.BRAIWSER_TEST_BROWSER, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));

test('review notes are read, proven not fixed, proven fixed and re-opened on regression over real MCP', { skip: !executablePath && 'no Chromium-family browser available', timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-review-loop-'));
  let fixed = false;
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>Shop</title><style>
      button{transition:color 2s;color:${fixed ? '#008000' : '#333'};padding:${fixed ? '0.75rem 1.5rem' : '4px 8px'};font-size:16px}</style>
      <h1>${fixed ? 'Spring sale' : 'Sale'}</h1><button data-testid="cta">Buy</button><p id="legal">Terms apply</p>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const url = `${origin}/`;

  // What the desktop app exports: a project bundle with the notes of one review session.
  const reviewDir = path.join(dir, 'review');
  fs.mkdirSync(reviewDir);
  const note = (extra) => ({ sessionId: 's1', url, kind: 'edit', action: 'change', status: 'open', priority: 'high', ...extra });
  fs.writeFileSync(path.join(reviewDir, 'shop.braiwser.json'), JSON.stringify({
    format: 'braiwser-bundle', kind: 'braiwser.project-bundle', version: 1,
    project: { name: 'Shop', kind: 'url' },
    sessions: [{ id: 's1', name: 'Homepage review', url }],
    annotations: [
      note({ note: 'Restyle the CTA', target: { selector: 'button', tag: 'button', text: 'Buy', locator: { by: 'testId', value: 'cta' } },
        edit: { type: 'style', css: 'color: green; padding: 12px 24px;', details: { props: { color: 'green', padding: '12px 24px' }, original: {} } } }),
      note({ note: 'New headline', target: { selector: 'h1', tag: 'h1', text: 'Sale', locator: { by: 'role', role: 'heading', name: 'Sale' } },
        edit: { type: 'text', css: '', details: { before: 'Sale', after: 'Spring sale' } } }),
      note({ kind: 'element', action: 'fix', note: 'The legal line feels cramped', target: { selector: '#legal', tag: 'p', text: 'Terms apply' } }),
      note({ note: 'Bigger legal text', target: { selector: '#legal', tag: 'p', text: 'Terms apply' },
        edit: { type: 'style', css: 'font-size: 14px;', details: { props: { 'font-size': '14px' }, original: {} } } }),
    ],
    recordings: [],
  }));

  const service = await startServer({ dataDir: path.join(dir, 'store'), reviewDir, driverOptions: { executablePath },
    principal: { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe', 'class:navigate', 'class:interact', `origin:${origin}`, 'review:read', 'review:write'] } });
  const client = new Client({ name: 'agent', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await service.close(); await new Promise((r) => site.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/main/services/automation/sidecar.mjs')],
    env: { ...getDefaultEnvironment(), BRAIWSER_BRIDGE_INFO: service.bridgeFile }, stderr: 'pipe' }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const must = async (name, args) => { const r = await call(name, args); assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`); return r.value; };

  // ---- read the review -------------------------------------------------------------------
  const listed = await must('review_notes', {});
  assert.equal(listed.total, 4);
  assert.equal(listed.trust, 'owner-review');
  const [cta, headline, cramped, legal] = listed.notes;
  assert.deepEqual(cta.checks, [{ kind: 'style', expected: 'color: green' }, { kind: 'style', expected: 'padding: 12px 24px' }]);
  assert.equal(cta.verifiable, true);
  assert.equal(headline.verifiable, true);
  assert.equal(cramped.verifiable, false);
  assert.equal(cramped.notVerifiable.code, 'NOTE_UNVERIFIABLE');
  assert.equal(legal.verifiable, false, 'an exact change on an element with no unique semantic name cannot be proven by a run');
  assert.equal(legal.notVerifiable.code, 'NOTE_NO_SEMANTIC_TARGET');
  assert.equal((await must('review_note_claim', { noteId: cta.id })).agent.claimedBy, 'fixture-agent');

  const opened = await must('browser_session_open', { driver: 'playwright', mode: 'headless', grant: { allowedOrigins: [origin], toolClasses: ['observe', 'navigate', 'interact'] } });
  const ids = { sessionId: opened.sessionId, pageId: opened.pageId };
  const verify = async (noteIds, requestKey) => {
    let run = await must('browser_run', { ...ids, requestKey, skillId: 'verify-notes', skillVersion: '1.0.0', inputs: { noteIds } });
    for (let i = 0; i < 200 && run.verdict === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      run = await must('browser_run_status', { runId: run.runId });
    }
    return run;
  };

  // ---- not fixed yet: the run says so, and the note stays open ------------------------------
  const before = await verify([cta.id], 'cta-before');
  assert.equal(before.state, 'failed', JSON.stringify(before));
  const r1 = await must('review_note_report', { noteId: cta.id, runId: before.runId });
  assert.equal(r1.verdict, 'not-fixed');
  assert.equal(r1.note.status, 'open');

  // A note no run can prove is refused before anything is dispatched, and can only be proposed.
  const refused = await call('browser_run', { ...ids, requestKey: 'cramped', skillId: 'verify-notes', skillVersion: '1.0.0', inputs: { noteIds: [cramped.id] } });
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /NOTE_UNVERIFIABLE/);
  assert.equal(refused.error.dispatched, false);
  const proposed = await must('review_note_propose', { noteId: cramped.id, message: 'Added line-height 1.6 and 8px top margin.' });
  assert.equal(proposed.status, 'open', 'a proposal never resolves a note');
  assert.equal(proposed.agent.proposal.by, 'fixture-agent');

  // ---- the fix lands ------------------------------------------------------------------------
  fixed = true;
  const after = await verify([cta.id, headline.id], 'both-after');
  assert.equal(after.state, 'passed', JSON.stringify(after));
  assert.equal(after.passedAssertions, 3);
  const r2 = await must('review_note_report', { noteId: cta.id, runId: after.runId });
  assert.equal(r2.verdict, 'fixed');
  assert.equal(r2.note.status, 'resolved', 'proof from a graded run resolves the note');
  assert.equal(r2.note.agent.verification.runId, after.runId);
  assert.equal((await must('review_note_report', { noteId: headline.id, runId: after.runId })).verdict, 'fixed');
  assert.equal((await must('review_notes', { status: 'open' })).total, 2);

  // A run cannot vouch for a note it did not check, and a journey run is not a note run.
  const wrong = await call('review_note_report', { noteId: legal.id, runId: after.runId });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'DENIED');
  assert.equal((await call('review_note_report', { noteId: cta.id, runId: 'run_does_not_exist' })).error.code, 'DENIED');

  // ---- a regression re-opens the resolved note ----------------------------------------------
  fixed = false;
  const later = await verify([cta.id], 'cta-regressed');
  assert.equal(later.state, 'failed');
  const r3 = await must('review_note_report', { noteId: cta.id, runId: later.runId });
  assert.equal(r3.verdict, 'regressed');
  assert.equal(r3.note.status, 'open');

  // The exported bundle itself was never written to.
  assert.ok(!fs.readFileSync(path.join(reviewDir, 'shop.braiwser.json'), 'utf8').includes('verification'));
});
