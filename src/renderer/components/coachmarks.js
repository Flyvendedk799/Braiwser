// Three-step first-run coach. Overlay lives in the renderer chrome (not the
// guest page) so it can point at Inspect, the stage, and the ship actions.
import { h, icon } from '../lib/dom.js';

const STEPS = [
  {
    id: 'inspect',
    title: 'Inspect what’s wrong',
    body: 'Inspect is on. Click the faded Buy now button on the sample page.',
    target: '[data-coach="inspect"]',
    fallback: '.stage',
  },
  {
    id: 'note',
    title: 'Save the note',
    body: 'Write one sentence about the fix, pick an action tag, and save. That note is what the agent will see.',
    target: '.panel [data-tab="notes"]',
    fallback: '.panel',
  },
  {
    id: 'ship',
    title: 'Ship it',
    body: 'Copy the agent prompt, or hand off to your coding agent. That’s the whole loop.',
    target: '[data-coach="ship"]',
    fallback: '.panel-footer',
  },
];

export function createCoachmarks(actions) {
  let step = 0;
  let visible = false;
  const spot = h('div', { class: 'coach-spot' });
  const title = h('div', { class: 'coach-title' });
  const body = h('div', { class: 'coach-body' });
  const stepLabel = h('div', { class: 'coach-step' });
  const card = h('div', { class: 'coach-card' }, [
    stepLabel,
    title,
    body,
    h('div', { class: 'coach-acts' }, [
      h('button', { class: 'btn btn-sm btn-ghost', text: 'Skip', on: { click: () => dismiss(true) } }),
      h('button', { class: 'btn btn-sm btn-primary', text: 'Next', on: { click: () => next() } }),
    ]),
  ]);
  const root = h('div', { class: 'coach-overlay', hidden: 'hidden' }, [spot, card]);
  document.body.appendChild(root);

  function layout() {
    if (!visible) return;
    const spec = STEPS[step] || STEPS[0];
    const el = document.querySelector(spec.target) || document.querySelector(spec.fallback);
    const r = el ? el.getBoundingClientRect() : { left: 24, top: 80, width: 280, height: 48, bottom: 128, right: 304 };
    const pad = 6;
    spot.style.left = Math.max(8, r.left - pad) + 'px';
    spot.style.top = Math.max(8, r.top - pad) + 'px';
    spot.style.width = Math.max(40, r.width + pad * 2) + 'px';
    spot.style.height = Math.max(28, r.height + pad * 2) + 'px';
    const cardW = 320;
    let left = r.left;
    if (left + cardW > window.innerWidth - 16) left = window.innerWidth - cardW - 16;
    let top = r.bottom + 12;
    if (top + 160 > window.innerHeight) top = Math.max(16, r.top - 170);
    card.style.left = Math.max(12, left) + 'px';
    card.style.top = top + 'px';
    title.textContent = spec.title;
    body.textContent = spec.body;
    stepLabel.textContent = `Step ${step + 1} of ${STEPS.length}`;
  }

  function show(index) {
    step = Math.max(0, Math.min(STEPS.length - 1, index == null ? 0 : index));
    visible = true;
    root.removeAttribute('hidden');
    layout();
    requestAnimationFrame(layout);
  }

  function hide() {
    visible = false;
    root.setAttribute('hidden', 'hidden');
  }

  function next() {
    if (step >= STEPS.length - 1) {
      dismiss(false);
      return;
    }
    step += 1;
    layout();
    if (actions.onStep) actions.onStep(STEPS[step].id, step);
  }

  function advance(event) {
    if (!visible) return;
    if (event === 'note-saved' && step <= 1) show(2);
    if (event === 'shipped' && step >= 2) dismiss(false);
  }

  function dismiss(skipped) {
    hide();
    if (actions.onComplete) actions.onComplete({ skipped: !!skipped, step: STEPS[step].id });
  }

  window.addEventListener('resize', () => { if (visible) layout(); });

  return {
    root,
    show,
    hide,
    next,
    advance,
    layout,
    isVisible: () => visible,
    stepId: () => (visible ? STEPS[step].id : null),
    iconHint: () => icon('inspect', 14),
  };
}
