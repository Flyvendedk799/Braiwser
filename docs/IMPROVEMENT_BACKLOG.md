# Braiwser — improvement backlog (from ultracode review wf_9644bfd6)

Generated from an exhaustive 9-dimension review with adversarial verification: 58 findings, 44 confirmed worth applying, synthesized into 10 batches.

**Invariants preserved by every change:** contextIsolation ON, webview `sandbox=no`, renderer ESM/`window.caos`-only, main/webview CommonJS, e2e suite stays green (>=51 checks).

## Plan summary

28 confirmed findings (one duplicate pair merged: history-unbounded-growth + history-unbounded -> single history cap item) organized into 10 ordered batches. Batches are grouped by AREA to keep file sets as disjoint as possible. The dominant shared file is src/renderer/app.js, which is unavoidably touched by several batches (B2 replay-correctness, B5 robustness, B6 UX-shortcuts/load-state, B8 goal-features). To keep batches independently applicable, app.js work is partitioned by function region rather than randomly: B2 owns the replay/tab-switch/pendingDomReady/replayWaiters regions; B5 owns the wv.send guard helper + onAnnotation error path; B6 owns the keydown listener + setupTabWebview load-state listeners; B8 owns the footer copy-prompt button, persistOpenTabs, console buffer, and suggestFix/locate wiring. Recommended ORDER of application = P0 security first (B1), then P0 replay/session correctness (B2), then P1 robustness (B3 store, B4 history+perf, B5 app robustness), then P1/P2 goal features (B7 capture quality, B8 handoff features), then UX (B6), a11y (B9), and finally the test-coverage expansion (B10) which validates everything and grows the harness from 51 checks. The e2e suite must end green at >=51 checks; B10 is the net-new-checks batch. Other batches add targeted checks only where they exercise new surfaces (popups, load-error UI, persisted tabs). KEY RULE preserved everywhere: contextIsolation ON, webview sandbox=no, renderer ESM/window.caos-only, main/webview CommonJS; no change touches the will-attach-webview sandbox policy.

## Batches (apply in this order)

### [x] B1 - Security hardening (main-process boundaries)  `P0` (risk: low)
Files: `src/main/main.js`, `src/main/ipc/index.js`, `src/main/store/repositories.js`, `src/renderer/app.js`

- no-window-open-handler: add shell to electron require in main.js; install contents.setWindowOpenHandler scoped to getType()==='webview' inside the existing web-contents-created handler, denying in-app popups and opening vetted http/https via shell.openExternal. allowpopups can remain since the handler now consumes the event.
- capture-fullpage-unscoped-debugger: in caos:capture-fullpage handler (ipc/index.js ~155), after the isDestroyed guard add an ownership/type check — reject unless wc.getType()==='webview' and wc.hostWebContents === main window's webContents, before any debugger.attach. Leave isAttached/detach lifecycle unchanged.
- secrets-setkey-arbitrary-provider: in repositories.js harden secrets.setKey with provider whitelist ('claude'|'openai') and non-empty string key validation, returning secrets.providers() on rejection to preserve the return contract. No ipc/index.js change.

_e2e:_ Current 51 checks unaffected (popups, full-page CDP capture, and key-write are not exercised by the harness happy path). Optional new check: assert caos:capture-fullpage rejects a non-webview id with {ok:false} — only add if you want regression cover; otherwise harness stays at 51. app.js touch is only the optional allowpopups removal at line 190 (skip to keep app.js out of this batch and fully disjoint from main-process files).

### [x] B2 - Replay & session correctness (tab-local replay, ack/restore gating, session race)  `P0` (risk: medium)
Files: `src/renderer/app.js`, `src/renderer/components/notes-panel.js`, `src/webview/inspector.js`

- pending-dom-ready-global-tab-switch: replace the single pendingDomReady global with a Map keyed by tab.id; make navigateAndWait(tab,url)/replayStep(tab,step,index) tab-local; resolve the dom-ready waiter via the map WITHOUT gating on isActive() (only maybeRestoreAnnotations stays isActive-gated); clear map for tab in finishReplay/cancelReplay. Add guard at top of setActiveTab: if (state.replaying) { toast(...'Finish or cancel replay before switching tabs','warn'); return; }.
- replay-navigated-away-stale-wv: add 'if (state.replaying) return;' guard at top of setActiveTab (shared with above) and 'if (state.replaying){toast(...);return;}' at top of closeTab; capture const targetWv=wv at start of doScreenshot and thread through capturePage/getWebContentsId/clientWidth/requestPageBoxes so screenshot is robust to tab switches.
- replay-ack-not-gated-by-active-tab: add 'if (!isActive()) break;' guard to the caos:replay-ack branch (app.js ~277-281) matching sibling branches.
- ensure-session-race-duplicate-sessions: add module-scoped _sessionInFlight promise guard in ensureSession so concurrent annotation callers share one create and the state.annotations=[] reset runs once.
- pin-number-vs-notes-number-mismatch: in refreshPins/maybeRestoreAnnotations attach pinNum = state.annotations.indexOf(a)+1 (full-list position) before sending caos:restore-annotations; in inspector.js restoreAnnotations use ann.pinNum when present, fallback to i+1. Derive index from state.annotations (same array notes-panel renders).

_e2e:_ Must keep 51 checks green; this batch touches the exact replay/restore paths the harness drives. Re-run npm run e2e after each sub-change. The pin-number fix interacts with section-3 pinCount assertions and B10's restore/region tests — verify pin badge text now equals notes '#'. No new checks required here (B10 adds the deeper replay/restore coverage); existing replay sections (5/6/9b) and restore-pins (section 3) are the regression guard.

### [x] B3 - Persistence error handling (JSON store + save IPC)  `P1` (risk: medium)
Files: `src/main/store/db.js`, `src/main/store/repositories.js`, `src/main/ipc/index.js`, `src/renderer/app.js`

- atomicwrite-no-error-handling: harden db.js atomicWrite with fd open/write/fsync/close/rename + catch that closes fd, unlinks the .tmp, and rethrows a clean 'Failed to persist <file>: <msg>' Error (preserves throw-on-failure contract). In app.js onAnnotation wrap caos.annotations.create in try/catch with an error toast and early return (push already runs post-await so no rollback needed).
- save-ipc-no-trycatch: in app.js saveAiResult wrap caos.fs.save in try/catch with success/failure toasts (mirror doExport). In ipc/index.js wrap each fs.writeFileSync (caos:save, caos:save-screenshot) in try/catch that rethrows a clean Error('Could not save file: '+msg) — do NOT switch to {ok:false,error} since callers branch on truthy filePath.

_e2e:_ db.js sits on every persistence path the harness uses (annotations/recordings/settings), so the happy-path contract (throw only on real failure) must be preserved — re-run npm run e2e to confirm 51 checks. No new harness checks needed; error paths are hard to trigger with trusted input. app.js overlap with other batches is confined to onAnnotation + saveAiResult (disjoint from B2's replay region and B6's keydown region).

### [x] B4 - Performance & history bounding  `P1` (risk: low)
Files: `src/main/store/repositories.js`, `src/renderer/app.js`, `src/main/ipc/index.js`, `src/main/preload.js`

- history-unbounded (MERGED with duplicate history-unbounded-growth): in repositories.js history.record add HISTORY_MAX (~1000) cap, trimming to newest N only when over cap; keep existing consecutive-URL de-dupe; optionally replace per-call .sort dedupe scan with an O(n) reduce. Optional app.js guard: skip caos.history.record while state.replaying.
- refreshsessions-nplus1: add repositories.js annotations.countsBySession() (single scan -> {sessionId:count}); add caos:annotations.countsBySession IPC handler in ipc/index.js; add countsBySession() to preload.js annotations block; replace app.js refreshSessions Promise.all per-session loop with one state.sessionCounts = await caos.annotations.countsBySession(). bumpSessionCount stays for incremental path.
- scroll-redraw-unthrottled: in inspector.js add early-return to redraw() when mode!=='draw' || !strokes.length (clear then bail); move scroll-path redraw into the rAF syncPins() batch (scroll listener calls only queuePinSync(); redraw() called inside syncPins).

_e2e:_ scroll/redraw change is webview-only (inspector.js) — section-3 pin restore and B10 region/draw tests exercise pin sync, so confirm pins still render after the rAF coalescing change. countsBySession changes the session-count source; the harness reads session badge counts indirectly via state — re-run e2e (51). New optional check: assert caos.annotations.countsBySession() returns a map summing to bySession length. Note inspector.js is also touched by B2 (restoreAnnotations) and B7 (anchor/selector) — those are different functions, but if applied together do them in one inspector.js pass.

### [x] B5 - Renderer robustness (webview guards, crash handling)  `P1` (risk: low)
Files: `src/renderer/app.js`, `src/main/services/ai/claude.js`, `src/main/services/ai/openai.js`, `src/main/services/ai/index.js`

- wv-send-unguarded: add a sendWv(channel,...args) helper (try/catch + isDestroyed fallback) near `safe`; route all wv.send calls (lines 118,127-128,216,436,506,622,632,888,943) through it; null-guard toolbar back/forward/reload callbacks; guard requestPageBoxes add/removeEventListener with an early 'if(!wv){resolve([]);return;}'.
- no-webview-crash-handling: in setupTabWebview add did-fail-load (ignore errorCode -3 and non-main-frame; toast + mark tab.errored), render-process-gone (toast + el.reload()), and optional unresponsive/responsive listeners — strictly additive, reading props off the event object.
- ai-fetch-no-timeout: in claude.js (and identically openai.js) wrap fetch with AbortController + 120s timeout, pass signal, clearTimeout in finally, and rethrow AbortError as a clear 'Claude/OpenAI request timed out after 120s' Error which runAiTask converts to {ok:false,error}.

_e2e:_ Routing wv.send through sendWv must not change behavior on the live (non-destroyed) path — re-run e2e (51) since every in-page message (annotations, replay-step, highlight) flows through it. did-fail-load/-3 handling overlaps conceptually with B6's load-state listener: if both batches land, MERGE the did-fail-load handler (one listener that both toasts and drives the load-error placeholder) to avoid two competing listeners on the same event. No new checks required; AI-timeout and crash paths aren't harness-exercised.

### [x] B6 - UX: keyboard shortcuts, load-state, address affordance  `P1` (risk: medium)
Files: `src/renderer/app.js`, `src/renderer/components/toolbar.js`

