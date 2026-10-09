# Agent browser (opt-in)

Braiwser can let a coding agent (Claude Code, Cursor, any MCP client) or a script drive a browser session that
**you** own and supervise, and then prove what happened with evidence you can review. It is off by default and
meant to be used with a human nearby. This page says what exists, how to connect, what is guarded, and what is
**not** supported yet.

> Status: pre-release. The adapter layer (MCP server, CLI, authenticated bridge, skills, verification script) is
> covered by automated tests against the real broker and a fake driver, and the Playwright driver was exercised
> against local fixtures. It has **not** been tested with Claude Code or Cursor themselves (only with the
> official MCP SDK client over stdio), not against the visible Electron driver, and not on macOS/Linux.

## How it fits together

```
 MCP client (Claude Code, Cursor, ...)          braiwser-agent CLI
        |  stdio                                       |
   sidecar.mjs  ----- authenticated local pipe ----- cli.mjs
                              |
                  Braiwser app (single owner)
        broker: grants, approvals, ledger, evidence, runs
              |                          |
      Playwright driver          Electron-embedded driver
```

Everything goes through one broker. The sidecar and CLI own no browser, no store and no ledger; they only
speak to the running app over a local pipe (named pipe on Windows, a socket in a private directory elsewhere)
with a random token. There is no network listener.

## Turn it on

1. Start Braiwser with the agent runtime enabled: set `BRAIWSER_AGENT_RUNTIME=1` (or the `agentRuntime`
   setting). Without it the broker answers every call with `UNAVAILABLE` and no pipe exists.
2. The app writes a **connection file** for each client (default `agent-bridge.json` in the app's user-data
   folder, mode 0600 where the OS supports it). It holds the pipe name and a bearer token, so treat it like a
   password: anyone who can read it can act as that client until it expires or is revoked.
3. Point your client at the file with `BRAIWSER_BRIDGE_INFO` (below). The token never goes in the MCP config.

What a client may do is decided by the **scope the app gave that client** (allowed origins, tool classes,
expiry, budgets). A session request can ask for less than that scope, never more.

> Not wired yet: starting the bridge from the Electron main process and issuing connection files from the UI
> is a main-process integration step (`startBridge` in `src/main/services/automation/bridge-server.js`). The
> module is complete and tested; until the app calls it, no connection file is produced.

## Connect Claude Code or Cursor (MCP over stdio)

Claude Code:

```
claude mcp add braiwser --env BRAIWSER_BRIDGE_INFO="C:\Users\you\AppData\Roaming\Braiwser\agent-bridge.json" -- node "C:\path\to\braiwser\src\main\services\automation\sidecar.mjs"
```

Cursor (`.cursor/mcp.json`) or any client that takes a JSON server list:

```json
{
  "mcpServers": {
    "braiwser": {
      "command": "node",
      "args": ["C:/path/to/braiwser/src/main/services/automation/sidecar.mjs"],
      "env": { "BRAIWSER_BRIDGE_INFO": "C:/Users/you/AppData/Roaming/Braiwser/agent-bridge.json" }
    }
  }
}
```

`npm run mcp` runs the same entrypoint from the repo. stdout carries only protocol messages; diagnostics go to
stderr. Set `BRAIWSER_MCP_DEBUG=1` for tool-name/result-code logging (never arguments or page text).

## The eight tools

| Tool | Does | Mutates |
|---|---|---|
| `browser_session_open` | Opens an owned session + first page from a grant **request** (origins, tool classes, expiry, budgets) | yes |
| `browser_observe` | Bounded semantic snapshot (<= 200 nodes, <= 64 KiB), opaque refs, coverage, truncation | no |
| `browser_act` | click / fill / press / select / check / navigate on a ref from a fresh observation. Returns a receipt, **not** a verified outcome | yes |
| `browser_extract` | Named values from the current observation with source refs and explicit `missing` / `ambiguous` markers | no |
| `browser_run` | Starts (or recovers by `requestKey`) a pinned workflow run | yes |
| `browser_run_status` | State, counters, bounded events after a sequence | no |
| `browser_run_cancel` | Requests cancellation. Already-dispatched effects stay; this is not rollback | yes |
| `browser_handoff` | Pauses agent control and reports how a person can take over | yes |

Every result is `{ ok, value, error }`. Errors are one of `STALE_REF`, `AMBIGUOUS_TARGET`, `DENIED`, `TIMEOUT`,
`CANCELLED`, `UNSUPPORTED`, `UNAVAILABLE`, `INTERNAL`, each with `dispatched`, `effectUnknown` and a `retry`
hint. A mutation that fails for an unclassified reason is reported as **uncertain**, never as safe to retry.

