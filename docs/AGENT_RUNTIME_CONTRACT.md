# Agent browser runtime — shared contract

Source of truth for the modules built in parallel. Derived from `Braiwser-Code-Audit.md`
(Agent browser expansion). Everything here is **disabled by default** behind the
`agentRuntime` setting / `BRAIWSER_AGENT_RUNTIME=1`.

## Identities (never interchangeable)
- `sessionId`  — a live `BrowserSession` (browser context/profile). Never a review session id.
- `pageId`     — a page registered in that session. Never the active UI tab, never a raw `webContentsId`.
- `reviewSessionId` — OPTIONAL link to a persisted annotation/review session.
- `runId`, `operationId`, `requestKey`, `observationId`, `refId`, `documentEpoch`.

## Module layout and owners
```
src/shared/browser-contracts.js            (CJS) ids, enums, error codes, DTO validators  [core]
src/main/services/browser/owned-page.js    (CJS) ownership kernel, from audit §A            [core]
src/main/services/browser/policy.js        grants, destinations, approvals (one-use)       [core]
src/main/services/browser/ledger.js        single-writer durable operation journal         [core]
src/main/services/browser/evidence.js      redaction, artifact store, manifests, quotas    [core]
src/main/services/browser/run.js           durable run state machine, uses review/verdict  [core]
src/main/services/browser/human-handoff.js agent<->human lease                             [core]
src/main/services/browser/broker.js        the ONE facade for MCP / CLI / UI               [core]
src/main/services/browser/drivers/playwright.js  headless/visible Chromium                 [core]
src/main/services/browser/drivers/electron.js    main-owned guest + CDP input              [core]
src/main/services/browser/drivers/cdp-pointer.js from audit §E                              [core]
src/main/services/browser/cli.js           headless worker entry (no Electron)             [core]
src/webview/probe.js                       bundled observation/highlight probe             [core]
src/main/services/automation/*.mjs         MCP adapter, receipt, workflow, cli             [automation]
src/main/services/automation/skill-registry.js                                              [automation]
.agents/skills/braiwser-verify/            SKILL.md + scripts/run.mjs                      [automation]
src/main/ipc/browser.js                    narrow trusted-shell IPC, sender-validated      [ui]
src/renderer/controllers/agent-runs.js, components/agent-runs-panel.js,
components/agent-approval-modal.js                                                          [ui]
```
New code in `src/main` / `src/webview` / `src/shared` is CommonJS (`.js`) unless the file is
`.mjs` (automation adapters only). Renderer is ESM. `scripts/check.js` must be taught about
`.mjs` and `src/shared`.

## Broker API (all methods async, all take `ctx = { principal, signal? }` as last arg)
`principal = { id, kind: 'ui'|'mcp'|'cli'|'skill', scopes: string[] }`. Ownership of every
session/run/resource is checked against `principal` — possession of an id is not authority.

```
createBroker({ dataDir, drivers, policy, clock, featureFlag }) -> broker
broker.openSession({ driver:'playwright'|'electron-embedded', mode:'headless'|'visible',
                     profile?, reviewSessionId?, grant }, ctx)
   -> { sessionId, pageId, capabilities, limits }
broker.closeSession({ sessionId }, ctx)
broker.observe({ sessionId, pageId, maxNodes?, focus?, cursor? }, ctx)
   -> { sessionId,pageId,observationId,documentEpoch,url,trust:'untrusted-page',nodes[],
        coverage,truncated,nextCursor,evidenceUri }
broker.act({ sessionId,pageId,runId?,observationId,documentEpoch,operationId,action,approvalId? }, ctx)
   -> receipt { operationId,sessionId,pageId,status:'not_attempted'|'dispatched'|'verified'|'uncertain',
                code,dispatched,effectUnknown,afterObservationId,evidenceUri }
broker.startRun({ sessionId,pageId,requestKey,skillId,skillVersion,maxDurationMs,inputs }, ctx) -> RunDTO
broker.getRun({ runId, afterSequence, maxEvents }, ctx) -> RunDTO
broker.cancelRun({ runId }, ctx) -> RunDTO
broker.handoff({ sessionId,pageId,runId?,reason }, ctx) -> { owner, documentEpoch, method }
broker.resume({ sessionId,pageId }, ctx)          // principal.kind === 'ui' only
broker.approve({ approvalId, decision:'allow'|'deny' }, ctx)  // principal.kind === 'ui' only
broker.listRuns({ reviewSessionId? }, ctx), broker.getManifest({ runId }, ctx)
broker.readResource(uri, ctx)                     // braiwser://capabilities | skills/catalog | runs/{id}/manifest | runs/{id}/observations/{id}
broker.forPrincipal(principal) -> same API with ctx bound
broker.events  // EventEmitter: 'run-event', 'approval-requested', 'owner-changed', 'session-closed'
```
`RunDTO` is exactly the `run` Zod schema in the audit's `mcp.mjs` slice (state + verdict +
counters + events + nextSequence + manifestUri). Verdict/counters come ONLY from
`src/main/services/review/verdict.js` (`runVerdict`). Lifecycle `uncertain|interrupted` => verdict `unknown`;
`queued|running|needsApproval|needsHuman` => `pending`.

