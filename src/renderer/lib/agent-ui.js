// Shared vocabulary for the Agent Runs UI: state metadata (label + icon + tone —
// never colour alone), a few formatters, and the one function that decides what
// verdict the UI is allowed to *display*.
//
// Nothing here talks to the runtime. The run state shown to a person is only ever
// a projection of what the broker persisted (RunDTO / journal events); this file
// can downgrade a claim ("passed" with incomplete evidence is shown as unknown)
// but can never upgrade one.

const SVG_PATHS = {
  passed: 'M20 6L9 17l-5-5',
  failed: 'M18 6L6 18M6 6l12 12',
  cancelled: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  timedOut: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  skipped: 'M5 5l8 7-8 7zM17 5v14',
  unknown: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17h.01',
  pending: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h.01M12 12h.01M16 12h.01',
  running: 'M5 3l14 9-14 9z',
  approval: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM12 8v4M12 16h.01',
  human: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  agent: 'M4 8h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 4v4M9 13h.01M15 13h.01M2 13h2M20 13h2',
  quarantine: 'M12 2L2 7v6c0 5 4 8 10 9 6-1 10-4 10-9V7zM9 9l6 6M15 9l-6 6',
  warn: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  link: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  back: 'M15 18l-6-6 6-6',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  note: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
  gap: 'M4 6h5M15 6h5M4 12h3M17 12h3M4 18h5M15 18h5',
};

export function agentIcon(name, size = 14) {
  const d = SVG_PATHS[name] || SVG_PATHS.unknown;
  const paths = d.split('M').filter(Boolean).map((seg) => `<path d="M${seg}"/>`).join('');
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

// ---- verdicts / step results -------------------------------------------------
// The six outcomes the review UI is allowed to name, plus "pending" for a run
// that has not finished. Text AND icon AND tone; tone is decoration only.
export const OUTCOMES = {
  passed: { label: 'Passed', icon: 'passed', tone: 'good' },
  failed: { label: 'Failed', icon: 'failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', icon: 'cancelled', tone: 'neutral' },
  timedOut: { label: 'Timed out', icon: 'timedOut', tone: 'warn' },
  skipped: { label: 'Skipped', icon: 'skipped', tone: 'neutral' },
  unknown: { label: 'Unknown', icon: 'unknown', tone: 'warn' },
  pending: { label: 'Pending', icon: 'pending', tone: 'neutral' },
};

export function outcomeMeta(key) {
  return OUTCOMES[key] || OUTCOMES.unknown;
}

// ---- lifecycle states --------------------------------------------------------
export const RUN_STATES = {
  queued: { label: 'Queued', icon: 'pending', tone: 'neutral', group: 'active', verdict: 'pending' },
  running: { label: 'Running', icon: 'running', tone: 'accent', group: 'active', verdict: 'pending' },
  needsApproval: { label: 'Needs approval', icon: 'approval', tone: 'warn', group: 'needsInput', verdict: 'pending' },
  needsHuman: { label: 'Needs you', icon: 'human', tone: 'warn', group: 'needsInput', verdict: 'pending' },
  passed: { label: 'Passed', icon: 'passed', tone: 'good', group: 'completed', verdict: 'passed' },
  failed: { label: 'Failed', icon: 'failed', tone: 'bad', group: 'completed', verdict: 'failed' },
  cancelled: { label: 'Cancelled', icon: 'cancelled', tone: 'neutral', group: 'completed', verdict: 'cancelled' },
  timedOut: { label: 'Timed out', icon: 'timedOut', tone: 'warn', group: 'completed', verdict: 'timedOut' },
  // uncertain / interrupted always read as "unknown" and always need a person.
  uncertain: { label: 'Outcome uncertain', icon: 'unknown', tone: 'warn', group: 'needsInput', verdict: 'unknown' },
  interrupted: { label: 'Interrupted', icon: 'warn', tone: 'warn', group: 'needsInput', verdict: 'unknown' },
};

export const UNKNOWN_STATE = { label: 'Unknown state', icon: 'unknown', tone: 'warn', group: 'needsInput', verdict: 'unknown' };

export function runStateMeta(state) {
  return RUN_STATES[state] || UNKNOWN_STATE;
}

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'needsInput', label: 'Needs input' },
  { id: 'completed', label: 'Completed' },
];

export function runGroup(run) {
  return runStateMeta(run && run.state).group;
}

