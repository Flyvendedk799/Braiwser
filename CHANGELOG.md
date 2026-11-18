# Changelog

## Unreleased

### Closing the loop: notes an agent can prove fixed

- **Recorder.** Click, input, key and picked-assertion steps carry a semantic locator (a test id, or a role and
  accessible name) whenever it names exactly one element. It is computed by the same in-page probe the agent runtime
  observes with, so journeys recorded without test ids now migrate into `verify-journey`. Label clicks are marked and
  dropped by the migration; ambiguous or unnamed elements still get no locator and are refused per step. Bundle import
  keeps valid locators and the Playwright export prefers them over positional CSS paths.
- **Notes as checks.** Notes that carry an exact change (Edit, Rearrange, "remove") derive checks
  (`src/shared/note-checks.js`). In-app Verify grades each note of the page as fixed, not fixed, regressed, could not
  check or needs a person, and a run fails when an exact change is demonstrably missing. Nothing is graded while a live
  edit preview is still applied to the page. Note targets now record a semantic locator too.
- **`style` assertion** in the shared assertion language, plans and in-app replay: one computed property compared with
  what the browser computes for the declared value on the same element. Declarations that could fetch are refused. Not
  emitted by the Playwright export.
- **Review over MCP and the CLI.** `review_notes`, `review_note`, `review_journeys`, `review_note_claim`,
  `review_note_propose`, `review_note_report`, and the `verify-notes` skill. Only a verdict the broker reads from a
  finished run can resolve a note; a failed proof re-opens one. New scopes `review:read` and `review:write`, separate
  from browsing.
- **Same tools in every deployment.** The desktop app serves its own store; the standalone owner (local, proxy/OpenBot,
  container) serves a read-only directory of exported bundles (`reviewDir`) and keeps agent reports in its data
  directory. `verify-journey` therefore works on the standalone owner for the first time.
- **`browser_pages`** lists a session's pages, so popups and new tabs can be reached.
- **`braiwser mcp`**: one command starts a headless owner and serves MCP on stdio, granting only the origins named on
  the command line. The desktop app accepts `BRAIWSER_AGENT_SCOPES` for its default client file.
- An assertion whose element is missing now reports `TARGET_MISSING` instead of a plain failure code.
- The built-in skill lock was regenerated (`workflow-core.js` changed; `verify-notes@1.0.0` added). Skill versions were
  not bumped because none has been released.

- Capability version is now **1.3.0** (seven added tools, nothing changed shape). Embedders that pin the exact tool set
  (OpenBot) must accept it explicitly; see `docs/standalone-handoff.md`.
- The redirect-hop guard is opt-in for direct users of the driver (`enforceRedirectHops`), and the broker always opts
  in. Enabled unconditionally it blocked every request of an embedder that decides requests in its own route, which is
  how SandboxOS's Browser uses the driver.

Not done: `compare-fix` is still a library orchestration, not a `browser_run` skill. Delta observations are still not
exposed. Downloads and uploads are still unsupported. The desktop review source has unit coverage only; no external MCP
client has driven it against the running app.

### Agent runtime: driver capability gaps

- Playwright driver: redirect hops are now checked against the destination policy before they are sent. Until now
  only the first URL of a request was checked and a redirect to an origin outside the grant was noticed on arrival,
  after that origin's server had already been contacted. A browser-level request interception (CDP `Fetch` on the
  browser target, request stage only) now asks the same `requestFilter` about every hop of navigations, popups,
  frames (also out-of-process), subresources and dedicated/shared/service workers; a denied hop fails with
  `ERR_BLOCKED_BY_CLIENT`. The filter receives `{ navigation, redirect }`. Redirects inside the grant are unchanged
  (cookies set on the redirect response, `307` POST bodies, one request per hop). Verified with headless Chromium
  against local servers. Still not covered: WebSocket/WebRTC, `data:`/`blob:` documents.
