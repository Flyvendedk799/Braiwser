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
