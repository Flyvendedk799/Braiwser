// Pure helper: what the hand-off dialog should say about WHERE an agent runs.
// Inputs are the main process's agent.write() result ({ file, cwd, imported, ... })
// and the session's project record. DOM-free so it can be unit tested.

const norm = (p) => String(p || '').split('\\').join('/').replace(/\/+$/, '').toLowerCase();

const hasLocalDirectory = (project) => !!(project && project.kind === 'local' && project.path && !project.imported);

// -> { cwd, entry, needsLocalDirectory, notices:[string] }
export function handoffWhere(res, project) {
  const written = res || {};
  const imported = !!(written.imported || (project && project.imported));
  const needsLocalDirectory = imported || !hasLocalDirectory(project);
  const notices = [];
  // When a directory is needed the dialog already explains it; notices only
  // carry what it cannot know (a write that fell back to app data).
  if (!needsLocalDirectory && written.cwd) {
    const a = norm(written.cwd);
    const b = norm(project.path);
    // The request normally lands inside the project folder (or beside its entry
    // file). Anywhere else means writing there failed and it fell back.
    if (!(a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))) {
      notices.push('Braiwser could not write into the project folder, so the request was saved in its own data folder.');
    }
  }
  return {
    cwd: needsLocalDirectory ? '' : (written.cwd || ''),
    entry: project && project.entry ? String(project.entry) : '',
    needsLocalDirectory,
    notices,
  };
}
