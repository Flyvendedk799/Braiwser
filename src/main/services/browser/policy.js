// Policy engine for the agent browser runtime: grants, destination checks,
// action classification, secret-field rules, budgets and one-use approvals.
//
// Principles (audit "Security boundary and authorization design"):
//   - A grant binds principal + project/session/profile + destinations + tool
//     classes + expiry + budgets. Page content, skills and request fields can
//     never widen one. A non-UI principal only gets the INTERSECTION of what it
//     requests and what its scopes allow.
//   - Default deny: file:, local/private network, credentials-in-URL, every
//     scheme except http(s), about:blank. Private/local hosts need the grant to
//     name the exact origin (host AND port); file: needs a canonical root
//     (realpath + symlink check).
//   - checkDestination is a NAVIGATION-ONLY check unless the driver advertises
//     capabilities.requestInterception and installs requestFilter(); redirects,
//     subresources, frames, workers and websockets are not covered otherwise.
//   - Approvals are server-held, one-use capabilities bound to {principal, run,
//     session, page, documentEpoch, action digest, destination, expiry}. Only a
//     `ui` principal can decide. Headless clients get approval_required.
//   - Unknown write-like actions fail closed.
'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const C = require('../../../shared/browser-contracts');
const { redactUrl, redactText } = require('../../../shared/browser-redact');

const DEFAULT_BUDGETS = Object.freeze({ maxActions: 500, maxObservations: 2000, maxNavigations: 100, maxDurationMs: 300000, maxArtifactBytes: 64 * 1024 * 1024 });
const DEFAULT_GRANT_TTL_MS = 8 * 3600 * 1000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVALS = 200;

const SECRET_TRAITS = new Set(['password', 'otp', 'one-time-code', 'payment', 'secret', 'cc-number', 'cc-csc', 'cc-exp', 'credit-card', 'current-password', 'new-password']);
const SECRET_NAME = /pass(?:word|wd|code|phrase)|\bpwd\b|\botp\b|one[-_ ]?time|verification code|security code|\bcvv\b|\bcvc\b|\bcsc\b|card[-_ ]?(?:number|no)\b|credit card|\bssn\b|\bpin\b|adgangskode|kodeord|kortnummer/i;
const WRITE_NAME = /\b(submit|send|pay|purchase|buy|order|checkout|delete|remove|destroy|erase|confirm|publish|post|transfer|book|reserve|subscribe|unsubscribe|sign\s?(?:up|in|out)?|log\s?(?:in|out)|save|apply|approve|place|donate|withdraw|invite|share|accept|agree|k[øo]b|slet|betal|bekr[æa]ft|indsend|gem|opret)\b/i;
const WRITE_TRAITS = new Set(['submit', 'destructive', 'write', 'form-submit']);

const denied = (message, detail, extra) => C.brokerError('DENIED', message, { detail, retry: 'never', extra });

// ---- host classification ------------------------------------------------------
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}
function privateV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}
function parseIPv6(host) {
  let h = host.replace(/^\[|\]$/g, '').split('%')[0];
  if (!h.includes(':')) return null;
  const dbl = h.indexOf('::');
  if (dbl !== h.lastIndexOf('::')) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  let head = toGroups(dbl === -1 ? h : h.slice(0, dbl));
  let tail = dbl === -1 ? [] : toGroups(h.slice(dbl + 2));
  const expandV4 = (g) => {
    if (g.length && g[g.length - 1].includes('.')) {
      const v4 = parseIPv4(g[g.length - 1]);
      if (!v4) return null;
      return [...g.slice(0, -1), ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)];
    }
    return g;
  };
  head = expandV4(head); tail = expandV4(tail);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (dbl === -1 ? head.length !== 8 : fill < 1) return null;
  const all = dbl === -1 ? head : [...head, ...Array(fill).fill('0'), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}
