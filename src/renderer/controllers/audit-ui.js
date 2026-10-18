// Pure helpers that translate app/tab state into the identity objects the Audit
// panel compares (see components/audit-panel.js: setReport(report, ctx),
// setCurrentContext(ctx)). Kept DOM-free so it can be unit tested.

// The audited page, from audit-controller's `source` ({tabId,url,title,viewport,at,...}).
// documentId is intentionally NOT sent: a reload of the same URL is still the same page.
export function reportContextFromSource(source) {
  if (!source) return null;
  const ctx = { url: source.url || '', viewport: source.viewport || null };
  if (source.tabId != null) ctx.tabId = source.tabId;
  if (source.title != null) ctx.title = source.title;
  if (source.at != null) ctx.at = source.at;
  return ctx;
}

// What the user is looking at now (the active tab). The viewport is context for
// display only; the panel's staleness test compares tab and URL.
export function currentContextFromTab(tab, viewport) {
  if (!tab) return null;
  return { url: tab.url || '', tabId: tab.id, viewport: viewport || null };
}
