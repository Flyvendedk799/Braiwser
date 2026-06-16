# Chrome AI OS — v2 plan

Four features, grounded in the current codebase. Each is scoped with: contract
changes, files touched, approach, verification (extend `npm run e2e`), effort, risk.

The JSON store is schema-free, so all new fields/collections need **no migration**.
**Golden rule:** re-run `npm run e2e` after every phase; keep the 27 baseline checks
green and add new ones. Commit per phase.

Recommended order (low-risk/high-value first, the big refactor last):
**Phase 1 — Agent hand-off → Phase 2 — Assertions → Phase 3 — Full-page screenshots → Phase 4 — Multi-tab.**

---

## Phase 1 — Direct agent hand-off ✅ DONE

> Shipped. `services/agent/handoff.js` (`writeRequest` + `runCommand`),
> `caos:agent.write` / `caos:agent.run` / `caos:reveal` IPC, `caos.agent.*` +
> `caos.fs.reveal` preload, `agentCommand` setting + Settings field, a "→ Agent"
> button in the panel footer opening a hand-off modal with live streamed output
> and Reveal. e2e suite now 30/30 (writes file, runs command, reads it back).

**Goal:** turn a review session into action without leaving the app — write the
change-request prompt into the project and (optionally) run a coding agent on it.

**Layered design (recommended):**
1. *Always:* build the prompt (reuse `services/export/prompt.js`) and write it to
   `<project.path>/.caos/request-<stamp>.md` when the project is `kind:'local'`.
2. *Opt-in:* if `settings.agentCommand` is set (e.g. `claude -p "{promptPath}"`),
   spawn it in the project dir, capture stdout/stderr, stream to a result panel.

**Contract / files**
- `src/main/services/agent/handoff.js` *(new)* — `handoff({ session, annotations, project, settings })`:
  builds prompt, writes file, optionally `child_process.spawn`s the command in
  `project.path`; returns `{ file, ran, exitCode, output }`.
- `src/main/ipc/index.js` — `caos:agent.handoff (sessionId)` → loads session/annotations/
  project/settings, calls handoff.
- `src/main/preload.js` — `caos.agent.handoff(sessionId)`.
- `src/main/config.js` — `DEFAULT_SETTINGS.agentCommand = ''`, `agentRunAuto = false`.
- `src/renderer/components/settings-modal.js` — command template field + auto-run toggle.
- `src/renderer/app.js` — "Hand off" action (toolbar or AI panel) → result modal with
  the written path + live output; "Reveal in Finder" via `shell.showItemInFolder`.

**Verify (e2e):** point a temp project at a temp dir, run handoff with
`agentCommand="cat {promptPath}"`; assert the `.caos/request-*.md` exists, contains the
selector/note, and captured output echoes it.

**Effort:** M · **Risk:** medium (spawning processes — guard on local project, sane
cwd, timeout, surface non-zero exit). File-drop stays the safe default; command is opt-in.

---

## Phase 2 — Assertion steps in recordings (journeys → real tests) ✅ DONE

> Shipped. New `assert` step `{kind:exists|visible|text|count|url, selector?, op, expected}`.
> Evaluated in `replay.js` (own-`[data-caos]`-UI excluded from queries); `url` evaluated
> host-side against the live location. Authoring: an "Assert" toolbar mode that points
> at an element in-page (`caos:assert-pick`) opening a host-side assertion editor, plus a
> full recording editor (open via the pencil on a recording: add/reorder/delete steps &
> assertions). Replay report shows per-step pass/fail + `actual`; recordings show
> `✓/✗ p/t` in the sidebar. e2e now 37/37 (exists/text/count/url pass + failing cases +
> mixed report counts).

**Goal:** author expectations ("element exists", "text contains X", "url is Y",
"count == N") into a journey; replay evaluates them and feeds the existing pass/fail
report (`recording.lastRun`).

**New step shape** (steps array is freeform, no schema change):
```
{ type:'assert', kind:'exists'|'text'|'visible'|'count'|'url',
  selector?, op:'contains'|'equals'|'matches', expected, ts }
```

**Authoring (two paths):**
- *In-page capture:* new inspector mode `'assert'` — click an element → small
  assertion editor (reuse the note-popup pattern) → choose kind/op/expected →
  `sendToHost('caos:rec-step', {type:'assert', …})` (appends to `recordingBuffer`).
- *Editor:* a recording-detail modal listing steps with add/remove/reorder and an
  "Add assertion" picker driven by the existing Inspector DOM-tree highlight.

**Replay eval:** extend `src/webview/replay.js` `executeStep` with an `'assert'` branch
(exists/text/visible/count via `anchor.resolve` + DOM reads) returning
`{ ok, error, actual }`. `url` asserts are evaluated **host-side** in `app.js`
(`replaySelected` already knows `state.currentUrl`). Report rows gain `actual`.

**Files:** `config.js` (assertion kinds/ops), `src/webview/inspector.js` (assert mode +
editor), `src/webview/replay.js` (assert eval), `src/renderer/app.js` (assert toggle,
recording-detail editor, url-assert handling, report shows assertions distinctly),
`src/renderer/components/` (recording-editor modal). `showReplayReport` already exists —
extend its rows.

**Verify (e2e):** add a passing assert (`#cta` exists) and a failing one
(`text equals "nope"`) to the journey; replay; assert `lastRun` marks them pass/fail
with `actual` populated.

