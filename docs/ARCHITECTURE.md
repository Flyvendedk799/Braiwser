# Architecture map

Braiwser keeps a clear process split. Prefer extending these seams over growing
`app.js` / `inspector.js` further. This file describes the repository as it is; the
audit-driven items that are still open are tracked in the audit, not here.

```
src/
  main/                  Electron main process (CommonJS, Node)
    main.js              boot, window, session/permission wiring, updater hook
    e2e-finalizer.js     the single terminal path for every e2e outcome (see Testing)
    build-config.js      build-time licence/channel configuration reader
    config.js            constants shared with the renderer (tags, models, settings defaults)
    env.js               BRAIWSER_E2E helpers
    migrate.js           userData / store folder migrations
    menu.js              native menu; every shortcut is a menu command
    preload.js           window.braiwser (+ caos alias) - the only renderer-facing API
    ipc/
      index.js           product IPC handlers, all registered through security.handle
      browser.js         agent-runtime IPC (disabled unless the flag is on)
    security/            IPC sender guard, navigation/permission/webview policies,
                         display-media grants, file roots
    store/               JSON collections + documents, schema migrations, repositories
    services/
      ai/                providers, credentials, local synthesis (see below)
      agent/             hand-off writer, command building, templates, PATH detection
      export/            md / prompt / json / playwright / element / recording
      review/            checklists, client packs, HTML report, verify runs, verdicts
      browser/           agent browser runtime (sessions, ledger, evidence, drivers)
      automation/        MCP/CLI adapters over the runtime broker
      bundle.js          project bundle export/import
      license.js         offline licence verification + Pro gating
      sync.js            LOCAL-ONLY staging queue (no remote)
      team.js            LOCAL-ONLY workspace/comment records
      billing.js         seat number, data inventory, export and erase (no payments)
      integrations.js    issue/webhook/Slack DRAFT builders, CI starter
      enterprise.js      status of SSO/SCIM (not implemented), built-in templates, schema
      analytics.js       opt-in LOCAL-ONLY event log + user-triggered diagnostics
      updater.js         electron-updater wrapper (user-initiated checks only)
  renderer/              the shell UI (ESM, contextIsolation on, no Node)
    app.js               shell controller (tabs, modes, command bus)
    controllers/         session, audit, recording/replay, verify, agent runs
    components/          panels, modals, coachmarks
    lib/                 persona, dom helpers, e2e harness
  webview/               guest preload: inspector, audit, recorder, replay, anchors
                         (bundled into webview/dist by scripts/bundle-guest.js)
  shared/                code used by more than one process (assertions, redaction, contracts)
schema/                  published .braiwser.json bundle schema
scripts/                 check, e2e launcher, bundle-guest, licence + build-config tooling
test/                    node:test suites (unit, offline, deterministic)
website/                 static marketing/docs site
```

## AI services

`services/ai/index.js` resolves provider, model and credential, then calls
`claude.js` or `openai.js`. Both go through `http.js`, which owns one deadline for the
whole exchange (connection, headers and body) and a cancellation signal; the renderer
cancels with `ai.cancel(requestId)`.

`auth.js` wraps `@flyvendedk799/ai-auth`. A credential lookup has three distinct outcomes:

| Outcome | Result |
| --- | --- |
| a usable credential | the provider is called |
| genuinely none (no login, no key) | local synthesis, `{ local: true, reason: 'no-credential' }`, labelled in the text |
| present but unusable (expired, undecryptable, corrupt login file, unreadable `machine.key`) | `{ ok: false, error }` with what to fix |

The e2e harness takes the same path with credential sources that are all disconnected
(`auth.js`, `DISCONNECTED`); there is no environment shortcut in the decision.
`openai.js` carries a per-model request contract table (`max_completion_tokens` vs
`max_tokens`, system-message handling).

## Licensing and build configuration

`license.js` verifies `BRW1.<payload>.<Ed25519 signature>` tokens against public keys
from `build-config.js`. Whether Pro add-ons are gated is decided by the build, not the
runtime environment: `scripts/gen-build-config.js` writes `src/main/build-config.json`
(git-ignored) for the `release` and `ci` channels; a source run is the unenforced `dev`
channel; a packaged app with no config fails closed. Pro add-on IPC channels are
refused in the main process (`license.assertChannel`, called from the `on()` wrapper in
`ipc/index.js`). Demo licences are signed by an in-process ephemeral key that exists
only in builds with `demoKeys: true`.

## Product surface that is local-only or absent

Sync, team, billing seats, integrations and analytics are records or drafts on this
machine. SSO, SCIM, self-hosted sync, payments and invitation delivery do not exist,
and the services say so in their return values. See the table in the README.

## Data scope

`billing.dataInventory()` lists everything Braiwser stores about the user. Export
(`exportGdprPackage`) and erase (`deleteAccountData`) are driven by it and covered by
`test/release/data-scope.test.js`, so the documented scope and the real scope cannot
silently diverge.

## Testing and CI

- `npm run check` - every file parses, imports resolve, module systems hold.
- `npm run test:unit` - `node --test` over `test/**` and `src/**/*.test.js`.
- `npm run e2e` - `scripts/e2e.js` launches the app (or `--app <packaged binary>`) and
  passes only on a complete `ok: true` report; the app side is `e2e-finalizer.js`.
- CI runs those on Linux, Windows and macOS, runs the suite against each packaged
  artifact, and runs an intentional renderer crash (`BRAIWSER_E2E_CRASH=1`) that must
  make the launcher exit 1, for the dev tree and the packaged app.

Startup budget target: first paint of the shell before AI auth / model refresh
completes (already deferred in `main.js`).