- Electron-embedded driver: `select`, screenshots and open shadow roots are now reported as supported, each after a
  run against real Electron (`test/agent-runtime/drivers/electron.native.test.js` starts Electron 44 with a
  `WebContentsView` and a `<webview>` on local fixtures; Linux under Xvfb, device scale 1, 1.5 and 2).
  - `select` works on a native single `<select>`: exactly one option by value (else by label), otherwise refused
    before dispatch. `input`/`change` are fired by the driver, as Playwright does, and are not trusted events.
  - Screenshots: viewport, a clip inside it, and `capture({ refId })` for one observed element that fits in the
    viewport. `capabilities.screenshots` is what the broker checks before a plan with `capture` steps, so such plans
    are no longer refused up front on this driver; that path through the broker was not run against real Electron.
    A zero-sized or hidden view is refused instead of
    returning an empty image.
  - Fixed while verifying: the owner badge was still in Electron screenshots, because `capturePage` copies the last
    presented frame. The driver now waits for a frame without the badge before taking pixels.
  - Open shadow roots were already walked by the shared probe; the flag was off only for lack of a native run.
  - Not changed and still unconfirmed natively: frames, popups, dialogs, downloads, uploads, viewport emulation,
    human takeover, macOS and Windows.

### Hand-off hygiene, Locate across pages, e2e coverage

- Guest console output and load errors are now redacted before they leave the app. The
  capture reaches the prompt and Markdown exports, the agent hand-off file and prompt
  templates through one formatter, which drops query-string values, bearer tokens, JWTs,
  `password=`/`token=`-style pairs and key-like strings, keeps script URLs and line numbers
  readable, and keeps only the 50 most recent entries whatever the renderer sends.
- "Locate on page" for a note on another page: if that page is open in another tab, that
  tab comes to the front; otherwise the current tab opens the page. A tab that is replaying
  is left alone. When it cannot locate, it says why: the page would not load (with the
  error), or the page opened and the element is no longer there.
- Fixed: pressing Escape while editing a note's text saved the edit instead of abandoning
  it. A Ctrl+Enter save was also written twice.
- e2e suite: 354 → 401 checks. New checks drive the Notes panel (priority, edit, resolve,
  reopen, delete), the recording editor dialog (reorder, delete, cancel, save), replay
  guards and failures (nothing selected, empty recording, page that will not load, second
  replay while one runs, cancel), cross-page and cross-tab Locate, and console redaction.
  How to run the suite on a headless Linux machine is in `docs/ARCHITECTURE.md`.
- Internal: the storage-health dialog, the shortcut sheet / About, and the import /
  Playwright export reports moved out of `app.js` into `components/`; Locate moved into
  `controllers/locate.js`. No behaviour change from the moves.
- `docs/IMPROVEMENT_BACKLOG.md` statuses corrected, with what is still open.

### Audit remediation: AI, licensing, release, product truthfulness

AI
- First-run offline AI: with no credential at all, AI tasks answer with a labelled local
  synthesis (`local: true`, `reason: 'no-credential'`) for every provider, including the
  `claude-code` default. An expired, unreadable or rejected credential is now an error
  instead of being hidden. The e2e flag no longer bypasses the credential decision; the
  harness gets disconnected credential sources instead, so tests exercise the production
  path. (AI-01)
- Credential initialisation is single-flight and not cached on failure; an unrecognised,
  unreadable or keyring-encrypted `machine.key` is reported and never overwritten, and a
  saved key that cannot be decrypted is an error rather than "no key".
- AI deadlines now cover the response body and error bodies (`ai/http.js`); tasks can be
  cancelled through `ai.cancel(requestId)`; credential resolution runs under the same
  deadline. (AI-02)
- OpenAI chat requests use a per-model contract table (`max_completion_tokens` for the
  o-series, gpt-5 and gpt-4.1/4o; `max_tokens` only for legacy models).

### Agent runtime: handoff v2, in-app runner, coding-agent surface

- Session handoff can pause without giving the caller human control. Resume consumes a one-use grant held by the broker. A restarted broker closes the saved handoff because the live browser is gone.
- The loopback viewer redeems a one-time code for an HttpOnly cookie. Writes also need a matching Origin and CSRF token. Private input suspends observations. A remote deployment refuses a loopback viewer URL.
- MCP and the CLI expose `browser_run_pause`, `browser_handoff_status` and `browser_run_resume` beside the existing tools. The invitation code is not part of the tool result.
- The in-app task runner calls the broker and cannot approve its own actions. Uncertain effects and approval waits stop the loop. An optional HTTP provider is used only when `BRAIWSER_AGENT_PROVIDER_URL` is set.
- The embedded driver can open a page the main process owns (`WebContentsView`). The shell's own tabs stay `<webview>`. A main-owned page is kept at zero size until the shell reports a rectangle, and that rectangle is clamped to the window. Capability flags stay conservative until a native run confirms them.