- no-keyboard-shortcuts + no-address-focus-affordance: add toolbar.focusAddress() (focus+select addressInput) to the returned object; add one renderer-level keydown listener in app.js guarded against editable targets — Cmd/Ctrl+L focusAddress, Cmd/Ctrl+T new tab, Cmd/Ctrl+W close active tab, Cmd/Ctrl+R reload, Cmd+Shift+I/D toggle inspect/draw, Escape -> setMode('off'); preventDefault on matched combos.
- no-page-load-state: in setupTabWebview add did-start-loading/did-stop-loading (per-tab tab.loading, renderTabs + syncToolbar when active) and did-fail-load -> tab.loadError + showLoadErrorPlaceholder (sibling overlay in stage, NOT inside webview) with Retry; clear on did-start-loading/did-navigate. In toolbar.update reflect state.loading (reload<->stop icon swap, mirroring rec icon pattern); pass loading through syncToolbar.
- no-address-focus-affordance (lock indicator): in toolbar.update drive lock icon from currentUrl protocol (lock for https, unlock/insecure for http, file for file://), toggling an .insecure class; renderer-only.

_e2e:_ Keep load-state/toolbar mutations gated on isActive() so tab switching + the 51 harness checks stay deterministic. The new keydown listener fires only on app chrome (webview swallows guest keys) so it won't interfere with the harness's trusted webview input. SHARED EVENT with B5: did-fail-load — land a single merged handler. New optional check: drive Cmd+L via a trusted key event and assert addressInput is focused; assert load-error placeholder appears on a bad navigate (errorCode != -3). Otherwise harness stays 51.

### [x] B7 - Goal: capture precision (stable selectors)  `P1` (risk: low)
Files: `src/webview/anchor.js`

- selector-no-testid-pref: in cssPath() add a stable-attribute fast-path (data-testid/data-test/data-cy/name/aria-label) guarded by document.querySelectorAll(cand).length===1, placed before the id fast-path; keep id and :nth-of-type chain as fallbacks. In describe().attrs add testid (data-testid||data-test||data-cy), name, and ariaLabel so exports/prompts can surface them.

_e2e:_ Fully isolated to anchor.js (no other batch touches it). The e2e fixture has no test hooks, so the id fast-path still yields #cta/#hero and all 51 checks remain green. Optional new check: add a [data-testid] element to __e2e/fixture.html and assert cssPath returns the [data-testid=...] selector — only if you want positive coverage of the new path (this would also touch fixture.html + e2e.js, overlapping B10).

### [~] B8 (partial: console-capture + cross-page locate-ack deferred) - Goal: agent-handoff features (copy/persist/console/suggest-fix/locate/ordering)  `P1` (risk: medium)
Files: `src/renderer/app.js`, `src/renderer/components/notes-panel.js`, `src/renderer/components/ai-panel.js`, `src/renderer/components/inspector-panel.js`, `src/webview/inspector.js`, `src/main/services/export/prompt.js`, `src/main/services/export/markdown.js`, `src/main/store/repositories.js`

- copy-all-as-prompt: add a footer 'Copy prompt' button + copyExport(format) helper that copies result.content (the string) to clipboard with toasts. Renderer-only.
- copy-selector-everywhere: add copy-selector buttons in inspector-panel renderNode (copy node.selector, stopPropagation) and notes-panel actsRow (copy a.target.selector only when present, else info toast/copy note); import toast in both; minimal .tree-copy CSS.
- suggest-fix-mis2-wired: add per-note Suggest-fix button in notes-panel; implement actions.suggestFix(a) in app.js running caos.ai.run({task:'suggest-fix',annotations:[a],...}), switch to AI tab, render via a new aiPanel.showExternalResult/runExternal; guard ai-panel.js run() so dropdown 'suggest-fix' without annotation shows an inline hint (or filter it from the dropdown taskIds).
- locate-fails-cross-page: make app.js locate handler async/page-aware (navigate to a.url then highlight after dom-ready); add caos:highlight-ack {ok} from inspector.js highlight-target handler and toast 'Couldn't find this element' on ok:false; in notes-panel render a cross-page chip when a.url !== currentUrl.
- persist-open-tabs: add debounced persistOpenTabs() writing {openTabs, activeTabIndex} via caos.settings.set; call after tab-set/active-tab/onNavigated changes (skip while replaying); in boot() restore-then-fallback gated by !caos.e2e. No backend change (settings merge handles arbitrary JSON).
- capture-guest-console: extend app.js console-message listener + add did-fail-load to push into bounded per-tab tab.consoleLog (~50, level>=1 + load fails); pass active tab's buffer into prompt.js/markdown.js exporters as optional 3rd arg rendering a 'Console errors observed' section (back-compatible).
- annotation-ordering: in prompt.js and markdown.js apply a STABLE priority sort (critical>high>normal>low) on a COPY of the list before numbering; do NOT mutate input array (pin numbers rely on insertion order); leave JSON exporter raw. No drag-reorder UI.

_e2e:_ Highest file fan-out; sequence after B2/B5/B6 since it reuses app.js regions (footer, setupTabWebview console listener, locate). persist-open-tabs MUST keep the !caos.e2e boot guard so the harness still boots deterministically to the fixture — verify e2e stays 51. Exporter 3rd-arg must stay optional so existing export checks pass. SHARED with B5/B6: the did-fail-load listener (console buffer + load placeholder + crash toast) should be ONE merged handler if those batches co-land. New optional checks: assert copyExport produces non-empty content; assert priority-sorted export leads with a 'critical' note; assert persisted openTabs round-trips through settings. Note repositories.js here is only the (optional) console-persistence touch — coordinate with B1/B3/B4 repo edits if co-landing.

### [~] B9 (a11y done; code-dedups deferred) - Accessibility & quality dedup (CSS + keyboard ops + focus + shared formatters)  `P2` (risk: medium)
Files: `src/renderer/styles/app.css`, `src/renderer/components/sidebar.js`, `src/renderer/components/tabs.js`, `src/renderer/components/inspector-panel.js`, `src/renderer/lib/dom.js`, `src/renderer/components/toolbar.js`, `src/renderer/components/ai-panel.js`, `src/main/services/format/annotation.js`, `src/main/services/ai/prompts.js`, `src/main/config.js`, `src/renderer/lib/screenshots.js`, `src/webview/inspector.js`

- no-focus-visible / faint-text-contrast / no-reduced-motion: add a global :focus-visible outline rule, change --faint to #8a93a3, and append a prefers-reduced-motion block to app.css (3 isolated CSS edits).
- div-rows-not-keyboard-operable: add role/tabindex/keydown (Enter+Space, preventDefault Space) to sidebar row(), tabs.js tab-chip (roving tabindex + aria-selected), and inspector-panel renderNode tree-self; do NOT switch sidebar row to <button> (nested buttons).
- modal-no-focus-trap-return: in dom.js modal() capture document.activeElement, add Tab focus-trap, set initial focus, and restore focus on close. confirmDialog/settings-modal inherit automatically.
- icon-buttons-no-aria-label: add aria-label to icon/glyph-only buttons across toolbar.js, tabs.js close, dom.js modal-x, sidebar.js clear/add/sr-act.
- dedup-escapehtml: replace ai-panel.js local escapeHtml with imported esc() from lib/dom.js.
- dedup-export-annotation-renderer: add src/main/services/format/annotation.js (truncate(str,max) with per-caller limits, labelFor(actionId) from config.ACTION_TAGS, targetPairs(annotation)); refactor markdown.js/prompt.js/prompts.js to use it preserving every truncation limit and output string exactly; keep prompt.js ACTION_VERBS overrides.
- dedup-action-tag-colors: make config.js canonical — screenshots.js compositeAnnotations reads optional {colors} (fallback to local ACTION_COLORS for the e2e no-args caller); app.js passes colors built from state.config.actionTags; inspector.js ACTIONS = require('../main/config').ACTION_TAGS. Leave app.css :root alone.

_e2e:_ The dedup refactors are the riskiest for the harness: golden export/prompt text and screenshot compositing are likely asserted. Preserve exact output strings/limits and keep compositeAnnotations' positional contract (only add an optional {colors} field) so e2e.js:228 (no-colors caller) stays green. div-keyboard-ops and aria additions must NOT change any class/data-attr the harness selects on — keep selectors stable. Re-run e2e (51). New optional checks: a11y attribute presence (role/tabindex/aria-label) on a sample row; modal focus-trap (Tab wraps). NOTE markdown.js/prompt.js also touched by B8 (ordering + console section) — if co-landing, do the dedup extraction first, then layer B8's sort/console onto the deduped functions to avoid double-rewrites. inspector.js shared with B2/B4.

### [ ] B10 - E2E coverage expansion (net-new harness checks)  `P2` (risk: low)
Files: `src/renderer/lib/e2e.js`, `src/renderer/__e2e/fixture.html`

- no-annotation-mutation-coverage: after section-3 pinCount check, add update(status/priority/note)+re-fetch assertions, then remove + bySession assertion, then set I.state.annotations and refreshPins -> assert 0 pins. Place AFTER section 3 so pinCount===1 still passes against the live annotation.
- no-reload-restore-coverage: add section 3b — navigate to fixtureUrl, await dom-ready + ~400ms, assert restoredPins===1 (exercises maybeRestoreAnnotations/bySessionUrl, distinct from refreshPins). Must run before replay sections.
- no-draw-region-coverage: add a region/draw section — setMode('draw'), synthesize a trusted drag (mouseDown/moves/mouseUp) inside #tall, click draw-bar note, fill+save, assert sent.kind==='region', persisted region note with numeric target.box, and pinCount===2 after refreshPins.
- no-recording-editor-coverage: add a recordings.update(steps reordered+spliced+appended-assert) round-trip via caos.recordings.get; assert length, swapped order, and appended assert step survive.
- no-error-path-coverage: add a recording [navigate, click '#gone']; replaySelected with small replayDelayMs; assert the click step reports ok:false (could-not-resolve/timeout) and report.failed>=1 && report.passed>=1; cleanup.

_e2e:_ This is the batch that GROWS the harness well beyond 51 checks; it is the validation layer for B2 (replay/restore correctness), B3 (persistence), and B8 (recording editor). All new checks drive the repository/data layer (caos.annotations/recordings) or trusted webview input to avoid modals, mirroring existing sections. Order new sections so the live element annotation isn't deleted before section 3's pinCount===1 and so 3b runs before replay perturbs the page. Land this LAST so it asserts the corrected behavior from earlier batches; if landed earlier it would assert pre-fix behavior. fixture.html only edited if B7's positive-selector check is folded in (add a [data-testid] node).

## Confirmed findings (full fixes)

### no-window-open-handler — Guest pages can open uncontrolled new windows (allowpopups + no setWindowOpenHandler)
- dimension: security · severity: high · effort: S · risk: low
- files: src/renderer/app.js, src/main/main.js
- fix:

In src/main/main.js, add shell to the electron require on line 5: const { app, BrowserWindow, webContents, shell } = require('electron'); Then inside the existing app.on('web-contents-created', (_e, contents) => { ... }) handler, after the will-attach-webview block, install a window-open handler scoped to guest webviews:

  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          shell.openExternal(url);
        }
      } catch { /* ignore malformed URLs */ }
      return { action: 'deny' };
    });
  }