**Effort:** M–L · **Risk:** medium (authoring UX; the cross-world popup is fine under
trusted/real input, as the e2e harness already established).

---

## Phase 3 — Full-page (beyond-viewport) annotated screenshots ✅ DONE

> Shipped. `caos:capture-fullpage(webContentsId)` attaches the CDP debugger to the
> guest webContents and runs `Page.captureScreenshot({captureBeyondViewport:true})`
> clipped to `Page.getLayoutMetrics().cssContentSize`. The camera button now opens a
> Viewport / Full-page popover menu. Full-page compositing uses fresh page-coordinate
> boxes from a new `caos:request-page-boxes` inspector handler; `screenshots.js` accepts
> an explicit `box`. e2e now 42/42 (page taller than viewport, 849×1888 capture beyond
> viewport, page-box resolved, annotated composite produced).

**Goal:** capture the whole scrollable page, not just the viewport, annotations baked in.

**Approach (recommended): CDP, not scroll-stitch.** Attach the debugger to the guest
webContents and call `Page.captureScreenshot({ captureBeyondViewport:true, format:'png' })`
— one robust shot, no seams.

**Accurate overlay:** element boxes are stored as *viewport* coords at capture time.
For a full-page image we need *page* coords, so add an inspector request
`caos:page-boxes` → returns each current annotation's live box as
`{ x:rect.left+scrollX, y:rect.top+scrollY, w, h }`. Composite with those.

**Contract / files**
- `src/main/ipc/index.js` *(or new `services/capture.js`)* — `caos:capture-fullpage(webContentsId)`:
  `webContents.fromId(id)`, `debugger.attach`, `Page.captureScreenshot`, detach, return dataURL.
- `src/main/preload.js` — `caos.fs.captureFullPage(webContentsId)`.
- `src/webview/inspector.js` — handle `caos:request-page-boxes` → `sendToHost('caos:page-boxes', …)`.
- `src/renderer/lib/screenshots.js` — page-coord composite mode (no viewport clamp).
- `src/renderer/app.js` — screenshot split button: "Viewport" (current) vs "Full page"
  (`wv.getWebContentsId()` → capture → composite page-boxes → save).

**Known limitation:** `position:fixed` elements render once (top); acceptable, document it.

**Verify (e2e):** make the fixture taller than the viewport; assert the captured image
height > viewport height and that an annotation box was drawn.

**Effort:** M · **Risk:** medium (debugger attach/detach lifecycle; one webContents at a time).

---

## Phase 4 — Multi-tab browsing + history + bookmarks ✅ DONE

> Shipped. `app.js` now owns a tab model (`state.tabs`, `state.activeTabId`) with a
> module-level `wv` aliasing the active tab; each tab is its own `<webview>` wired by
> `setupTabWebview` and stacked via visibility/z-index (not `display:none`, so
> background tabs keep loading). New `components/tabs.js` strip (new/select/close).
> `history` + `bookmarks` store collections + IPC + preload; navigations recorded
> (welcome skipped, consecutive-dupe-collapsed); a ☆ star in the address bar toggles
> bookmarks; sidebar gained Bookmarks + History sections (open/remove/clear). e2e now
> 51/51 (open/switch/close tabs, history recorded, bookmark add/query/remove, plus
> address-bar autocomplete from history/bookmarks via a native `<datalist>`).

**Goal:** multiple guest tabs, per-tab history, a tab strip, global history + bookmarks.

**Core refactor (the risky part):** today `app.js` has a single `wv`. Introduce a tab
model and route every `wv.*` call through `activeTab().wv`.
- `state.tabs = [{ id, wv, url, title, sessionId }]`, `state.activeTabId`.
- Each tab is its own `<webview>` (same inspector preload + `will-attach-webview`
  sandbox policy); inactive ones `display:none`.
- Mode / recording / replay / pins / inspector all operate on the **active** tab.
- New `src/renderer/components/tabs.js` — strip with new/close/switch, title + spinner.

**History & bookmarks (new store collections, mirror existing repo pattern):**
- `repositories.js` — `history` `{id,url,title,visitedAt}` (record on `did-navigate`,
  dedupe recent), `bookmarks` `{id,url,title,createdAt}`.
- `ipc/index.js` + `preload.js` — CRUD for both.
- `sidebar.js` — History and Bookmarks sections; toolbar star toggles a bookmark;
  address bar autocompletes from history.

**Files:** large diff to `app.js` (webview indirection everywhere), new `tabs.js`,
`sidebar.js`, `repositories.js`, `ipc/index.js`, `preload.js`.

**Verify (e2e):** open 2 tabs, navigate each, switch, assert the active webview's URL;
assert a history row was recorded; add + list a bookmark. **Re-run the full suite** —
this phase has the highest regression risk to already-verified flows.

**Effort:** L (largest) · **Risk:** high — sequence last, ideally on its own branch,
and re-baseline e2e before starting.

---

## Cross-cutting

- **Testing:** grow `src/renderer/lib/e2e.js`; consider splitting into suites
  (`core`, `agent`, `assertions`, `capture`, `tabs`) selected by an env var as it grows.
- **Docs:** update `README.md` features/roadmap per phase.
- **Commits:** one branch/commit per phase; never bundle Phase 4 with others.