function isPrivateHost(rawHost) {
  const host = String(rawHost).toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const v4 = parseIPv4(host);
  if (v4) return privateV4(v4);
  const v6 = parseIPv6(host);
  if (v6) {
    const [a, b, c, d, e, f, g, h] = v6;
    if (v6.every((x) => x === 0) || (v6.slice(0, 7).every((x) => x === 0) && h === 1)) return true;
    if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) return true;
    const embedded = (hi, lo) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return embedded(g, h); // ::ffff:a.b.c.d
    if (a === 0x64 && b === 0xff9b) return embedded(g, h); // NAT64
    if (a === 0x2002) return embedded(b, c); // 6to4
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes('.')) return true; // bare intranet-style names
  return /\.(local|internal|lan|intranet|corp|home|home\.arpa|localdomain)$/.test(host) || host === 'metadata.google.internal';
}

// ---- origin grammar ----------------------------------------------------------------
const WILDCARD = /^(https?):\/\/\*\.([a-z0-9.-]+)(?::(\d{1,5}))?$/i;
// `https://*` names every PUBLIC host of that scheme. Private, loopback and bare intranet hosts stay
// reachable only through an exact entry, exactly as with any other wildcard.
const ANY_PUBLIC = /^(https?):\/\/\*$/i;
function normalizeOrigin(entry) {
  const any = ANY_PUBLIC.exec(entry);
  if (any) return { wildcard: true, any: true, protocol: `${any[1].toLowerCase()}:`, host: '*', port: '' };
  const w = WILDCARD.exec(entry);
  if (w) {
    const host = w[2].toLowerCase();
    if (!host.includes('.') || isPrivateHost(host)) return null; // wildcards never cover private/bare hosts
    return { wildcard: true, protocol: `${w[1].toLowerCase()}:`, host, port: w[3] || '' };
  }
  let u;
  try { u = new URL(entry); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  return { wildcard: false, origin: u.origin, hostname: u.hostname };
}
function originCovered(entry, request) {
  // `entry` is a normalised ceiling/grant origin, `request` a normalised requested one.
  if (!entry.wildcard) return !request.wildcard && entry.origin === request.origin;
  if (request.wildcard) return entry.protocol === request.protocol && (entry.any || (entry.host === request.host && entry.port === request.port));
  const u = new URL(request.origin);
  if (entry.any) return u.protocol === entry.protocol && !isPrivateHost(u.hostname);
  return u.protocol === entry.protocol && u.hostname.endsWith('.' + entry.host) && (entry.port ? u.port === entry.port : true);
}

const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (child, root) => { const c = lc(child); const r = lc(root); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

function createPolicy({ clock = { now: () => Date.now() }, fs = nodeFs, lookup, approvalTtlMs = DEFAULT_APPROVAL_TTL_MS, defaultBudgets = DEFAULT_BUDGETS, ceilingFor } = {}) {
  const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
  const approvals = new Map();
  const budgetStates = new Map();
  const revoked = new Set();

  // ---- ceilings: what a principal may ever be granted ------------------------------
  function ceiling(principal) {
    if (ceilingFor) return ceilingFor(principal);
    if (principal.kind === 'ui') return { unlimited: true };
    const c = { classes: new Set(), origins: [], roots: [], projects: new Set(), profiles: new Set(), expires: null, budgets: {} };
    for (const s of principal.scopes) {
      const i = s.indexOf(':');
      const kind = s.slice(0, i); const val = s.slice(i + 1);
      if (kind === 'class' && C.TOOL_CLASSES.includes(val)) c.classes.add(val);
      else if (kind === 'origin') { const o = normalizeOrigin(val); if (o) c.origins.push(o); }
      else if (kind === 'root') c.roots.push(val);
      else if (kind === 'project') c.projects.add(val);
      else if (kind === 'profile') c.profiles.add(val);
      else if (kind === 'expires' && !Number.isNaN(Date.parse(val))) c.expires = c.expires === null ? Date.parse(val) : Math.min(c.expires, Date.parse(val));
      else if (kind === 'budget') { const m = /^(\w+)=(\d+)$/.exec(val); if (m) c.budgets[m[1]] = Number(m[2]); }
    }
    return c;
  }

  function canonicalRoot(root) {
    if (!path.isAbsolute(root)) throw denied('allowedRoots entries must be absolute paths', 'BAD_ROOT');
    try { return realpath(root); } catch { throw denied('allowed root does not exist', 'BAD_ROOT'); }
  }

  // Builds the EFFECTIVE grant. Requested scope outside the principal's ceiling
  // is dropped (never widened); an empty effective class set is a denial.
  function createGrant(request, principal, { sessionId } = {}) {
    const req = C.validateGrantRequest(request);
    const cap = ceiling(principal);
    const now = clock.now();
    let classes; let origins; let roots; let expires; const budgets = {}; let projectId; let profile;
    if (cap.unlimited) {
      classes = req.toolClasses.length ? req.toolClasses : ['observe', 'navigate', 'interact'];
      origins = req.allowedOrigins; roots = req.allowedRoots;
      expires = req.expiresAt ? Date.parse(req.expiresAt) : now + DEFAULT_GRANT_TTL_MS;
      projectId = req.projectId; profile = req.profile;
    } else {
      classes = (req.toolClasses.length ? req.toolClasses : [...cap.classes]).filter((c) => cap.classes.has(c));
      origins = [];
      for (const o of req.allowedOrigins) {
        const n = normalizeOrigin(o);
        if (!n) throw denied('invalid origin in grant request', 'BAD_ORIGIN');
        if (cap.origins.some((e) => originCovered(e, n))) origins.push(o);
      }
      if (!req.allowedOrigins.length) origins = cap.origins.filter((e) => !e.wildcard).map((e) => e.origin);
      const capRoots = cap.roots.map((r) => { try { return canonicalRoot(r); } catch { return null; } }).filter(Boolean);
      roots = (req.allowedRoots.length ? req.allowedRoots : capRoots).filter((r) => { try { const real = canonicalRoot(r); return capRoots.some((cr) => within(real, cr)); } catch { return false; } });
      expires = req.expiresAt ? Date.parse(req.expiresAt) : now + DEFAULT_GRANT_TTL_MS;
      if (cap.expires !== null) expires = Math.min(expires, cap.expires);
      if (cap.projects.size && !(req.projectId && cap.projects.has(req.projectId))) projectId = undefined;
      else projectId = req.projectId;
      if (cap.profiles.size && !(req.profile && cap.profiles.has(req.profile))) profile = undefined;
      else profile = req.profile;
      if ((cap.projects.size && projectId === undefined) || (cap.profiles.size && profile === undefined)) throw denied('project/profile is outside the principal scope', 'SCOPE');
      for (const [k, v] of Object.entries(cap.budgets)) budgets[k] = v;
    }
    if (!classes.length) throw denied('principal has no scope for the requested tool classes', 'SCOPE');
    if (expires <= now) throw denied('grant already expired', 'EXPIRED');
    for (const [k, v] of Object.entries(req.budgets)) budgets[k] = budgets[k] === undefined ? v : Math.min(budgets[k], v);
    for (const o of origins) if (!normalizeOrigin(o)) throw denied('invalid origin in grant', 'BAD_ORIGIN');
    const grant = C.freezeDeep({
      grantId: C.newId('grant'), principalId: principal.id, sessionId: sessionId || null, projectId: projectId || null, profile: profile || null,
      allowedOrigins: [...new Set(origins)], allowedRoots: [...new Set(roots.map(canonicalRoot))], toolClasses: [...new Set(classes)],
      expiresAt: expires, createdAt: now, budgets: { ...defaultBudgets, ...budgets },
      // Fixtures skip approval for write-like actions; only a ui principal can request one.
      trustedFixture: req.trustedFixture === true && principal.kind === 'ui',
    });
    budgetStates.set(grant.grantId, { actions: 0, observations: 0, navigations: 0, artifactBytes: 0 });
    return grant;
  }

  function assertActive(grant, principal) {
    if (!grant || grant.principalId !== principal.id) throw denied('grant does not belong to this principal', 'GRANT_PRINCIPAL');
    if (revoked.has(grant.grantId) || clock.now() >= grant.expiresAt) throw denied('grant expired or revoked', 'GRANT_EXPIRED');
  }
  function assertClass(grant, toolClass) {
    if (!C.TOOL_CLASSES.includes(toolClass)) throw denied('unknown tool class', 'UNKNOWN_CLASS');
    if (!grant.toolClasses.includes(toolClass)) throw denied(`tool class '${toolClass}' is not granted`, 'CLASS_NOT_GRANTED');
  }

  // ---- budgets ---------------------------------------------------------------------
  const BUDGET_KEY = { actions: 'maxActions', observations: 'maxObservations', navigations: 'maxNavigations', artifactBytes: 'maxArtifactBytes' };
  function spend(grant, what, n = 1) {
    const st = budgetStates.get(grant.grantId);
    const limit = grant.budgets[BUDGET_KEY[what]];
    if (!st || limit === undefined) throw denied('unknown budget', 'BUDGET');
    if (st[what] + n > limit) throw denied(`budget exhausted: ${what}`, 'BUDGET_EXHAUSTED');
    st[what] += n;
  }
  const budgetUsage = (grant) => ({ ...(budgetStates.get(grant.grantId) || {}) });

  // ---- destinations (navigation-only) ------------------------------------------------
  function checkDestination(grant, rawUrl) {
    const no = (reason) => ({ allowed: false, reason, url: redactUrl(String(rawUrl).slice(0, 2048)) || '[invalid]' });
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return no('invalid_url');
    let u;
    try { u = new URL(rawUrl); } catch { return no('invalid_url'); }
    if (u.username || u.password) return no('credentials_in_url');
    if (u.protocol === 'about:') return rawUrl === 'about:blank' ? { allowed: true, reason: 'blank', origin: 'null', url: 'about:blank' } : no('scheme_not_allowed');
    if (u.protocol === 'file:') {
      if (!grant.allowedRoots.length) return no('file_denied');
      if (u.hostname && u.hostname !== 'localhost') return no('file_unc_denied');
      let real;
      try { real = realpath(fileURLToPath(u)); } catch { return no('file_unresolvable'); }
      return grant.allowedRoots.some((r) => within(real, r)) ? { allowed: true, reason: 'root', origin: 'file://', url: redactUrl(rawUrl) } : no('file_outside_roots');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('scheme_not_allowed');
    const entries = grant.allowedOrigins.map(normalizeOrigin).filter(Boolean);
    const request = { wildcard: false, origin: u.origin };
    if (isPrivateHost(u.hostname)) {
      // Local/private targets only by an EXACT entry naming host and port.
      return entries.some((e) => !e.wildcard && e.origin === u.origin) ? { allowed: true, reason: 'private_named', origin: u.origin, url: redactUrl(rawUrl) } : no('private_network_denied');
    }
    return entries.some((e) => originCovered(e, request)) ? { allowed: true, reason: 'origin', origin: u.origin, url: redactUrl(rawUrl) } : no('origin_not_granted');
  }

  // DNS-aware variant: a public name that resolves to a private address is
  // refused unless the grant names the origin. Still navigation-time only.
  async function checkDestinationResolved(grant, rawUrl) {
    const base = checkDestination(grant, rawUrl);
    if (!base.allowed || !/^https?:/.test(rawUrl) || base.reason === 'private_named') return base;
    const resolver = lookup || ((h) => require('node:dns').promises.lookup(h, { all: true }));
    try {
      const addrs = await resolver(new URL(rawUrl).hostname);
      if (addrs.some((a) => isPrivateHost(a.address))) return { allowed: false, reason: 'resolves_to_private_network', url: base.url };
    } catch { return { allowed: false, reason: 'dns_failure', url: base.url }; }
    return base;
  }

  // Hook for drivers that CAN intercept every request (capabilities.requestInterception).
  const requestFilter = (grant) => (url) => (checkDestination(grant, url).allowed ? 'allow' : 'block');

  // ---- actions ---------------------------------------------------------------------------
  const traitSet = (t) => new Set((t && Array.isArray(t.traits) ? t.traits : []).map((x) => String(x).toLowerCase()));
  function isSecretTarget(target = {}) {
    const traits = traitSet(target);
    for (const t of traits) { if (SECRET_TRAITS.has(t) || (t.startsWith('autocomplete:') && SECRET_TRAITS.has(t.slice(13)))) return true; }
    return SECRET_NAME.test(String(target.name || '')) || target.secret === true;
  }
  function classifyAction(action, target = {}) {
    if (!C.ACTION_KINDS.includes(action && action.kind)) return { toolClass: null, writeLike: true, unknown: true };
    const traits = traitSet(target);
    if (action.kind === 'navigate') return { toolClass: 'navigate', writeLike: false };
    // Emulated viewport: changes layout/media-query state of the page but dispatches no page input and has no external effect.
    if (action.kind === 'setViewport') return { toolClass: 'interact', writeLike: false };
    if (traits.has('file-input')) return { toolClass: 'upload', writeLike: true };
    let writeLike = [...traits].some((t) => WRITE_TRAITS.has(t));
    if (action.kind === 'click' && WRITE_NAME.test(String(target.name || ''))) writeLike = true;
    if (action.kind === 'press' && action.key === 'Enter') writeLike = true; // may submit a form
    return { toolClass: writeLike ? 'submit' : 'interact', writeLike };
  }
  // Single decision point. Throws on denial; returns {toolClass, needsApproval}.
  function authorizeAction({ grant, principal, action, target, headless = true }) {
    assertActive(grant, principal);
    const cls = classifyAction(action, target);
    if (cls.unknown) throw C.brokerError('UNSUPPORTED', 'unknown action fails closed', { detail: 'UNKNOWN_ACTION' });
    if (cls.toolClass === 'upload') throw C.brokerError('UNSUPPORTED', 'file inputs are not supported (no native picker)', { detail: 'UPLOAD_UNSUPPORTED' });
    if (action.kind === 'fill' && isSecretTarget(target)) throw denied('fill into password/OTP/payment fields is refused; use takeover', 'SECRET_FIELD');
    assertClass(grant, cls.toolClass);
    if (cls.toolClass === 'submit') assertClass(grant, 'interact');
    return { toolClass: cls.toolClass, writeLike: cls.writeLike, needsApproval: cls.writeLike && !grant.trustedFixture, headless };
  }

  // ---- approvals ---------------------------------------------------------------------------
  function purgeApprovals() {
    const now = clock.now();
    for (const [id, a] of approvals) if (now > a.expiresAt + 60000 || (a.status === 'used' && now > a.usedAt + 60000)) approvals.delete(id);
    while (approvals.size > MAX_APPROVALS) approvals.delete(approvals.keys().next().value);
  }
  const BIND_FIELDS = ['principalId', 'runId', 'sessionId', 'pageId', 'documentEpoch', 'digest', 'destination'];
  function requestApproval(bound, summary = {}) {
    purgeApprovals();
    for (const f of BIND_FIELDS) if (bound[f] === undefined) bound = { ...bound, [f]: null };
    const approvalId = crypto.randomBytes(18).toString('base64url').replace(/^/, 'apr_');
    const rec = { approvalId, bound: Object.fromEntries(BIND_FIELDS.map((f) => [f, bound[f]])), status: 'pending', createdAt: clock.now(), expiresAt: clock.now() + approvalTtlMs,
      summary: { action: redactText(String(summary.action || ''), 200), target: redactText(String(summary.target || ''), 120), destination: summary.destination ? redactUrl(summary.destination) || redactText(String(summary.destination), 200) : null, data: redactText(String(summary.data || ''), 200) } };
    approvals.set(approvalId, rec);
    return view(rec);
  }
  const view = (a) => ({ approvalId: a.approvalId, status: a.status, expiresAt: a.expiresAt, principalId: a.bound.principalId, runId: a.bound.runId, sessionId: a.bound.sessionId, pageId: a.bound.pageId, documentEpoch: a.bound.documentEpoch, summary: { ...a.summary } });
  function decide(approvalId, decision, actor) {
    if (!actor || actor.kind !== 'ui') throw denied('only the trusted UI can decide an approval', 'APPROVAL_ACTOR');
    if (decision !== 'allow' && decision !== 'deny') throw C.invalid('decision must be allow|deny');
    const a = approvals.get(approvalId);
    if (!a || a.status !== 'pending') throw denied('approval is not pending', 'APPROVAL_STATE');
    if (clock.now() > a.expiresAt) { a.status = 'expired'; throw denied('approval expired', 'APPROVAL_EXPIRED'); }
    a.status = decision === 'allow' ? 'allowed' : 'denied';
    a.decidedBy = actor.id;
    return view(a);
  }
  // One use. Every bound field must match exactly or the approval stays unused
  // for the legitimate action but this attempt fails.
  function consumeApproval(approvalId, expected) {
    const a = approvals.get(approvalId);
    if (!a) throw denied('unknown approval', 'APPROVAL_UNKNOWN');
    if (a.status !== 'allowed') throw denied(`approval is ${a.status}`, 'APPROVAL_STATE');
    if (clock.now() > a.expiresAt) { a.status = 'expired'; throw denied('approval expired', 'APPROVAL_EXPIRED'); }
    for (const f of BIND_FIELDS) {
      if ((expected[f] === undefined ? null : expected[f]) !== a.bound[f]) throw denied(`approval does not match the action (${f})`, 'APPROVAL_MISMATCH');
    }
    a.status = 'used'; a.usedAt = clock.now();
    return true;
  }
  function approvalState(approvalId) { const a = approvals.get(approvalId); return a ? view(a) : null; }
  function listApprovals({ principal, status = 'pending' }) {
    purgeApprovals();
    return [...approvals.values()].filter((a) => a.status === status && (principal.kind === 'ui' || a.bound.principalId === principal.id)).map(view);
  }
  // Takeover / session close / document change invalidates outstanding approvals.
  function revokeApprovals(match) {
    let n = 0;
    for (const a of approvals.values()) {
      if ((a.status === 'pending' || a.status === 'allowed') && Object.entries(match).every(([k, v]) => a.bound[k] === v)) { a.status = 'revoked'; n++; }
    }
    return n;
  }
  function actionDigest({ action, target, observationId, destination }) {
    return C.sha256({ kind: action.kind, key: action.key, checked: action.checked, value: action.value, text: action.text, url: action.url,
      target: target ? { frameId: target.frameId || null, nodeIdentity: target.nodeIdentity || null, role: target.role || null, name: target.name || null } : null, observationId: observationId || null, destination: destination || null });
  }

  return { createGrant, assertActive, assertClass, spend, budgetUsage, checkDestination, checkDestinationResolved, requestFilter, classifyAction, isSecretTarget, authorizeAction,
    requestApproval, decide, consumeApproval, approvalState, listApprovals, revokeApprovals, actionDigest, revokeGrant: (g) => { revoked.add(g.grantId); } };
}

module.exports = { createPolicy, isPrivateHost, normalizeOrigin, DEFAULT_BUDGETS };