There is no tool for arbitrary JavaScript, CSS selectors, file paths, cookies or shell commands, and unknown
keys or action kinds are rejected before they reach the broker. `fill` into password, one-time-code and payment
fields is refused. Page content (names, text, URLs) is untrusted data marked `trust: "untrusted-page"`;
credential-looking query values and embedded credentials are removed from URLs before they reach the model.

Resources (read-only, owner-checked, never trigger browser actions):
`braiwser://capabilities`, `braiwser://skills/catalog`, `braiwser://runs/{runId}/manifest`,
`braiwser://runs/{runId}/observations/{observationId}`. A foreign or unknown id looks identical to the owner.

Actions that can change something (a `Save`, `Pay`, `Delete` button, Enter in a form) need a one-use approval
from you in the app. The agent receives `approval_required` with an id and can only wait; it cannot approve
itself. A client can pass `_meta: { "braiwser/schemaVersion": 1 }`; an unsupported major version is rejected.

## Command line

```
braiwser-agent open --driver playwright --mode headless --origin https://app.test --classes observe,navigate,interact
braiwser-agent observe --session bs_.. --page pg_..
braiwser-agent act --session bs_.. --page pg_.. --observation ob_.. --epoch 3 --operation op1 --action '{"kind":"click","ref":"r_.."}'
braiwser-agent run --session bs_.. --page pg_.. --request-key rk1 --skill verify-journey --skill-version 1.0.0 --inputs '{"recordingId":"rec_1"}'
braiwser-agent status --run run_.. --max-events 20
braiwser-agent cancel --run run_..
braiwser-agent handoff --session bs_.. --page pg_.. --reason "needs a person"
braiwser-agent close --session bs_..
braiwser-agent skills
```

It prints one JSON envelope on stdout and exits `0` (ok), `1` (usage error), `2` (tool or broker error). Same
broker, same validation and projection as MCP. It takes an executable and arguments only and never invokes a
shell. `npm run agent -- <command>` runs it from the repo.

## Skills and runs

| Skill | Runs through `browser_run` | What it does |
|---|---|---|
| `verify-journey` 1.0.0 | yes | Compiles a saved recording into a closed plan and proves its assertions |
| `review-responsive` 1.0.0 | planned; **the current broker rejects it** (needs viewport + capture steps) | Fixed-viewport landmark checks with capture evidence |
| `compare-fix` 1.0.0 | no (library / CLI orchestration) | Same frozen assertions on a baseline and a candidate; reports fixed / regressed / not-fixed / not-reproduced, or why the comparison is unavailable |
| `extract-table` 1.0.0 | no (library) | Bounded pagination with missing-value markers; never "complete" unless the end of the table was seen |
| `handoff-repro` 1.0.0 | no (library) | Builds a redacted issue/repro package; sending it elsewhere is a separate approved action |

Versions are pinned exactly and each resolves to one digest (`skill-lock.json`). Changed bytes under the same
version are blocked. A recording is migrated into a plan only if every step has a semantic locator (role + name,
label or test id); steps with secrets, regex assertions, unknown controls or credential-looking URLs are
**refused with a reason**, never skipped or guessed (`.first()` is never used). Typed values become inputs, not plan
bytes. A plan must end in an assertion.

A run is `passed` only when the shared grader says so: every planned step done, at least one required assertion
and all of them passed, the evidence manifest committed, nothing pending, skipped, unknown or uncertain. A
cancelled run with a green prefix is `cancelled`; a timeout after dispatch is uncertain, not "nothing happened".

Importing a third-party skill package is **inert**: `SKILL.md` is parsed, files are inventoried and hashed, and
nothing is executed or installed. `allowed-tools` is recorded and ignored. A package can only run if it ships a
validated workflow manifest, and a human in the UI must approve its exact digest; an upgrade shows a diff and
needs re-approval.

### Verifying a journey from an agent

