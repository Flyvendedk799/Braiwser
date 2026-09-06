// Team workspaces, roles, and async comments on notes (local-first foundation
// that later syncs via services/sync.js).
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
  repos.auditLog.append('workspace.create', { id: ws.id, name: ws.name });
  return ws;
}

function inviteMember(repos, workspaceId, { email, role }) {
  const ws = repos.workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const r = ROLES.includes(role) ? role : 'commenter';
  const members = Array.isArray(ws.members) ? ws.members.slice() : [];
  if (members.some((m) => m.email === email)) return { ok: false, error: 'Already invited' };
  members.push({ email, role: r, joinedAt: new Date().toISOString(), status: 'invited' });
  repos.workspaces.update(workspaceId, { members });
  repos.auditLog.append('workspace.invite', { workspaceId, email, role: r });
  return { ok: true, workspace: repos.workspaces.get(workspaceId) };
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

function canExport(role) {
  return role === 'owner' || role === 'editor' || role === 'viewer';
}

function canHandoff(role) {
  return role === 'owner' || role === 'editor';
}

module.exports = {
  ROLES,
  listWorkspaces,
  createWorkspace,
  inviteMember,
  addComment,
  listComments,
  canExport,
  canHandoff,
};
