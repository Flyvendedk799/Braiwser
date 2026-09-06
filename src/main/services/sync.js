// Optional local-first sync queue. Encrypted project snapshots are staged here;
// a future cloud endpoint drains them. Logged-out / sync.enabled=false leaves
// the local JSON store as the only source of truth.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function accountStatus(repos) {
  const sync = repos.settings.get().sync || {};
  return {
    signedIn: !!(sync.accountEmail),
    email: sync.accountEmail || '',
    enabled: !!sync.enabled,
    workspaceId: sync.workspaceId || '',
    pending: repos.syncQueue.list().filter((x) => x.status === 'pending').length,
  };
}

function signIn(repos, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return { ok: false, error: 'Enter a valid email' };
  repos.settings.set({
    sync: {
      ...(repos.settings.get().sync || {}),
      accountEmail: clean,
      enabled: true,
      workspaceId: repos.settings.get().sync.workspaceId || crypto.randomUUID(),
    },
  });
  repos.analytics.track('sync_signin', {});
  repos.auditLog.append('sync.signin', { email: clean });
  return { ok: true, ...accountStatus(repos) };
}

function signOut(repos) {
  repos.settings.set({
    sync: { enabled: false, accountEmail: '', workspaceId: repos.settings.get().sync.workspaceId || '' },
  });
  repos.auditLog.append('sync.signout', {});
  return { ok: true, ...accountStatus(repos) };
}

function enqueueProjectSnapshot(repos, projectId) {
  const project = repos.projects.get(projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  const sessions = repos.sessions.list(projectId);
  const annotations = sessions.flatMap((s) => repos.annotations.bySession(s.id));
  const recordings = repos.recordings.list(projectId);
  const snapshot = { project, sessions, annotations, recordings, at: new Date().toISOString() };
  const raw = JSON.stringify(snapshot);
  // Local "encryption at rest" for the queue using a machine-local key file.
  const keyPath = path.join(repos.dir, 'sync.key');
  let key;
  if (fs.existsSync(keyPath)) key = fs.readFileSync(keyPath);
  else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const item = repos.syncQueue.enqueue({
    type: 'project-snapshot',
    projectId,
    blob: Buffer.concat([iv, tag, enc]).toString('base64'),
  });
  return { ok: true, id: item.id, bytes: raw.length };
}

function drainLocal(repos) {
  // Placeholder drain: mark pending as synced-local. Real cloud push lands later.
  const pending = repos.syncQueue.list().filter((x) => x.status === 'pending');
  pending.forEach((p) => repos.syncQueue.mark(p.id, 'synced-local'));
  return { ok: true, drained: pending.length };
}

module.exports = { accountStatus, signIn, signOut, enqueueProjectSnapshot, drainLocal };