Licensing and release
- Licences are Ed25519-signed (`BRW1.` prefix kept) and verified against a public key
  baked in at build time; the shared HMAC secret and its `BRAIWSER_LICENSE_SECRET`
  override are gone, and HMAC-era keys are rejected. Gating comes from
  `src/main/build-config.json` written by `scripts/gen-build-config.js`, not from the
  runtime environment; a packaged build with no config fails closed. Pro add-on IPC
  channels are refused in the main process in enforcing builds. Demo licences exist only
  in dev/CI builds and are signed by an in-process ephemeral key. Source runs are labelled
  as development builds (`license.status().build`). `scripts/gen-license-keypair.js` and
  `scripts/issue-license.js` added; private keys are git-ignored. (REL-02)
- `scripts/e2e.js` now parses the app's report and fails on a crash, hang, missing,
  partial or `ok: false` report as well as a non-zero exit; supports `--app` for packaged
  builds; scrubs credentials from the test environment; exit codes 0/1/2/3. (REL-03)
- CI: `check` + `test:unit`; behavioural e2e on Linux, Windows and macOS; packaged e2e on
  all three; an intentional renderer crash (`BRAIWSER_E2E_CRASH=1`, injected over CDP)
  must fail the launcher for the dev tree and the packaged app. The release workflow
  bakes the release config, fails without a licence public key and verifies the packed
  `app.asar`.
- Node 20+ is documented everywhere (the `ai-auth` dependency requires it).

Product truthfulness
- Sync, team, billing, integrations and analytics are labelled local-only/draft in their
  return values, README, docs and website. Enterprise no longer reports SSO `ready: true`
  or a SCIM endpoint (`not-implemented`), and configuring SSO is refused. Checkout creation
  is `not-implemented` instead of returning a checkout-shaped link. Sync queue items are
  `staged-local`, not "synced".
- Data export/erase are driven by a data inventory (`billing.dataInventory`) and tested
  against it: comments, bookmarks, history, workspaces, profile/agency/integration settings,
  licence and credential files are now covered; the remaining out-of-scope items are
  listed. Previously erase left projects, notes, comments and more.
- Updater makes no network call until the user asks, and is skipped in source runs.

UI polish pass on the aha-loop shell.

- Left and right rails now have clear jobs: Workspace/Page on the left,
  Review & Ship on the right. Both collapse independently and persist.
- Skip onboarding no longer opens the sample page; only **Open sample page** starts Inspect + coach.
- Coach is a real dialog (Escape, Done, spotlight, Notes on step 2). Welcome, playground, toolbar, and light theme follow the same tokens.
- Settings grouped into General / Agent / Privacy / Advanced. Verify, notes, and overlays pick up empty states, busy Run, and keyboard menus.

Aha loop, then prove the fix.

- Sample playground + welcome launcher (open folder / file / URL / try the sample).
- Slim first-run: pick a persona, skip AI keys, land on the sample page with Inspect and a 3-step coach.
- Persona actually shapes the toolbar, tabs, and footer primary action; extras live in More tools.
- Detect `claude` / `cursor-agent` / `codex` on PATH; preset picker in Settings and the hand-off modal.
- Next-action rail after the first note (copy prompt, hand off, audit, client pack).
- **Verify session**: re-audit + optional journey replay, persist a before/after (including screenshots) on the session.
- Optional cloud sync in Settings is labeled experimental.

## 1.1.0

Productization release: MVP → full end-to-end product foundations for solo
builders, design/QA, and agencies — with optional cloud/team seams ahead.

### Identity and data

- Store folder renamed to `userData/braiwser/` (migrates from `caos/`).
- Explicit **schema version** + migrations; `window.braiwser` API with `window.caos` alias.
- E2E flag: `BRAIWSER_E2E` (alias `CAOS_E2E` still accepted).

### Workflows

- Persona onboarding (Agent / Reviewer / Agency) with persona-aware empty states.
- Note drag-reorder, client/internal visibility, configurable AI timeout.
- Handoff templates, agent presets, review checklists, client packs, static HTML reports.
- Full-page capture softens `position:fixed`/`sticky` chrome; replay allows tab switching.

### Distribution and GTM

- `electron-updater` wiring, GitHub Release workflow, marketing site under `website/`.
- Published `.braiwser.json` schema; architecture + support docs.

### Monetization and platform

- Local Pro license activation (`BRW1.…`), Free/Pro feature list (soft until enforce flag).
- Opt-in analytics + diagnostics; optional sync sign-in + encrypted snapshot queue.
- Team workspaces/comments, billing/GDPR helpers, integrations (issue drafts, CI starter),
  enterprise SSO/marketplace stubs.

