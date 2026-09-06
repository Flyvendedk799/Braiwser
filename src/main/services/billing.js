// Seat billing + compliance helpers. Stripe is represented as a portable
// checkout intent; real Stripe keys are env-configured when going live.
const crypto = require('crypto');

function billingStatus(repos) {
  const license = repos.license.get();
  const sync = repos.settings.get().sync || {};
  const ws = sync.workspaceId ? repos.workspaces.get(sync.workspaceId) : null;
  const seats = (license && license.seats) || (ws && ws.members && ws.members.length) || 1;
  return {
    tier: license.tier || 'free',
    seats,
    members: (ws && ws.members) || [],
    customerId: license.customerId || null,
    subscriptionId: license.subscriptionId || null,
  };
}

function createCheckoutIntent(repos, { seats = 3, plan = 'team' } = {}) {
  const intent = {
    id: `cs_${crypto.randomBytes(8).toString('hex')}`,
    plan,
    seats: Math.max(1, Number(seats) || 1),
    url: `https://braiwser.app/checkout?seats=${encodeURIComponent(seats)}&plan=${encodeURIComponent(plan)}`,
    createdAt: new Date().toISOString(),
  };
  repos.auditLog.append('billing.checkout_intent', intent);
  return intent;
}

function applySeatChange(repos, seats) {
  const n = Math.max(1, Number(seats) || 1);
  repos.license.set({ ...repos.license.get(), seats: n });
  repos.auditLog.append('billing.seats', { seats: n });
  return billingStatus(repos);
}

function exportGdprPackage(repos) {
  const settings = repos.settings.get();
  const payload = {
    exportedAt: new Date().toISOString(),
    profile: settings.profile,
    sync: settings.sync,
    projects: repos.projects.list(),
    sessions: repos.sessions.list(),
    annotations: repos.projects.list().flatMap((p) =>
      repos.sessions.list(p.id).flatMap((s) => repos.annotations.bySession(s.id))
    ),
    recordings: repos.projects.list().flatMap((p) => repos.recordings.list(p.id)),
    comments: repos.workspaces.list().length
      ? repos.sessions.list().flatMap((s) => repos.comments.bySession(s.id))
      : [],
    analytics: settings.analyticsOptIn ? repos.analytics.list(5000) : [],
    auditLog: repos.auditLog.list(5000),
  };
  return {
    defaultName: `braiwser-gdpr-export-${Date.now()}.json`,
    content: JSON.stringify(payload, null, 2),
    mime: 'application/json',
  };
}

function deleteAccountData(repos) {
  repos.analytics.clear();
  repos.syncQueue.clear();
  repos.settings.set({
    sync: { enabled: false, accountEmail: '', workspaceId: '' },
    licenseKey: '',
  });
  repos.license.set({ key: '', activatedAt: null, tier: 'free' });
  repos.auditLog.append('gdpr.delete', {});
  return { ok: true };
}

module.exports = {
  billingStatus,
  createCheckoutIntent,
  applySeatChange,
  exportGdprPackage,
  deleteAccountData,
};
