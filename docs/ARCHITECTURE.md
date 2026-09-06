# Architecture map (Phase 5)

Braiwser keeps a clear process split. Prefer extending these seams over growing
`app.js` / `inspector.js` further.

```
main/
  main.js              boot, window, updater hook
  migrate.js           userData / store folder migrations
  env.js               BRAIWSER_E2E helpers
  preload.js           window.braiwser (+ caos alias)
  ipc/index.js         all IPC handlers
  store/               JSON collections + schema migrations
  services/
    ai/                providers + local synthesis
    agent/             handoff + templates
    export/            md / prompt / playwright / element / recording
    review/            checklists, client pack, HTML report
    license.js         Free/Pro activation
    sync.js            optional encrypted snapshot queue
    team.js            workspaces + comments
    billing.js         seats + GDPR package
    integrations.js    issue drafts + CI starter
    analytics.js       opt-in events + diagnostics
    updater.js         electron-updater wrapper
    enterprise.js      SSO/marketplace/schema
renderer/
  app.js               shell controller (tabs, modes, command bus)
  lib/persona.js       persona empty-state copy
  components/          panels and modals
webview/
  inspector.js         in-page inspect/draw/edit/arrange
  audit.js / recorder.js / replay.js
```

Startup budget target: first paint of the shell before AI auth / model refresh
completes (already deferred in `main.js`).