This denies all in-app popups (preventing uncontrolled top-level windows) and opens vetted http/https links in the OS browser. Since the handler is now consumed, allowpopups can stay; if you prefer the stricter posture of no popups at all, also drop allowpopups:'' at src/renderer/app.js:190. Add/keep an e2e assertion only if popups are exercised; current 51 checks are unaffected.

### capture-fullpage-unscoped-debugger — caos:capture-fullpage attaches the CDP debugger to any webContentsId from the renderer
- dimension: security · severity: medium · effort: S · risk: low
- files: src/main/ipc/index.js
- fix:

In the caos:capture-fullpage handler (src/main/ipc/index.js:155), after resolving `const wc = webContents.fromId(webContentsId)` and the existing `if (!wc || wc.isDestroyed())` guard, add an ownership/type check before touching the debugger: e.g. `const host = win() && !win().isDestroyed() ? win().webContents : null; if (wc.getType() !== 'webview' || (host && wc.hostWebContents !== host)) return { ok: false, error: 'not a guest webContents' };`. This rejects any id that is not a guest <webview> hosted by the main window, preventing debugger attach to the privileged renderer or arbitrary contents while leaving the legitimate full-page capture path (wv.getWebContentsId()) working. Keep the existing isAttached/detach lifecycle unchanged.

### secrets-setkey-arbitrary-provider — secrets.setKey writes arbitrary renderer-supplied provider keys into secrets.json
- dimension: security · severity: low · effort: S · risk: low
- files: src/main/store/repositories.js, src/main/ipc/index.js
- fix:

In src/main/store/repositories.js, harden secrets.setKey with a provider whitelist and key validation: `setKey: (provider, key) => { if (provider !== 'claude' && provider !== 'openai') return secrets.providers(); if (typeof key !== 'string' || !key) return secrets.providers(); secretsD.set(provider, key); return secrets.providers(); }`. No change needed in ipc/index.js. Returning providers() on rejection keeps the existing return contract intact for the renderer.

### pending-dom-ready-global-tab-switch — pendingDomReady is a single global shared across tabs; tab switch mid-replay strands or steals the navigation waiter
- dimension: correctness · severity: high · effort: M · risk: medium
- files: src/renderer/app.js
- fix:

Two-part fix. (1) Make replay tab-local: in replaySelected(), capture the target tab at start (const replayTab = activeTab(); if (!replayTab) return;) and thread its webview through the replay calls. Change navigateAndWait(url) -> navigateAndWait(tab, url) so it sets tab.wv.src and registers the waiter keyed to tab.id (replace the single pendingDomReady global with a Map: pendingDomReady = new Map() keyed by tab id; store finish under map.set(tab.id, finish), and in setupTabWebview's dom-ready handler resolve via const r = pendingDomReady.get(tab.id); if (r) { pendingDomReady.delete(tab.id); r(); } WITHOUT gating that resolution on isActive() — only the maybeRestoreAnnotations() call should stay gated on isActive()). Likewise change replayStep(step, index) -> replayStep(tab, step, index) and send via tab.wv.send. Update finishReplay()/cancelReplay() to clear the map for that tab. (2) Add a cheap guard at the top of setActiveTab(id): if (state.replaying) { toast('Finish or cancel replay before switching tabs', 'warn'); return; } to prevent the global wv from being swapped mid-run. Part (2) alone closes the bug at minimal risk; part (1) makes replay correct even if tab-switching is later re-allowed. Verify npm run e2e still reports 51 checks afterward.

### recorder-double-emit-input — Recorder registers onInputEvt for both input and change, double-emitting input steps
- dimension: correctness · severity: medium · effort: M · risk: low
- files: src/webview/recorder.js
- fix:

Coalesce consecutive same-selector text-input steps rather than restructuring the listener split, to stay deterministic for the e2e harness (no timers/debounce). Two acceptable spots:

Preferred (host buffer, single choke point that also drives the displayed count): in app.js where 'caos:rec-step' is handled (around line 275), before pushing, if the incoming payload.type === 'input', the last buffered step is also type 'input' with the same selector, and the value is not a boolean (i.e. not a checkbox/radio toggle), replace that trailing step in place instead of appending:
  case 'caos:rec-step':
    if (isActive() && state.recordingBuffer) {
      const steps = state.recordingBuffer.steps;
      const last = steps[steps.length - 1];
      const p = payload;
      if (p && p.type === 'input' && typeof p.value !== 'boolean'
          && last && last.type === 'input' && last.selector === p.selector
          && typeof last.value !== 'boolean') {
        steps[steps.length - 1] = p; // coalesce: keep only latest value for this field
      } else {
        steps.push(p);
      }
    }
    break;
This collapses keystroke spam and the duplicate final change-event step into one step holding the latest value, fixes the padded count, and lightens replay. Keep boolean values (checkbox/radio toggles) uncoalesced so distinct toggles are preserved. Leave recorder.js listening to both 'input' and 'change' so select/checkbox/radio (which only fire 'change' reliably for value commit) are still captured.

If preferred to fix at source instead of the host, equivalently dedupe inside the recorder by tracking the last emitted step locally, but the host-buffer approach is simplest and is exactly where the count is read.

### pin-number-vs-notes-number-mismatch — Restored pin badge numbers do not match Notes panel numbers across multiple URLs
- dimension: correctness · severity: medium · effort: M · risk: low
- files: src/renderer/app.js, src/renderer/components/notes-panel.js, src/webview/inspector.js
- fix:

Number pins by each annotation's position in the FULL session list so badge text equals the Notes '#'. In app.js refreshPins, instead of sending the bare URL-filtered subset, attach the full-list index to each item before sending: e.g. const list = state.annotations.filter((a) => a.url === url).map((a) => ({ ...a, pinNum: state.annotations.indexOf(a) + 1 })); wv.send('caos:restore-annotations', list); Do the same for maybeRestoreAnnotations, but since it fetches via bySessionUrl it lacks the full list — change it to derive numbers from state.annotations when available (or fetch bySession and filter client-side) so pinNum is the full-list position. Then in inspector.js restoreAnnotations, use the provided number when present: badge.textContent = String(ann && ann.pinNum != null ? ann.pinNum : i + 1). Compute the index from state.annotations (the same array the Notes panel renders) — not from a re-sorted bySession fetch — so pin and note numbers agree regardless of URL ordering. Keep the existing fallback to i+1 for robustness against missing pinNum.

### ensure-session-race-duplicate-sessions — Concurrent annotations create duplicate Quick-notes sessions (no in-flight guard in ensureSession)
- dimension: correctness · severity: medium · effort: S · risk: low
- files: src/renderer/app.js
- fix:

Add a module-scoped in-flight promise guard in app.js so concurrent callers share one create. Replace ensureSession with:

let _sessionInFlight = null;
async function ensureSession() {
  if (state.currentSession) return state.currentSession;
  if (_sessionInFlight) return _sessionInFlight;
  _sessionInFlight = (async () => {
    const session = await caos.sessions.create({
      projectId: state.currentProject ? state.currentProject.id : null,
      name: 'Quick notes',
      url: state.currentUrl,
      title: state.currentTitle,
    });
    state.currentSession = session;
    state.annotations = [];
    await refreshSessions();
    toast('Started a “Quick notes” session');
    return session;
  })();
  try {
    return await _sessionInFlight;
  } finally {
    _sessionInFlight = null;
  }
}

This makes the second concurrent caller await the same create instead of starting a new one, so both annotations land in one session and the state.annotations=[] reset happens once. Keep the existing curly quote in the toast string to match surrounding code.

### replay-ack-not-gated-by-active-tab — caos:replay-ack handler is keyed only by step index and not gated to the replaying tab
- dimension: correctness · severity: low · effort: S · risk: low
- files: src/renderer/app.js
- fix:

Make the caos:replay-ack branch consistent with its siblings by gating it to the active tab, since replay-step is only ever dispatched to the active tab (wv.send). In src/renderer/app.js, change the branch at lines 277-281 from `case 'caos:replay-ack': { const w = replayWaiters.get(payload.index); if (w) { replayWaiters.delete(payload.index); w.resolve(payload); } break; }` to add the same `if (isActive())` guard used by the rec-step/annotation/dom-tree/assert-pick branches, e.g. `case 'caos:replay-ack': { if (!isActive()) break; const w = replayWaiters.get(payload.index); if (w) { replayWaiters.delete(payload.index); w.resolve(payload); } break; }`. This is the minimal fix and matches existing convention. (Optional stronger variant for future multi-tab replay: capture the replaying tab id at replayStep time and key replayWaiters by `${tabId}:${index}`, using state.activeTabId in replayStep and payload-side tab id in the ack; not required now and larger surface.) Run `npm run e2e` after to confirm the 51 checks stay green.

### no-webview-crash-handling — No webview crash / did-fail-load / unresponsive handling
- dimension: robustness · severity: high · effort: M · risk: low
- files: src/renderer/app.js, src/main/main.js
- fix:

In setupTabWebview (src/renderer/app.js, alongside the existing el.addEventListener calls), add guest-failure listeners. Note the <webview> DOM event shape differs from main-process webContents events: read properties off the event object, not positional args, and guard on the main frame.

el.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;            // user-initiated abort (ERR_ABORTED)
  if (e.isMainFrame === false) return;       // ignore sub-frame failures
  toast(`Failed to load ${e.validatedURL || tab.url || ''}: ${e.errorDescription || 'error ' + e.errorCode}`, 'error');
  tab.errored = true;                         // optional: mark tab errored for UI
  if (isActive()) renderTabs();
});

el.addEventListener('render-process-gone', (e) => {
  const reason = (e.details && e.details.reason) || e.reason || 'crashed';
  toast(`Page crashed (${reason}). Reloading…`, 'error');
  try { el.reload(); } catch (_) {}           // el.reload() mirrors existing wv.reload() at app.js:86
});

// Optional, low-value extra:
el.addEventListener('unresponsive', () => toast('Page is unresponsive', 'warn'));
el.addEventListener('responsive', () => {});

Keep these strictly additive; do not alter the existing listeners, the will-attach-webview sandbox policy, or contextIsolation. (If a 'crashed' alias is desired for older Electron, render-process-gone supersedes it on current versions, so render-process-gone alone is sufficient.)

