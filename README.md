# Braiwser

**An annotation-first inspector browser for reviewing web UIs and handing precise
change requests to a coding agent.**

Open the sample page (or any local project / URL), click what’s wrong, leave a
note, and copy an agent prompt — usually in under two minutes. Then audit
accessibility, review breakpoints, record journeys as tests, and **verify** the
fix by re-running the audit and journey against a before/after report.

Think Chrome DevTools' element picker fused with a sticky-note layer, an
accessibility auditor and a journey recorder, purpose-built for turning "this looks
wrong" into something an engineer or an agent can act on directly.

Everything stays on your machine. Projects, notes, journeys and API keys never
leave it; the only thing that is ever sent anywhere is the content of an AI task
you run, and only to the provider you connected (Anthropic or OpenAI). There is
no hosted Braiwser service: sync, team workspaces, billing and single sign-on are
**not implemented** (see [What is and is not implemented](#what-is-and-is-not-implemented)).

---

## Install and run

```bash
npm install
npm start            # or: npm run dev   (devtools + console forwarding)
```

Package a distributable (dmg / nsis / AppImage):

```bash
npm run dist         # installers
npm run dist:dir     # unpacked app, faster
```

Requires **Node 20+** for development (`engines` enforces it; the `@flyvendedk799/ai-auth`
dependency needs it, and the CI uses Node 22). The packaged app bundles its own runtime.

Releases bake their licence configuration in at build time: see
[Licensing and releases](#licensing-and-releases).

---

## What it does

### Browse

Full browser chrome: multiple tabs, back/forward/reload with a live loading state,
an address bar that accepts URLs, bare domains, absolute paths or a search phrase,
autocomplete from your history and bookmarks, a security indicator, and per-page
zoom. Open a **File** or a **Folder** (the entry `index.html` is auto-detected) and
Braiwser creates a matching project for you. Open tabs are restored next launch.

### Capture

| Mode | What it does |
| --- | --- |
| **⌖ Inspect** `⌘⇧E` | DevTools-style hover highlight; click an element to capture its selector, id, classes, text, attributes, computed styles and box. |
| **✎ Draw** `⌘⇧D` | Freehand-circle or underline a region of the page and attach a note to that area. |
| **✐ Edit** `⌘⇧T` | The visual editor: click an element, type straight into its text, and drive font, size, weight, line height, letter spacing, alignment, colour, opacity, background, radius, border, padding, margin and size from the **Style** panel. Controls apply live and fold into ONE edit note per element carrying the exact CSS. Every property you touch is marked and revertible on its own; numbers scrub by dragging their label. |
| **✥ Rearrange** `⌘⇧M` | Edit the layout live — drag to reorder siblings, Alt-drag to free-move, pull handles to resize, hide elements, or apply a smart re-layout (row / column / grid / tidy). Every change previews on the page *and* is captured as a note carrying the exact CSS or reorder, so it exports straight to an agent. Undo reverts the page and retracts the note. |
| **✓ Assert** `⌘⇧A` | Point at an element to add an assertion to the journey you are recording. |

Notes carry an **action tag** (remove / change / fix / add / question / comment), a
**status** (open / resolved), a **priority** (low → critical), and the **viewport**
they were captured at. Saved notes are re-anchored and re-pinned on the page every
time you reload or revisit that URL (selector → text → position fallback), and the
pin numbers match the Notes panel.

Page edits — copy, style, reorder, re-parent, resize, hide, re-layout — share one
**undo / redo** history in the header (`⌘⇧Z` / `⌘⇧Y`). Undoing also retracts the
note the edit filed; redoing brings it back.

### Workspace + Page / Review + Ship

The two sidebars have distinct jobs. The left sidebar owns **where and what**:
**Workspace** keeps projects, sessions, journeys, bookmarks and history visible, while
**Page** holds Sections and Layers for the live document. Selecting an element brings
Page forward automatically. Sections names the tree the way you would (heading text,
id, landmark); Layers zooms into the selected container and stacking order.

The right sidebar owns **what to do about it**: Notes, Style, Audit, AI and Verify,
plus the final export / hand-off actions. Both sidebars collapse independently so the
page can take the full canvas without losing quick expand controls.

### Audit `⌘⇧U`

A local accessibility and UI-quality scan that runs *inside* the page, against the
real post-JavaScript DOM. No API key, no network, no build step. It checks:

- **Contrast** — computed text vs. effective (blended, inherited) background, at
  the WCAG AA thresholds for normal and large text
- **Images** — missing `alt`, broken `src`
- **Names and labels** — form fields with no label, buttons and links that announce
  as empty
- **Structure** — missing `<h1>`, skipped heading levels, missing `<main>`,
  duplicate ids, positive `tabindex`, untitled frames
- **Document** — missing `lang`, empty `<title>`, no responsive viewport meta
- **Ergonomics** — tap targets below 24×24 CSS px, text below 11px

Findings are ranked by severity, filterable, and each one can be **located on the
page** or **promoted into a real note** in one click — arriving already triaged, so
audit output flows into the same export and hand-off pipeline as manual capture.

### Review responsively

Switch the guest viewport between **Mobile / Mobile L / Tablet / Laptop / Desktop**
(or fit-to-window) and rotate it. The page renders at exact CSS pixel sizes, and
every note records the viewport it was taken at — so a responsive bug reaches the
agent with the width needed to reproduce it.

### Record, replay, test

Record a real user journey (clicks, inputs, keys, scrolls, navigations), then replay
it step-by-step through the browser. Replay produces a **pass/fail report per step**
that is saved on the recording, so a journey doubles as a smoke test. Add
**assertions** — element exists / visible / text / count / URL — via Assert mode or
the recording editor, and replay reports `actual` vs. expected.

Any journey **exports as a runnable Playwright spec** (`npx playwright test`), or as
raw JSON for archiving.

### Organize

Reviews live in **projects** → **sessions**, with **bookmarks** and **history** in the
sidebar. A whole project — sessions, notes and recordings — exports as a portable
`.braiwser.json` **bundle** and imports back on any machine. Imports are re-keyed
onto fresh ids, so importing twice makes two independent copies rather than
corrupting what you already have.

### Ship it

- **Export** Markdown (a readable review doc), an **agent prompt** (imperative,
  priority-ordered, selector-precise), or JSON — plus annotated screenshots
  (viewport or full page, captured beyond the viewport via CDP)
- **Export a single element** — click any element and hit **Export** in the Style
  panel. You get a standalone `.html` (assets inlined as data URIs), or a `.zip`
  (`index.html`, `styles.css`, `assets/`, `element.json`, `README.md`) when it
  carries real files. The capture takes the page's own matching CSS — hover states,
  media queries, custom properties, @font-face, keyframes — and falls back to baked
  computed styles when the stylesheets are cross-origin
- **Export a journey** as a video (`.webm`), a PDF report, Markdown, a Playwright
  spec, or raw JSON
- **Copy agent prompt** `⌘⇧C` straight to the clipboard
- **Hand off** `⌘⇧H` writes the change request into the project
  (`<project>/.braiwser/…`, or the app data dir for URL projects) and optionally runs
  a configured coding-agent command right there, streaming its output live
- **AI assistant** — transcribe notes into a polished review, generate an agent
  prompt, cluster by theme, summarize, or suggest a fix for a single note. If the
  `claude` CLI is signed in on your machine it works with **nothing configured** —
  the call goes on that subscription. Otherwise sign in to a Claude subscription
  from Settings, or paste an Anthropic/OpenAI API key. **With no credential at all
  it still works**, synthesizing a useful result locally from your notes (the
  result is labelled as locally generated and no model is called). A credential
  that exists but is expired, unreadable or rejected is reported as an error
  instead; it is never quietly replaced by a local answer.

Guest console errors and failed loads are captured (bounded, per tab) and included
in the prompt and Markdown exports, so the agent sees runtime errors next to the
change requests.

---

## Keyboard shortcuts

Press `⌘/` (`Ctrl+/`) in the app for the full list. Every shortcut is also a menu
item, so accelerators work while the page has keyboard focus.

| | |
| --- | --- |
| New / close tab | `⌘T` / `⌘W` |
| Reload · address bar · bookmark | `⌘R` · `⌘L` · `⌘D` |
| Inspect · Draw · Edit · Rearrange · Assert | `⌘⇧E` · `⌘⇧D` · `⌘⇧T` · `⌘⇧M` · `⌘⇧A` |
| Run page audit | `⌘⇧U` |
| Undo · redo page edit | `⌘⇧Z` · `⌘⇧Y` |
| Record · replay journey | `⌘⇧J` · `⌘⇧P` |
| Screenshot viewport · full page | `⌘⇧S` · `⌘⌥S` |
| Notes / Style / Audit / AI panel | `⌘1` … `⌘4` |
| Search notes | `⌘F` |
| Copy agent prompt · hand off | `⌘⇧C` · `⌘⇧H` |
| Rotate device viewport | `⌘⇧R` |
| Exit the current mode | `Esc` |

---

## Architecture

Electron desktop app. The guest project loads inside a `<webview>`; the inspector
engine is its preload, so it runs *inside* the page (full DOM access, like a content
script) and streams annotations, journey steps and audit findings back to the shell
over `ipc-message`. The shell owns all state and persistence.

```
src/
  main/                       # Electron main process (Node backend)
    main.js                   # app lifecycle, window, webview sandbox policy, theme
    menu.js                   # native menu → command ids dispatched to the renderer
    migrate.js                # one-time userData migration from the old app name
    preload.js                # contextBridge → the entire window.caos API
    config.js                 # action tags, devices, themes, models, shortcuts, defaults
    ipc/index.js              # every IPC handler
    store/
      db.js                   # atomic JSON store (JsonCollection / JsonDocument)
      repositories.js         # projects, sessions, annotations, recordings,
                              #   history, bookmarks, settings, secrets
    services/
      ai/                     # provider-agnostic AI (claude.js, openai.js), prompts.js,
                              #   local.js (offline synthesis)
      export/                 # markdown.js, prompt.js, json.js, playwright.js,
                              #   element.js (one element, standalone), recording.js
      agent/handoff.js        # write the request file, run the agent command
      bundle.js               # portable project bundles (export / import)
      format/                 # shared text + console formatters
  renderer/                   # the shell UI (contextIsolation on, no Node)
    index.html · app.js       # controller: state, tabs, command table, all flows
    lib/dom.js                # h()/icon/toast/modal/menu helpers
    lib/screenshots.js        # annotation compositing
    lib/naming.js             # human names for elements (headings, ids, landmarks)
    lib/e2e.js                # the end-to-end harness (loads only under CAOS_E2E=1)
    components/               # toolbar, tabs, sidebar, sections, layers, notes,
                              #   style, audit, ai, settings
    styles/app.css            # dark + light themes, one token set
    welcome.html
  webview/                    # injected into the guest page (preload, require enabled)
    inspector.js              # element picker, region drawing, note popup, pins,
                              #   rearrange, DOM-tree serializer
    anchor.js                 # selector / describe / resolve / highlight
    element-export.js         # lift one element + its real CSS off the page
    audit.js                  # the offline accessibility & quality engine
    recorder.js               # capture user actions as steps
    replay.js                 # re-execute steps + evaluate assertions
```

**Invariants** (enforced by `npm run check`): `contextIsolation` is on everywhere;
the guest webview runs `sandbox=no` only so the inspector preload can `require()`
its siblings; the renderer is ESM talking exclusively through `window.caos`; main
and webview code is CommonJS.

### Data model

- **Project** `{ id, name, path, kind, createdAt, lastOpenedAt }`
- **Session** `{ id, projectId, name, url, title, createdAt, updatedAt }`
- **Annotation** `{ id, sessionId, kind:'element'|'region'|'edit', action, note, target,
  url, viewport, status, priority, edit?, … }`
- **Recording** `{ id, projectId, name, startUrl, steps[], lastRun? }`

Storage is plain JSON under Electron's `userData/braiwser/` (migrated from
`userData/caos/` on first launch), written atomically
(temp file → fsync → rename). Credentials live in a separate `credentials.json`
there, encrypted at rest (AES-256-GCM under a per-machine secret, itself kept in
the OS keyring where one is available). No channel returns a key to the renderer:
the settings page is sent a mask such as `sk-ant-…9ZQ`, never the value.

The renderer talks to main through `window.braiwser` (with `window.caos` kept as
a compatibility alias during the rename period).

---

## Configuring AI

There are four ways to pay for a call, handled by
[`@flyvendedk799/ai-auth`](https://github.com/Flyvendedk799/ai-auth):

| Provider | Credential | How to connect |
| --- | --- | --- |
| **Claude subscription** | OAuth | Automatic if `claude` is signed in here, or **Sign in with Claude** in Settings |
| **ChatGPT subscription** | OAuth | Automatic if `codex` is signed in here |
| **Anthropic API key** | Metered key | Paste it in Settings, or set `ANTHROPIC_API_KEY` |
| **OpenAI API key** | Metered key | Paste it in Settings, or set `OPENAI_API_KEY` |

The subscription paths read the login the CLI already wrote and never disturb it:
the file is re-read on every call, so signing out of `claude` is noticed at once,
and a token is only refreshed once it has actually expired.

On first launch, pick Agent / Reviewer / Agency. **Open sample page** lands on a
planted shop with Inspect and a 3-step coach. **Skip** leaves you on the launcher
without the tour — Help → Try Sample Page anytime. Connect AI later from
**Profile** / **Settings** (`⌘,`) if you want; local synthesis already works with
nothing configured. The toolbar shows the tools for your persona; everything else
stays in **More tools** and the native menu. After a hand-off, **Verify session**
re-runs the audit and journey and stores a before/after on the session.

With no credential at all, AI tasks fall back to a labelled local synthesis so the
app stays useful offline. If a credential is present but unusable (expired login,
undecryptable saved key, damaged login file) the task fails with a message that
says what to fix. AI calls honour the configured timeout through the whole
response, not just the headers, and can be cancelled from the panel.

---

## What is and is not implemented

| Area | Status |
| --- | --- |
| Inspect, annotate, audit, journeys, exports, hand-off, local AI synthesis | Implemented. |
| AI through Claude / ChatGPT subscription or your own API key | Implemented; a real provider call needs a credential. |
| Cloud sync | **Local-only.** "Sign in" stores an email on this machine; the queue stages encrypted snapshots locally and uploads nothing. It is not a backup. |
| Team workspaces, invitations, roles | **Local-only records.** Invitations are not sent; roles are not enforced; comments are not shared. |
| Billing / checkout / seats | **Not implemented.** Seat counts are local numbers; there is no payment flow. |
| SSO (SAML/OIDC), SCIM, self-hosted sync | **Not implemented.** Reported as `not-implemented`; configuring them is refused. |
| Integrations (GitHub / Linear / Jira / Slack / webhooks) | **Drafts only.** Braiwser builds the payload; it does not authenticate with or send to those services. A CI workflow starter can be written to your project. |
| Licences | Offline, Ed25519-verified tokens. See below. |
| Data export / erase | Covers every item in the data inventory (`billing.dataInventory`): projects, review sessions, notes, journeys, comments, bookmarks, history, workspaces, analytics, audit log, sync queue, your profile / agency / integration settings, the licence, and the stored AI credentials and key files. It does not touch files you exported, handoff files written into your project folders, embedded-browser site data, or logins owned by the `claude` / `codex` CLIs. |

---

## Licensing and releases

A licence is `BRW1.<payload>.<signature>`, signed with **Ed25519**. The app embeds
only a *public* key and verifies offline; it cannot mint a licence. The private key
never enters the repository (`.license-keys/` is git-ignored).

Whether Pro features are gated is decided at **build time**, not by the environment
the installed app runs in:

- `scripts/gen-build-config.js --channel release` writes `src/main/build-config.json`
  (git-ignored, packed into the app): licences enforced, no demo keys, no e2e bypass,
  and it **fails the build** without `BRAIWSER_LICENSE_PUBLIC_KEY`. `release.yml` does
  this and then checks the packed `app.asar` with `scripts/verify-packaged-config.js`.
- `--channel ci` enforces licences but keeps demo keys and the e2e bypass so the
  packaged smoke test can drive Pro features; those builds are never published.
- Running from source (`npm start`) is a **development build**: nothing is enforced and
  Pro features are unlocked for everyone. `license.status().build` says so
  (`channel: 'dev'`, `proUnlockedForAll: true`) so the UI can label it. A packaged build
  with no generated config fails closed (gated, no demo keys).

Maintainers:

```bash
npm run license:keypair                         # writes .license-keys/ (private key stays local)
BRAIWSER_LICENSE_PUBLIC_KEY="$(cat .license-keys/license-public.pem)" \
  node scripts/gen-build-config.js --channel release
npm run license:issue -- --email a@b.co --tier pro --days 365
```

Set the repository variable `BRAIWSER_LICENSE_PUBLIC_KEY` (the public PEM) for
`release.yml`. For local development, `BRAIWSER_LICENSE_PUBLIC_KEY` in the
environment of a *source* run is trusted; in a packaged app it is ignored.

---

## Testing

Two gates, both runnable on a bare checkout:

```bash
npm run check      # static: every file parses, imports resolve, module systems hold
npm run test:unit  # deterministic, offline unit tests (node --test)
npm run e2e        # end-to-end: drives the real app, prints PASS/FAIL per check
npm test           # all three
```

`npm run e2e` is a launcher (`scripts/e2e.js`). It does not trust the app's exit
code alone: the run passes only if the app writes a complete `ok: true` report
(the `BRAIWSER_E2E_REPORT` stdout line the app prints, or a JSON file at `BRAIWSER_E2E_REPORT_FILE`). A crash, a
hang, a missing/partial report or a failed check all fail it (exit 1; 2 on timeout;
3 for a harness error). `node scripts/e2e.js --app <packaged binary>` runs the same
suite against a packaged build, and `BRAIWSER_E2E_CRASH=1` deliberately kills the
renderer mid-suite so CI can prove the gate goes red.

The e2e suite boots the actual app and drives it with **trusted input events** —
real mouse and keystrokes into the guest webview, so isolated-world listeners fire
exactly as they do for a user. It covers the whole product: inspect and annotate,
region drawing, rearrange edits, the audit engine and finding promotion, device
viewports, themes, note search and bulk triage, DOM tree, record and replay,
assertions and their failure paths, full-page capture and compositing, tabs,
history and bookmarks, persistence and restore, exports (Markdown / prompt / JSON /
Playwright), project bundle round-trips, the agent hand-off, the menu command
bus, and product-platform foundations (license, templates, checklists, schema).
It exits non-zero when any check fails, so CI goes red.

CI (`.github/workflows/ci.yml`) runs `check` and `test:unit`; runs the behavioural
e2e suite on Linux (Xvfb), Windows and macOS; builds the unpacked app on all three
and runs the whole suite **again against each packaged artifact** — which is what
proves the bundle is real, most importantly that the webview's inspector preload
still loads from inside `app.asar`. Every one of those jobs is followed by an
intentional-renderer-crash step that must make the launcher exit 1, for both the
dev tree and the packaged app.

---

## License

MIT — see [LICENSE](LICENSE).