## 1.0.0

The release that takes Braiwser from a capable prototype to a finished product.

### Identity and shell

- Renamed from **Chrome AI OS** to **Braiwser** throughout, with a one-time
  `userData` migration so an existing store is carried across rather than
  orphaned. The old directory is left untouched.
- **Native application menu** (File / Edit / View / Go / Review / Help) dispatching
  command ids to a single renderer command table. Accelerators now fire while the
  guest `<webview>` holds keyboard focus — something a renderer `keydown` listener
  could never see, which is why most of the app was previously mouse-only.
  `Escape` deliberately stays renderer-side so modals and text fields keep it.
- **About** and **Keyboard Shortcuts** dialogs, driven by the same shortcut table
  the menu is built from, so the two cannot drift.
- Per-page **zoom** and a **Toggle Page DevTools** command for the guest page.

### Appearance

- A real **theme system**: dark, light, and follow-the-system, as one token swap.
  `nativeTheme` is kept in step so native dialogs and the welcome page follow too.
  Switchable live from Settings or the View menu. (The `theme` setting previously
  existed but did nothing.)
- The **accessibility pass** that earlier notes described but never shipped:
  `:focus-visible` rings, `prefers-reduced-motion` handling, keyboard-operable
  sidebar rows, tab chips with a roving tabindex and arrow-key navigation, and
  keyboard-operable DOM-tree nodes.

### Reviewing

- **Page audit** (`⌘⇧U`) — a new offline accessibility and UI-quality engine that
  runs inside the guest page against the real post-JavaScript DOM: contrast against
  the effective blended background, missing alt text, broken images, unlabelled
  form fields, controls that announce as empty, heading structure, duplicate ids,
  positive tabindex, untitled frames, document `lang` / `<title>` / viewport meta,
  tap targets under 24×24, and tiny text. Findings are ranked by severity,
  filterable, locatable on the page, and promotable into real notes in one click —
  arriving already triaged. No API key, no network.
- **Device viewport emulation** — mobile / tablet / laptop / desktop presets plus
  rotate, rendering the page at exact CSS pixel sizes. Every annotation now records
  the viewport it was captured at, and exports carry it, so a responsive finding
  reaches an agent with the width needed to reproduce it.
- **Note search** across note text, selectors, element text, page and action, plus
  **multi-select bulk triage** (resolve, reopen, set priority, delete).
- Notes show the viewport they were taken at and flag when they belong to another
  page.

### Output

- **Playwright export** — any recorded journey converts to a runnable
  `@playwright/test` spec, mapping navigate / click / fill / press / scroll and
  every assertion kind, so a review artefact becomes a regression test in your
  repo. Journeys also export as raw JSON.
- **Project bundles** — export a whole project (sessions, notes, recordings) as a
  portable `.braiwser.json` file and import it on another machine. Imports are
  re-keyed onto fresh ids, so importing twice yields two independent copies rather
  than corrupting existing data, and a non-bundle file is refused outright.
- Agent hand-off now writes to `<project>/.braiwser/` (was `.caos/`).
- Current AI model defaults, and a Settings model picker offering known-good ids
  while still accepting free text for models released after this build.

### Quality

- `npm run check` — a dependency-free static gate: every source file parses,
  renderer imports resolve, and the module-system invariant holds (renderer ESM
  under `contextIsolation`, main and webview CommonJS).
- The e2e suite grew from 94 to **149 checks**, covering the audit engine and
  finding promotion, device viewports, themes, note search and bulk triage,
  Playwright export, bundle round-trips, and the menu command bus.
- The e2e suite now **exits non-zero when a check fails** — it previously exited 0
  regardless, so a failing suite could not have failed CI.
- CI workflow running both gates under Xvfb, packaging the unpacked app on
  Linux, macOS and Windows, and re-running the whole suite against the packaged
  Linux artifact — which is what proves the webview's inspector preload still
  loads from inside `app.asar`.
- `anchor.cssPath` now names `<html>` and `<body>` instead of returning an empty
  selector, so page-level targets resolve and highlight.
- `LICENSE` (MIT) added to match the declared license.

## 0.2.0 and earlier

Multi-tab browsing with history and bookmarks, full-page screenshots via CDP,
journey assertions, agent hand-off, rearrange mode, and the security /
persistence / performance hardening pass. See `docs/V2_PLAN.md` and
`docs/IMPROVEMENT_BACKLOG.md` for the design records.
