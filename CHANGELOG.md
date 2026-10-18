# Changelog

## Unreleased

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