Error DTO: `{ code: STALE_REF|AMBIGUOUS_TARGET|DENIED|TIMEOUT|CANCELLED|UNSUPPORTED|UNAVAILABLE|INTERNAL,
message, dispatched, effectUnknown, retry }`. Brokers throw `Error` with `.publicError` set to it.

## Rules that must hold everywhere
1. No arbitrary JS/CDP/shell/file-path/cookie export in any tool. Closed action + assertion DSL.
2. Page content is untrusted data; it never alters grants/approvals/destinations.
3. A timeout is a result deadline, not proof work stopped — keep the lane barrier, quarantine.
4. Never auto-replay an `uncertain`/dispatched-before-crash operation. Restart => `interrupted`.
5. Secrets (password/OTP/payment fields) never enter observations, ledgers, manifests, logs, exports.
6. Playwright driver: `require('playwright-core')`, launched with `chromiumSandbox: true`,
   `acceptDownloads: false` unless a download expectation is granted. Never `force:true`.
7. Only ONE process writes the ledger/store (the owning broker). No sidecar JSON writers.

## Driver interface (implemented by `drivers/*.js`, consumed by broker/run)
```
driver.name                       'playwright' | 'electron-embedded'
driver.capabilities()             versioned doc: { driver, version, dom, frames, shadowDom, canvas, popups, downloads,
                                  uploads, dialogs, permissions, screenshots, humanHandoff:'native'|'remote-view'|
                                  'checkpoint-relaunch'|'unsupported', liveModeSwitch:false, modes:[...] }
driver.open({ mode, viewport, locale, timezoneId, profile, onPageEvent }) -> DriverSession
DriverSession { capabilities, pages: Map<pageId, DriverPage>, newPage(), close() }
DriverPage {
  pageId, url(), documentEpoch,                      // epoch bumps on ANY navigation incl. SPA/frame
  navigate(url, { signal, timeoutMs }) -> { outcome:'ready'|'failed'|'timeout'|'cancelled', url }
  observe({ maxNodes, focus, cursor }) -> { nodes:[{refId,role,name,enabled?,editable?,frameId?}], coverage, truncated, nextCursor }
  resolve(refId) -> { fingerprint, scope }          // server-side only, never exposed
  act(cmd, control) -> { status:'dispatched'|'verified', evidence[] }   // control = OwnedPage {signal,check,beforeDispatch}
  evaluateAssertion(assertion) -> { status:'passed'|'failed'|'unknown', actual, evidence[] }  // closed DSL only
  screenshot({ clip? }) -> { bytes, meta:{url,viewport,scale,scroll,capturedAt,transformed:false} }
  setOwnerBadge(owner)                                // visible drivers: show agent/human/quarantined
  events: 'navigated' | 'crashed' | 'closed' | 'popup' | 'download' | 'dialog'  (EventEmitter)
  dispose()
}
```
Actions DSL (closed): `click{ref}`, `fill{ref,text}` (rejects password/OTP/payment), `press{ref,key}`,
`select{ref,value}`, `check{ref,checked}`, `navigate{url}`. Assertion DSL: `{kind:'visible'|'text'|'exists'|'count'|'url',
op:'equals'|'contains', expected, target?}` — semantics identical to `src/shared/assertions.js`.

