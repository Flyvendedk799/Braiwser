// Replay scheduler. Pure orchestration over an injected driver (see
// replay-driver.js) so every outcome path is unit-testable with fakes.
//
// Guarantees:
//  - the report's `total` is the number of PLANNED steps; steps that never ran
//    are reported as skipped/cancelled, never silently dropped;
//  - a navigation is only a pass if the driver says `ready`;
//  - cancel settles any in-flight waiter immediately (the driver listens to the
//    same AbortSignal) and ends the run with terminal 'cancelled';
//  - a failed/timed-out navigation or an unresponsive guest stops the run
//    (later steps would act on the wrong page); ordinary step failures
//    (missing element, failed assertion) do not.
import { buildReplayReport, stepLabel, stepTarget } from './run-report.js';

// String comparison shared with the replay engine's assert ops.
export function compareStr(op, actual, expected) {
  const a = String(actual == null ? '' : actual);
  const e = String(expected == null ? '' : expected);
  if (op === 'equals') return a === e;
  if (op === 'matches') { try { return new RegExp(e).test(a); } catch (_err) { return false; } }
  return a.toLowerCase().includes(e.toLowerCase());
}

function parseStepTs(step) {
  if (!step || !step.ts) return NaN;
  if (typeof step.ts === 'number') return step.ts;
  const ms = Date.parse(step.ts);
  return Number.isFinite(ms) ? ms : NaN;
}

// Inter-step pause. Prefer the real gaps captured at record time so the film
// matches what the reviewer did; fall back to settings.replayDelayMs.
// `fast` (e2e / delay < 100) keeps the fixed short pause so the suite stays snappy.
export function pauseAfterStep(prev, next, { baseDelay, forVideo, fast }) {
  if (fast) return Math.max(0, baseDelay);
  const floor = forVideo ? Math.max(baseDelay, 900) : Math.max(baseDelay, 450);
  const ceiling = forVideo ? 3500 : 2500;
  const a = parseStepTs(prev);
  const b = parseStepTs(next);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return floor;
  return Math.max(floor, Math.min(ceiling, b - a));
}

// A sleep that ends early when the signal aborts.
export function abortableSleep(ms, signal, timers = { setTimeout, clearTimeout }) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    const t = timers.setTimeout(done, ms);
    function done() { timers.clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

export async function runReplay({
  steps, driver, signal, baseDelay = 600, forVideo = false, fast = false,
  navTimeoutMs = 8000, sleep = abortableSleep, onProgress, extra = {},
  stepOptions = {}, // passed to the guest: secrets, actionTimeoutMs, allowSuggested
}) {
  const planned = Array.isArray(steps) ? steps : [];
  const results = [];
  let terminal = 'completed';
  const cancelled = () => !!(signal && signal.aborted);

  for (let i = 0; i < planned.length; i++) {
    if (cancelled()) { terminal = 'cancelled'; break; }
    const step = planned[i];
    if (onProgress) onProgress({ i, total: planned.length });
    const row = { i, type: stepLabel(step), selector: stepTarget(step), status: 'failed', error: '', actual: undefined };
    let stop = false;

    if (step.type === 'navigate') {
      const nav = await driver.navigate(step.url, { signal, timeoutMs: navTimeoutMs });
      if (nav.outcome === 'ready') row.status = 'passed';
      else if (nav.outcome === 'cancelled') { row.status = 'cancelled'; row.error = 'cancelled'; stop = true; }
      else if (nav.outcome === 'timeout') { row.status = 'timedOut'; row.error = `navigation to ${step.url} timed out`; stop = true; }
      else { row.status = 'failed'; row.error = nav.error || `navigation to ${step.url} failed`; stop = true; }
    } else if (step.type === 'assert' && step.kind === 'url') {
      // URL assertions are evaluated host-side against the live location of the
      // replay's own page (never the active tab).
      const url = driver.currentUrl() || '';
      const ok = compareStr(step.op || 'contains', url, step.expected);
      row.status = ok ? 'passed' : 'failed';
      row.actual = url;
      row.error = ok ? '' : `url "${url.slice(0, 48)}" ${step.op || 'contains'} "${step.expected}" failed`;
    } else {
      const res = await driver.step(step, i, { fast, forVideo, ...stepOptions }, { signal });
      row.actual = res.actual;
      row.error = res.error || '';
      if (res.effect) row.effect = res.effect; // guest's own claim: confirmed | observed | dispatchOnly | none
      if (res.reason) row.reason = res.reason;
      if (res.cancelled) { row.status = 'cancelled'; stop = true; }
      else if (res.timedOut) { row.status = 'timedOut'; stop = true; }
      else if (res.ok && res.status === 'skipped') row.status = 'skipped';
      else if (res.ok) row.status = 'passed';
      else { row.status = 'failed'; if (res.dispatched === false) row.dispatched = false; }
    }
    results.push(row);
    if (row.status === 'cancelled') { terminal = 'cancelled'; break; }
    if (stop) break;
    if (cancelled()) { terminal = 'cancelled'; break; }
    const next = planned[i + 1];
    if (next) await sleep(pauseAfterStep(step, next, { baseDelay, forVideo, fast }), signal);
    else if (forVideo) await sleep(Math.max(baseDelay, 700), signal);
  }
  if (terminal === 'completed' && cancelled() && results.length < planned.length) terminal = 'cancelled';
  return buildReplayReport({ steps: planned, results, terminal, extra });
}
