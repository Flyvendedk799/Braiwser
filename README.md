# Braiwser

**An annotation-first inspector browser for reviewing web UIs and handing precise
change requests to a coding agent.**

Open any local project or URL, click the elements that need work, leave notes,
audit accessibility, review every breakpoint, record journeys as real tests — then
export the whole review as Markdown, an agent prompt, or a Playwright spec, or run
your coding agent on it without leaving the app.

Think Chrome DevTools' element picker fused with a sticky-note layer, an
accessibility auditor and a journey recorder, purpose-built for turning "this looks
wrong" into something an engineer or an agent can act on directly.

Everything stays on your machine. Projects, notes, journeys and API keys never
leave it; nothing is uploaded unless you run an AI task with your own key.

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

Requires Node 18+ for development. The packaged app bundles its own runtime.

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
| **✥ Rearrange** `⌘⇧M` | Edit the layout live — drag to reorder siblings, Alt-drag to free-move, pull handles to resize, hide elements, or apply a smart re-layout (row / column / grid / tidy). Every change previews on the page *and* is captured as a note carrying the exact CSS or reorder, so it exports straight to an agent. Undo reverts the page and retracts the note. |
| **✓ Assert** `⌘⇧A` | Point at an element to add an assertion to the journey you are recording. |

Notes carry an **action tag** (remove / change / fix / add / question / comment), a
**status** (open / resolved), a **priority** (low → critical), and the **viewport**
they were captured at. Saved notes are re-anchored and re-pinned on the page every
time you reload or revisit that URL (selector → text → position fallback), and the
pin numbers match the Notes panel.

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
- **Copy agent prompt** `⌘⇧C` straight to the clipboard
- **Hand off** `⌘⇧H` writes the change request into the project
  (`<project>/.braiwser/…`, or the app data dir for URL projects) and optionally runs
  a configured coding-agent command right there, streaming its output live
- **AI assistant** — transcribe notes into a polished review, generate an agent
  prompt, cluster by theme, summarize, or suggest a fix for a single note. Choose
  Claude or OpenAI, pick a model, and store the key locally. **With no key it still
  works**, synthesizing a useful result locally from your notes.

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
| Inspect · Draw · Rearrange · Assert | `⌘⇧E` · `⌘⇧D` · `⌘⇧M` · `⌘⇧A` |
| Run page audit | `⌘⇧U` |
| Record · replay journey | `⌘⇧J` · `⌘⇧P` |
| Screenshot viewport · full page | `⌘⇧S` · `⌘⌥S` |
| Notes / Inspector / Audit / AI panel | `⌘1` … `⌘4` |
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
      export/                 # markdown.js, prompt.js, json.js, playwright.js
      agent/handoff.js        # write the request file, run the agent command
      bundle.js               # portable project bundles (export / import)
      format/                 # shared text + console formatters
  renderer/                   # the shell UI (contextIsolation on, no Node)
    index.html · app.js       # controller: state, tabs, command table, all flows
    lib/dom.js                # h()/icon/toast/modal/menu helpers
    lib/screenshots.js        # annotation compositing
    lib/e2e.js                # the end-to-end harness (loads only under CAOS_E2E=1)
    components/               # toolbar, tabs, sidebar, notes, inspector, audit, ai, settings
    styles/app.css            # dark + light themes, one token set
    welcome.html
  webview/                    # injected into the guest page (preload, require enabled)
    inspector.js              # element picker, region drawing, note popup, pins,
                              #   rearrange, DOM-tree serializer
    anchor.js                 # selector / describe / resolve / highlight
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

Storage is plain JSON under Electron's `userData/caos/`, written atomically
(temp file → fsync → rename). API keys live in a separate `secrets.json` there and
are never returned wholesale to the renderer or written into a project directory.

---

## Configuring AI

On first launch, onboarding asks for a local profile name, a default provider
(Claude or OpenAI), model ids, and optional API keys. Change any of it later from
**Profile** in the toolbar or **Settings** (`⌘,`). The model field offers known-good
ids and still accepts free text, so a model released after this build is usable
immediately. The AI tab shows which provider is active and whether it has a key.

Without a key, AI tasks fall back to local synthesis so the app stays fully useful
offline.

---

## Testing

Two gates, both runnable on a bare checkout:

```bash
npm run check      # static: every file parses, imports resolve, module systems hold
npm run e2e        # end-to-end: drives the real app, prints PASS/FAIL per check
npm test           # both
```

The e2e suite boots the actual app and drives it with **trusted input events** —
real mouse and keystrokes into the guest webview, so isolated-world listeners fire
exactly as they do for a user. It covers the whole product: inspect and annotate,
region drawing, rearrange edits, the audit engine and finding promotion, device
viewports, themes, note search and bulk triage, DOM tree, record and replay,
assertions and their failure paths, full-page capture and compositing, tabs,
history and bookmarks, persistence and restore, exports (Markdown / prompt / JSON /
Playwright), project bundle round-trips, the agent hand-off, and the menu command
bus. **147 checks.** It exits non-zero when any check fails, so CI goes red.

CI (`.github/workflows/ci.yml`) runs both gates under Xvfb and then builds the
unpacked app on Linux, macOS and Windows.

---

## License

MIT — see [LICENSE](LICENSE).
