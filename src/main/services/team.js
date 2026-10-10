// Team workspaces, roles, and comments on notes: a LOCAL-ONLY foundation.
//
// Everything here is a record on this machine. Inviting someone stores a member
// row; no invitation is sent and the invitee cannot sign in anywhere. The role
// helpers (canExport / canHandoff) are not enforced on any operation, and
// comments are not shared. Real collaboration needs a hosted service that does
// not exist yet (see services/sync.js).
const LOCAL_ONLY_NOTE =
  'Team workspaces are local-only in this version: invitations are not sent, members cannot sign in, ' +
  'and roles and comments are not shared or enforced across people or devices.';

const ROLES = ['owner', 'editor', 'commenter', 'viewer'];

function listWorkspaces(repos) {
  return repos.workspaces.list();
}

function createWorkspace(repos, { name }) {
  const ws = repos.workspaces.create({ name: name || 'Team workspace', role: 'owner' });
  repos.settings.set({
    sync: {
      ...(repos.settings.get().sync || {}),
      workspaceId: ws.id,
      enabled: true,
    },
  });
  repos.auditLog.append('workspace.create', { id: ws.id, name: ws.name, localOnly: true });
  return { ...ws, localOnly: true, note: LOCAL_ONLY_NOTE };
}

function inviteMember(repos, workspaceId, { email, role }) {
  const ws = repos.workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const address = String(email || '').trim().toLowerCase();
  if (!address || !address.includes('@')) return { ok: false, error: 'Enter a valid email' };
  const r = ROLES.includes(role) ? role : 'commenter';
  const members = Array.isArray(ws.members) ? ws.members.slice() : [];
  if (members.some((m) => m.email === address)) return { ok: false, error: 'Already invited' };
  // `delivered: false` is the truth: this row is a note-to-self, not an invitation.
  members.push({ email: address, role: r, joinedAt: new Date().toISOString(), status: 'invited', delivered: false });
  repos.workspaces.update(workspaceId, { members });
  repos.auditLog.append('workspace.invite', { workspaceId, email: address, role: r, delivered: false });
  return { ok: true, delivered: false, localOnly: true, note: LOCAL_ONLY_NOTE, workspace: repos.workspaces.get(workspaceId) };
}

function addComment(repos, { sessionId, annotationId, author, body }) {
  if (!body || !String(body).trim()) return { ok: false, error: 'Empty comment' };
  const c = repos.comments.create({
    sessionId,
    annotationId,
    author: author || repos.settings.get().profile.displayName || 'You',
    body: String(body).trim().slice(0, 4000),
  });
  repos.analytics.track('comment_add', {});
  return { ok: true, comment: c };
}

function listComments(repos, { sessionId, annotationId }) {
  if (annotationId) return repos.comments.byAnnotation(annotationId);
  if (sessionId) return repos.comments.bySession(sessionId);
  return [];
}

// Role predicates. NOT enforced by any IPC handler today; they describe the intent
// a hosted multi-user service would enforce.
function canExport(role) {
  return role === 'owner' || role === 'editor' || role === 'viewer';
}

function canHandoff(role) {
  return role === 'owner' || role === 'editor';
}

module.exports = {
  LOCAL_ONLY_NOTE,
  ROLES,
  listWorkspaces,
  createWorkspace,
  inviteMember,
  addComment,
  listComments,
  canExport,
  canHandoff,
};