// What verdict may the UI show for this run snapshot?
//   * a run that is not finished is "pending", whatever the verdict field says;
//   * uncertain / interrupted is "unknown";
//   * "passed" is shown only if the counters prove it (every planned step passed,
//     every required assertion passed, evidence complete, no uncertain effect).
//     Otherwise the UI says "unknown" and flags the report as inconsistent —
//     the same refusal the CLI makes. We never *add* a pass.
export function displayVerdict(dto) {
  if (!dto || typeof dto !== 'object') return { verdict: 'unknown', inconsistent: false, reason: 'No run report received yet.' };
  const meta = runStateMeta(dto.state);
  if (meta.verdict === 'pending') return { verdict: 'pending', inconsistent: false, reason: '' };
  if (dto.state === 'uncertain' || dto.state === 'interrupted') {
    return { verdict: 'unknown', inconsistent: false, reason: dto.state === 'uncertain' ? 'A step was dispatched and its effect could not be confirmed.' : 'The runtime stopped mid-run. Nothing is replayed automatically.' };
  }
  const claimed = dto.verdict;
  if (claimed === 'pending') return { verdict: 'unknown', inconsistent: true, reason: 'The run finished but its report still says pending.' };
  if (claimed === 'passed' || dto.state === 'passed') {
    const n = (k) => (Number.isFinite(dto[k]) ? dto[k] : NaN);
    const proven = claimed === 'passed' && dto.state === 'passed'
      && n('planned') > 0 && n('passed') === n('planned')
      && n('failed') === 0 && n('skipped') === 0 && n('cancelled') === 0
      && n('timedOut') === 0 && n('unknown') === 0 && n('pending') === 0
      && dto.evidenceComplete === true && dto.uncertainEffect === false
      && n('requiredAssertions') > 0 && n('passedAssertions') === n('requiredAssertions');
    if (!proven) return { verdict: 'unknown', inconsistent: true, reason: 'Reported as passed, but the report does not prove it (incomplete evidence, skipped steps or an unchecked assertion).' };
    return { verdict: 'passed', inconsistent: false, reason: '' };
  }
  if (OUTCOMES[claimed] && claimed !== 'pending') return { verdict: claimed, inconsistent: false, reason: '' };
  return { verdict: 'unknown', inconsistent: false, reason: 'The report did not contain a recognised verdict.' };
}

// ---- owner / controller ------------------------------------------------------
export const CONTROLLERS = {
  agent: { label: 'Agent control', icon: 'agent', tone: 'accent' },
  'handoff-pending': { label: 'Handing over…', icon: 'pause', tone: 'warn' },
  human: { label: 'Human control', icon: 'human', tone: 'good' },
  quarantined: { label: 'Quarantined', icon: 'quarantine', tone: 'bad' },
};

export function controllerMeta(controller) {
  return CONTROLLERS[controller] || { label: 'Control unknown', icon: 'unknown', tone: 'warn' };
}

export const ADAPTERS = {
  headless: 'Headless',
  headed: 'Headed',
  visible: 'Headed',
  attached: 'Attached',
  'electron-embedded': 'Embedded',
  playwright: 'Playwright',
};

export function adapterLabel(owner) {
  if (!owner) return 'Adapter unknown';
  const mode = ADAPTERS[owner.mode] || owner.mode || '';
  const driver = ADAPTERS[owner.driver] || owner.driver || '';
  return [mode, driver].filter(Boolean).join(' · ') || 'Adapter unknown';
}

// ---- formatting --------------------------------------------------------------
export function originOf(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'file://' : u.origin;
  } catch (_e) {
    return '';
  }
}

export function clockTime(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function shortId(id, keep = 10) {
  const s = String(id == null ? '' : id);
  return s.length > keep + 1 ? s.slice(0, keep) + '…' : s;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

// Only inline raster data URLs are ever put in an <img>; a preview that is not
// one is dropped rather than handed to the browser to resolve.
export function safeImageSrc(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length < 6_000_000 ? src : '';
}

// A broker error DTO -> a sentence a person can act on.
export function describeError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code || '';
  const base = typeof err.message === 'string' && err.message ? err.message : 'The runtime reported an error.';
  const tail = [];
  if (err.effectUnknown) tail.push('The effect of the last action is unknown.');
  if (err.dispatched && !err.effectUnknown) tail.push('The action was dispatched.');
  return [code ? `${code}: ${base}` : base, ...tail].join(' ');
}
