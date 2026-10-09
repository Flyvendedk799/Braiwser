// Verify tab: last before/after run for the active session.
//
// The panel renders the schema-v2 run documented at the top of
// src/main/services/review/verify.js, and reads older (v1 / legacy) runs too.
// Its job is to never turn "we could not check" into "everything is fixed":
//   • every audit and journey outcome is an explicit state with an icon AND text
//     (passed / failed / cancelled / timed out / skipped / unknown — and for the
//     audit completed / error / timed out / skipped / cancelled / no result);
//   • a numeric audit change is shown only when run.audit.deltaAvailable is true;
//     otherwise the panel says the comparison is unavailable and why;
//   • the journey shows planned vs ran/passed counts, not just "n/n passed";
//   • an audit that did not complete shows its error text and a Retry button;
//   • only status 'verified' (and individual 'passed'/'completed' states) are green.
//
// Optional action: actions.retryAudit() — re-runs the audit (falls back to
// actions.run(), the full Verify).
import { h, icon, clear } from '../lib/dom.js';

const AUDIT_STATE = {
  completed: { icon: 'check', label: 'Completed', tone: 'neutral' },
  error: { icon: 'close', label: 'Error', tone: 'bad' },
  timedOut: { icon: 'warn', label: 'Timed out', tone: 'warn' },
  skipped: { icon: 'forward', label: 'Skipped', tone: 'warn' },
  cancelled: { icon: 'stop', label: 'Cancelled', tone: 'warn' },
  missing: { icon: 'help', label: 'No result', tone: 'warn' },
};

const JOURNEY_STATE = {
  passed: { icon: 'check', label: 'Passed', tone: 'good' },
  failed: { icon: 'close', label: 'Failed', tone: 'bad' },
  cancelled: { icon: 'stop', label: 'Cancelled', tone: 'warn' },
  timedOut: { icon: 'warn', label: 'Timed out', tone: 'warn' },
  skipped: { icon: 'forward', label: 'Skipped', tone: 'neutral' },
  unknown: { icon: 'help', label: 'Unknown', tone: 'warn' },
};

const HEADLINE = {
  verified: { icon: 'check', label: 'Verified', tone: 'good' },
  failed: { icon: 'close', label: 'Failed', tone: 'bad' },
  inconclusive: { icon: 'help', label: 'Inconclusive', tone: 'warn' },
};

// Why a comparison is unavailable, in words (reasons come from verify.js /
// review/verdict.js; unknown ones are shown verbatim rather than hidden).
const REASONS = {
  legacy: 'legacy: comparison unavailable',
  incomparable_context: 'The two audits ran against a different page, viewport or rule set.',
  unexpected_application_revision: 'The audited application revision was not the expected one.',
  missing_report: 'There is no audit report to compare.',
  check_not_passed: 'An audit did not pass cleanly.',
  check_error: 'An audit reported an error.',
  invalid_total: 'An audit did not return a valid finding count.',
  missing_context: 'The audits carry no comparison context.',
  missing_evidence: 'An audit has no evidence attached.',
  no_report: 'No audit report was captured.',
};

function reasonText(reason) {
  if (!reason) return '';
  const m = /^(baseline|before|after|candidate):(.+)$/.exec(reason);
  if (m) {
    const side = m[1] === 'baseline' || m[1] === 'before' ? 'The baseline audit' : 'The after audit';
    const what = m[2];
    const state = AUDIT_STATE[what];
    if (state) return `${side}: ${state.label.toLowerCase()}.`;
    return `${side}: ${REASONS[what] || what}`;
  }
  return REASONS[reason] || reason;
}

// ---- legacy / v1 normalisation (the main process normalises stored runs, but a
// run can still reach the renderer in its old shape: never trust a legacy delta).
function legacyAudit(a) {
  if (!a || typeof a !== 'object') return { status: 'missing', total: null, error: '', reason: 'no_report' };
  if (a.status && AUDIT_STATE[a.status]) return { status: a.status, total: a.status === 'completed' ? a.total : null, error: a.error || '', reason: a.reason || '' };
  if (a.error) return { status: /time/i.test(a.error) ? 'timedOut' : 'error', total: null, error: String(a.error), reason: '' };
  if (Number.isFinite(a.total)) return { status: 'completed', total: a.total, error: '', reason: '' };
  return { status: 'missing', total: null, error: '', reason: 'no_report' };
}

