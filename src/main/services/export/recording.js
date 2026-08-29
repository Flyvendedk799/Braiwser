// Turn a recorded journey into something a person (or an agent) can read:
// every step in order, what it touched, what it typed, where it scrolled, what
// the page did — plus how the last replay went, step by step. Markdown for
// pasting into an issue, HTML for printing to PDF.
//
// The same narrative drives both, so the PDF and the Markdown never disagree.

function pad(n) {
  return String(n).padStart(2, '0');
}

// "+1.4s" — offsets from the first step read better than wall-clock stamps.
function offset(ms) {
  if (!isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '+' + ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return '+' + (Math.round(s * 10) / 10) + 's';
  return '+' + Math.floor(s / 60) + ':' + pad(Math.round(s % 60));
}

function when(iso) {
  const t = Date.parse(iso || '');
  return isFinite(t) ? t : null;
}

function truncate(v, n) {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function targetLabel(step) {
  const text = (step.text || '').trim();
  const sel = step.selector || '';
  if (text && sel) return '“' + truncate(text, 48) + '” (' + sel + ')';
  if (text) return '“' + truncate(text, 48) + '”';
  return sel || '(no target)';
}

function valueLabel(step) {
  if (step.secret) return '•••••• (password, not recorded)';
  if (typeof step.value === 'boolean') return step.value ? 'checked' : 'unchecked';
  if (step.value == null || step.value === '') return '(cleared)';
  return '“' + truncate(step.value, 80) + '”';
}

function scrollLabel(step, prev) {
  const y = Math.round(step.y || 0);
  const x = Math.round(step.x || 0);
  const py = prev ? Math.round(prev.y || 0) : null;
  if (py == null) return 'to y=' + y + (x ? ', x=' + x : '');
  const dy = y - py;
  if (!dy) return 'settles at y=' + y;
  return (dy > 0 ? 'down ' : 'up ') + Math.abs(dy) + 'px (y=' + py + ' → ' + y + ')';
}

function assertLabel(step) {
  const bits = [step.kind || 'exists'];
  if (step.selector) bits.push('on `' + step.selector + '`');
  if (step.op) bits.push(step.op);
  if (step.expected != null && step.expected !== '') bits.push('“' + truncate(step.expected, 60) + '”');
  return bits.join(' ');
}

// One line of plain english per step, plus the details worth keeping.
function describeStep(step, prevScroll) {
  switch (step.type) {
    case 'navigate':
      return { verb: 'Navigate', detail: step.url || '' };
    case 'click':
      return { verb: 'Click', detail: targetLabel(step) };
    case 'input':
      return { verb: 'Type into', detail: targetLabel(step) + ' → ' + valueLabel(step) };
    case 'key':
      return { verb: 'Press ' + (step.key || 'key'), detail: 'in ' + targetLabel(step) };
    case 'scroll':
      return { verb: 'Scroll', detail: scrollLabel(step, prevScroll) };
    case 'assert':
      return { verb: 'Assert', detail: assertLabel(step) };
    default:
      return { verb: step.type || 'step', detail: step.selector || '' };
  }
}

// Merge the last replay's per-step outcome onto the steps it ran.
function runFor(lastRun, index) {
  if (!lastRun || !Array.isArray(lastRun.steps)) return null;
  return (
    lastRun.steps.find((s) => s.i === index || s.index === index) ||
    lastRun.steps[index] ||
    null
  );
}

function buildNarrative(recording, lastRun) {
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  const t0 = when(steps.length ? steps[0].ts : null);
  let prevScroll = null;
  const rows = steps.map((step, i) => {
    const at = when(step.ts);
    const d = describeStep(step, step.type === 'scroll' ? prevScroll : null);
    if (step.type === 'scroll') prevScroll = step;
    const run = runFor(lastRun, i);
    return {
      n: i + 1,
      at: t0 != null && at != null ? offset(at - t0) : '',
      verb: d.verb,
      detail: d.detail,
      type: step.type,
      selector: step.selector || '',
      result: run ? (run.ok ? 'ok' : 'failed') : '',
      error: run && run.error ? String(run.error) : '',
      actual: run && run.actual != null ? String(run.actual) : '',
    };
  });
  const duration = t0 != null && steps.length ? when(steps[steps.length - 1].ts) - t0 : null;
  return { rows, duration, t0 };
}

function summarise(recording, lastRun, narrative) {
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  const counts = {};
  for (const s of steps) counts[s.type] = (counts[s.type] || 0) + 1;
  return {
    name: recording.name || 'Recording',
    startUrl: recording.startUrl || '',
    createdAt: recording.createdAt || '',
    updatedAt: recording.updatedAt || '',
    stepCount: steps.length,
    duration: narrative.duration,
    counts,
    lastRun: lastRun
      ? {
          at: lastRun.at || '',
          passed: lastRun.passed,
          failed: lastRun.failed,
          total: lastRun.total,
        }
      : null,
  };
}

function durationLabel(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
}

// ---- markdown ------------------------------------------------------------------
function toRecordingMarkdown(recording, lastRun) {
  const narrative = buildNarrative(recording, lastRun);
  const sum = summarise(recording, lastRun, narrative);
  const out = [];
  out.push('# ' + sum.name);
  out.push('');
  out.push('_Recorded journey — ' + sum.stepCount + ' steps, ' + durationLabel(sum.duration) + '_');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push('| Start URL | ' + (sum.startUrl || '—') + ' |');
  out.push('| Recorded | ' + (sum.createdAt || '—') + ' |');
  out.push(
    '| Steps | ' +
      Object.keys(sum.counts)
        .map((k) => sum.counts[k] + ' × ' + k)
        .join(', ') +
      ' |'
  );
  if (sum.lastRun) {
    out.push(
      '| Last replay | ' +
        (sum.lastRun.failed === 0 ? '✓ all passed' : '✗ ' + sum.lastRun.failed + ' failed') +
        ' (' + sum.lastRun.passed + '/' + sum.lastRun.total + ')' +
        (sum.lastRun.at ? ' · ' + sum.lastRun.at : '') +
        ' |'
    );
  }
  out.push('');
  out.push('## What happens');
  out.push('');
  for (const r of narrative.rows) {
    const mark = r.result === 'failed' ? ' **✗ FAILED**' : r.result === 'ok' ? ' ✓' : '';
    out.push(
      (r.n + '. ') + (r.at ? '`' + r.at + '` ' : '') + '**' + r.verb + '** ' + r.detail + mark
    );
    if (r.error) out.push('    - error: ' + r.error);
    if (r.actual) out.push('    - actual: `' + truncate(r.actual, 120) + '`');
  }
  out.push('');
  if (narrative.rows.some((r) => r.result === 'failed')) {
    out.push('## Failures');
    out.push('');
    for (const r of narrative.rows.filter((x) => x.result === 'failed')) {
      out.push('- **Step ' + r.n + '** (' + r.verb + ' ' + r.detail + ') — ' + (r.error || 'failed'));
    }
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('Replay this journey in Chrome AI OS, or hand this file to an agent as a repro.');
  out.push('');
  return out.join('\n');
}

// ---- html (for print → PDF) -------------------------------------------------------
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toRecordingHtml(recording, lastRun) {
  const narrative = buildNarrative(recording, lastRun);
  const sum = summarise(recording, lastRun, narrative);
  const rows = narrative.rows
    .map(
      (r) => `<tr class="${r.result === 'failed' ? 'failed' : ''}">
      <td class="n">${r.n}</td>
      <td class="at">${esc(r.at)}</td>
      <td class="what"><b>${esc(r.verb)}</b> ${esc(r.detail)}${
        r.error ? `<div class="err">error: ${esc(r.error)}</div>` : ''
      }${r.actual ? `<div class="act">actual: <code>${esc(truncate(r.actual, 160))}</code></div>` : ''}</td>
      <td class="res">${r.result === 'failed' ? '✗' : r.result === 'ok' ? '✓' : ''}</td>
    </tr>`
    )
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(sum.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #14161c; margin: 0; padding: 28px 32px; }
  h1 { font-size: 21px; margin: 0 0 2px; }
  .sub { color: #667; margin-bottom: 16px; }
  .meta { border: 1px solid #dde; border-radius: 8px; padding: 10px 12px; margin-bottom: 18px; }
  .meta div { display: flex; gap: 8px; padding: 2px 0; }
  .meta b { min-width: 92px; color: #667; font-weight: 600; }
  .pass { color: #0a7d46; font-weight: 700; }
  .fail { color: #b3261e; font-weight: 700; }
  h2 { font-size: 14px; margin: 18px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  td { border-top: 1px solid #e8e8ef; padding: 6px 6px; vertical-align: top; page-break-inside: avoid; }
  td.n { width: 26px; color: #99a; text-align: right; }
  td.at { width: 62px; color: #99a; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  td.res { width: 20px; text-align: center; font-weight: 700; }
  tr.failed td { background: #fff5f5; }
  tr.failed td.res { color: #b3261e; }
  .err { color: #b3261e; margin-top: 2px; }
  .act { color: #667; margin-top: 2px; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .foot { margin-top: 18px; color: #99a; font-size: 11px; }
</style></head>
<body>
  <h1>${esc(sum.name)}</h1>
  <div class="sub">Recorded journey — ${sum.stepCount} steps, ${durationLabel(sum.duration)}</div>
  <div class="meta">
    <div><b>Start URL</b> <span>${esc(sum.startUrl || '—')}</span></div>
    <div><b>Recorded</b> <span>${esc(sum.createdAt || '—')}</span></div>
    <div><b>Steps</b> <span>${esc(
      Object.keys(sum.counts)
        .map((k) => sum.counts[k] + ' × ' + k)
        .join(', ')
    )}</span></div>
    ${
      sum.lastRun
        ? `<div><b>Last replay</b> <span class="${sum.lastRun.failed === 0 ? 'pass' : 'fail'}">${
            sum.lastRun.failed === 0 ? '✓ all passed' : '✗ ' + sum.lastRun.failed + ' failed'
          }</span> <span>(${sum.lastRun.passed}/${sum.lastRun.total})${sum.lastRun.at ? ' · ' + esc(sum.lastRun.at) : ''}</span></div>`
        : ''
    }
  </div>
  <h2>What happens</h2>
  <table>${rows}</table>
  <div class="foot">Exported from Chrome AI OS · ${new Date().toISOString()}</div>
</body></html>`;
}

module.exports = { toRecordingMarkdown, toRecordingHtml, buildNarrative };
