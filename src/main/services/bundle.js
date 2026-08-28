// Project bundles — a portable, self-contained snapshot of a review.
//
// A bundle carries one project with every session, annotation, and recording
// that belongs to it, so a review can be handed to a teammate, archived next to
// the code, or moved between machines. Import always creates NEW ids: importing
// a bundle twice yields two independent copies rather than silently merging
// into (or corrupting) whatever already exists.

const crypto = require('crypto');

const BUNDLE_KIND = 'braiwser.project-bundle';
const BUNDLE_VERSION = 1;

function slug(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
}

// Collect a project and everything hanging off it.
function exportBundle(repos, projectId) {
  const project = repos.projects.get(projectId);
  if (!project) throw new Error('Project not found');

  const sessions = repos.sessions.list(projectId);
  const annotations = [];
  for (const s of sessions) annotations.push(...repos.annotations.bySession(s.id));
  const recordings = repos.recordings.list(projectId);

  const bundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project,
    sessions,
    annotations,
    recordings,
  };

  return {
    defaultName: `${slug(project.name)}.braiwser.json`,
    content: JSON.stringify(bundle, null, 2),
    counts: { sessions: sessions.length, annotations: annotations.length, recordings: recordings.length },
  };
}

function parseBundle(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || data.kind !== BUNDLE_KIND) {
    throw new Error('That file is not a Braiwser project bundle.');
  }
  if (!data.project || !data.project.name) {
    throw new Error('The bundle has no project in it.');
  }
  if (Number(data.version) > BUNDLE_VERSION) {
    throw new Error(`This bundle was written by a newer Braiwser (v${data.version}).`);
  }
  return data;
}

// Re-key everything onto fresh ids so an import can never collide with, or
// overwrite, existing local data.
function importBundle(repos, text) {
  const data = parseBundle(text);

  const project = repos.projects.create({
    name: data.project.name,
    path: data.project.path || '',
    kind: data.project.kind || 'url',
  });

  const sessionIdMap = new Map();
  for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
    const created = repos.sessions.create({
      projectId: project.id,
      name: s.name,
      url: s.url,
      title: s.title,
    });
    sessionIdMap.set(s.id, created.id);
  }

  let annotationCount = 0;
  for (const a of Array.isArray(data.annotations) ? data.annotations : []) {
    const sessionId = sessionIdMap.get(a.sessionId);
    if (!sessionId) continue; // orphaned annotation — drop rather than guess
    repos.annotations.create({
      ...a,
      id: crypto.randomUUID(),
      sessionId,
    });
    annotationCount += 1;
  }

  let recordingCount = 0;
  for (const r of Array.isArray(data.recordings) ? data.recordings : []) {
    repos.recordings.create({
      projectId: project.id,
      name: r.name,
      startUrl: r.startUrl,
      steps: Array.isArray(r.steps) ? r.steps : [],
    });
    recordingCount += 1;
  }

  return {
    project,
    counts: { sessions: sessionIdMap.size, annotations: annotationCount, recordings: recordingCount },
  };
}

module.exports = { exportBundle, importBundle, parseBundle, BUNDLE_KIND, BUNDLE_VERSION };