### wv-send-unguarded — Most wv.send() / wv.* calls are unguarded against a null or destroyed webview
- dimension: robustness · severity: medium · effort: M · risk: low
- files: src/renderer/app.js
- fix:

Add a single helper near the other utils (e.g. beside `safe` at line 381):

  function sendWv(channel, ...args) {
    try {
      if (wv && (typeof wv.isDestroyed !== 'function' || !wv.isDestroyed())) wv.send(channel, ...args);
    } catch (_e) { /* webview not ready or destroyed */ }
  }

Route all in-page messages through it, replacing `wv.send(...)` at lines 118, 127-128, 216 (can drop its now-redundant try/catch), 436, 506, 622, 632, 888, and 943. For the toolbar callbacks (lines 84-86) add a null guard matching the existing style:
  back: () => wv && wv.canGoBack() && wv.goBack(),
  forward: () => wv && wv.canGoForward() && wv.goForward(),
  reload: () => { if (wv) safe(() => wv.reload()); },
In requestPageBoxes (937-945) also guard the add/removeEventListener calls with `if (!wv) { resolve([]); return; }` at the top so the handler is never attached to a null wv. Note: `wv.isDestroyed()` exists on the underlying webContents, not the <webview> DOM element, so the `typeof ... !== 'function'` fallback in the helper is what actually protects most cases via try/catch — keep the try/catch as the real safety net.

### atomicwrite-no-error-handling — JSON store writes have no error handling, no fsync, and a failed write surfaces as a rejected IPC promise
- dimension: robustness · severity: medium · effort: M · risk: medium
- files: src/main/store/db.js, src/main/store/repositories.js
- fix:

In src/main/store/db.js, harden atomicWrite while preserving its throw-on-failure contract (so e2e and existing callers are unaffected on the happy path):

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);     // flush file contents before rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {} // remove partial .tmp
    throw new Error(`Failed to persist ${path.basename(file)}: ${err.message}`);
  }
}

(Optional, low priority: also fsync the parent directory after rename to durably flush the dir entry; skip if it complicates Windows/portability.)

In src/renderer/app.js onAnnotation (around lines 391-401), surface failures to the user instead of leaking an unhandled rejection — wrap the write/state-update so a rejected create() shows a toast rather than silently failing:

async function onAnnotation(raw) {
  if (!raw) return;
  const session = await ensureSession();
  const annotation = { ...raw, sessionId: session.id, url: raw.url || state.currentUrl, title: raw.title || state.currentTitle };
  let saved;
  try {
    saved = await caos.annotations.create(annotation);
  } catch (err) {
    toast('Could not save note (disk write failed)', 'error');
    return;
  }
  state.annotations.push(saved);
  notesPanel.setAnnotations(state.annotations);
  bumpSessionCount(session.id, 1);
  toast(`Note captured — ${saved.action}`, 'success');
  refreshPins();
}

Do NOT add a 'roll back state.annotations.push' step — the push already runs after the await, so there is no optimistic-write divergence to undo (correcting the finding). Keep the change minimal and verify `npm run e2e` stays green (51 checks), since db.js sits on every persistence path.

### save-ipc-no-trycatch — caos:save and caos:save-screenshot writeFileSync have no try/catch
- dimension: robustness · severity: medium · effort: S · risk: low
- files: src/main/ipc/index.js, src/renderer/app.js
- fix:

Two parts. (1) Renderer (highest value, the only fully-unguarded path): make saveAiResult resilient like doExport — wrap the caos.fs.save call in try/catch and toast on failure, e.g. async function saveAiResult(task, text){ if(!text) return; const name=`ai-${task}-${stamp()}.md`; try { const saved = await caos.fs.save({ defaultName:name, content:text }); if(saved) toast('Saved','success'); } catch(e){ toast('Save failed: '+(e&&e.message?e.message:e),'error'); } }. (2) Main (defense-in-depth, cleaner error messages): in ipc/index.js wrap each fs.writeFileSync in try/catch. Since the renderer save helpers currently treat any returned truthy value as success and rely on a thrown rejection for failure, the simplest non-breaking option is to rethrow a clean Error message (e.g. catch(e){ throw new Error('Could not save file: '+e.message); }) so the renderer's catch surfaces a readable string rather than a raw Node fs error. Avoid changing the return contract to {ok:false,error} unless you also update saveAiResult/doExport/doScreenshot/saveShot to inspect it, since those callers currently branch on a truthy filePath; rethrow keeps the existing success-path semantics intact and keeps e2e green.

### ai-fetch-no-timeout — AI provider fetch has no timeout or network-error wrapping; a hung request hangs the AI panel indefinitely
- dimension: robustness · severity: medium · effort: S · risk: low
- files: src/main/services/ai/claude.js, src/main/services/ai/index.js
- fix:

In claude.js (and identically openai.js), wrap the fetch with an AbortController + timeout. Add at the top of complete(): `const controller = new AbortController(); const timeoutMs = 120000; const timer = setTimeout(() => controller.abort(), timeoutMs);` then pass `signal: controller.signal` into the fetch options object, and clear the timer in a `finally` block wrapping the whole body (`clearTimeout(timer)`). Wrap the fetch call so an abort throws a clear error, e.g. catch and rethrow: if the rejection is an AbortError (err.name === 'AbortError'), throw `new Error('Claude request timed out after 120s')` (resp. 'OpenAI request timed out after 120s'). runAiTask's existing try/catch already converts this thrown Error into {ok:false,error}, which ai-panel.js renders via showError and re-enables the button in its finally. Keep the timeout a hardcoded constant (120s) to stay effort-S; making it settings-driven is optional and would require adding a settings field (config.js default settings + settings-modal), which is out of scope for the minimal fix. Do not change the renderer/IPC boundary.

### history-unbounded-growth — Browsing history grows without bound; every navigation re-reads/sorts/rewrites the whole file
- dimension: robustness · severity: low · effort: S · risk: low
- files: src/main/store/repositories.js
- fix:

Add a bounded cap inside history.record in src/main/store/repositories.js so the collection is trimmed after each insert. The existing consecutive-URL de-dupe (lines 107-108) already covers the finding's "de-dupe repeated visits" suggestion, so only the cap needs adding. Example:

const HISTORY_CAP = 2000;
const history = {
  list: (limit) => historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '')).slice(0, limit || 100),
  record: ({ url, title }) => {
    if (!url) return null;
    const recent = historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || ''))[0];
    if (recent && recent.url === url) return historyC.update(recent.id, { visitedAt: now(), title: title || recent.title });
    const saved = historyC.insert({ id: id(), url, title: title || '', visitedAt: now() });
    const all = historyC.all();
    if (all.length > HISTORY_CAP) {
      const cutoff = all.sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || ''))[HISTORY_CAP - 1].visitedAt;
      historyC.removeWhere((h) => (h.visitedAt || '') < cutoff);
    }
    return saved;
  },
  clear: () => { historyC.removeWhere(() => true); return true; },
};

Note removeWhere does a single _save (db.js:52-55), so trimming adds at most one extra rewrite only when the cap is exceeded. Optionally also add an `if (!state.replaying)` guard around the caos.history.record(...) call at src/renderer/app.js:296 so replay runs don't pollute history (low priority, separate from the cap). Do not lower the cap so far that it conflicts with the default list limit of 100; 1000-5000 as suggested is fine.

### replay-navigated-away-stale-wv — Replay/page-boxes/screenshot use the global wv alias, which can change if the user switches tabs mid-operation
- dimension: robustness · severity: low · effort: M · risk: low
- files: src/renderer/app.js
- fix:

Primary fix (smallest, fully correct): block tab switching/closing while replaying. In setActiveTab add an early guard `if (state.replaying) return;` at the top, and in closeTab add `if (state.replaying) { toast('Finish or cancel replay first', 'warn'); return; }` at the top. This mirrors the existing `if (state.replaying) return;` pattern used elsewhere (e.g. line 620) and prevents any reassignment of the global `wv` while replaySelected/navigateAndWait/replayStep are in flight. Optionally also guard tabStrip select/close visually by no-opping, but the controller-side guard is sufficient since both delegate to setActiveTab/closeTab.

For doScreenshot specifically (a long full-page CDP capture should not necessarily lock the whole UI), additionally capture the webview into a local at the start: `const targetWv = wv;` and use `targetWv` for `.capturePage()`, `.getWebContentsId()`, `.clientWidth`, and pass it into requestPageBoxes(annotations, targetWv) so requestPageBoxes uses the passed reference instead of the global. This makes the screenshot path robust to tab switches without needing to disable the tab strip during capture.

If the broader "capture-local" approach is preferred for replay too: capture `const targetWv = wv;` at the top of replaySelected and thread it as a parameter through navigateAndWait(url, targetWv), replayStep(step, index, targetWv), so they use the passed webview rather than the module-global. Either approach is acceptable; the setActiveTab/closeTab guard is the lowest-effort/lowest-risk and is recommended as the baseline.

### no-keyboard-shortcuts — No keyboard shortcuts for any core action (inspect toggle, address focus, tab open/close, reload, escape)
- dimension: ux · severity: high · effort: M · risk: medium
- files: src/renderer/app.js, src/main/main.js, src/renderer/components/toolbar.js
- fix:

Add a single renderer-level keydown listener in src/renderer/app.js (after the controller wires up wv/state), guarded so it never fires when an editable element is focused: const t=e.target; const typing = t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable); skip non-Escape shortcuts when typing. Map: Cmd/Ctrl+L -> toolbar.focusAddress() (add a focusAddress() method to createToolbar in toolbar.js that does addressInput.focus()+addressInput.select(), and include it in the returned object — addressInput is a closure local with no id, so this export is required); Cmd/Ctrl+T -> createTab(state.config.welcomeUrl); Cmd/Ctrl+W -> { const a=activeTab(); if(a) closeTab(a.id); }; Cmd/Ctrl+R -> { if(wv) wv.reload(); }; toggle Inspect/Draw via a non-conflicting combo such as Cmd+Shift+I / Cmd+Shift+D (or bare 'i'/'d' only when !typing) -> setMode('inspect')/setMode('draw'); Escape -> setMode('off') (call 'off' literally, not the toggle of a specific mode, because setMode toggles: state.mode = state.mode===mode?'off':mode). Call e.preventDefault() on each matched combo so it does not bubble to default browser behavior. Note these only fire when focus is on the app chrome (the webview guest swallows its own key events), which is exactly the gap. Keep the existing inspector.js:506 guest-page Escape path; this adds the missing app-chrome path. No change needed in main.js.

