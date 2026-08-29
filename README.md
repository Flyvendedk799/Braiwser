# Chrome AI OS

An **annotation-first inspector browser** for agentic UI testing. Open any local
web project (or any URL), click directly on any UI element to capture exactly what
it is, leave notes ("remove this", "fix that"), **record & replay user journeys**,
and export the whole review as a **Markdown doc**, an **AI fix-prompt**, or **JSON** —
or run an AI pass over it right inside the app.

Think Chrome DevTools' element picker fused with a sticky-note layer and a journey
recorder, purpose-built for reviewing web apps and feeding precise change requests
to a coding agent.

## Features

- 🌐 **Open anything** — a local project folder (auto-detects `index.html`), a single
  file, or any URL. Full back/forward/reload + address bar (with **autocomplete** from
  history/bookmarks), **multiple tabs**, and **history + bookmarks** (☆ in the address
  bar; both in the sidebar's Library drawer).
- ⌖ **Inspect mode** — DevTools-style hover highlight; click an element to capture its
  CSS selector, id, classes, text, attributes, computed styles, and bounding box. The
  click drops a **comment bubble** on the element’s top-right corner — open it when you
  are ready to write. Elements that already carry notes keep their bubble on the page
  with the number of notes on them, whether or not anything is selected.
  Clicking also lights the element up in the Sections tree; double-clicking hands it to
  Edit mode. Tools switch with `Ctrl/⌘1`–`4`.
- ✎ **Draw mode** — freehand-circle (or underline) a region and attach a note to it.
- ✎ **Edit mode** — the visual editor: click any element to select it, type straight
  into its text, and drive font, size, weight, line height, letter spacing,
  alignment, colour, opacity, background, radius, border, padding, margin and size
  from the **Style** panel. Controls apply live as you drag them and fold into ONE
  edit note per element carrying the exact CSS. Double-click text in Inspect mode to
  land here with the caret already in it. Every property you touch is marked and
  revertible on its own, numbers scrub by dragging their label, colours come with the
  page's own palette, sizes take px / rem / em / %, and **Copy CSS** / **Reset** sit in
  the panel header.
- 📦 **Export a single element** — like a login button on some site? Click it and hit
  **Export** in the Style panel. You get a standalone `.html` (assets inlined as data
  URIs) — or a `.zip` (`index.html`, `styles.css`, `assets/`, `element.json`,
  `README.md`) when it carries real files. The capture takes the page's own matching
  CSS rules — hover states, media queries, custom properties, @font-face, keyframes —
  plus the typography and surface it was sitting in, and falls back to baked computed
  styles when the stylesheets are cross-origin (the manifest says which mode was used).
- ↶ **Undo / redo** — in the header, across every kind of page edit (copy, style,
  reorder, re-parent, resize, hide, re-layout). Undo also retracts the note it filed;
  redo brings it back. `Ctrl/⌘Z` and `Ctrl/⌘⇧Z`.
- ✥ **Rearrange mode** — edit the layout live: drag any element to move it (among its
  siblings or into another container) with a ghost under the cursor and the drop slot
  shown as you go, click the selection again to go a level deeper, Alt-drag to
  free-move, pull handles to resize, hide elements, or apply a smart re-layout
  (row / column / grid / tidy) to a container.
  Every change is previewed on the page AND captured as an `edit` note carrying the
  exact CSS / reorder details, so it exports straight to a coding agent. Undo/Reset
  revert the page and retract the notes.
- 🏷️ **Action tags & triage** — remove / change / fix / add / question / comment, plus
  per-note **status** (open/resolved) and **priority** (low→critical).
- 📌 **Persistent pins** — saved annotations are re-anchored and re-pinned on the page
  every time you reload or revisit a URL (selector → text → position fallback).
- 🗂️ **Projects & sessions** — organize reviews into projects and named review sessions;
  everything is persisted locally.
- 🎬 **Record & replay** — capture a real user journey (clicks, inputs, keys, scrolls,
  navigations) and replay it step-by-step through the browser.
- 🧱 **Sections & Layers** — the left sidebar is the page: **Sections** lists it as a
  Shopify-style tree named the way you'd name it (heading text, id, landmark), where a
  click selects and jumps to the element, the eye hides it, and dragging a row reorders
  it; **Layers** zooms in on the selected element's container and stacking order. Both
  record their changes as `edit` notes. Projects, sessions, recordings, bookmarks and
  history are folded away behind the **Library** button at the bottom.
- 🤖 **AI assistant** — transcribe notes into a polished review, generate a coding-agent
  prompt, cluster by theme, or summarize. First-run onboarding and the always-available
  **Profile** control let you choose Claude or OpenAI, set each model, and add or replace
  provider API keys at any time. Keys are stored locally in app data and **never** written
  into a project. **Works offline too**: with no key it synthesizes a useful result
  locally from your notes.
- 🧪 **Replay-as-test** — every replay produces a pass/fail report per step (resolved /
  timed-out), saved on the recording, so a journey doubles as a smoke test. Author
  **assertions** (element exists / visible / text / count / URL) via the "Assert" mode or
  the recording editor — replay evaluates them and reports `actual` vs expected.
- 🤝 **Agent hand-off** — "→ Agent" writes the change-request prompt into the project
  (`<project>/.caos/request-*.md`) and can run a configurable coding-agent command
  (`claude -p "{promptPath}"`) right there, streaming its output live.
- 📤 **Export** — Markdown / AI-prompt / JSON, plus screenshots with annotations baked
  in (the camera offers **Viewport** or **Full page** — the latter captures beyond the
  viewport via CDP and composites annotations at page coordinates).

## Run

```bash
cd "Chrome AI OS"
npm install
npm start          # or: npm run dev  (devtools + console forwarding)
```

Package a distributable (dmg / nsis / AppImage):

```bash
npm run dist
```

## Architecture

Electron (Chromium) desktop app. The guest project loads inside a `<webview>`; the
inspector engine is its preload, so it runs *inside* the page (full DOM access, like a
content script) and streams annotations/steps back to the shell over `ipc-message`.
The shell owns all state and persistence.

```
src/
  main/                       # Electron main process (Node backend)
    main.js                   # app lifecycle, window, webview sandbox policy, dev logging
    preload.js                # contextBridge → the entire window.caos API
    config.js                 # action tags, AI tasks, default settings (shared via IPC)
    ipc/index.js              # every IPC handler (projects/sessions/annotations/…)
    store/
      db.js                   # atomic JSON store (JsonCollection / JsonDocument)
      repositories.js         # domain repos: projects, sessions, annotations, recordings, settings, secrets
    services/
      ai/                     # provider-agnostic AI (claude.js, openai.js via fetch), prompts.js
      export/                 # markdown.js, prompt.js, json.js, index.js
  renderer/                   # the shell UI (contextIsolation on, no Node)
    index.html · app.js       # controller: state, webview wiring, all flows
    lib/dom.js                # h()/toast/modal/confirm helpers
    components/               # toolbar, sidebar, sections-panel, layers-panel, notes-panel, ai-panel, settings-modal
    styles/app.css            # dark theme
    welcome.html
  webview/                    # injected into the guest page (preload, Node require enabled)
    inspector.js              # entry: element picker, region drawing, note popup, pins, DOM-tree serializer
    anchor.js                 # selector / describe / resolve / highlight
    recorder.js               # capture user actions as steps
    replay.js                 # re-execute steps against the live page
```

### Data model

- **Project** `{ id, name, path, kind, createdAt, lastOpenedAt }`
- **Session** `{ id, projectId, name, url, title, createdAt, updatedAt }`
- **Annotation** `{ id, sessionId, kind:'element'|'region', action, note, target, url, status, priority, … }`
- **Recording** `{ id, projectId, name, startUrl, steps[], … }`

Storage lives under Electron's `userData/caos/` as JSON. API keys live in a separate
`secrets.json` there and are never returned wholesale to the renderer or written to a
project directory.

## Configuring AI

On first launch, the onboarding flow asks for a local profile name, a default provider
(Claude or OpenAI), model IDs, and optional API keys. You can change all of that later
from **Profile** in the toolbar. The AI tab shows which provider is active and whether
that provider has a key. Without a key, AI tasks use the local fallback so the rest of
the app continues to work offline.

## Testing

An end-to-end self-test drives the real app (host + guest webview) with **trusted
input events** — it opens a fixture, inspects/annotates/persists, restores pins,
serializes the DOM tree, records & replays a journey against the live page, and
checks all exports + the local-AI fallback. 27 checks.

```bash
npm run e2e        # boots headless-ish, prints PASS/FAIL per check, exits
```

The harness and fixture live under `src/renderer/lib/e2e.js` + `src/renderer/__e2e/`
and only load when `CAOS_E2E=1`.

## Roadmap

- Assertion authoring polish; richer agent-handoff integrations.

All four `docs/V2_PLAN.md` phases are done (agent hand-off, assertions, full-page
screenshots, multi-tab + history/bookmarks + address-bar autocomplete). The e2e suite
covers them at **51 checks**.
