// Hand-off modal: says where the agent runs, and refuses (clearly) when the
// project has no local directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click, tick, settle } from './dom-env.mjs';

const { document } = setupDom();
const { openHandoffModal } = await load('components/handoff-modal.js');

const PRESETS = [{ id: 'claude', label: 'Claude Code', command: 'claude -p "{promptPath}"', available: true }];
const runBtn = () => Array.from(document.querySelectorAll('.modal-footer button')).find((b) => b.textContent === 'Run agent');

async function close() {
  document.querySelectorAll('.modal-x').forEach((b) => b.click());
  await tick(250);
}

test('local project: shows the working directory and runs the agent there', async () => {
  const runs = [];
  openHandoffModal({
    file: '/proj/.braiwser/request.md', command: 'claude -p x', presets: PRESETS, cwd: '/proj', entry: 'index.html',
    onRun: async (a) => { runs.push(a); return { ok: true }; },
  });
  await settle();
  const card = document.querySelector('.modal-card');
  assert.match(card.querySelector('.handoff-cwd').textContent, /^\/proj {2}\(entry: index\.html\)/);
  assert.equal(card.querySelector('.handoff-notice').style.display, 'none');
  assert.equal(runBtn().disabled, false);
  click(runBtn());
  await tick(10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cwd, '/proj');
  await close();
});

test('imported project (no local directory): clear message, Run agent disabled and inert', async () => {
  const runs = [];
  openHandoffModal({
    file: '/appdata/requests/request.md', command: 'claude -p x', presets: PRESETS, needsLocalDirectory: true,
    onRun: async (a) => { runs.push(a); return { ok: true }; },
  });
  await settle();
  const card = document.querySelector('.modal-card');
  const notice = card.querySelector('.handoff-notice');
  assert.notEqual(notice.style.display, 'none');
  assert.match(notice.textContent, /no local directory/);
  assert.match(notice.textContent, /Copy the prompt|copy the prompt/i);
  assert.equal(runBtn().disabled, true);
  assert.match(runBtn().title, /No local project directory/);
  click(runBtn());
  await tick(10);
  assert.deepEqual(runs, [], 'agent never started');
  await close();
});

test('choosing a folder unblocks the run and runs there', async () => {
  const runs = [];
  openHandoffModal({
    file: '/appdata/requests/request.md', command: 'claude -p x', presets: PRESETS, needsLocalDirectory: true,
    onChooseDirectory: async () => ({ cwd: '/picked/site', file: '/picked/site/.braiwser/request.md' }),
    onRun: async (a) => { runs.push(a); return { ok: true }; },
  });
  await settle();
  const card = document.querySelector('.modal-card');
  const choose = Array.from(card.querySelectorAll('button')).find((b) => /Choose project folder/.test(b.textContent));
  assert.ok(choose);
  click(choose);
  await tick(10);
  assert.equal(runBtn().disabled, false);
  assert.equal(card.querySelector('.handoff-notice').style.display, 'none');
  assert.equal(card.querySelector('.handoff-cwd').textContent, '/picked/site');
  assert.equal(card.querySelector('.handoff-file').textContent, '/picked/site/.braiwser/request.md');
  click(runBtn());
  await tick(10);
  assert.equal(runs[0].cwd, '/picked/site');
  await close();
});

test('cancelling the folder picker leaves the block in place', async () => {
  openHandoffModal({ file: '/x/r.md', command: 'c', presets: PRESETS, needsLocalDirectory: true, onChooseDirectory: async () => null, onRun: async () => ({ ok: true }) });
  await settle();
  const card = document.querySelector('.modal-card');
  click(Array.from(card.querySelectorAll('button')).find((b) => /Choose project folder/.test(b.textContent)));
  await tick(10);
  assert.equal(runBtn().disabled, true);
  await close();
});

test('extra notices from the hand-off are shown; legacy callers (no new props) are unchanged', async () => {
  openHandoffModal({ file: '/p/r.md', command: '', presets: PRESETS, notices: ['The entry is a file; its folder was used.'], onRun: async () => ({ ok: true }) });
  await settle();
  const card = document.querySelector('.modal-card');
  assert.match(card.querySelector('.handoff-notice').textContent, /entry is a file/);
  assert.equal(card.querySelector('.handoff-cwd-row').style.display, 'none', 'no cwd known => row hidden');
  assert.equal(runBtn().disabled, false);
  await close();
});
