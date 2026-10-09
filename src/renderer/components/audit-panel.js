// Audit tab: runs the in-page accessibility / quality scan and lists what it
// found. Every finding can be located on the page or promoted into a real
// annotation in one click, which is the whole point — the audit feeds the same
// review pipeline (notes → export → agent hand-off) as manual capture.
//
// Report identity (RF-06). A report belongs to the page it was run on. The panel
// shows where that was (URL + viewport) and flags it STALE when the page the user
// is looking at now is a different one, instead of letting an old finding be
// promoted onto the wrong URL.
//   • report context: report.context = { url, title?, viewport?: {w,h,label?},
//     tabId?, documentId?, at? }   (also read: report.source, report.url,
//     report.viewport) — or pass it as setReport(report, context).
//   • current context: panel.setCurrentContext({ url, viewport?, tabId?, documentId? })
//     on navigation / tab switch, or actions.currentContext() polled on render.
//   • stale: urls differ (ignoring #fragment), or tabId / documentId differ.
//   • while stale, Locate / Add / Add-all are disabled (the finding's selector
//     targets a different document) unless actions.allowStalePromotion === true,
//     which is the app promising to save with the REPORT's context. Either way the
//     handlers receive the report context:
//       actions.locate(f, ctx, { stale })   actions.copySelector(f, ctx, { stale })
//       actions.addOne(f, ctx, { stale })   actions.addAll(findings, ctx, { stale })
import { h, icon, clear, esc, timeAgo } from '../lib/dom.js';

const SEV_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
const SEV_COLOR = { critical: 'var(--remove)', serious: 'var(--change)', moderate: 'var(--fix)', minor: 'var(--comment)' };

const noHash = (u) => String(u || '').split('#')[0];

function shortUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    if (x.protocol === 'file:') return decodeURIComponent(x.pathname.split('/').pop() || x.pathname);
    return x.hostname.replace(/^www\./, '') + (x.pathname !== '/' ? x.pathname : '') + x.search;
  } catch (_e) {
    return String(u);
  }
}

function viewportText(v) {
  if (!v || typeof v !== 'object') return '';
  const size = v.w && v.h ? `${v.w}×${v.h}` : '';
  const label = v.label && v.label !== 'Fit to window' ? v.label : '';
  return [label, size].filter(Boolean).join(' ');
}

// Pull the report's own identity out of whichever fields the producer used.
export function reportContext(report, override) {
  if (!report) return null;
  const src = Object.assign({}, report.source || {}, report.context || {}, override || {});
  const url = src.url || report.url || '';
  const viewport = src.viewport || report.viewport || null;
  const ctx = { url, viewport };
  for (const k of ['title', 'tabId', 'documentId', 'at', 'sessionId']) if (src[k] != null) ctx[k] = src[k];
  if (!ctx.at && report.at) ctx.at = report.at;
  return ctx.url || ctx.viewport || ctx.tabId != null || ctx.documentId != null ? ctx : null;
}

// Is the page the user is on now a different one from the report's?
export function isStale(reportCtx, currentCtx) {
  if (!reportCtx || !currentCtx) return false; // unknown is not stale: nothing to compare
  if (reportCtx.tabId != null && currentCtx.tabId != null && reportCtx.tabId !== currentCtx.tabId) return true;
  if (reportCtx.documentId != null && currentCtx.documentId != null && reportCtx.documentId !== currentCtx.documentId) return true;
  if (reportCtx.url && currentCtx.url && noHash(reportCtx.url) !== noHash(currentCtx.url)) return true;
  return false;
}

