// sync / team / enterprise / integrations must not claim what they do not do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRepositories } = require('../../src/main/store/repositories');
const sync = require('../../src/main/services/sync');
const team = require('../../src/main/services/team');
const enterprise = require('../../src/main/services/enterprise');
const integrations = require('../../src/main/services/integrations');

function fresh() {
  return createRepositories(fs.mkdtempSync(path.join(os.tmpdir(), 'brw-truth-')));
}

test('enterprise: SSO / SCIM are not-implemented, never ready:true, and cannot be "enforced"', () => {
  const repos = fresh();
  const st = enterprise.enterpriseStatus(repos);
  assert.equal(st.sso.ready, false);
  assert.equal(st.sso.status, 'not-implemented');
  assert.equal(st.sso.enforced, false);
  assert.equal(st.scim.enabled, false);
  assert.equal(st.scim.endpoint, null);
  assert.equal(st.scim.status, 'not-implemented');
  assert.equal(st.selfHostedSync.status, 'not-implemented');

  const res = enterprise.setSsoConfig(repos, { enforced: true, provider: 'okta' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'not-implemented');
  assert.equal(res.sso.enforced, false);
  assert.equal(repos.license.get().ssoEnforced, undefined, 'nothing is persisted');
});

test('enterprise: templates are labelled built-in and the schema is the shipped file', () => {
  for (const t of enterprise.listMarketplace()) {
    assert.equal(t.source, 'built-in');
    assert.doesNotMatch(t.description, /community/i);
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'braiwser-bundle.v1.json'), 'utf8'));
  assert.deepEqual(enterprise.openSchema(), shipped);
});

test('sync: every response is labelled local-only; drain uploads nothing', () => {
  const repos = fresh();
  assert.equal(sync.accountStatus(repos).mode, 'local-only');
  assert.equal(sync.accountStatus(repos).remote, false);
  const signedIn = sync.signIn(repos, 'Ada@Example.test');
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.authenticated, false);
  assert.match(signedIn.note, /local-only/);

  const project = repos.projects.create({ name: 'P', path: '/p', kind: 'local' });
  const queued = sync.enqueueProjectSnapshot(repos, project.id);
  assert.equal(queued.ok, true);
  assert.equal(queued.remote, false);
  const drained = sync.drainLocal(repos);
  assert.equal(drained.drained, 1);
  assert.equal(drained.uploaded, 0);
  assert.equal(drained.mode, 'local-only');
  assert.equal(repos.syncQueue.list()[0].status, 'staged-local');
});

test('sync: a damaged queue key is reported and not silently replaced', () => {
  const repos = fresh();
  const project = repos.projects.create({ name: 'P', path: '/p', kind: 'local' });
  assert.equal(sync.enqueueProjectSnapshot(repos, project.id).ok, true);
  const keyFile = path.join(repos.dir, 'sync.key');
  const original = fs.readFileSync(keyFile);
  assert.equal(original.length, 32);
  fs.writeFileSync(keyFile, Buffer.from('short'));
  const res = sync.enqueueProjectSnapshot(repos, project.id);
  assert.equal(res.ok, false);
  assert.match(res.error, /damaged/);
  assert.equal(fs.readFileSync(keyFile).toString(), 'short');
});

test('team: invitations are recorded as undelivered local rows', () => {
  const repos = fresh();
  const ws = team.createWorkspace(repos, { name: 'Crew' });
  assert.equal(ws.localOnly, true);
  assert.equal(team.inviteMember(repos, ws.id, { email: 'not-an-email' }).ok, false);
  const res = team.inviteMember(repos, ws.id, { email: ' Bob@Example.test ', role: 'editor' });
  assert.equal(res.ok, true);
  assert.equal(res.delivered, false);
  const member = res.workspace.members.find((m) => m.email === 'bob@example.test');
  assert.equal(member.delivered, false);
  assert.equal(team.inviteMember(repos, ws.id, { email: 'bob@example.test' }).ok, false);
});

test('integrations: drafts only, labelled as such', () => {
  const repos = fresh();
  const project = repos.projects.create({ name: 'P', path: '/p', kind: 'local' });
  const session = repos.sessions.create({ projectId: project.id, name: 'S', url: 'https://x.test' });
  const a = repos.annotations.create({ sessionId: session.id, note: 'Fix me', action: 'fix' });
  for (const provider of ['github', 'linear', 'jira']) {
    const res = integrations.createIssueDraft(repos, { provider, annotationId: a.id, sessionId: session.id });
    assert.equal(res.ok, true);
    assert.equal(res.created, false);
    assert.equal(res.status, 'draft');
    assert.match(res.note, /not sent|not created|draft/i);
  }
  // Builders return plain payloads; delivery is the caller's job.
  const hook = integrations.webhookEnvelope('note.created', { id: 1 });
  assert.deepEqual(Object.keys(hook).sort(), ['at', 'data', 'event', 'source']);
});
