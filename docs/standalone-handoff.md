# Standalone handoff contract 2.1.0

Baseline: `d89acc6aa27378229b4847f8cb5073427350b075` (`main`).
Automation schema major remains **1**. Capability version is **1.1.0**; the
independently negotiated handoff contract is **2.1.0**. Existing strict tool
DTO shapes are unchanged. Version 1.1.0 corrects the cursor semantics of both run
and handoff status, including byte-budget truncation. Clients written against
1.0.0's run cursor workaround (`nextSequence - 1`) must stop subtracting one when
negotiating 1.1.0. The additive tool `browser_session_close` returns
`{ok:true,value:{closed:true},error:null}`. Status cursors are exclusive: pass
the last consumed sequence as `afterSequence`; `nextSequence` is that last
sequence, never the next event number. A discontinuity requires a fresh status
snapshot. Native v2 handoff is unavailable; legacy native workflows remain.

## Local installation and startup

Use Node 22, `npm ci`, and `npx playwright-core install chromium`. On Linux use
`npx playwright-core install --with-deps chromium`. A system Chromium can be
selected by the trusted supervisor with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Create a protected configuration file outside a model workspace:

```json
{
  "dataDir": "/private/braiwser-owner",
  "port": 17771,
  "ownerId": "local-owner",
  "principal": {
    "id": "local-agent",
    "kind": "mcp",
    "scopes": ["class:observe", "class:navigate", "class:interact", "origin:https://example.com"]
  }
}
```

Set `BRAIWSER_SERVER_CONFIG` to that file and run `npm run server`. The first
JSON line is the transport readiness receipt and names two protected files:
`agent-bridge.json` for the stdio sidecar and `viewer-owner.json` for the human
owner. Never copy their contents to chat, traces, artifacts or URLs. Set
`BRAIWSER_BRIDGE_INFO` to the first file when launching `npm run mcp`. The
model cannot mint principals or select the scope ceiling. Open the non-secret
handoff URL, enter the owner token locally, then explicitly take control.
Reopening a link is not return authorization. Return to agent is an explicit
authenticated, CSRF-checked transaction in the viewer. Supervisor integrations
may perform the same owner-authenticated redemption server to server; they must
keep both the credential and resulting cookies outside model-visible surfaces.

The optional `runtime-sidecar.mjs` entrypoint accepts trusted
`BRAIWSER_RUNTIME_CONFIG` JSON, starts one detached owner in the same namespace,
and attaches the sidecar. An existing failed descriptor or store lock is **not**
silently replaced. An MCP disconnect only closes its transport. The owner exits
after five minutes with no live sessions and no bridge clients; active sessions
retain it. Explicit session close cancels pending runs. SIGTERM/SIGINT stop the
bridge, viewer and browser and remove connection credentials and the store lock.

## Recovery, stop and rollback

One exclusive `owner.lock` protects the store. A second owner fails before
opening it. After a crash, verify that the recorded PID and browser processes
are gone before explicitly removing a stale lock and restarting. Persisted
episodes recover closed with `BROKER_RESTART`; their previous live contexts
cannot be restored. Pending input receipts cannot be replayed. Obtain explicit
authorization for replacement work rather than treating restart as continuation.

Disable new connector sessions first for rollback, cancel or close known runs
and sessions, reconcile uncertain receipts, then signal the owner. Preserve the
store for evidence. Remove a runtime installation only after the owner has
stopped; leave protected configuration and evidence under the owner's retention
policy. Neither release nor heartbeat loss authorizes agent resume.

Private input fences pending observations and frames. Entered private text is
registered with the evidence redactor; retained pixel captures remain disabled
for that tainted session. Secondary viewers remain excluded from its pixels.
The controlling human's pixels and input pass through the trusted runtime host.

## Validation and deployment boundary

`npm run test:standalone` requires real Chromium and fails when it is unavailable.
It starts the executable owner, attaches actual stdio MCP clients, authenticates
a separate viewer browser, dispatches real input, verifies exactly one submission
on the same session/page, verifies the original registered workflow reaches its
asserted pass after return, and checks transport reconnection. The security suite
also checks cursor continuity, grant audience, durable duplicate/conflicting
requests, dispatch/release ordering, revocation and failed/private-racing captures.
Run `npm run check`, `npm run test:unit` and `npm run e2e` as regression gates.

This contract supports **local single-owner use only**. `deployment: remote` is
rejected. An external HTTPS origin alone cannot enable hosted operation. Hosted
authentication, proxy trust, tenant isolation, CSRF/cookie policy, public
reachability and staging gates remain separate release requirements. No tunnel,
production deployment or security-setting change is performed by this work.
