// Three-step first-run coach. Overlay lives in the renderer chrome (not the
// guest page) so it can point at Inspect, the stage, and the ship actions.
//
// The coach NEVER blocks the page (RF-12). The overlay is pointer-events:none;
// only the coach card is interactive, so the instructed interactions — click the
// sample Buy now button, type and save a note, hand off — all reach their real
// targets. Steps therefore advance from what the user actually does, via
//
//   coach.notify(eventName, detail?)       (coach.advance is a back-compat alias)
//
// which app.js should call at these moments:
//   'inspect-mode'      Inspect was switched on/off. detail: true | false (or
//                       { on: boolean }). While Inspect is off the first step
//                       points at the Inspect button; once on it points at the page.
//   'element-selected'  the user picked an element in Inspect/Edit.   step 1 -> 2
//   'note-saved'        a note was saved.                             step 1/2 -> 3
//   'shipped'           prompt copied / handed off / client pack.     step 3 -> done
// Skip / Next / Done remain as manual escapes; the flow completes without them.
import { h, icon, modalDepth } from '../lib/dom.js';

const STEPS = [
  {
    id: 'inspect',
    title: 'Inspect what’s wrong',
    sample: 'Inspect is on. Click the faded Buy now button on the sample page.',
    generic: 'Inspect is on. Click the primary button — or any element that looks wrong.',
    // While Inspect is still off the step points at the toolbar button instead.
    sampleOff: 'Turn on Inspect in the toolbar, then click the faded Buy now button on the sample page.',
    genericOff: 'Turn on Inspect in the toolbar, then click the primary button — or any element that looks wrong.',
    target: '.stage',
    targetOff: '[data-coach="inspect"]',
    fallback: '.stage',
    inside: true, // the target is the page itself: keep the card inside it
    passthrough: true,
  },
  {
    id: 'note',
    title: 'Save the note',
    sample: 'Write one sentence about the fix, pick an action tag, and save. That note is what the agent will see.',
    generic: 'Write one sentence about the fix, pick an action tag, and save. That note is what the agent will see.',
    target: '.panel [data-tab="notes"]',
    fallback: '.panel',
    passthrough: true,
  },
  {
    id: 'ship',
    title: 'Ship it',
    sample: 'Copy the agent prompt, or hand off to your coding agent. That’s the whole loop.',
    generic: 'Copy the agent prompt, or hand off to your coding agent. That’s the whole loop.',
    target: '[data-coach="ship"]',
    fallback: '.panel-footer',
    passthrough: false,
  },
];

const CARD_W = 320;

