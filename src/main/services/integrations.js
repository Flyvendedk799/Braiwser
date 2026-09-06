// Integrations: create issues from notes + webhook notify + CI starter.
const fs = require('fs');
const path = require('path');

function noteToIssueBody(annotation, session) {
  const sel = (annotation.target && (annotation.target.selector || annotation.target.id)) || '';
  const vp = annotation.viewport && annotation.viewport.w
    ? `${annotation.viewport.w}×${annotation.viewport.h}`
    : 'n/a';
  return [
    annotation.note || '(no note)',
    '',
    `**Action:** ${annotation.action || 'comment'}`,
    `**Priority:** ${annotation.priority || 'normal'}`,
    `**Selector:** \`${sel}\``,
    `**Viewport:** ${vp}`,
    session && session.url ? `**URL:** ${session.url}` : '',
    '',
    '_Created from Braiwser_',
  ].filter(Boolean).join('\n');
}

function buildGithubIssue(annotation, session) {
  return {
    provider: 'github',
    title: `[Braiwser] ${(annotation.note || 'UI finding').slice(0, 72)}`,
    body: noteToIssueBody(annotation, session),
    labels: ['braiwser', annotation.action || 'comment', annotation.priority || 'normal'],
  };
}

function buildLinearIssue(annotation, session) {
  return {
    provider: 'linear',
    title: `[Braiwser] ${(annotation.note || 'UI finding').slice(0, 72)}`,
    description: noteToIssueBody(annotation, session),
    priority: annotation.priority === 'critical' ? 1 : annotation.priority === 'high' ? 2 : 3,
  };
}

function buildJiraIssue(annotation, session) {
  return {
    provider: 'jira',
    fields: {
      summary: `[Braiwser] ${(annotation.note || 'UI finding').slice(0, 72)}`,
      description: noteToIssueBody(annotation, session),
      issuetype: { name: 'Bug' },
    },
  };
}

function createIssueDraft(repos, { provider, annotationId, sessionId }) {
  const annotation = repos.annotations.get(annotationId);
  const session = sessionId ? repos.sessions.get(sessionId) : null;
  if (!annotation) return { ok: false, error: 'Annotation not found' };
  let draft;
  if (provider === 'linear') draft = buildLinearIssue(annotation, session);
  else if (provider === 'jira') draft = buildJiraIssue(annotation, session);
  else draft = buildGithubIssue(annotation, session);
  repos.auditLog.append('integration.issue_draft', { provider: draft.provider, annotationId });
  repos.analytics.track('integration_issue', { provider: draft.provider });
  return { ok: true, draft };
}

function slackPayload(text) {
  return { text: text || 'Braiwser update' };
}

function playwrightCiWorkflow() {
  return `name: Braiwser journeys
on:
  push:
  pull_request:
jobs:
  journeys:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx playwright install --with-deps
      - run: npx playwright test tests/braiwser
`;
}

function writeCiStarter(projectPath) {
  if (!projectPath) return { ok: false, error: 'No local project path' };
  const dir = path.join(projectPath, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'braiwser-journeys.yml');
  fs.writeFileSync(file, playwrightCiWorkflow());
  return { ok: true, file };
}

function webhookEnvelope(event, data) {
  return {
    event,
    at: new Date().toISOString(),
    source: 'braiwser',
    data,
  };
}

module.exports = {
  createIssueDraft,
  slackPayload,
  playwrightCiWorkflow,
  writeCiStarter,
  webhookEnvelope,
  noteToIssueBody,
};