export function createAuditPanel(config, actions) {
  const severities = config.auditSeverities || ['critical', 'serious', 'moderate', 'minor'];
  let report = null;
  let reportCtx = null;
  let currentCtx = null;
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
    on: { click: () => actions.addAll(visibleFindings(), reportCtx, { stale: stale() }) },
  });
  const meta = h('div', { class: 'audit-meta' });
  const source = h('div', { class: 'audit-source' });
  const staleBanner = h('div', { class: 'audit-stale', role: 'status', hidden: 'hidden' });
  const summary = h('div', { class: 'audit-summary' });
  const list = h('div', { class: 'audit-list' });

  const root = h('div', { class: 'tab-body', dataset: { tab: 'audit' } }, [
    h('div', { class: 'audit-bar' }, [
      h('div', { class: 'audit-row' }, [runBtn, addAllBtn]),
      summary,
      meta,
      source,
      staleBanner,
    ]),
    list,
  ]);

  function liveContext() {
    if (actions.currentContext) {
      try {
        const c = actions.currentContext();
        if (c) return c;
      } catch (_e) { /* fall through */ }
    }
    return currentCtx;
  }

  function stale() {
    return isStale(reportCtx, liveContext());
  }

  // Stale reports lock their page-bound actions unless the app opted in to
  // binding promotion to the report's own context.
  function locked() {
    return stale() && actions.allowStalePromotion !== true;
  }

  function visibleFindings() {
    if (!report || !Array.isArray(report.findings)) return [];
    return report.findings.filter((f) => !hidden.has(f.severity));
  }

  function renderSource() {
    clear(source);
    staleBanner.setAttribute('hidden', 'hidden');
    clear(staleBanner);
    if (!report || !reportCtx) return;
    const parts = [];
    if (reportCtx.url) parts.push(h('span', { class: 'as-url', title: reportCtx.url, text: shortUrl(reportCtx.url) }));
    const vp = viewportText(reportCtx.viewport);
    if (vp) parts.push(h('span', { class: 'as-vp', text: vp }));
    if (reportCtx.at) parts.push(h('span', { class: 'as-when', text: timeAgo(reportCtx.at) }));
    if (parts.length) {
      source.appendChild(h('span', { class: 'as-label', text: 'Audited' }));
      parts.forEach((p) => source.appendChild(p));
    }
    if (stale()) {
      const cur = liveContext() || {};
      staleBanner.removeAttribute('hidden');
      staleBanner.appendChild(h('strong', { text: 'Out of date. ' }));
      staleBanner.appendChild(h('span', {
        text: `These findings are from ${shortUrl(reportCtx.url) || 'another page'}` + (cur.url ? `, not ${shortUrl(cur.url)}.` : '.')
          + (actions.allowStalePromotion === true
            ? ' Notes you add are saved against the audited page.'
            : ' Re-run the audit here to locate or capture them.'),
      }));
    }
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
          'aria-pressed': on ? 'true' : 'false',
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
    meta.textContent = report.error
      ? 'The audit did not complete.'
      : report.total === 0
        ? `No issues found — ${scanned}${trunc}.`
        : `${report.total} finding${report.total === 1 ? '' : 's'} · ${scanned}${trunc}`;
    addAllBtn.disabled = !visibleFindings().length || locked();
    addAllBtn.title = locked() ? 'This report is from a different page — re-run the audit here first' : 'Capture every visible finding as a note in this session';
  }

  function findingCard(f) {
    const done = promoted.has(f.id);
    const isLocked = locked();
    const lockedTitle = 'This finding is from a different page — re-run the audit here first';
    const card = h('div', { class: 'finding' + (stale() ? ' is-stale' : '') });
    card.style.setProperty('--stripe', SEV_COLOR[f.severity] || 'var(--line2)');
    const ctx = () => [reportCtx, { stale: stale() }];
    card.appendChild(
      h('div', { class: 'finding-top' }, [
        h('span', { class: `finding-sev sev-${f.severity}`, style: { color: SEV_COLOR[f.severity] }, text: SEV_LABEL[f.severity] || f.severity }),
        h('span', { class: 'finding-rule', text: f.ruleId }),
        stale() ? h('span', { class: 'finding-stale', title: 'From ' + (reportCtx && reportCtx.url || 'another page'), text: 'stale' }) : null,
        h('span', { class: 'finding-grow' }),
        h('div', { class: 'finding-acts' }, [
          f.target
            ? h('button', {
                class: 'note-act', title: isLocked ? lockedTitle : 'Locate on page', 'aria-label': 'Locate on page',
                disabled: isLocked, html: icon('locate', 15), on: { click: () => actions.locate(f, ...ctx()) },
              })
            : null,
          f.selector
            ? h('button', { class: 'note-act', title: 'Copy selector', 'aria-label': 'Copy selector', html: icon('copy', 15), on: { click: () => actions.copySelector(f, ...ctx()) } })
            : null,
          h('button', {
            class: `note-act ${done ? 'on' : ''}`,
            title: isLocked ? lockedTitle : done ? 'Already captured as a note' : 'Capture as a note',
            'aria-label': done ? 'Already captured as a note' : 'Capture as a note',
            disabled: isLocked,
            html: icon(done ? 'check' : 'plus', 15),
            on: { click: () => actions.addOne(f, ...ctx()) },
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
    renderSource();
    clear(list);

    if (running) {
      list.appendChild(h('div', { class: 'ai-loading', role: 'status' }, [h('span', { class: 'spinner' }), h('span', { text: 'Auditing the page…' })]));
      return;
    }
    if (!report) {
      list.appendChild(placeholder('check', 'Audit this page', 'Run a local accessibility and UI-quality scan — contrast, alt text, labels, tap targets, heading order and more. No API key needed.'));
      return;
    }
    if (report.error) {
      // An audit that failed is not "no issues": say so, and offer another try.
      list.appendChild(h('div', { class: 'ai-error', role: 'alert' }, [
        h('div', { text: report.error }),
        h('button', { class: 'btn btn-sm audit-retry', style: { marginTop: '8px' }, text: 'Retry audit', on: { click: () => actions.run() } }),
      ]));
      return;
    }
    const items = visibleFindings();
    if (!report.findings || !report.findings.length) {
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
    return h('div', { class: 'placeholder empty-state' }, [
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

  // setReport(report, context?) — context overrides/extends what the report
  // carries (the app knows the tab, document and viewport it ran against).
  function setReport(r, context) {
    report = r || null;
    reportCtx = reportContext(report, context);
    running = false;
    runBtn.disabled = false;
    hidden = new Set();
    promoted.clear();
    render();
    actions.onCount(report && report.total ? report.total : 0);
  }

  // Tell the panel which page the user is on now (navigation, tab switch).
  function setCurrentContext(ctx) {
    currentCtx = ctx || null;
    render();
  }

  function markPromoted(ids) {
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => promoted.add(id));
    render();
  }

  render();
  return {
    root,
    setReport,
    setRunning,
    markPromoted,
    setCurrentContext,
    isStale: stale,
    getReportContext: () => reportCtx,
    getReport: () => report,
  };
}
