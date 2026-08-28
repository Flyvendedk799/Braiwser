// Audit tab: runs the in-page accessibility / quality scan and lists what it
// found. Every finding can be located on the page or promoted into a real
// annotation in one click, which is the whole point — the audit feeds the same
// review pipeline (notes → export → agent hand-off) as manual capture.
import { h, icon, clear, esc } from '../lib/dom.js';

const SEV_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
const SEV_COLOR = { critical: 'var(--remove)', serious: 'var(--change)', moderate: 'var(--fix)', minor: 'var(--comment)' };

export function createAuditPanel(config, actions) {
  const severities = config.auditSeverities || ['critical', 'serious', 'moderate', 'minor'];
  let report = null;
  let running = false;
  let hidden = new Set(); // severities toggled off
  const promoted = new Set(); // finding ids already turned into notes

  const runBtn = h('button', {
    class: 'btn btn-sm btn-primary',
    html: icon('check', 14) + '<span>Run audit</span>',
    on: { click: () => actions.run() },
  });
  const addAllBtn = h('button', {
    class: 'btn btn-sm',
    text: 'Add all as notes',
    title: 'Capture every visible finding as a note in this session',
    on: { click: () => actions.addAll(visibleFindings()) },
  });
  const meta = h('div', { class: 'audit-meta' });
  const summary = h('div', { class: 'audit-summary' });
  const list = h('div', { class: 'audit-list' });

  const root = h('div', { class: 'tab-body', dataset: { tab: 'audit' } }, [
    h('div', { class: 'audit-bar' }, [
      h('div', { class: 'audit-row' }, [runBtn, addAllBtn]),
      summary,
      meta,
    ]),
    list,
  ]);

  function visibleFindings() {
    if (!report || !Array.isArray(report.findings)) return [];
    return report.findings.filter((f) => !hidden.has(f.severity));
  }

  function renderSummary() {
    clear(summary);
    if (!report) { meta.textContent = ''; addAllBtn.disabled = true; return; }
    const counts = report.counts || {};
    for (const sev of severities) {
      const n = counts[sev] || 0;
      if (!n) continue;
      const on = !hidden.has(sev);
      summary.appendChild(
        h('button', {
          class: `sev-pill sev-${sev} ${on ? 'on' : ''}`,
          title: on ? `Hide ${SEV_LABEL[sev]} findings` : `Show ${SEV_LABEL[sev]} findings`,
          html: `<span class="dot"></span>${n} ${esc(SEV_LABEL[sev] || sev)}`,
          on: {
            click: () => {
              if (hidden.has(sev)) hidden.delete(sev);
              else hidden.add(sev);
              render();
            },
          },
        })
      );
    }
    const scanned = report.scanned != null ? `${report.scanned} elements scanned` : '';
    const trunc = report.truncated ? ' (truncated)' : '';
    meta.textContent = report.total === 0
      ? `No issues found — ${scanned}${trunc}.`
      : `${report.total} finding${report.total === 1 ? '' : 's'} · ${scanned}${trunc}`;
    addAllBtn.disabled = !visibleFindings().length;
  }

  function findingCard(f) {
    const done = promoted.has(f.id);
    const card = h('div', { class: 'finding' });
    card.style.setProperty('--stripe', SEV_COLOR[f.severity] || 'var(--line2)');
    card.appendChild(
      h('div', { class: 'finding-top' }, [
        h('span', { class: `finding-sev sev-${f.severity}`, style: { color: SEV_COLOR[f.severity] }, text: SEV_LABEL[f.severity] || f.severity }),
        h('span', { class: 'finding-rule', text: f.ruleId }),
        h('span', { class: 'finding-grow' }),
        h('div', { class: 'finding-acts' }, [
          f.target
            ? h('button', { class: 'note-act', title: 'Locate on page', 'aria-label': 'Locate on page', html: icon('locate', 15), on: { click: () => actions.locate(f) } })
            : null,
          f.selector
            ? h('button', { class: 'note-act', title: 'Copy selector', 'aria-label': 'Copy selector', html: icon('copy', 15), on: { click: () => actions.copySelector(f) } })
            : null,
          h('button', {
            class: `note-act ${done ? 'on' : ''}`,
            title: done ? 'Already captured as a note' : 'Capture as a note',
            'aria-label': done ? 'Already captured as a note' : 'Capture as a note',
            html: icon(done ? 'check' : 'plus', 15),
            on: { click: () => actions.addOne(f) },
          }),
        ]),
      ])
    );
    card.appendChild(h('div', { class: 'finding-title', text: f.title }));
    if (f.detail) card.appendChild(h('div', { class: 'finding-detail', text: f.detail }));
    if (f.snippet) card.appendChild(h('div', { class: 'finding-snippet', text: f.snippet }));
    if (f.help) card.appendChild(h('div', { class: 'finding-help', text: f.help }));
    return card;
  }

  function render() {
    renderSummary();
    clear(list);

    if (running) {
      list.appendChild(h('div', { class: 'ai-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'Auditing the page…' })]));
      return;
    }
    if (!report) {
      list.appendChild(placeholder('check', 'Audit this page', 'Run a local accessibility and UI-quality scan — contrast, alt text, labels, tap targets, heading order and more. No API key needed.'));
      return;
    }
    if (report.error) {
      list.appendChild(h('div', { class: 'ai-error', text: report.error }));
      return;
    }
    const items = visibleFindings();
    if (!report.findings.length) {
      list.appendChild(placeholder('check', 'Nothing to flag', 'This page passed every rule the audit checks. Re-run it after changes to keep it that way.'));
      return;
    }
    if (!items.length) {
      list.appendChild(placeholder('check', 'All severities hidden', 'Re-enable a severity above to see its findings.'));
      return;
    }
    items.forEach((f) => list.appendChild(findingCard(f)));
  }

  function placeholder(ic, title, sub) {
    return h('div', { class: 'placeholder' }, [
      h('div', { class: 'ph-icon', html: icon(ic, 30) }),
      h('div', { class: 'ph-title', text: title }),
      h('div', { class: 'ph-sub', text: sub }),
    ]);
  }

  function setRunning(v) {
    running = !!v;
    runBtn.disabled = running;
    render();
  }

  function setReport(r) {
    report = r || null;
    running = false;
    runBtn.disabled = false;
    hidden = new Set();
    promoted.clear();
    render();
    actions.onCount(report && report.total ? report.total : 0);
  }

  function markPromoted(ids) {
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => promoted.add(id));
    render();
  }

  render();
  return { root, setReport, setRunning, markPromoted, getReport: () => report };
}