export function createCoachmarks(actions) {
  let step = 0;
  let visible = false;
  let prevFocus = null;
  // null = unknown (assume on: the sample flow switches Inspect on before it
  // shows the coach); otherwise the last 'inspect-mode' value.
  let inspectOn = null;
  const spot = h('div', { class: 'coach-spot' });
  const title = h('div', { class: 'coach-title', id: 'caos-coach-title' });
  const body = h('div', { class: 'coach-body', id: 'caos-coach-body' });
  const stepLabel = h('div', { class: 'coach-step' });
  const nextBtn = h('button', { class: 'btn btn-sm btn-primary', text: 'Next', on: { click: () => next() } });
  const card = h('div', {
    class: 'coach-card',
    role: 'dialog',
    // Non-modal on purpose: the page behind it stays usable and focusable.
    'aria-modal': 'false',
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

  function currentInspectOn() {
    if (inspectOn != null) return inspectOn;
    if (actions.isInspectOn) {
      const v = actions.isInspectOn();
      if (v != null) return !!v;
    }
    return true;
  }

  function layout() {
    if (!visible) return;
    const spec = STEPS[step] || STEPS[0];
    const off = spec.targetOff && !currentInspectOn();
    const el = document.querySelector(off ? spec.targetOff : spec.target) || document.querySelector(spec.fallback);
    const r = el ? el.getBoundingClientRect() : { left: 24, top: 80, width: 280, height: 48, bottom: 128, right: 304 };
    const pad = 6;
    spot.style.left = Math.max(8, r.left - pad) + 'px';
    spot.style.top = Math.max(8, r.top - pad) + 'px';
    spot.style.width = Math.max(40, r.width + pad * 2) + 'px';
    spot.style.height = Math.max(28, r.height + pad * 2) + 'px';
    let left;
    let top;
    if (spec.inside && !off) {
      // Bottom-right corner of the page area, clear of the page's own content flow.
      left = r.right - CARD_W - 16;
      top = r.bottom - 180;
    } else {
      left = r.left;
      top = r.bottom + 12;
      if (top + 160 > window.innerHeight) top = Math.max(16, r.top - 170);
    }
    if (left + CARD_W > window.innerWidth - 16) left = window.innerWidth - CARD_W - 16;
    card.style.left = Math.max(12, left) + 'px';
    card.style.top = Math.max(12, top) + 'px';
    title.textContent = spec.title;
    const sample = isSample();
    body.textContent = off ? (sample ? spec.sampleOff : spec.genericOff) : sample ? spec.sample : spec.generic;
    stepLabel.textContent = `Step ${step + 1} of ${STEPS.length}`;
    nextBtn.textContent = step >= STEPS.length - 1 ? 'Done' : 'Next';
    // Steps that ask the user to work in the page or the notes panel carry no
    // dimming scrim — it would grey out the very thing they are told to use.
    root.classList.toggle('coach-passthrough', !!spec.passthrough);
    root.dataset.step = spec.id;
  }

  function goTo(index, { focus = false, announce = true } = {}) {
    step = Math.max(0, Math.min(STEPS.length - 1, index));
    layout();
    if (announce && actions.onStep) actions.onStep(STEPS[step].id, step);
    // Only a user-driven move may take focus: an automatic advance happens while
    // they are typing in the page or the notes panel.
    if (focus) try { card.focus(); } catch (_e) { /* ignore */ }
  }

  function show(index) {
    const wasVisible = visible;
    visible = true;
    if (!wasVisible) prevFocus = document.activeElement;
    root.removeAttribute('hidden');
    step = Math.max(0, Math.min(STEPS.length - 1, index == null ? 0 : index));
    layout();
    requestAnimationFrame(() => {
      layout();
      if (!wasVisible) try { card.focus(); } catch (_e) { /* ignore */ }
    });
    if (actions.onStep) actions.onStep(STEPS[step].id, step);
  }

  function hide() {
    visible = false;
    root.setAttribute('hidden', 'hidden');
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); } catch (_e) { /* ignore */ }
    prevFocus = null;
  }

  function next() {
    if (step >= STEPS.length - 1) {
      dismiss(false);
      return;
    }
    goTo(step + 1, { focus: true });
  }

  // App-driven progress. Safe to call at any time — ignored while hidden.
  function notify(event, detail) {
    if (event === 'inspect-mode') {
      inspectOn = detail && typeof detail === 'object' ? !!detail.on : detail == null ? true : !!detail;
      if (visible) layout();
      return;
    }
    if (!visible) return;
    if (event === 'element-selected' && step === 0) goTo(1);
    else if (event === 'note-saved' && step <= 1) goTo(2);
    else if (event === 'shipped' && step >= 2) dismiss(false);
  }

  function dismiss(skipped) {
    const id = STEPS[step].id;
    hide();
    if (actions.onComplete) actions.onComplete({ skipped: !!skipped, step: id });
  }

  function onKey(e) {
    if (!visible || e.key !== 'Escape') return;
    if (modalDepth() > 0 || e.defaultPrevented) return; // that dialog's Escape, not ours
    const t = e.target;
    const editing = t && !card.contains(t) && t.matches && t.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (editing) return; // Escape while typing cancels the edit, not the tour
    e.preventDefault();
    e.stopPropagation();
    dismiss(true);
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', () => { if (visible) layout(); });

  return {
    root,
    show,
    hide,
    next,
    notify,
    advance: notify, // back-compat alias
    layout,
    isVisible: () => visible,
    stepId: () => (visible ? STEPS[step].id : null),
    iconHint: () => icon('inspect', 14),
  };
}
