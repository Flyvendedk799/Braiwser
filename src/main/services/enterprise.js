// Enterprise surface: what exists and what does not.
//
// NOT IMPLEMENTED: single sign-on (SAML/OIDC), SCIM provisioning and self-hosted
// sync. This repository contains no authentication, token validation, identity
// provider integration or provisioning endpoint, and no server. Earlier versions
// of this file reported `sso.ready: true` and a SCIM endpoint string, and let a
// caller "enforce" SSO by writing a flag that nothing read; both implied
// capabilities that do not exist. Every status below says `not-implemented`, and
// configuring SSO is refused rather than silently recorded.
//
// What is real: the built-in handoff/checklist templates and the bundle schema.
const fs = require('fs');
const path = require('path');

const NOT_IMPLEMENTED_NOTE =
  'Single sign-on, SCIM provisioning and self-hosted sync are not implemented in this version.';

// Templates shipped inside the app. (They were labelled "community" presets, but
// there is no community catalogue or publishing flow.)
const MARKETPLACE_TEMPLATES = [
  {
    id: 'agent-ui-fix',
    kind: 'handoff',
    label: 'UI fix for coding agents',
    description: 'Built-in preset: selector-precise UI repairs.',
    source: 'built-in',
  },
  {
    id: 'qa-a11y',
    kind: 'checklist',
    label: 'QA accessibility checklist',
    description: 'Built-in preset mirroring WCAG-oriented review.',
    source: 'built-in',
  },
  {
    id: 'agency-launch',
    kind: 'checklist',
    label: 'Agency launch pack',
    description: 'Built-in pre-launch client review checklist.',
    source: 'built-in',
  },
];

function enterpriseStatus(repos) {
  const license = repos.license.get();
  return {
    sso: {
      enforced: false,
      provider: null,
      ready: false,
      status: 'not-implemented',
    },
    scim: {
      enabled: false,
      endpoint: null,
      status: 'not-implemented',
    },
    selfHostedSync: { enabled: false, status: 'not-implemented' },
    note: NOT_IMPLEMENTED_NOTE,
    tier: license.tier || 'free',
  };
}

// Refused: there is nothing to configure. Nothing is written, so no stored flag can
// later be mistaken for an active control.
function setSsoConfig(repos) {
  return {
    ok: false,
    status: 'not-implemented',
    error: 'Single sign-on is not implemented in this version.',
    ...enterpriseStatus(repos),
  };
}

function listMarketplace() {
  return MARKETPLACE_TEMPLATES.slice();
}

// The published interchange schema, read from the file that ships with the app so
// this can never drift from schema/braiwser-bundle.v1.json.
function openSchema() {
  const file = path.join(__dirname, '..', '..', '..', 'schema', 'braiwser-bundle.v1.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  enterpriseStatus,
  setSsoConfig,
  listMarketplace,
  openSchema,
  MARKETPLACE_TEMPLATES,
  NOT_IMPLEMENTED_NOTE,
};
