// Verify tab: last before/after run for the active session.
import { h, icon, clear } from '../lib/dom.js';

export function createVerifyPanel(actions) {
  const meta = h('div', { class: 'verify-meta' });
  const empty = h('div', { class: 'placeholder' }, [
    h('div', { class: 'ph-icon', html: icon('check', 30) }),
    h('div', { class: 'ph-title', text: 'Prove the fix' }),
    h('div', { class: 'ph-sub', text: 'After you hand off, re-run the audit and journey. Verify stores a before/after on this session.' }),
  ]);
  const runBtn = h('button', {
    class: 'btn btn-sm btn-primary',
    html: icon('check', 14) + '<span>Verify session</span>',
    on: { click: () => actions.run && actions.run() },
  });
  const bar = h('div', { class: 'verify-bar' }, [runBtn, meta]);
  const body = h('div', { class: 'verify-body' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'verify' } }, [bar, body]);

  let run = null;
  let running = false;

  function setRunning(on) {
    running = !!on;
    runBtn.disabled = running;
    runBtn.querySelector('span').textContent = running ? 'Verifying…' : 'Verify session';
  }

  function setRun(next) {
    run = next || null;
    render();
  }

  function pill(label, value, tone) {
    return h('div', { class: `verify-pill tone-${tone || 'neutral'}` }, [
      h('span', { class: 'vp-label', text: label }),
      h('span', { class: 'vp-value', text: String(value) }),
    ]);
  }

  function render() {
    clear(body);
    if (!run) {
      body.appendChild(empty);
      meta.textContent = '';
      return;
    }
    meta.textContent = run.at ? new Date(run.at).toLocaleString() : '';
    const delta = run.delta || {};
    const beforeA = (run.before && run.before.audit) || {};
    const afterA = (run.after && run.after.audit) || {};
    const afterJ = (run.after && run.after.journey) || (run.before && run.before.journey);
    const wrap = h('div', { class: 'verify-stats' }, [
      pill('Audit before', beforeA.total == null ? '—' : beforeA.total, 'neutral'),
      pill('Audit after', afterA.total == null ? '—' : afterA.total, delta.audit < 0 ? 'good' : delta.audit > 0 ? 'bad' : 'neutral'),
      pill('Audit Δ', (delta.audit > 0 ? '+' : '') + (delta.audit == null ? '—' : delta.audit), delta.audit < 0 ? 'good' : delta.audit > 0 ? 'bad' : 'neutral'),
      pill('Notes still open', run.notesOpen == null ? '—' : run.notesOpen, run.notesOpen ? 'warn' : 'good'),
    ]);
    if (afterJ && afterJ.total != null) {
      wrap.appendChild(pill('Journey', `${afterJ.passed}/${afterJ.total} passed`, afterJ.failed ? 'bad' : 'good'));
    }
    body.appendChild(wrap);

    const shotRow = h('div', { class: 'verify-shots' });
    const beforeShot = run.before && run.before.screenshot;
    const afterShot = run.after && run.after.screenshot;
    if (beforeShot || afterShot) {
      if (beforeShot) {
        shotRow.appendChild(h('figure', {}, [
          h('figcaption', { text: 'Before' }),
          h('img', { src: beforeShot, alt: 'Viewport before verify' }),
        ]));
      }
      if (afterShot) {
        shotRow.appendChild(h('figure', {}, [
          h('figcaption', { text: 'After' }),
          h('img', { src: afterShot, alt: 'Viewport after verify' }),
        ]));
      }
      body.appendChild(shotRow);
    }
    body.appendChild(h('p', {
      class: 'field-hint',
      text: 'Resolve notes that the agent actually fixed, then verify again. Deltas stay on this session.',
    }));
  }

  render();
  return { root, setRun, setRunning, getRun: () => run };
}
