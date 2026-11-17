// "Locate on page" for notes and audit findings.
//
// A note belongs to the page (URL) it was written on, which is not necessarily
// the page in front. Locating it never fails silently:
//
//   same page             highlight it here
//   open in another tab   bring that tab to the front, then highlight
//   not open anywhere     navigate the front tab to the note's page, then highlight
//   cannot do that        say why (the front tab is mid-replay, the page would
//                         not load, or the element is no longer on the page)
//
// Pure ESM, no DOM and no globals: the host (app.js) supplies the tab lookups,
// navigation, the guest highlight request and the toast; tests supply fakes.

// Decide how to reach the note's page. `tabs`: [{ id, url }] in strip order.
//   { action: 'here' }
//   { action: 'switch', tabId }
//   { action: 'navigate' }
//   { action: 'blocked', reason }
export function planLocate({ noteUrl, activeTabId, tabs = [], busyReason } = {}) {
  const active = tabs.find((t) => t.id === activeTabId) || null;
  if (!noteUrl || (active && active.url === noteUrl)) return { action: 'here' };
  const other = tabs.find((t) => t.id !== activeTabId && t.url === noteUrl);
  if (other) return { action: 'switch', tabId: other.id };
  const reason = typeof busyReason === 'function' ? busyReason(activeTabId) : null;
  if (reason) return { action: 'blocked', reason };
  return { action: 'navigate' };
}

export const LOCATE_MESSAGES = Object.freeze({
  notFound: 'Could not locate that element on the page',
  notFoundAfterOpen: 'Opened that note’s page, but the element is no longer there',
  noSwitch: 'Could not switch to that note’s tab',
  noOpen: 'Could not open that note’s page',
  noFindingTarget: 'This finding has no element to locate',
  staleAudit: 'These findings belong to a different page — run the audit again',
});
const MSG = LOCATE_MESSAGES;

export function createLocator({
  ops, // operation contexts (controllers/operation-context.js)
  getTabs, // () => [{ id, url }]
  setActiveTab, // (tabId) => void
  navigate, // (ctx, url) => Promise<{ outcome: 'ready'|'failed'|'timeout'|'cancelled', error? }>
  highlight, // (webview, target) => Promise<boolean>  true when the guest found it
  busyReason, // (tabId) => string|null  why this tab must not be navigated right now
  auditIsCurrent, // (ctx) => boolean  the tab's audit report still describes ctx's page
  toast,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settleMs = 150,
}) {
  // Resolves with what happened, for callers and tests:
  //   'located' | 'not-found' | 'no-target' | 'no-tab' | 'blocked' | 'switch-failed'
  //   | 'open-failed' | 'stale'
  async function locateAnnotation(a) {
    if (!a || !a.target) return 'no-target';
    let ctx = ops.capture('locate');
    if (!ctx.wv) return 'no-tab';
    const plan = planLocate({ noteUrl: a.url, activeTabId: ctx.tabId, tabs: getTabs(), busyReason });
    let moved = false;
    if (plan.action === 'blocked') { toast(plan.reason, 'warn'); return 'blocked'; }
    if (plan.action === 'switch') {
      setActiveTab(plan.tabId);
      ctx = ops.capture('locate');
      if (!ctx.wv || ctx.tabId !== plan.tabId) { toast(MSG.noSwitch, 'warn'); return 'switch-failed'; }
      moved = true;
    } else if (plan.action === 'navigate') {
      const nav = await navigate(ctx, a.url);
      if (!nav || nav.outcome !== 'ready') {
        const why = nav && nav.outcome === 'timeout' ? ' — it took too long to load' : nav && nav.error ? ` — ${nav.error}` : '';
        toast(MSG.noOpen + why, 'warn');
        return 'open-failed';
      }
      await sleep(settleMs);
      moved = true;
    }
    if (ops.staleReason(ctx)) return 'stale'; // the tab went away meanwhile
    const ok = await highlight(ctx.wv, a.target);
    if (!ok) toast(moved ? MSG.notFoundAfterOpen : MSG.notFound, 'warn');
    return ok ? 'located' : 'not-found';
  }

  // Highlight an arbitrary target descriptor (used by audit findings, which are
  // not annotations but carry the same anchor shape). Audit findings are only
  // located on the page they were found on.
  async function locateTarget(target, { audit = false } = {}) {
    if (!target) { toast(MSG.noFindingTarget, 'warn'); return 'no-target'; }
    const ctx = ops.capture('locate');
    if (!ctx.wv) return 'no-tab';
    if (audit && !auditIsCurrent(ctx)) { toast(MSG.staleAudit, 'warn'); return 'stale'; }
    const ok = await highlight(ctx.wv, target);
    if (!ok) toast(MSG.notFound, 'warn');
    return ok ? 'located' : 'not-found';
  }

  return { locateAnnotation, locateTarget };
}