`.agents/skills/braiwser-verify/` is an opt-in Agent Skills package (copy it into your project's `.agents/skills/`).
`scripts/run.mjs` starts or resumes `verify-journey` and waits:

```
BRAIWSER_MCP_ENTRY=/abs/path/to/sidecar.mjs BRAIWSER_BRIDGE_INFO=/abs/path/agent-bridge.json \
  node .agents/skills/braiwser-verify/scripts/run.mjs <sessionId> <pageId> <recordingId> <requestKey> [resumeRunId]
```

Exit codes: `0` proven pass, `2` not passed / error / inconsistent run, `3` needs approval or a human (resume with the
printed run id), `4` the client wait budget (5 minutes) ran out; the run itself is **not** cancelled. Requires
`@modelcontextprotocol/sdk` to be installed beside the script (it is not downloaded).

## Safety model in one page

- One owner: the app's broker. No second process writes the ledger or store.
- Authorization is the broker's, not the schema's. Possession of a session or run id is not authority.
- Grants are intersected with the scope you gave the client; approvals are one-use and bound to the action.
- Closed action and assertion language; no code, selectors, paths or shell.
- Page text cannot change grants, approvals or destinations. Hostile instructions in a page are just data.
- Secrets never enter observations, plans, manifests or logs; secret fills are refused.
- A cancellation or timeout never auto-replays an effect; after a crash a run is `interrupted`.
- Local only: named pipe / private socket plus a 256-bit token, hashed at rest in memory, expiring, revocable.
  The connection file is as private as your user profile; there is no TCP listener.

## Capability matrix

Driver capabilities as reported by the drivers in this repository:

| Capability | Playwright (headless / visible) | Electron-embedded (visible) |
|---|---|---|
| DOM actions | yes | yes |
| Frames | yes | main frame only |
| Shadow DOM | open roots only | no |
| Canvas | reported as a limitation | reported as a limitation |
| Popups | yes (see limits) | no |
| Downloads / uploads | no | no |
| Select | yes | **unsupported** |
| Screenshots | yes | no |
| Request-level destination check | yes (initial requests; redirect hops are not re-checked) | navigation only |
| Human takeover | visible: yes; headless: **unsupported** | native, needs native confirmation |
| Live headless/visible switch | no | no |

What the MCP/CLI surface adds on top (verified against the real broker unless noted):

| Behavior | State |
|---|---|
| Typed errors, schema validation, owner checks, secret refusal, approvals, stale/ambiguous refusal | verified (tests) |
| Pinned runs, `requestKey` recovery, cancellation, owner-scoped manifest | verified (tests, fake driver) |
| Real headless Chromium against local fixtures | exercised by the benchmark harness; one machine, one build |
| Claude Code / Cursor clients | **untested** |
| Visible Electron driver, native takeover | **untested** here |

## Honest limits

- Not wired into the app UI yet (see "Not wired yet"); no connection-management screen.
- Packaged builds keep sources inside `app.asar`, which plain Node cannot execute; run the sidecar and CLI from a
  checkout or an unpacked copy (an `asarUnpack` entry for the automation folder is not configured yet).
- No tool lists the pages of a session, so a popup/new tab cannot be switched to. No viewport control, so
  `review-responsive` and responsive checks cannot run.
- Observations contain landmarks, h1/h2 headings, interactables, status and error text. They do not contain table
  cells or list items, so `extract-table` returns `NO_TABLE` (incomplete) on real pages; this is reported, not hidden.
- Delta observations (`sinceObservationId`) are not exposed.
- Recordings made today only carry CSS selectors; unless a step has a `data-testid`, an `aria-label` on a button or
  form field, or a button's own text, migration refuses it. Re-record with test ids, or add semantic locators.
- Recording-derived typed values reach a run through a resolver hook that depends on the broker passing its
  `inputs` object to the skill resolver; a broker that copies it first fails closed with "missing input".
- `browser_extract` reads accessible names from the last observation; it is not a scraping engine.
- A dispatched click is not proof of an outcome. Use a run with registered assertions for that.
- No claim is made that this is faster, cheaper or more reliable than any other tool. See
  `test/agent-runtime/corpus/README.md` for what the benchmark harness measures and what it refuses to claim.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `BRAIWSER_AGENT_RUNTIME=1` | app | Enables the runtime (default off) |
| `BRAIWSER_BRIDGE_INFO` | sidecar, CLI, `run.mjs` | Path of the connection file |
| `BRAIWSER_MCP_ENTRY` | `run.mjs` | Absolute path of the sidecar to launch |
| `BRAIWSER_MCP_DEBUG=1` | sidecar | Log tool names and result codes to stderr |
| `BRAIWSER_POLL_MS`, `BRAIWSER_WAIT_MS` | `run.mjs` | Poll interval (default 750 ms) and client wait budget (default 5 min) |

## Tests and benchmark

```
node --test "test/agent-runtime/automation/*.test.mjs"      # adapters, bridge, skills, corpus, real-broker integration
npm run bench:agent -- --self-check                        # validate the 30-task corpus
npm run bench:agent -- --adapters braiwser-mcp,braiwser-cli
```