### no-page-load-state — No page-load progress/spinner and no failed-load UI in the browser stage
- dimension: ux · severity: medium · effort: M · risk: low
- files: src/renderer/app.js, src/renderer/components/toolbar.js
- fix:

In src/renderer/app.js setupTabWebview, add per-tab listeners alongside the existing ones: (1) el.addEventListener('did-start-loading', () => { tab.loading = true; renderTabs(); if (isActive()) syncToolbar(); clearLoadError(tab); }) and ('did-stop-loading', () => { tab.loading = false; renderTabs(); if (isActive()) syncToolbar(); }). (2) el.addEventListener('did-fail-load', (e) => { if (e.errorCode === -3) return; // ERR_ABORTED is normal for redirects/cancelled navs — do NOT show error UI; if (!e.isMainFrame) return; tab.loading = false; tab.loadError = { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL }; if (isActive()) { toast(`Couldn't load: ${e.errorDescription}`, 'warn'); showLoadErrorPlaceholder(tab); syncToolbar(); } renderTabs(); }). Implement showLoadErrorPlaceholder/clearLoadError as a sibling overlay inside the stage container (NOT inside the webview) reusing the existing .placeholder markup (.ph-icon/.ph-title/.ph-sub) plus a Retry button that calls wv.reload() (or wv.loadURL(tab.loadError.url)); clear it on did-start-loading and on did-navigate. In toolbar.js: in update(state), reflect a state.loading flag by toggling a class on reloadBtn and swapping its icon to 'stop' when loading (wire reloadBtn's click to call actions.stop() when loading, falling back to actions.reload otherwise) — mirroring the existing recBtn record/stop icon-swap pattern at toolbar.js:72-73. Pass loading through syncToolbar's state payload. Keep all loading state per-tab and only mutate the toolbar/lock when isActive() so the e2e harness (51 checks) and tab-switching stay correct. The progress bar is optional and can be skipped to keep effort down.

### locate-fails-cross-page — 'Locate on page' and pin click silently do nothing when the note belongs to a different page/tab
- dimension: ux · severity: high · effort: M · risk: medium
- files: src/renderer/app.js, src/renderer/components/notes-panel.js, src/webview/inspector.js
- fix:

Make Locate page-aware and never silent. 1) In app.js change the locate handler to be async: if `a.url && a.url !== state.currentUrl`, navigate the active tab to a.url (reuse navigateTo) and highlight after the next dom-ready/caos:ready for that tab, then `wv.send('caos:highlight-target', a.target)`; otherwise send immediately. Guard against a stale highlight if the user navigates away before ready fires. 2) Add a found/not-found ack: in inspector.js extend the caos:highlight-target handler to `ipcRenderer.sendToHost('caos:highlight-ack', { ok: !!el })` (or include whether it fell back to box-only), and in app.js's webview message wiring show `toast("Couldn't find this element on the current page", 'warn')` when ok is false. Treat the box-only fallback for an element target as a miss for ack purposes when resolve returned null, since page-A coordinates on page B are misleading. 3) In notes-panel.js noteCard, when `a.url` differs from the current page (pass currentUrl into the panel or compute host/pathname), render a small note-page chip (host + truncated pathname) so cross-page notes are legible; keep targetLabel as-is. Keep contextIsolation on, webview sandbox=no, renderer ESM/window.caos-only, and run `npm run e2e` to confirm the 51 checks stay green.

### action-tag-not-editable — A note's action tag can't be changed after capture (only text/status/priority are editable)
- dimension: ux · severity: medium · effort: S · risk: low
- files: src/renderer/components/notes-panel.js, src/renderer/app.js, src/webview/inspector.js
- fix:

In src/renderer/components/notes-panel.js, make the action span clickable to open the existing menu() helper instead of a raw <select>. (1) Import menu: change the import to `import { h, icon, clear, timeAgo, esc, menu } from '../lib/dom.js';`. (2) In noteCard, give the action span a click handler that opens an action picker, e.g. replace the static span with: `const actionSpan = h('span', { class: 'note-action', text: (actionMap[a.action] && actionMap[a.action].label) || a.action || 'comment', style: { color, background: color + '22', cursor: 'pointer' }, attrs: { title: 'Change action' } }); actionSpan.addEventListener('click', () => menu(actionSpan, config.actionTags.map((t) => ({ label: t.label, onClick: () => actions.setAction(a, t.id) }))));` and append actionSpan in the note-top row. In src/renderer/app.js, add to the createNotesPanel actions object (alongside editNote/setPriority, ~line 119-121): `setAction: (a, action) => updateAnnotation(a, { action }),`. updateAnnotation already persists and calls refreshPins(), so the pin recolors automatically; no IPC/store changes needed. The optional in-page pin badge menu can be deferred — keep scope to the notes panel.

### no-address-focus-affordance — Address bar lacks Cmd+L focus and the lock/security indicator is non-functional
- dimension: ux · severity: low · effort: S · risk: low
- files: src/renderer/components/toolbar.js, src/renderer/app.js
- fix:

Two-part renderer-only change. (a) In toolbar.js, add a focusAddress() helper { addressInput.focus(); addressInput.select(); } and include it in the returned object alongside root/update/setAddress/setSuggestions. (b) In app.js, register one global document keydown listener: if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); toolbar.focusAddress(); }. (c) In toolbar.js update(), drive the lock from currentUrl protocol: pick a 'lock'/'globe' icon for https://, an 'unlock'/'globe' (or warning-styled) icon for http://, and keep 'file' for file:// (empty/welcome -> file). Mutate the existing closure-held `lock` element, e.g. lock.innerHTML = icon(<chosen>, 14), and optionally toggle a class (e.g. lock.classList.toggle('insecure', isHttp)) for styling via .address .lock in app.css. Scope the lock to protocol only since update()'s state carries no load-failure flag; do not invent a failure signal unless syncToolbar is also extended to pass one. Skip the optional typed-hint to keep effort/risk minimal.

### dedup-export-annotation-renderer — Annotation-target renderer, ACTION_LABELS map, and truncate() are triplicated across main-process exporters/prompts
- dimension: quality · severity: high · effort: M · risk: low
- files: src/main/services/ai/prompts.js, src/main/services/export/markdown.js, src/main/services/export/prompt.js, src/main/config.js
- fix:

Add src/main/services/format/annotation.js (CommonJS) exporting: (1) truncate(str, max) — the existing identical body, with max kept as a required caller arg so each surface preserves its own limit (markdown 200, prompt 120, prompts.js 160); (2) labelFor(actionId) built from config.ACTION_TAGS (id→label) for the plain label case, replacing the two identical ACTION_LABELS maps in markdown.js and prompts.js; (3) targetPairs(annotation) — a single walker that returns an ordered array of {key, value} entries for the target shape (region box, else selector/tag/id/classes/text, then attrs href/src/alt/role/ariaLabel), so adding a new attr is a one-line change in one place. Then: markdown.describeTarget and prompts.renderAnnotation map ALL pairs into their respective formats; prompt.describeTargetInline maps only the subset it currently emits (selector|id|tag fallback, text, href|src) — keep its filtering behavior identical. Do NOT derive ACTION_VERBS from config.label: keep it as a small override map in prompt.js (or pass config labels through an override layer) because 'question' and 'comment' use custom verbs. Preserve every existing truncation limit and output string exactly so e2e/golden-text behavior is unchanged.

### dedup-action-tag-colors — Action-tag color hex values are hardcoded in 4 places despite config already flowing to the renderer
- dimension: quality · severity: medium · effort: M · risk: low
- files: src/main/config.js, src/webview/inspector.js, src/renderer/lib/screenshots.js, src/renderer/styles/app.css
- fix:

Make config.js the canonical data source and have the JS consumers derive from it; leave app.css :root as the styling source (it's CSS, can't import JS, and changing it is out of scope/over-engineering). Concretely:

1) screenshots.js (renderer, ESM): change compositeAnnotations to read colors from its existing third options arg without breaking current callers. e.g. signature `compositeAnnotations(dataUrl, annotations, { cssWidth, colors })` and inside use `const map = colors || ACTION_COLORS;` then `const color = map[a.action] || '#9aa2b1';`. Keep the local ACTION_COLORS as the fallback so e2e.js:228 (which passes no colors) stays green. Then in app.js at the two call sites (lines 960, 975) pass `colors: actionColorMap` where actionColorMap is built once from state.config.actionTags (e.g. `state.config.actionTags.reduce((m,t)=>((m[t.id]=t.color),m),{})`). This removes the renderer-side hardcode while preserving the harness.

2) inspector.js (webview CJS preload): replace the inline ACTIONS array (28-35) with `const ACTIONS = require('../main/config').ACTION_TAGS;` (config.js is pure data, no main-process deps, so this does not violate sandbox=no). ACTION_COLOR (36), the popup builder (282), and the badge color lookup (362) all keep working unchanged since ACTION_TAGS has the same {id,label,color} shape. If you prefer to avoid the webview->main cross-tree require, instead have the shell pass action tags into the inspector via the existing ipcRenderer channel and store them locally — but the require approach is acceptable and smaller.

Do NOT change compositeAnnotations to a required/positional colors param (would force editing e2e.js and risk the harness). Do NOT attempt to drive app.css :root from JS.

### dedup-escapehtml — escapeHtml in ai-panel.js duplicates esc() in lib/dom.js (same ESM module)
- dimension: quality · severity: low · effort: S · risk: low
- files: src/renderer/components/ai-panel.js, src/renderer/lib/dom.js
- fix:

In src/renderer/components/ai-panel.js: (1) change the import on line 4 to include esc, e.g. `import { h, icon, clear, toast, esc } from '../lib/dom.js';`. (2) Replace `escapeHtml(text)` with `esc(text)` at line 118 and line 132. (3) Delete the local escapeHtml function definition at lines 135-140. No other changes needed; the extra quote-escaping in esc is a safe superset and does not affect the downstream markdown regexes.

### history-unbounded — Browsing history grows unbounded and is fully rewritten on every navigation
- dimension: perf · severity: high · effort: S · risk: low
- files: src/main/store/repositories.js, src/main/store/db.js
- fix:

In repositories.js history.record, after determining it's a new URL, insert then trim to the newest N entries. Add a constant (e.g. const HISTORY_MAX = 1000;). Rewrite record as:
  record: ({ url, title }) => {
    if (!url) return null;
    const all = historyC.all();
    // newest entry is the last appended row (inserts append); fall back to a scan only if needed
    const recent = all.length ? all.reduce((a, b) => ((b.visitedAt || '') > (a.visitedAt || '') ? b : a)) : null;
    if (recent && recent.url === url) return historyC.update(recent.id, { visitedAt: now(), title: title || recent.title });
    const saved = historyC.insert({ id: id(), url, title: title || '', visitedAt: now() });
    if (all.length + 1 > HISTORY_MAX) {
      const keep = new Set(historyC.all().sort((a, b) => (b.visitedAt || '').localeCompare(a.visitedAt || '')).slice(0, HISTORY_MAX).map((h) => h.id));
      historyC.removeWhere((h) => !keep.has(h.id));
    }
    return saved;
  }
