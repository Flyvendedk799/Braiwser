// LOCAL-ONLY sync queue. Braiwser has no hosted sync service: nothing in this file
// contacts a server, authenticates an account or uploads anything.
//
// What it does do: "sign in" records an email address and a workspace id in the
// local settings, and "enqueue" stages an encrypted snapshot of a project in a
// local queue file, ready for a future endpoint. Draining the queue only marks
// items `staged-local`; they remain on this machine and are NOT a backup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCAL_ONLY_NOTE =
  'Sync is local-only in this version: no hosted service exists, so nothing is uploaded, ' +
  'backed up or shared across devices. Signing in only records an email address on this machine.';

function localOnlyFlags() {
  return { mode: 'local-only', remote: false, authenticated: false, note: LOCAL_ONLY_NOTE };
}

function accountStatus(repos) {
  const sync = repos.settings.get().sync || {};
  return {
    signedIn: !!(sync.accountEmail),
    email: sync.accountEmail || '',
    enabled: !!sync.enabled,
    workspaceId: sync.workspaceId || '',
    pending: repos.syncQueue.list().filter((x) => x.status === 'pending').length,
    ...localOnlyFlags(),
  };
}

function signIn(repos, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return { ok: false, error: 'Enter a valid email' };
  const current = repos.settings.get().sync || {};
  repos.settings.set({
    sync: {
      ...current,
      accountEmail: clean,
      enabled: true,
      workspaceId: current.workspaceId || crypto.randomUUID(),
    },
  });
  repos.analytics.track('sync_signin', {});
  repos.auditLog.append('sync.signin', { email: clean, localOnly: true });
  return { ok: true, ...accountStatus(repos) };
}

function signOut(repos) {
  const current = repos.settings.get().sync || {};
  repos.settings.set({
    sync: { enabled: false, accountEmail: '', workspaceId: current.workspaceId || '' },
  });
  repos.auditLog.append('sync.signout', {});
  return { ok: true, ...accountStatus(repos) };
}

// The key that encrypts staged snapshots. Only a missing file means "make one";
// a file that exists but is the wrong size is a fault, because replacing it would
// make every already-staged snapshot undecryptable without saying so.
function queueKey(dir) {
  const keyPath = path.join(dir, 'sync.key');
  let existing = null;
  try {
    existing = fs.readFileSync(keyPath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw new Error(`Cannot read the sync queue key (${keyPath}): ${err && err.message}`);
  }
  if (existing) {
    if (existing.length !== 32) throw new Error(`The sync queue key (${keyPath}) is damaged (expected 32 bytes, found ${existing.length}). It was not replaced.`);
    return existing;
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return queueKey(dir);
    throw err;
  }
  return key;
}

function enqueueProjectSnapshot(repos, projectId) {
  const project = repos.projects.get(projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  const sessions = repos.sessions.list(projectId);
  const annotations = sessions.flatMap((s) => repos.annotations.bySession(s.id));
  const recordings = repos.recordings.list(projectId);
  const snapshot = { project, sessions, annotations, recordings, at: new Date().toISOString() };
  const raw = JSON.stringify(snapshot);
  let key;
  try {
    key = queueKey(repos.dir);
  } catch (err) {
    return { ok: false, error: err.message };
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
  return { ok: true, id: item.id, bytes: raw.length, ...localOnlyFlags() };
}

// There is no remote to push to. Items are marked `staged-local` so the queue
// does not grow a "pending" badge forever, and the result says plainly that
// nothing was uploaded.
function drainLocal(repos) {
  const pending = repos.syncQueue.list().filter((x) => x.status === 'pending');
  pending.forEach((p) => repos.syncQueue.mark(p.id, 'staged-local'));
  return { ok: true, drained: pending.length, uploaded: 0, ...localOnlyFlags() };
}

module.exports = { accountStatus, signIn, signOut, enqueueProjectSnapshot, drainLocal, queueKey, LOCAL_ONLY_NOTE };
