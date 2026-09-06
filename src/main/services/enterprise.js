// Enterprise / marketplace foundations: SSO config shape, SCIM stubs, templates.
const MARKETPLACE_TEMPLATES = [
  {
    id: 'agent-ui-fix',
    kind: 'handoff',
    label: 'UI fix for coding agents',
    description: 'Community preset: selector-precise UI repairs.',
  },
  {
    id: 'qa-a11y',
    kind: 'checklist',
    label: 'QA accessibility checklist',
    description: 'Community preset mirroring WCAG-oriented review.',
  },
  {
    id: 'agency-launch',
    kind: 'checklist',
    label: 'Agency launch pack',
    description: 'Pre-launch client review checklist.',
  },
];

function enterpriseStatus(repos) {
  const license = repos.license.get();
  return {
    sso: {
      enforced: !!license.ssoEnforced,
      provider: license.ssoProvider || null,
      ready: true,
    },
    scim: {
      enabled: !!license.scimEnabled,
      endpoint: '/api/scim/v2',
    },
    selfHostedSync: !!license.selfHostedSync,
    tier: license.tier || 'free',
  };
}

function setSsoConfig(repos, { enforced, provider }) {
  repos.license.set({
    ...repos.license.get(),
    ssoEnforced: !!enforced,
    ssoProvider: provider || 'oidc',
  });
  repos.auditLog.append('enterprise.sso', { enforced: !!enforced, provider });
  return enterpriseStatus(repos);
}

function listMarketplace() {
  return MARKETPLACE_TEMPLATES.slice();
}

function openSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://braiwser.app/schema/braiwser-bundle.v1.json',
    title: 'Braiwser project bundle',
    type: 'object',
    required: ['format', 'version', 'project'],
    properties: {
      format: { const: 'braiwser-bundle' },
      version: { type: 'integer', minimum: 1 },
      project: { type: 'object' },
      sessions: { type: 'array' },
      annotations: { type: 'array' },
      recordings: { type: 'array' },
    },
  };
}

module.exports = {
  enterpriseStatus,
  setSsoConfig,
  listMarketplace,
  openSchema,
  MARKETPLACE_TEMPLATES,
};