Notes: (1) The reduce avoids the full .sort() per call for the dedupe check (single O(n) pass instead of O(n log n)). If you prefer the absolute-minimal change, keep just the trim block and leave the existing sort line. (2) Trimming only runs when over the cap; the periodic removeWhere rewrite is acceptable since it happens once per insert only past the threshold. (3) An even cheaper dedupe (tracking last url in a closure variable) is possible but must be reset in history.clear() and is not robust across an update to an older same-URL row — the reduce above is correct without that bookkeeping, so prefer it.

### refreshsessions-nplus1 — refreshSessions fires one IPC + full-collection scan per session to compute badge counts
- dimension: perf · severity: medium · effort: S · risk: low
- files: src/renderer/app.js, src/main/store/repositories.js
- fix:

Add a grouped-count repo method, wire it through IPC + preload, and swap the renderer call. (1) In repositories.js annotations object, add: `countsBySession: () => { const m = {}; for (const a of annotationsC.all()) m[a.sessionId] = (m[a.sessionId] || 0) + 1; return m; }` (one scan, no sort). (2) In src/main/ipc/index.js add: `on('caos:annotations.countsBySession', () => repos.annotations.countsBySession());`. (3) In src/main/preload.js annotations block add: `countsBySession: () => invoke('caos:annotations.countsBySession'),`. (4) In app.js refreshSessions, replace the Promise.all block (lines 514-520) with: `state.sessionCounts = await caos.annotations.countsBySession();` (single IPC call, single pass). Note annotationsC.all() returns a sliced copy (db.js:32) which is fine here; if avoiding the slice matters you can iterate via find/_load, but all() is acceptable. bumpSessionCount stays as-is for the incremental add/remove path.

### scroll-redraw-unthrottled — Webview scroll handler calls full canvas redraw() synchronously on every scroll event
- dimension: perf · severity: low · effort: S · risk: low
- files: src/webview/inspector.js
- fix:

1) Add an early-return guard to redraw() so it skips work when there is nothing to draw or the canvas is hidden: at the top of redraw() (after the `if (!ctx) return;` at line 129) add `if (mode !== 'draw' || !strokes.length) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }` — clearing first keeps the canvas clean if strokes were just cleared, then bails before the stroke loop. 2) Throttle the scroll-path redraw through the existing rAF batch instead of calling it directly. Change the scroll listener (lines 519-526) from `redraw(); queuePinSync();` to just `queuePinSync();`, and inside syncPins() (line 414) add a `redraw();` call (e.g. right after `pinSyncQueued = false;`). Because redraw now early-returns unless mode==='draw' with strokes, the resize path (sizeCanvas already calls redraw at line 125) and the off-draw scroll path do effectively no extra work, and the draw-mode scroll redraw is coalesced to one call per frame alongside pin syncing. Do not call redraw unconditionally on every scroll event.

### no-focus-visible — No keyboard focus indicator on any button or interactive control
- dimension: a11y · severity: high · effort: S · risk: low
- files: src/renderer/styles/app.css
- fix:

Add a single global keyboard-scoped focus rule to src/renderer/styles/app.css. Place it near the top after the base reset (e.g. just after the `button { font-family: inherit; }` rule on line 47, or after the `* { box-sizing: border-box; }` on line 33):

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

Notes: use the existing --accent (#5b8cff) and --radius-sm tokens for consistency. Keep it as :focus-visible (NOT :focus) so mouse clicks don't draw rings — Chromium/Electron supports :focus-visible natively. Do not add a plain :focus rule. No changes are needed to the elements that set outline:none/outline:0 (.address input, .note-edit, .input): they already show a focus indicator via box-shadow/border, and the global :focus-visible outline is additive and harmless on them. Drop the `border-radius: inherit` from the original proposed fix in favor of an explicit var(--radius-sm), since `inherit` on many of these buttons would resolve to a non-rounded ancestor value.

### div-rows-not-keyboard-operable — Sidebar rows, browser tab chips, and DOM-tree nodes are click-only <div>s (not keyboard operable)
- dimension: a11y · severity: high · effort: M · risk: medium
- files: src/renderer/components/sidebar.js, src/renderer/components/tabs.js, src/renderer/components/inspector-panel.js
- fix:

Make the click-only divs keyboard-operable without nesting interactive elements illegitimately. (1) sidebar.js row(): on the outer `side-row` div add `role: 'button'`, `tabindex: '0'`, and an `on.keydown` that fires onClick for Enter/Space — for Space call e.preventDefault() to suppress page scroll; keep the inner sr-act buttons' e.stopPropagation() so they don't double-trigger. Optionally add `'aria-label'` or rely on the sr-name text. (2) tabs.js: on `tab-chip` add `role: 'tab'` (or 'button'), `tabindex: t.id === activeId ? '0' : '-1'` (roving tabindex; '0' for all is also acceptable), `'aria-selected'`, and a keydown handler calling actions.selectTab for Enter/Space (preventDefault on Space); leave tc-close as-is. (3) inspector-panel.js renderNode(): on `tree-self` add `role: 'treeitem'` (or 'button'), `tabindex: '0'`, and a keydown handler that runs the existing highlight()+hot logic for Enter/Space (preventDefault on Space), excluding the toggle the same way the click handler does. Because h() forwards unknown props via setAttribute, pass these in the props object. Do not change tag to <button> in the sidebar case (it contains nested <button>s, which is invalid HTML). After applying, run `npm run e2e` to confirm the 51 checks stay green.

### modal-no-focus-trap-return — Modals have no focus trap, no initial focus, and no return-focus
- dimension: a11y · severity: medium · effort: M · risk: low
- files: src/renderer/lib/dom.js
- fix:

In modal() in src/renderer/lib/dom.js: (1) Capture the trigger before showing the modal — at the top of modal(), `const lastFocused = document.activeElement;`. (2) Define a focusable selector `const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';` and a helper to read card.querySelectorAll(FOCUSABLE). (3) Extend onKey to also trap Tab: when e.key==='Tab', collect focusable descendants of card; if none, preventDefault; if Shift+Tab and active===first (or focus is outside card), wrap to last and preventDefault; if Tab and active===last (or outside), wrap to first and preventDefault. Keep the existing Escape branch. (4) After requestAnimationFrame(...add 'show'), set initial focus: focus the first focusable element in card, else the modal-x close button, else card itself (give card tabindex="-1"). Do this inside the rAF or a microtask so layout is ready. (5) In close(), after removing the keydown listener, restore focus: `if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) lastFocused.focus();`. Leave promptDialog's own input.focus()+select() (line 226) as-is — it runs after and refines selection within the already-focused input; no change needed there. No other files require edits since confirmDialog and settings-modal inherit modal() automatically.

### icon-buttons-no-aria-label — Icon-only buttons rely on title but have no aria-label; star/close use bare glyphs
- dimension: a11y · severity: medium · effort: S · risk: low
- files: src/renderer/components/toolbar.js, src/renderer/components/tabs.js, src/renderer/lib/dom.js, src/renderer/components/sidebar.js
- fix:

Add aria-label to every icon-only/glyph-only button, matching the existing title text; for glyph buttons set aria-label explicitly so the glyph isn't announced.
- toolbar.js btn() (line 25-31): add `'aria-label': cfg.title || cfg.label || ''` to the h() props so back/forward/reload/camera/settings get a name (already have visible text when cfg.label set, but aria-label keyed off title is fine and consistent).
- toolbar.js:23 bookmarkBtn: add `'aria-label': 'Bookmark this page'`. Note line 65 only updates textContent; the aria-label stays correct, but optionally update it to 'Bookmarked'/'Bookmark this page' in update() to reflect toggled state.
- tabs.js:17 close button: add `'aria-label': 'Close tab'`.
- dom.js:142 modal-x: add `'aria-label': 'Close'` (it currently has no title either).
- sidebar.js:13 clearHistoryBtn: add `'aria-label': 'Clear history'`. In row() sr-act buttons (line 42) add `'aria-label': a.title`. In section() add button (line 25) add `'aria-label': 'New ' + title.slice(0, -1).toLowerCase()`.
Leave the labeled toolbar buttons' visible <span> text as-is. Do not change any class names or data attributes the e2e harness selects on.

### no-reduced-motion — No prefers-reduced-motion handling for pulsing/spinning/transition animations
- dimension: a11y · severity: low · effort: S · risk: low
- files: src/renderer/styles/app.css
- fix:

Append a reduced-motion block to the end of src/renderer/styles/app.css:

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

This neutralizes the infinite pulse/spin (they render a single static frame) and collapses all micro-transitions, while leaving normal layout/visibility intact. Place it at end-of-file so the !important rules reliably win over the cascade.

### faint-text-contrast — --faint dim text fails WCAG AA contrast at small sizes
- dimension: a11y · severity: low · effort: S · risk: low
- files: src/renderer/styles/app.css
- fix:

In src/renderer/styles/app.css line 12, change `--faint: #6b7280;` to `--faint: #8a93a3;`. This raises contrast on --bg from 3.96:1 to 6.19:1, clearing the 4.5:1 WCAG AA threshold for normal text, and cascades to all dependent selectors (.sr-meta, .field-hint, .note-kind, .note-num, .note-time, .tree-text, .placeholder, .rc-badge.no, address placeholder, etc.). No other changes needed; the finding's ~5:1 estimate was conservative — actual is 6.19:1.

### suggest-fix-mis2-wired — suggest-fix is reachable in the AI panel but wired without the single annotation it needs, so it returns garbage
- dimension: goal · severity: high · effort: M · risk: low
- files: src/renderer/components/ai-panel.js, src/renderer/app.js, src/main/services/ai/prompts.js
- fix:

Two parts. (1) Per-note action: in src/renderer/components/notes-panel.js noteCard actsRow (lines 80-85), add a button e.g. `h('button', { class: 'note-act', title: 'Suggest fix', html: icon('ai', 15), on: { click: () => actions.suggestFix(a) } })`, and add `suggestFix` to the actions object passed to createNotesPanel in app.js (~line 117-124). Implement it in app.js as an async fn that runs `caos.ai.run({ task: 'suggest-fix', sessionId: state.currentSession && state.currentSession.id, annotations: [a], context: { annotation: a } })`, switches to the AI tab (switchTab('ai')), shows a loading state, and renders the result in the AI panel (expose a method on aiPanel like `showExternalResult(text)`/`runExternal(...)` rather than reusing the dropdown-bound run()). Reuse aiPanel.focusTask('suggest-fix') to set the dropdown for consistency. (2) Guard the generic dropdown: in ai-panel.js run(), when select.value === 'suggest-fix' and no annotation context is available, show an inline message ('Suggest fix runs on a single note — use the Suggest fix button on a note card') instead of dispatching, OR omit 'suggest-fix' from the dropdown taskIds (filter it out at line 7) so it can only be invoked per-note. The context.html (target element outerHTML) is genuinely optional — prompts.js truncates/guards it and the no-key synthesize() path ignores context entirely — so a new webview IPC to capture outerHTML can be deferred; ship the annotation wiring first.

### selector-no-testid-pref — Selector capture has no data-testid/name/aria preference and falls back to brittle :nth-of-type chains
- dimension: goal · severity: high · effort: M · risk: low
- files: src/webview/anchor.js
- fix:

In src/webview/anchor.js cssPath(), add a stable-attribute fast-path. Place it ahead of (or right alongside) the id fast-path, guarded by a global-uniqueness check so a brittle chain is never emitted when a clean hook exists:

After the `if (!(el instanceof Element)) return '';` guard, before the id block, add:
```
const STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label'];
for (const a of STABLE_ATTRS) {
  try {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) {
      const cand = '[' + a + '="' + String(v).replace(/(["\\])/g, '\\$1') + '"]';
      if (document.querySelectorAll(cand).length === 1) return cand;
    }
  } catch (_e) { /* ignore */ }
}
```
Keep the existing id fast-path and the :nth-of-type chain unchanged as fallbacks. The uniqueness guard (.length === 1) ensures we only emit a stable-attr selector when it resolves to exactly one element, mirroring the existing id guard.

In describe().attrs (lines 85-91), add the captured hooks so exports/prompts surface them:
```
attrs: {
  href: get('href'),
  src: get('src'),
  alt: get('alt'),
  role: get('role'),
  ariaLabel: get('aria-label'),
  testid: get('data-testid') || get('data-test') || get('data-cy'),
  name: get('name'),
},
```
Optional (the finding's "candidate list" idea): omit unless you also update the export/prompt/markdown surfaces to render it — not required for the core win and would widen scope. No e2e changes needed; the fixture has no test hooks so the id fast-path still produces #cta/#hero and all 51 checks remain green. Run npm run e2e after applying to confirm.

### copy-selector-everywhere — No copy-selector / copy-note affordance in the inspector tree or note cards
- dimension: goal · severity: medium · effort: S · risk: low
- files: src/renderer/components/inspector-panel.js, src/renderer/components/notes-panel.js
- fix:

Mirror ai-panel.js copy() in both panels using navigator.clipboard.writeText + toast (import toast in both files; both already import from ../lib/dom.js, and a 'copy' icon exists).

inspector-panel.js: in renderNode, add a copy button into the `self` row (or append after nodeLabel) that copies node.selector. Guard against missing selector. Use stopPropagation so clicking copy does not trigger the node's highlight/hot-select click handler. Example handler:
  const copyBtn = h('button', { class: 'tree-copy', title: 'Copy selector', html: icon('copy', 12), on: { click: async (e) => { e.stopPropagation(); if (!node.selector) return; try { await navigator.clipboard.writeText(node.selector); toast('Selector copied', 'success'); } catch { toast('Copy failed', 'error'); } } } });
  self.appendChild(copyBtn);

notes-panel.js: add to actsRow a 'Copy selector' button that copies the real resolved selector only when present, and a 'Copy note' button for the text. Do NOT copy targetLabel(a) blindly — it returns region geometry ("region · WxH @ x,y") or "<tag>"/"element" fallbacks that are not valid selectors. Use a.target && a.target.selector; if absent, either omit/disable the copy-selector button or fall back to copying the note text. Example:
  const sel = (a.target && a.target.selector) || '';
  ... h('button', { class: 'note-act', title: 'Copy selector', html: icon('copy', 15), on: { click: async () => { if (!sel) { toast('No CSS selector for this target', 'info'); return; } try { await navigator.clipboard.writeText(sel); toast('Selector copied', 'success'); } catch { toast('Copy failed', 'error'); } } } })
Optionally add a second button copying a.note. Add minimal CSS for .tree-copy in styles/app.css (small, shown on row hover) to match existing .note-act styling.

### copy-all-as-prompt — No one-click 'copy all as prompt' to clipboard — every export forces a save dialog
- dimension: goal · severity: medium · effort: S · risk: low
- files: src/renderer/app.js, src/main/ipc/index.js
- fix:

In src/renderer/app.js add a 'Copy prompt' button to the footer (around app.js:151-156), e.g. h('button', { class: 'btn btn-sm', text: 'Copy prompt', title: 'Copy the agent prompt to clipboard', on: { click: () => copyExport('prompt') } }), placed before the Agent button. Then add a helper alongside doExport: async function copyExport(format) { if (!state.currentSession) { toast('Open or start a session first', 'warn'); return; } try { const result = await caos.export.build(format, state.currentSession.id); if (!result || !result.content) { toast('Nothing to export', 'warn'); return; } await navigator.clipboard.writeText(result.content); toast('Prompt copied to clipboard', 'success'); } catch (e) { toast('Copy failed: ' + (e && e.message ? e.message : e), 'error'); } } Note: copy result.content (the string), not the result object — matching how doExport passes result.content to save. No changes to ipc/index.js, preload.js, CSP, or webview sandbox settings are needed. If the e2e harness asserts a fixed button count, add a corresponding check so it stays green.

### persist-open-tabs — Open tabs are not persisted across launches; app always boots to the welcome page
- dimension: goal · severity: medium · effort: M · risk: low
- files: src/renderer/app.js, src/main/store/repositories.js
- fix:

Persist the open-tab working set through the existing settings channel and restore it on boot.

1) Add a debounced persistter in app.js:
   function persistOpenTabs() {
     const urls = state.tabs.map((t) => t.url).filter((u) => u && !/welcome\.html$/.test(u));
     const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
     caos.settings.set({ openTabs: urls, activeTabIndex: activeIdx }).catch(() => {});
   }
   (Reuse the same /welcome\.html$/ filter already used in onNavigated so welcome pages are never persisted.)

2) Call persistOpenTabs() after the tab set or active tab changes: at the end of createTab (after setActiveTab), in closeTab (after splice/refresh), in setActiveTab, and in onNavigated once tab.url is updated. Skip persisting while state.replaying is true to avoid churn.

