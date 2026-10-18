// Local-only analytics + user-triggered diagnostics.
// Events are recorded on this machine, and only when analyticsOptIn is true. There is
// no upload path and no collection endpoint in this version: nothing here is ever
// transmitted. The diagnostics bundle is a file the user chooses to save and share.
const fs = require('fs');
const path = require('path');
const os = require('os');

function track(repos, event, props = {}) {
  try {
    return repos.analytics.track(event, props);
  } catch (_e) {
    return null;
  }
}

function funnel(repos) {
  const events = repos.analytics.list(2000);
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;
  return {
    install: counts.install || 0,
    first_annotation: counts.first_annotation || 0,
    first_export: counts.first_export || 0,
    handoff_success: counts.handoff_success || 0,
    handoff_fail: counts.handoff_fail || 0,
    pro_activate: counts.pro_activate || 0,
    total: events.length,
  };
}

function buildDiagnostics({ repos, appVersion, paths }) {
  const settings = repos.settings.get();
  const license = repos.license.get();
  const payload = {
    at: new Date().toISOString(),
    appVersion: appVersion || '1.0.0',
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron,
    schemaVersion: repos.schema && repos.schema.schemaVersion,
    settings: {
      persona: settings.persona,
      theme: settings.theme,
      aiProvider: settings.aiProvider,
      analyticsOptIn: !!settings.analyticsOptIn,
      crashReportsOptIn: !!settings.crashReportsOptIn,
      syncEnabled: !!(settings.sync && settings.sync.enabled),
    },
    license: { tier: license.tier || 'free', activated: !!license.activatedAt },
    counts: {
      projects: repos.projects.list().length,
      sessions: repos.sessions.list().length,
      annotations: Object.values(repos.annotations.countsBySession()).reduce((a, b) => a + b, 0),
      recordings: repos.recordings.list().length,
    },
    paths: {
      store: repos.dir,
      inspector: paths && paths.inspector,
    },
    funnel: funnel(repos),
  };
  return {
    defaultName: `braiwser-diagnostics-${Date.now()}.json`,
    content: JSON.stringify(payload, null, 2),
    mime: 'application/json',
  };
}

function writeCrashBreadcrumb(repos, detail) {
  const settings = repos.settings.get();
  if (!settings.crashReportsOptIn) return null;
  return repos.auditLog.append('crash', detail || {});
}

module.exports = { track, funnel, buildDiagnostics, writeCrashBreadcrumb };