---

# Addenda v1.1 — as implemented by the broker core

Nothing above was removed. Where the implementation had to be more precise than the first draft, the rule
below is binding for the drivers, automation and UI engineers. Tests: `test/agent-runtime/*.test.js`
(`node --test test/agent-runtime/*.test.js`). The reusable fake: `test/agent-runtime/fake-driver.js`
(`createFakeDriver()` -> `{ driver, ctl, world }`; `ctl` injects delays/hangs/crashes/redirects, `world` records
every emitted input and external effect). `test/agent-runtime/harness.js` boots a real broker over it.

## createBroker options (all optional except `dataDir` when enabled)
`{ dataDir, drivers, policy, clock, featureFlag, skills, limits, evidence, fs, env, appVersion }`
- `featureFlag`: `true`/`false`; default `env.BRAIWSER_AGENT_RUNTIME === '1'`. When OFF the returned broker has
  `enabled:false`, touches no disk, and every method rejects `UNAVAILABLE` ("agent runtime is disabled").
- `skills`: `{ resolve({skillId, skillVersion, inputs, principal}) -> { plan } | null, catalog({principal}) -> [] }`.
  `plan` is the *plain validated JSON* of the closed workflow (`schemaVersion:1`, steps navigate/click/fill/assert).
  The broker re-validates it (`browser-contracts.validatePlan`) and checks the pin (`plan.skillId/version`).
  Without `skills`, `startRun` rejects `UNAVAILABLE`.
- `limits` defaults: 8 sessions (4 per principal), 4 pages/session, ref TTL 5 min, response cap 64 KiB, 200 nodes,
  step timeout 15 s, observe timeout 15 s, approval wait 10 min, human wait 30 min, drain timeout 5 s.
- `clock`: `{ now(), monotonic() }`. `evidence`: `{ quotas, retentionMs }`. `fs`: injectable for fault tests.
- Persistence under `<dataDir>/browser/{ledger,runs,evidence}` (single writer, lock files, `ledger.key` HMAC key).
- Extra broker members: `retryRun`, `listApprovals`, `close()`, `stats()`, `enabled`, `limits`, and the test-only
  `_internals`. Extra events: `'approval-decided'`, `'session-opened'`, `'page-event'`.

## Errors
- Closed public vocabulary stays `STALE_REF|AMBIGUOUS_TARGET|DENIED|TIMEOUT|CANCELLED|UNSUPPORTED|UNAVAILABLE|INTERNAL`.
  Malformed input is `DENIED` with message prefix `INVALID_INPUT:`; an unknown action/step/driver is `UNSUPPORTED`.
  Foreign and unknown sessions/runs/resources are both `DENIED` ("unknown or unauthorized ...").
- `approval_required` = `DENIED` + `retry:'after-approval'` + message `approval_required: approvalId=<id>`; in-process
  callers also get `err.approvalId`. Only the same principal can use the id, and only after a `ui` principal allowed it.
- **Thrown vs. receipt.** Anything rejected before the action enters the page lane (validation, ownership, grant, budget,
  unknown/expired/foreign ref => `STALE_REF`, policy, secret field, approval needed) is a thrown error and is NOT
  journaled. Anything decided inside the lane is a *receipt* (`status:'not_attempted'`) with `code` in:
  `CANCELLED, DEADLINE_EXCEEDED, OWNERSHIP_LOST, STALE_DOCUMENT, AMBIGUOUS_TARGET, STALE_REF, DRIVER_DID_NOT_DISPATCH,
  LEDGER_WRITE_FAILED, APPROVAL_MISMATCH, DESTINATION_DENIED, HANDOFF_REQUESTED, PAGE_CRASHED, <driver error code>`.
- Receipt keys are exactly `operationId,sessionId,pageId,status,code,dispatched,effectUnknown,afterObservationId,evidenceUri`.
  A duplicate `operationId` (same request) returns the recorded receipt even after the document moved on or the broker
  restarted; the same id with different content is `DENIED` (IDEMPOTENCY_CONFLICT); input is never re-emitted.