function legacyJourney(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.status && JOURNEY_STATE[j.status]) return j;
  const passed = Number(j.passed) || 0;
  const failed = Number(j.failed) || 0;
  const total = Number(j.total);
  return {
    source: 'legacy', status: failed > 0 ? 'failed' : 'unknown', planned: Number.isFinite(total) ? total : null,
    executed: passed + failed, passed, failed, skipped: 0, cancelled: 0, timedOut: 0, pending: 0, unknown: 0,
  };
}

export function normalizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.v === 2 && run.audit && run.audit.before) return run;
  const before = run.before || {};
  const after = run.after || {};
  const afterJourney = legacyJourney(after.journey || before.journey);
  return {
    v: 2,
    legacy: true,
    at: run.at || null,
    notesOpen: run.notesOpen,
    status: 'inconclusive',
    reason: 'recorded before Verify tracked audit failures (legacy run)',
    audit: { before: legacyAudit(before.audit), after: legacyAudit(after.audit), deltaAvailable: false, delta: null, reason: 'legacy' },
    journey: afterJourney,
    before: { screenshot: before.screenshot, journey: legacyJourney(before.journey) },
    after: { screenshot: after.screenshot, journey: afterJourney },
  };
}

export function createVerifyPanel(actions) {
  const meta = h('div', { class: 'verify-meta' });
  const empty = h('div', { class: 'placeholder empty-state' }, [
    h('div', { class: 'ph-icon', html: icon('check', 30) }),
    h('div', { class: 'ph-title', text: 'Prove the fix' }),
    h('div', { class: 'ph-sub', text: 'After you hand off, re-run the audit and journey. Verify stores a before/after on this session.' }),
  ]);
  const runBtn = h('button', {
    class: 'btn btn-sm btn-primary',
    disabled: true,
    html: icon('check', 14) + '<span>Verify session</span>',
    on: { click: () => actions.run && actions.run() },
  });
  const bar = h('div', { class: 'verify-bar' }, [runBtn, meta]);
  const body = h('div', { class: 'verify-body' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'verify' } }, [bar, body]);

  let run = null;
  let running = false;
  let pageReady = false;

  function syncBtn() {
    runBtn.disabled = running || !pageReady;
    runBtn.querySelector('span').textContent = running ? 'Verifying…' : 'Verify session';
    runBtn.setAttribute('aria-busy', running ? 'true' : 'false');
    const retry = body.querySelector('.verify-retry');
    if (retry) retry.disabled = running || !pageReady;
  }

  function setRunning(on) {
    running = !!on;
    syncBtn();
  }

  function setPageReady(on) {
    pageReady = !!on;
    syncBtn();
  }

  function setRun(next) {
    run = next || null;
    render();
  }

  // A state chip: icon + text, never colour alone.
  function stateChip(state) {
    return h('span', { class: `verify-state tone-${state.tone}` }, [
      h('span', { class: 'vs-icon', 'aria-hidden': 'true', html: icon(state.icon, 13) }),
      h('span', { class: 'vs-label', text: state.label }),
    ]);
  }

  function pill(label, valueNode, tone, extra) {
    return h('div', { class: `verify-pill tone-${tone || 'neutral'}` }, [
      h('span', { class: 'vp-label', text: label }),
      valueNode,
      extra || null,
    ]);
  }

  const textValue = (v) => h('span', { class: 'vp-value', text: String(v) });

  function auditPill(label, a) {
    const st = AUDIT_STATE[a.status] || AUDIT_STATE.missing;
    if (a.status === 'completed') {
      return pill(label, h('span', { class: 'vp-value' }, [
        h('span', { text: String(a.total) }),
        h('span', { class: 'vp-sub', text: a.total === 1 ? ' finding' : ' findings' }),
      ]), 'neutral', stateChip(st));
    }
    // No number at all: a failed audit has no count, and "0" would claim it passed.
    return pill(label, textValue('—'), st.tone, stateChip(st));
  }

  function countsLine(j) {
    const parts = [];
    const add = (n, text) => { if (n) parts.push(`${n} ${text}`); };
    add(j.passed, 'passed');
    add(j.failed, 'failed');
    add(j.skipped, 'skipped');
    add(j.cancelled, 'cancelled');
    add(j.timedOut, 'timed out');
    add(j.unknown, 'unverified');
    add(j.pending, 'not run');
    return parts.join(' · ');
  }

  function journeyBlock(j) {
    const st = JOURNEY_STATE[j.status] || JOURNEY_STATE.unknown;
    const block = h('div', { class: `verify-journey tone-${st.tone}` });
    const planned = j.planned != null && j.planned > 0 ? j.planned : null;
    const ran = j.executed != null ? j.executed : (j.passed || 0) + (j.failed || 0);
    block.appendChild(h('div', { class: 'vj-head' }, [
      h('span', { class: 'vp-label', text: 'Journey' }),
      j.name ? h('span', { class: 'vj-name', text: j.name }) : null,
      stateChip(st),
    ]));
    block.appendChild(h('div', {
      class: 'vj-counts',
      text: planned != null ? `${ran} of ${planned} planned steps ran` : (j.source === 'legacy' ? 'legacy: planned step count unavailable' : 'No planned step count recorded'),
    }));
    const detail = countsLine(j);
    if (detail) block.appendChild(h('div', { class: 'vj-detail', text: detail }));
    if (j.status === 'unknown') {
      block.appendChild(h('div', { class: 'vj-note', text: 'Not every planned step has proof of success, so this is not reported as passed.' }));
    }
    return block;
  }

  function render() {
    clear(body);
    if (!run) {
      body.appendChild(empty);
      meta.textContent = '';
      syncBtn();
      return;
    }
    const v = normalizeRun(run);
    meta.textContent = v.at ? new Date(v.at).toLocaleString() : '';

    // Headline: the one place a green "verified" can appear.
    const head = HEADLINE[v.status] || HEADLINE.inconclusive;
    body.appendChild(h('div', { class: `verify-headline tone-${head.tone}`, role: 'status' }, [
      stateChip(head),
      v.reason ? h('span', { class: 'vh-reason', text: v.reason }) : null,
    ]));

    // ---- audit ----
    const audit = v.audit;
    const wrap = h('div', { class: 'verify-stats' }, [
      auditPill('Audit before', audit.before),
      auditPill('Audit after', audit.after),
    ]);
    if (audit.deltaAvailable && Number.isFinite(audit.delta)) {
      const d = audit.delta;
      const tone = d < 0 ? 'good' : d > 0 ? 'bad' : 'neutral';
      wrap.appendChild(pill('Audit change', textValue((d > 0 ? '+' : '') + d), tone, h('span', { class: 'vp-sub', text: d < 0 ? 'fewer findings' : d > 0 ? 'more findings' : 'no change' })));
    } else {
      wrap.appendChild(pill('Audit change', textValue('—'), 'warn', h('span', { class: 'vp-sub', title: audit.reason || '', text: reasonText(audit.reason) || 'comparison unavailable' })));
    }
    wrap.appendChild(pill('Notes still open', textValue(v.notesOpen == null ? '—' : v.notesOpen), v.notesOpen ? 'warn' : 'neutral'));
    body.appendChild(wrap);

    // Audit errors are shown, never swallowed — with a way to try again.
    const problems = [['Baseline audit', audit.before], ['After audit', audit.after]].filter(([, a]) => a.status !== 'completed');
    if (problems.length) {
      const box = h('div', { class: 'verify-problems', role: 'alert' });
      for (const [name, a] of problems) {
        const st = AUDIT_STATE[a.status] || AUDIT_STATE.missing;
        box.appendChild(h('div', { class: 'vpb-row' }, [
          stateChip(st),
          h('span', { class: 'vpb-text', text: `${name}: ${a.error || reasonText(a.reason) || st.label}` }),
        ]));
      }
      box.appendChild(h('button', {
        class: 'btn btn-sm verify-retry',
        html: icon('reload', 13) + '<span>Retry audit</span>',
        disabled: running || !pageReady,
        on: { click: () => (actions.retryAudit ? actions.retryAudit() : actions.run && actions.run()) },
      }));
      body.appendChild(box);
    }

    // ---- journey ----
    if (v.journey) body.appendChild(journeyBlock(v.journey));

    // ---- screenshots ----
    const shotRow = h('div', { class: 'verify-shots' });
    const beforeShot = v.before && v.before.screenshot;
    const afterShot = v.after && v.after.screenshot;
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
      text: 'Resolve notes that the agent actually fixed, then verify again. A change is only reported when both audits completed on the same page.',
    }));
    syncBtn();
  }

  render();
  return { root, setRun, setRunning, setPageReady, getRun: () => run };
}
