// Product truthfulness: the export/erase scope is what the inventory says it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRepositories } = require('../../src/main/store/repositories');
const billing = require('../../src/main/services/billing');

function seed(repos) {
  const project = repos.projects.create({ name: 'Acme', path: '/tmp/acme', kind: 'local' });
  const session = repos.sessions.create({ projectId: project.id, name: 'Review', url: 'https://acme.test' });
  const orphanSession = repos.sessions.create({ projectId: null, name: 'Loose', url: 'https://loose.test' });
  const note = repos.annotations.create({ sessionId: session.id, note: 'private note', action: 'fix' });
  repos.annotations.create({ sessionId: orphanSession.id, note: 'loose note' });
  repos.recordings.create({ projectId: project.id, name: 'Journey', steps: [] });
  repos.recordings.create({ projectId: null, name: 'Loose journey', steps: [] });
  repos.comments.create({ sessionId: session.id, annotationId: note.id, body: 'hello' });
  repos.bookmarks.toggle({ url: 'https://bookmark.test', title: 'b' });
  repos.history.record({ url: 'https://history.test', title: 'h' });
  const ws = repos.workspaces.create({ name: 'Team' });
  repos.settings.set({
    profile: { displayName: 'Ada Lovelace' },
    agency: { name: 'Acme Agency', logoDataUrl: 'data:image/png;base64,AAAA' },
    sync: { enabled: true, accountEmail: 'ada@example.test', workspaceId: ws.id },
    integrations: { github: { enabled: true, tokenHint: 'ghp_...', repo: 'acme/site' } },
    licenseKey: 'BRW1.x.y',
    openTabs: ['https://secret.test/page'],
    agentCommand: 'my-agent --run',
    analyticsOptIn: true,
    theme: 'light',
  });
  repos.license.set({ key: 'BRW1.x.y', tier: 'pro', activatedAt: '2026-01-01T00:00:00Z', seats: 5 });
  repos.analytics.track('first_export', {});
  repos.auditLog.append('something', { a: 1 });
  repos.syncQueue.enqueue({ type: 'project-snapshot', projectId: project.id, blob: 'AAAA' });
  // credential + key material that erase must remove
  for (const f of billing.SECRET_FILES) fs.writeFileSync(path.join(repos.dir, f), 'secret');
  return { project, session };
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-scope-'));
  return createRepositories(dir);
}

test('inventory counts everything seeded, and every collection is covered by export and erase', () => {
  const repos = fresh();
  seed(repos);
  const inv = billing.dataInventory(repos);
  const byId = Object.fromEntries(inv.collections.map((c) => [c.id, c.count]));
  assert.equal(byId.projects, 1);
  assert.equal(byId.sessions, 2);
  assert.equal(byId.annotations, 2);
  assert.equal(byId.recordings, 2);
  assert.equal(byId.comments, 1);
  assert.equal(byId.bookmarks, 1);
  assert.equal(byId.history, 1);
  assert.equal(byId.workspaces, 1);
  assert.equal(byId.analytics, 1);
  assert.equal(byId.auditLog >= 1, true);
  assert.equal(byId.syncQueue, 1);
  for (const c of inv.collections) {
    assert.equal(c.exported, true, c.id);
    assert.equal(c.erased, true, c.id);
  }
  assert.ok(inv.notCovered.length > 0);
});

test('export includes every inventory collection (comments no longer depend on workspaces) but never keys', () => {
  const repos = fresh();
  seed(repos);
  const out = JSON.parse(billing.exportGdprPackage(repos).content);
  for (const id of ['projects', 'sessions', 'annotations', 'recordings', 'comments', 'bookmarks', 'history', 'workspaces', 'analytics', 'auditLog', 'syncQueue']) {
    assert.ok(Array.isArray(out[id]) && out[id].length >= 1, id);
  }
  assert.equal(out.annotations.length, 2); // including the loose session's note
  assert.equal(out.profile.displayName, 'Ada Lovelace');
  const text = JSON.stringify(out);
  assert.equal(text.includes('BRW1.x.y'), false, 'licence key must not be exported');
  assert.equal(out.syncQueue[0].blob, undefined);
});

test('erase removes every inventory collection, personal settings, licence and key files', () => {
  const repos = fresh();
  seed(repos);
  const result = billing.deleteAccountData(repos);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.deleted.annotations, 2);
  assert.equal(result.deleted.comments, 1);

  const inv = billing.dataInventory(repos);
  for (const c of inv.collections) {
    // The audit log keeps exactly one record that an erase happened.
    assert.equal(c.count, c.id === 'auditLog' ? 1 : 0, c.id);
  }
  const settings = repos.settings.get();
  assert.equal(settings.profile.displayName, '');
  assert.equal(settings.agency.name, '');
  assert.equal(settings.agency.logoDataUrl, '');
  assert.equal(settings.sync.accountEmail, '');
  assert.equal(settings.sync.enabled, false);
  assert.equal(settings.licenseKey, '');
  assert.deepEqual(settings.openTabs, []);
  assert.equal(settings.agentCommand, '');
  assert.equal(settings.integrations.github.enabled, false);
  assert.equal(settings.integrations.github.repo, '');
  assert.equal(settings.theme, 'light', 'preferences are kept and disclosed');
  const lic = repos.license.get();
  assert.equal(lic.key, '');
  assert.equal(lic.tier, 'free');
  for (const f of billing.SECRET_FILES) assert.equal(fs.existsSync(path.join(repos.dir, f)), false, f);
  assert.deepEqual(repos.auditLog.list(10).map((e) => e.action), ['gdpr.delete']);
});

test('erase on an empty store is fine and idempotent', () => {
  const repos = fresh();
  assert.equal(billing.deleteAccountData(repos).ok, true);
  assert.equal(billing.deleteAccountData(repos).ok, true);
});

test('billing is not implemented: no checkout object, honest status', () => {
  const repos = fresh();
  const intent = billing.createCheckoutIntent(repos, { seats: 3 });
  assert.equal(intent.ok, false);
  assert.equal(intent.status, 'not-implemented');
  assert.equal(intent.url, undefined);
  const st = billing.billingStatus(repos);
  assert.equal(st.billing.connected, false);
  assert.equal(st.billing.status, 'not-implemented');
  assert.equal(repos.auditLog.list(10).some((e) => /checkout/.test(e.action)), false);
});