## Principals, scopes, grants
- Non-`ui` principals get the INTERSECTION of the requested grant and their `scopes`:
  `class:<observe|navigate|interact|submit|...>`, `origin:<https://host[:port] | https://*.host>`, `root:<abs path>`,
  `project:<id>`, `profile:<name>`, `expires:<iso>`, `budget:<maxActions|...>=<n>`. A `ui` principal is trusted for
  its own sessions. `trustedFixture:true` (skips approvals for write-like actions) is honoured only for `ui`.
- A `ui` principal supervises every session/run (list/get/cancel/handoff/resume/approve/read resources) but never
  observes or acts on another principal's session. Only `ui` may `resume`/`approve`/acknowledge uncertainty.
- Default deny: `file:`, localhost/private/link-local/bare hostnames (incl. decimal/hex/IPv6-mapped spellings),
  credentials in URLs, every scheme but http(s)/`about:blank`. Private targets need the EXACT origin+port in the grant;
  wildcards never cover the apex or private hosts; `file:` needs a canonical root (realpath, symlink-safe).
- Destination checks are **navigation-only** (before dispatch and again on arrival via the `navigated` event; a
  forbidden arrival quarantines the page and sends it to `about:blank`). Request-level enforcement exists only if a
  driver reports `capabilities.requestInterception:true` and installs `open({ requestFilter })` -> `'allow'|'block'`.
- Classification: `navigate`; `interact` (click/fill/press/select/check); **write-like => class `submit` + one-use approval**:
  node `traits` contain `submit|destructive|write`, or the node name matches a write verb (pay/send/delete/save/...),
  or `press Enter`. `file-input` => `UNSUPPORTED`. `fill` into password/OTP/payment (trait or name heuristic) => `DENIED`.
- Approvals are server-held and bound to `{principal, run, session, page, documentEpoch, action digest, destination,
  expiry}`, single use, revoked by takeover/resume/session close. The approval id never appears in manifests.

## What the broker passes to drivers / expects from them
- `driver.open({ mode, viewport:{width,height,deviceScaleFactor?}, locale, timezoneId, profile, onPageEvent, requestFilter? })`.
  `onPageEvent({type:'popup'|'page', page, opener?})` registers new pages; page-level `page.events` emit
  `navigated|crashed|closed|popup|download|dialog` with an object payload (`{url}` for navigated, `{page}` for popup).
  The broker listens on `page.events` for registered pages (and `onPageEvent` only for pages it does not know).
- Observation nodes: `{ refId, role, name, enabled?, editable?, frameId?, testId?, traits? }`. `traits` is a string
  array: `password|otp|payment|secret|submit|destructive|file-input|autocomplete:<token>`. **Never put field values in
  `name`**; secrets must not enter observations. The broker mints its own opaque `r_...` refs and resolves them
  server-side; `driver.resolve()` is not required by the broker.
- `driverPage.act(cmd, control)` receives
  `cmd = { operationId, sessionId, pageId, runId, observationId, documentEpoch /*broker epoch*/, driverDocumentEpoch,
  action:{kind, refId, text?|key?|value?|checked?}, target:{refId, frameId, nodeIdentity, role, name} }` and
  `control = { signal, check, beforeDispatch }`. Call `control.beforeDispatch()` immediately before each real input
  (after resolution/hit-testing/waits). It commits the ledger point, consumes the approval, rechecks lease/epoch/grant and
  throws if input must not go out. Throw `{code:'STALE_REF'|'AMBIGUOUS_TARGET'|...}` BEFORE it when resolution fails.
- `navigate(url, { signal, timeoutMs, operationId, sessionId, pageId })`; the broker calls `beforeDispatch` itself.
  Outcomes: `ready` (verified), `failed` (dispatched), `timeout`/`cancelled` (uncertain).