3) In boot(), replace the unconditional createTab(state.config.welcomeUrl) with a restore-then-fallback, and DO NOT restore under e2e (the harness drives tabs itself):
   const saved = !caos.e2e ? (state.settings.openTabs || []) : [];
   if (saved.length) {
     saved.forEach((u) => createTab(u));
     const idx = Number.isInteger(state.settings.activeTabIndex) ? state.settings.activeTabIndex : 0;
     const target = state.tabs[idx] || state.tabs[0];
     if (target) setActiveTab(target.id);
   } else {
     createTab(state.config.welcomeUrl);
   }

No backend change is required: settings.set already merges arbitrary JSON (store/db.js merge) and persists it. Run `npm run e2e` afterward to confirm the harness (51 checks) stays green — the !caos.e2e guard keeps boot deterministic for the harness.

### capture-guest-console — Guest console messages are observed but never captured for the agent handoff
- dimension: goal · severity: medium · effort: M · risk: low
- files: src/renderer/app.js, src/main/services/export/prompt.js, src/main/store/repositories.js
- fix:

In src/renderer/app.js, extend the existing 'console-message' listener (lines 250-252) and add a 'did-fail-load' listener to push into a bounded per-tab buffer (e.g. tab.consoleLog = []), keeping the last ~50 entries with level>=1 (warnings+errors) plus failed loads, each as {level, message, source, line, ts} or {kind:'load-fail', code, desc, url}. Keep the existing console.warn for dev visibility. When building the export payload (the existing prompt/markdown export path in app.js), pass the active tab's buffered console entries through to the main-process exporters rather than having main read renderer state. Update prompt.js toPrompt(session, annotations, consoleEntries) and markdown.js toMarkdown(session, annotations, consoleEntries) to accept an optional third arg and, when non-empty, render a 'Console errors observed' section (prompt: a short bulleted list of recent errors/warnings the agent should account for; markdown: a fenced section). Keep the third arg optional/back-compatible so existing callers and the e2e harness stay green. Do NOT add network capture or CDP webRequest in this change. Do not conflate with the screenshot CDP debugger at ipc/index.js:158. Optionally surface the buffer in a small read-only panel, but that is not required.

### annotation-ordering — Annotations cannot be reordered or grouped; export order is fixed insertion order
- dimension: goal · severity: low · effort: M · risk: low
- files: src/renderer/components/notes-panel.js, src/main/services/export/prompt.js
- fix:

Apply ONLY the priority-sort export (the S tier); do NOT add a drag-reorder UI or a persisted `order` field. In src/main/services/export/prompt.js, before the numbering loop, replace the raw `list` iteration with a priority-sorted copy that is a STABLE sort (preserves insertion order within a priority tier). Concretely: define `const PRIO_RANK = { critical: 0, high: 1, normal: 2, low: 3 };` and build `const ordered = list.map((a, i) => [a, i]).sort((x, y) => (PRIO_RANK[x[0].priority || 'normal'] - PRIO_RANK[y[0].priority || 'normal']) || (x[1] - y[1])).map((p) => p[0]);` then iterate `for (const a of ordered)`. Do NOT mutate the input `annotations` array (keep it a copy, since the notes-panel pin numbers rely on insertion order via annotations.indexOf). Apply the identical stable priority-sort in the markdown exporter (src/main/services/export/markdown.js) for consistency so both exports lead with critical->high->normal->low. Leave the JSON exporter in raw order (it is a faithful data dump). The notes-panel render order can stay insertion-order (it preserves pin-number correspondence); reordering the panel is the deferred L tier and is out of scope.

### no-draw-region-coverage — Region/draw-mode annotations are entirely untested
- dimension: tests · severity: high · effort: M · risk: low
- files: src/renderer/lib/e2e.js, src/webview/inspector.js
- fix:

