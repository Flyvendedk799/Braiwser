// Three-step first-run coach. Overlay lives in the renderer chrome (not the
// guest page) so it can point at Inspect, the stage, and the ship actions.
import { h, icon } from '../lib/dom.js';

const STEPS = [
  {
    id: 'inspect',
    title: 'Inspect what’s wrong',
    sample: 'Inspect is on. Click the faded Buy now button on the sample page.',
    generic: 'Inspect is on. Click the primary button — or any element that looks wrong.',
    target: '[data-coach="inspect"]',
    fallback: '.stage',
  },
  {
    id: 'note',
    title: 'Save the note',
    sample: 'Write one sentence about the fix, pick an action tag, and save. That note is what the agent will see.',
    generic: 'Write one sentence about the fix, pick an action tag, and save. That note is what the agent will see.',
    target: '.panel [data-tab="notes"]',
    fallback: '.panel',
  },
  {
    id: 'ship',
    title: 'Ship it',
    sample: 'Copy the agent prompt, or hand off to your coding agent. That’s the whole loop.',
    generic: 'Copy the agent prompt, or hand off to your coding agent. That’s the whole loop.',
    target: '[data-coach="ship"]',
    fallback: '.panel-footer',
  },
];

export function createCoachmarks(actions) {
  let step = 0;
  let visible = false;
  let prevFocus = null;
  const spot = h('div', { class: 'coach-spot' });
  const title = h('div', { class: 'coach-title', id: 'caos-coach-title' });
  const body = h('div', { class: 'coach-body', id: 'caos-coach-body' });
  const stepLabel = h('div', { class: 'coach-step' });
  const nextBtn = h('button', { class: 'btn btn-sm btn-primary', text: 'Next', on: { click: () => next() } });
  const card = h('div', {
    class: 'coach-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'caos-coach-title',
    'aria-describedby': 'caos-coach-body',
    tabindex: '-1',
  }, [
    stepLabel,
    title,
    body,
    h('div', { class: 'coach-acts' }, [
      h('button', { class: 'btn btn-sm btn-ghost', text: 'Skip', on: { click: () => dismiss(true) } }),
      nextBtn,
    ]),
  ]);
  const root = h('div', { class: 'coach-overlay', hidden: 'hidden' }, [spot, card]);
  document.body.appendChild(root);

  function isSample() {
    return !!(actions.isSample && actions.isSample());
  }

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
    body.textContent = isSample() ? spec.sample : spec.generic;
    stepLabel.textContent = `Step ${step + 1} of ${STEPS.length}`;
    nextBtn.textContent = step >= STEPS.length - 1 ? 'Done' : 'Next';
  }

  function show(index) {
    step = Math.max(0, Math.min(STEPS.length - 1, index == null ? 0 : index));
    visible = true;
    prevFocus = document.activeElement;
    root.removeAttribute('hidden');
    layout();
    requestAnimationFrame(() => {
      layout();
      try { card.focus(); } catch (_e) { /* ignore */ }
    });
    if (actions.onStep) actions.onStep(STEPS[step].id, step);
  }

  function hide() {
    visible = false;
    root.setAttribute('hidden', 'hidden');
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_e) { /* ignore */ }
    prevFocus = null;
  }

  function next() {
    if (step >= STEPS.length - 1) {
      dismiss(false);
      return;
    }
    step += 1;
    layout();
    if (actions.onStep) actions.onStep(STEPS[step].id, step);
    try { card.focus(); } catch (_e) { /* ignore */ }
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

  function onOverlayPointer(e) {
    if (!visible) return;
    if (card.contains(e.target)) return;
    const r = spot.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) {
      // Let the click reach the spotlighted control (Inspect, Notes, Ship).
      root.style.pointerEvents = 'none';
      setTimeout(() => { if (visible) root.style.pointerEvents = 'auto'; }, 0);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e) {
    if (!visible) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss(true);
    }
  }

  root.addEventListener('pointerdown', onOverlayPointer, true);
  document.addEventListener('keydown', onKey, true);
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
