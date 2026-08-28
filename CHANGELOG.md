# Changelog

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
- The e2e suite grew from 94 to **147 checks**, covering the audit engine and
  finding promotion, device viewports, themes, note search and bulk triage,
  Playwright export, bundle round-trips, and the menu command bus.
- The e2e suite now **exits non-zero when a check fails** — it previously exited 0
  regardless, so a failing suite could not have failed CI.
- CI workflow running both gates under Xvfb, then packaging the unpacked app on
  Linux, macOS and Windows.
- `LICENSE` (MIT) added to match the declared license.

## 0.2.0 and earlier

Multi-tab browsing with history and bookmarks, full-page screenshots via CDP,
journey assertions, agent hand-off, rearrange mode, and the security /
persistence / performance hardening pass. See `docs/V2_PLAN.md` and
`docs/IMPROVEMENT_BACKLOG.md` for the design records.