Add a new section to src/renderer/lib/e2e.js after section 3 (restore pins). Steps: (1) I.setMode('draw'); assert I.state.mode === 'draw'. Note setMode toggles, so call only once from a non-draw state. (2) Synthesize a drag inside #tall's visible viewport area. Compute a start point from the guest (e.g. #tall's getBoundingClientRect top + a small offset, clamped into the viewport) and issue trusted events: wv.sendInputEvent mouseDown at (x,y1); a few mouseMove events (e.g. y1→y1+40→y1+90, x→x+60) so curStroke accumulates points; mouseUp. Add small awaits between events. These fire the capture-phase onDown/onDraw/onUp listeners (inspector.js 190-203). Optionally assert the canvas/drawBar are visible (drawBar.style.display==='flex'). (3) Click the draw-bar note button: clickSel('[data-caos] [data-act=note]'); await sleep(250); assert the popup textarea appeared. (4) Fill + save reusing the existing helpers: const regMsg = onceChannel('caos:annotation', 3000); clickSel('[data-caos] textarea'); typeText('Region note for the tall block'); optionally pick a chip; clickSel('[data-caos] [data-save]'); const sentReg = await regMsg; assert sentReg && sentReg.kind === 'region'. (5) await sleep(400); const persisted2 = await caos.annotations.bySession(session.id); const regNote = persisted2.find(a => a.kind === 'region'); check region annotation persisted with a numeric target.box (regNote && regNote.target && regNote.target.box && typeof regNote.target.box.w === 'number'). (6) I.refreshPins(); await sleep(250); re-count the circular badges as in section 3 and assert pinCount === 2 (the element pin plus the new region pin). Then proceed to section 4. No production code changes; webview sandbox/contextIsolation/ESM-CJS split untouched.

### no-annotation-mutation-coverage — Annotation edit / delete / status / priority never exercised
- dimension: tests · severity: high · effort: M · risk: low
- files: src/renderer/lib/e2e.js, src/renderer/app.js
- fix:

In src/renderer/lib/e2e.js, after the existing "host state synced" check (line 100, where elNote is the persisted element annotation), insert a mutation-coverage block before section 3:

1. Update all three fields at once: `const upd = await caos.annotations.update(elNote.id, { status: 'resolved', priority: 'high', note: 'edited note' });` and assert the returned record reflects them: `check('annotation update returns patched record', upd && upd.status === 'resolved' && upd.priority === 'high' && upd.note === 'edited note', upd && JSON.stringify({s:upd.status,p:upd.priority}));`
2. Re-fetch via bySession and assert all three fields stuck: `const reFetched = (await caos.annotations.bySession(session.id)).find((a) => a.id === elNote.id); check('annotation update persisted (re-fetch)', reFetched && reFetched.status === 'resolved' && reFetched.priority === 'high' && reFetched.note === 'edited note');`
3. Sync host state and pins as the UI path does, then delete: keep `I.state.annotations` updated by re-fetching the full set into state if you want to exercise refreshPins faithfully — but minimally: `await caos.annotations.remove(elNote.id); const afterDel = await caos.annotations.bySession(session.id); check('annotation remove deletes the record', !afterDel.some((a) => a.id === elNote.id), 'remaining=' + afterDel.length);`
4. Verify pins drop to 0: set `I.state.annotations = afterDel;` then `I.refreshPins(); await sleep(250); const pinsAfterDel = await guest("Array.from(document.querySelectorAll('div[data-caos]')).filter(d => d.style.borderRadius === '50%').length"); check('pin removed after delete (0 pins)', pinsAfterDel === 0, 'pins=' + pinsAfterDel);`

Note: refreshPins filters on a.url === state.currentUrl, and elNote.url === fixtureUrl (the current URL), so updating I.state.annotations before calling I.refreshPins is required for the pin-count assertion to be meaningful. Place this block BEFORE the existing section 3 "Restore pins" block, OR fully replace section 3 — but if kept before section 3, note that section 3 then asserts pinCount === 1 against a now-deleted annotation; therefore put the mutation/delete block AFTER section 3 (after line 107) so the pinCount===1 check still passes against the live annotation, then mutate and delete. Drive entirely at the repository (caos.annotations) layer to avoid the confirmDialog modal, mirroring how section 5 bypasses the recording-name prompt.

### no-reload-restore-coverage — Restore-annotations-after-reload (a headline feature) is not tested
- dimension: tests · severity: high · effort: M · risk: low
- files: src/renderer/lib/e2e.js, src/renderer/app.js, src/webview/inspector.js
- fix:

In e2e.js, after section 3's existing refreshPins check (after line 107), add an end-to-end reload-restore sub-section that exercises maybeRestoreAnnotations specifically (NOT refreshPins):

```js
// --- 3b. Pins survive a reload (dom-ready restore path) ---
I.state.settings.restoreAnnotationsOnLoad = true; // default true, set defensively
const readyReload = waitDomReady();
I.navigateTo(fixtureUrl);
await readyReload;
await sleep(400); // let did-navigate update state.currentUrl + dom-ready fire maybeRestoreAnnotations -> bySessionUrl
const restoredPins = await guest("Array.from(document.querySelectorAll('div[data-caos]')).filter(d => d.style.borderRadius === '50%').length");
check('annotation pin restored after reload (dom-ready path)', restoredPins === 1, 'pins=' + restoredPins);
```

Notes: (1) Reuse the section-0 waitDomReady/guest/sleep helpers already in scope. (2) The 400ms sleep matters: maybeRestoreAnnotations (app.js:424) reads state.currentUrl, which is set by the did-navigate handler; the assertion must run only after the dom-ready restore round-trips through the host. (3) This must come BEFORE the replay sections (5-6) so the freshly-loaded page state isn't already perturbed. (4) Optionally, to prove bySessionUrl's exact-url match guards correctly, this is sufficient since session.url === fixtureUrl === the annotation's url. Do not change the existing line-103 refreshPins check; keep both to distinguish the two code paths.

### no-recording-editor-coverage — Recording editor (reorder / delete / add assertion) has no coverage
- dimension: tests · severity: medium · effort: S · risk: low
- files: src/renderer/lib/e2e.js, src/renderer/app.js
- fix:

In src/renderer/lib/e2e.js, after the existing recording is created/replayed (around the section using `recording` near lines 134-164, before its cleanup at line 263), add a step-array editing round-trip that mirrors what editRecording persists. Reuse the existing `recording` (or create a small dedicated one with >=3 steps of known order). Capture the original order, then build a `reordered` array by swapping two adjacent steps and splicing one out (the same array mutations editRecording performs), and append an assert step like `{ type: 'assert', kind: 'exists', selector: '#cta', ts: 99 }`. Persist via `await caos.recordings.update(recording.id, { steps: reordered });` then `const edited = await caos.recordings.get(recording.id);` and assert: (a) edited.steps.length === reordered.length (delete + add reflected), (b) the swapped order survives (e.g. compare edited.steps[0].type/selector to the expected swapped value), and (c) the appended assert step round-trips (edited.steps.some(s => s.type === 'assert' && s.selector === '#cta')). Use the existing `check(...)` helper for each assertion. Clean up with caos.recordings.remove if you created a dedicated recording. Do not attempt to open the modal or openAssertEditor UI — drive the data contract directly.

### no-error-path-coverage — No negative/error-path checks for replay timeout or missing-recording guards
- dimension: tests · severity: medium · effort: M · risk: low
- files: src/renderer/lib/e2e.js, src/renderer/app.js, src/webview/replay.js
- fix:

In src/renderer/lib/e2e.js, after the section-9b assert block (before the agent-handoff section, around line 191), add a new section: create a recording with steps [{type:'navigate', url:fixtureUrl, ts:1}, {type:'click', selector:'#gone', ts:2}] via caos.recordings.create; refreshRecordings(); selectRecording(it); set state.settings.replayDelayMs=30; const report = await I.replaySelected(). Then assert: (a) the click step failed — check('replay action-step on missing selector reports ok:false', !!report && report.steps.some((s) => s.type==='click' && !s.ok && /could not resolve|timeout/i.test(s.error||'')) ), and (b) report counts reflect it — check('report marks action failure', report && report.failed>=1 && report.passed>=1). Start the recording with a navigate step (as 9b does) so the host re-navigates to a fresh fixture and #gone is deterministically absent. Clean up with caos.recordings.remove(it.id) afterward, mirroring the aRec cleanup. This exercises the per-step resolve-miss/timeout branch (replay.js:125, app.js:889) that the assert path never hits.

## Deliberately rejected (scope creep)

- Settings-driven AI timeout (config.js default + settings-modal field) — explicitly out of scope; hardcoded 120s constant is the minimal fix.
- Drag-to-reorder annotation UI + persisted `order` field — only the stable priority-sort export (S tier) is in scope; the drag UI is the deferred L tier.
- Capturing target element outerHTML via a new webview IPC for suggest-fix context — prompts.js guards/ignores it and the no-key path drops context entirely; ship annotation wiring only.
- Network/CDP webRequest capture for the agent handoff — only bounded console-message + did-fail-load buffering is in scope; no network capture.
- Network progress bar in the load-state UI — optional and dropped to keep effort down; spinner/stop-icon + error placeholder is sufficient.
- Driving app.css :root colors from JS — CSS can't import JS and it's over-engineering; config.js stays canonical only for the JS consumers (screenshots/inspector).
- Stronger tab-keyed replayWaiters (`${tabId}:${index}`) for future multi-tab replay — larger surface, not needed now; the isActive() gate + replay-locks-tab-switching is sufficient.
- Switching save IPC handlers to a {ok:false,error} return contract — would force editing all save callers; rethrow-clean-Error keeps existing truthy-filePath semantics and the harness green.
- Parent-directory fsync after rename in atomicWrite — portability risk on Windows; skipped as low priority.
- Reordering the notes panel render to match priority — would break pin-number/insertion-order correspondence; panel stays insertion-order.
- Disabling allowpopups entirely — kept enabled since setWindowOpenHandler now consumes the event; stricter posture is optional, not required.
- Candidate-selector-list export surface for anchor.js — would widen scope into export/prompt/markdown rendering with no core win.

## Progress (ultracode improvement pass)

- [x] B1 security · [x] B2 replay/session correctness · [x] B3 persistence
- [x] B4 perf/history · [x] B5 robustness · [x] B7 stable selectors
- [x] B6 UX shortcuts/load-state · [~] B8 goal features (copy-prompt, copy-selector,
  suggest-fix, priority-ordered exports, persist-tabs done; **deferred:** guest
  console/network capture, cross-page locate-ack)
- [~] B9 (focus-visible, contrast, reduced-motion, aria-labels, modal focus-trap done;
  **deferred:** code dedups — escapeHtml, export annotation renderer, action-tag colors)
- [ ] B10 e2e coverage expansion (annotation mutation/reload-restore/draw-region/recording-
  editor/error-path checks) — **deferred**

e2e: 52/52 green throughout. Deferred items are low-risk follow-ups, none on the critical path.