- **Evidence.** `act` returns `status:'verified'` only if `evidence` is a non-empty array of plain objects
  `{ kind, observed:true, ... }` with `kind` in `visible,text,exists,count,url,navigation,state-change,value,focus,checked,
  selected,clicked`. Anything else degrades to `dispatched`. A document change during an action is accepted only with a
  `{kind:'navigation', observed:true, url}` item whose URL the grant allows. Return `verified` only for a concrete
  observed post-condition of THAT action (fill: control value equals the text; click: the target received the trusted
  click and/or the document/DOM changed); otherwise return `dispatched`.
- `evaluateAssertion({kind, op, expected, target})`: `target` is the plan target `{by:'role',role,name}|{by:'testId',value}|
  {by:'label',value}`; `{status:'passed'|'failed'|'unknown', actual, evidence}`.
- `setOwnerBadge('agent'|'human')` is called on takeover/resume; `dispose()` on page/session close.

## Ownership
- One `SessionLease` per session (fencing epoch) over per-page serial lanes. Takeover (`handoff`) revokes agent dispatch
  on EVERY page first, aborts in-flight work, waits (bounded) for the real driver barrier, invalidates all refs, revokes
  approvals, bumps every page epoch. A possibly dispatched action => `DENIED` (effectUnknown) for an agent; the `ui`
  principal may take over anyway (the human reconciles). A hung driver => `UNAVAILABLE` and the page stays quarantined.
- Agents cannot `observe` while a human owns the page. `resume` is `ui`-only, bumps epochs, requires a fresh observation.
- Handoff methods: `native`/`remote-view` are honoured; `checkpoint-relaunch`/`unsupported` => `UNSUPPORTED`, nothing changes.
- Quarantine (crash, closed, forbidden arrival, unsettled timeout) is terminal for the agent; only a `ui` takeover moves it on.

## Runs
- `startRun` validates everything before any dispatch (skill pin, inputs, navigate URLs against the grant, DOM capability)
  and acknowledges after the run record is journaled. `(owner, requestKey)` is unique: identical request => the existing run,
  conflicting inputs => `DENIED`. Runs on one session execute one at a time (others stay `queued`).
- Plan targets resolve by a fresh observation; 0 matches => step `failed`, >1 => `failed` (`AMBIGUOUS_TARGET`). Steps are
  fail-fast. Step effect: `verified` => `confirmed`, `dispatched` => `dispatched` (graded `unknown`), `uncertain` => `unknown`.
- Terminal mapping: cancel/session-close => `cancelled`; deadline => `timedOut`; any unknown effect => `uncertain`; otherwise
  the grader's status (`passed|failed|timedOut|cancelled`, else `uncertain`). `passed` requires the grader to pass with
  `evidenceComplete` = every referenced artifact intact and error-free AND a committed manifest. Failed manifest commit =>
  `uncertain`. Run input VALUES are never persisted (digest + key names only), so a restarted run cannot be resumed.
- Restart: active runs => `interrupted`; a step whose ledger op reached `dispatch_started` => effect `unknown`; a manifest
  with `terminal.state:'interrupted'` is committed. Nothing is replayed.
- `retryRun({ runId, requestKey, inputs?, sessionId?, pageId?, acknowledgeUncertain? })` creates a LINKED attempt (new run,
  `attempt+1`, parent link in the run store/manifest). Passed runs are not retried; an unknown external effect needs a `ui`
  principal with `acknowledgeUncertain:true`.
- `cancelRun` aborts synchronously (the fence), then waits up to 250 ms for finalisation; it is not a rollback.
- Operations outside a run are evidenced under a per-session implicit container (`runs/run_.../...` ids), so every
  `evidenceUri` is `braiwser://runs/{id}/(manifest|observations/{ob}|artifacts/{art})`; reads are owner (or `ui`) only and
  return `{uri,mimeType,encoding:'utf8'|'base64',text|data,truncated,totalBytes,returnedBytes,nextCursor}`.
- Observation responses are capped (default 64 KiB) with `truncated:true` + `nextCursor`; cursors are opaque, expire with
  the document, and are only valid for the page they were issued for.

## New shared file
`src/shared/browser-redact.js` (general text/URL/value redaction used by contracts, ledger summaries and evidence; the
storage engineer's `src/shared/redact.js` remains the journey-step redactor).
