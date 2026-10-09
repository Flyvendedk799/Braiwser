// RF-12: the first-run coach must not block the page, and the flow must complete
// from real user actions (select element -> save note -> ship) with no Skip/Next.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupDom, load, key, tick } from './dom-env.mjs';

const { window, document } = setupDom(
  '<!doctype html><html><body><div class="stage"><button id="buy" data-testid="buy-now">Buy now</button></div><div class="panel"><div data-tab="notes"><textarea id="note"></textarea></div><div class="panel-footer"></div></div><button data-coach="inspect">Inspect</button></body></html>'
);
const { createCoachmarks } = await load('components/coachmarks.js');
const { modal, modalDepth } = await load('lib/dom.js');

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/renderer/styles/app.css'), 'utf8');

const mounted = [];
// One coach per test: hide and detach so overlays and Escape handlers from an
// earlier (possibly failed) test cannot leak into the next one.
afterEach(() => {
  while (mounted.length) {
    const c = mounted.pop();
    c.hide();
    c.root.remove();
  }
});

function mount(over = {}) {
  const log = { steps: [], complete: [] };
  const coach = createCoachmarks({
    isSample: () => true,
    onStep: (id, i) => log.steps.push([id, i]),
    onComplete: (r) => log.complete.push(r),
    ...over,
  });
  mounted.push(coach);
  return { coach, log };
}

test('css: the overlay is click-through and only the card takes pointer events', () => {
  const overlay = /\.coach-overlay\s*\{[^}]*\}/.exec(css)[0];
  assert.match(overlay, /pointer-events:\s*none/);
  assert.doesNotMatch(overlay, /pointer-events:\s*auto/);
  const card = /\.coach-card\s*\{[^}]*\}/.exec(css)[0];
  assert.match(card, /pointer-events:\s*auto/);
  assert.match(css, /\.coach-overlay\.coach-passthrough \.coach-spot\s*\{[^}]*box-shadow:\s*none/);
});

test('no pointer handler cancels or swallows page interaction', () => {
  const { coach } = mount();
  coach.show(0);
  const buy = document.getElementById('buy');
  let clicked = 0;
  buy.addEventListener('click', () => clicked++);
  const down = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  buy.dispatchEvent(down);
  assert.equal(down.defaultPrevented, false, 'page pointerdown must not be prevented');
  buy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(clicked, 1);
  assert.equal(coach.root.style.pointerEvents, '', 'no inline pointer-events juggling');
  coach.hide();
});

test('first-run flow completes from app events alone (no Skip / Next)', () => {
  const { coach, log } = mount();
  coach.show(0);
  assert.equal(coach.stepId(), 'inspect');
  coach.notify('inspect-mode', true);
  assert.equal(coach.stepId(), 'inspect', 'switching Inspect on keeps the step (it asks for the click)');
  coach.notify('element-selected');
  assert.equal(coach.stepId(), 'note');
  coach.notify('note-saved');
  assert.equal(coach.stepId(), 'ship');
  coach.notify('shipped');
  assert.equal(coach.isVisible(), false);
  assert.deepEqual(log.complete, [{ skipped: false, step: 'ship' }]);
  assert.deepEqual(log.steps.map((s) => s[0]), ['inspect', 'note', 'ship']);
});

test('a note saved before an element-selected signal still advances to Ship', () => {
  const { coach } = mount();
  coach.show(0);
  coach.notify('note-saved');
  assert.equal(coach.stepId(), 'ship');
  coach.hide();
});

test('advance() remains a working alias (existing app.js callers)', () => {
  const { coach } = mount();
  coach.show(0);
  coach.advance('note-saved');
  assert.equal(coach.stepId(), 'ship');
  coach.advance('shipped');
  assert.equal(coach.isVisible(), false);
});

test('events while hidden are ignored; stale events never resurrect or skip', () => {
  const { coach, log } = mount();
  coach.notify('note-saved');
  coach.notify('shipped');
  assert.equal(coach.isVisible(), false);
  assert.deepEqual(log.complete, []);
  coach.show(1);
  coach.notify('element-selected'); // only meaningful on step 0
  assert.equal(coach.stepId(), 'note');
  coach.notify('shipped'); // only meaningful on the ship step
  assert.equal(coach.stepId(), 'note');
  coach.hide();
});

test('step 0 follows Inspect mode: off -> points at the toolbar button, on -> the page', () => {
  const { coach } = mount();
  coach.notify('inspect-mode', false);
  coach.show(0);
  assert.match(document.querySelector('.coach-body').textContent, /Turn on Inspect/);
  coach.notify('inspect-mode', true);
  assert.match(document.querySelector('.coach-body').textContent, /Inspect is on/);
  assert.equal(coach.root.classList.contains('coach-passthrough'), true, 'no dimming scrim on the page step');
  coach.notify('inspect-mode', { on: false });
  assert.match(document.querySelector('.coach-body').textContent, /Turn on Inspect/);
  coach.notify('inspect-mode', true);
  coach.hide();
});

test('an automatic advance never steals focus from where the user is typing', () => {
  const { coach } = mount();
  coach.show(1);
  const ta = document.getElementById('note');
  ta.focus();
  coach.notify('note-saved');
  assert.equal(coach.stepId(), 'ship');
  assert.equal(document.activeElement, ta);
  coach.hide();
});

test('Escape while typing in a field cancels the field, not the tour; Escape elsewhere skips', () => {
  const { coach, log } = mount();
  coach.show(1);
  const ta = document.getElementById('note');
  ta.focus();
  key(ta, 'Escape');
  assert.equal(coach.isVisible(), true);
  key(document.body, 'Escape');
  assert.equal(coach.isVisible(), false);
  assert.deepEqual(log.complete, [{ skipped: true, step: 'note' }]);
});

test('Escape belongs to an open modal, not the coach', async () => {
  const { coach } = mount();
  coach.show(0);
  const m = modal({ title: 'x', body: document.createElement('div') });
  assert.equal(modalDepth(), 1);
  key(document.body, 'Escape');
  assert.equal(coach.isVisible(), true, 'coach stays');
  assert.equal(modalDepth(), 0, 'modal closed');
  coach.hide();
  await tick(250);
});

test('the card is a non-modal dialog and Next walks the steps with focus on the card', () => {
  const { coach } = mount();
  coach.show(0);
  const card = document.querySelector('.coach-card');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'false');
  const nextBtn = document.querySelector('.coach-acts .btn-primary');
  assert.equal(nextBtn.textContent, 'Next');
  nextBtn.click();
  assert.equal(coach.stepId(), 'note');
  assert.equal(document.activeElement, card);
  nextBtn.click();
  assert.equal(nextBtn.textContent, 'Done');
  nextBtn.click();
  assert.equal(coach.isVisible(), false);
});
