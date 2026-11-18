# Agent browser (opt-in)

Braiwser can let a coding agent (Claude Code, Cursor, any MCP client) or a script drive a browser session that
**you** own and supervise, and then prove what happened with evidence you can review. It is off by default and
meant to be used with a human nearby. This page says what exists, how to connect, what is guarded, and what is
**not** supported yet.

> Status: pre-release. The adapter layer (MCP server, CLI, authenticated bridge, skills, verification script) is
> covered by automated tests against the real broker and a fake driver, and the Playwright driver was exercised
> against local fixtures. It has **not** been tested with Claude Code or Cursor themselves (only with the
> official MCP SDK client over stdio). The Electron-embedded driver has only been run inside real Electron for a
> slice of its surface (observe, click, select, screenshots, open shadow roots; Linux under Xvfb), not through the
> desktop shell with a person at the window, and not on macOS or Windows.

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

## Fastest start: one command, no desktop app

For a coding agent that should check a site you are developing, one command starts a headless supervised browser
and serves MCP on stdio. It grants exactly the sites you name and nothing else:

```
claude mcp add braiwser -- npx -y github:Flyvendedk799/Braiwser braiwser mcp --origin http://localhost:3000 --review ./review
```

From a checkout the same thing is `node src/main/services/automation/up.mjs mcp --origin ...`. `--review DIR` is a
directory of project bundles exported from the desktop app (`.braiwser.json`); it is what lets the agent read your
notes and journeys (see "The review loop"). `braiwser mcp --help` lists the options, including
`--review-read-only`, `--classes`, `--data`, `--chromium` and `--no-browser-sandbox` (containers only).

Verified here by a real MCP SDK client over stdio against real headless Chromium (`up.test.mjs`). The `npx` form of
the command has **not** been run against the published repository, and Claude Code / Cursor themselves are still
untested clients.

## Turn it on

1. Start Braiwser with the agent runtime enabled: set `BRAIWSER_AGENT_RUNTIME=1` (or the `agentRuntime`
   setting). Without it the broker answers every call with `UNAVAILABLE` and no pipe exists.
2. The app writes a **connection file** for each client (default `agent-bridge.json` in the app's user-data
   folder, mode 0600 where the OS supports it). It holds the pipe name and a bearer token, so treat it like a
   password: anyone who can read it can act as that client until it expires or is revoked.
3. Point your client at the file with `BRAIWSER_BRIDGE_INFO` (below). The token never goes in the MCP config.

What a client may do is decided by the **scope the app gave that client** (allowed origins, tool classes,
expiry, budgets). A session request can ask for less than that scope, never more.

> The bridge starts with the agent runtime (`BRAIWSER_AGENT_RUNTIME=1`) from the Electron main process, except during the e2e harness. The connection file is written beside the broker store. A supervised headless process can also own the broker without Electron (`src/main/services/automation/server.mjs`).

## Connect Claude Code or Codex (MCP over stdio)

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

## The tools

| Tool | Does | Mutates |
|---|---|---|
| `browser_session_open` | Opens an owned session + first page from a grant **request** (origins, tool classes, expiry, budgets) | yes |
| `browser_observe` | Bounded semantic snapshot (<= 200 nodes, <= 64 KiB), opaque refs, coverage, truncation | no |
| `browser_act` | click / fill / press / select / check / navigate on a ref from a fresh observation. Returns a receipt, **not** a verified outcome | yes |
| `browser_extract` | Named values from the current observation with source refs and explicit `missing` / `ambiguous` markers | no |
| `browser_run` | Starts (or recovers by `requestKey`) a pinned workflow run | yes |
| `browser_run_status` | State, counters, bounded events after a sequence | no |
| `browser_run_cancel` | Requests cancellation. Already-dispatched effects stay; this is not rollback | yes |
| `browser_handoff` | Pauses the session and records a handoff. It does not give the caller human control | yes |
| `browser_run_pause` | Fences agent dispatch on a run and leaves the session paused | yes |
| `browser_handoff_status` | Reads handoff state. It has no side effect and does not resume the agent | no |
| `browser_run_resume` | Returns the session to the agent only when the broker holds a one-use grant | yes |
| `browser_pages` | Lists the session's pages, including popups and new tabs the page opened, with the page that opened each | no |
| `review_notes` | Lists the review notes a person left; each says whether a run can prove it and which exact checks that run makes | no |
| `review_note` | One note with its exact change, checks and what has been reported about it | no |
| `review_journeys` | Recorded journeys and whether each can run as `verify-journey`, with reason codes for steps that cannot | no |
| `review_note_claim` | Marks a note as being worked on by this client | yes |
| `review_note_propose` | Says a note is ready for a person to look at, with a message. Never resolves it | yes |
| `review_note_report` | Attaches a finished `verify-notes` run to a note. The verdict is read from the run, not from the caller | yes |

Every result is `{ ok, value, error }`. Errors are one of `STALE_REF`, `AMBIGUOUS_TARGET`, `DENIED`, `TIMEOUT`,
`CANCELLED`, `UNSUPPORTED`, `UNAVAILABLE`, `INTERNAL`, each with `dispatched`, `effectUnknown` and a `retry`
hint. A mutation that fails for an unclassified reason is reported as **uncertain**, never as safe to retry.
Handoff protocol failures (`CONTROL_BUSY`, `RESUME_NOT_AUTHORIZED`, `VIEWER_UNREACHABLE`, and the other v2 codes)
are carried in the message prefix; the public code stays inside the closed list above. `browser_handoff` never
includes a reusable invitation secret. The standalone viewer exchanges that secret once for an HttpOnly cookie.

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
braiwser-agent handoff --session bs_.. --page pg_.. --reason "needs a person" --request-key rk1
braiwser-agent pause --run run_.. --request-key rk2 --epoch 4
braiwser-agent handoff-status --handoff ho_..
braiwser-agent resume --handoff ho_.. --request-key rk3 --epoch 4
braiwser-agent close --session bs_..
braiwser-agent skills
braiwser-agent doctor
```

It prints one JSON envelope on stdout and exits `0` (ok), `1` (usage error), `2` (tool or broker error). Same
broker, same validation and projection as MCP. It takes an executable and arguments only and never invokes a
shell. `npm run agent -- <command>` runs it from the repo.

## The review loop

The point of the review tools is that a note stops being a message and becomes a contract an agent can prove.

1. A person reviews a page in the desktop app. Notes made in **Edit** or **Rearrange** mode, and "remove this" notes,
   carry the exact change: the CSS, the new copy, the removal.
2. The agent reads them with `review_notes`. Each note lists its `checks` (`style`, `text`, `absent`) and whether it is
   `verifiable`. It may `review_note_claim` the ones it takes.
3. The agent changes the source, then starts `browser_run` with skill `verify-notes` and `inputs: { noteIds: [...] }`.
4. When the run has finished, `review_note_report { noteId, runId }` attaches it. The broker reads the verdict from the
   stored run: `fixed` resolves the note, `not-fixed` leaves it open, `regressed` re-opens a note that had been resolved,
   and a missing element or unfinished run is `unknown`.

What an agent cannot do: set a verdict, resolve a note without a passing run, or edit a note. A note with nothing
exact to check (a written remark, a reorder) is `verifiable: false`; the agent can only `review_note_propose` it for a
person. A note whose element has no unique test id or role + name is also not verifiable by a run, with the reason.

A `style` check compares the element's computed value with what the browser computes for the declared value on that
same element, so `color: red` matches `rgb(255, 0, 0)` and `padding: 0.5rem` matches `8px`. Declarations that could
fetch something (`url()`, `image-set()`) are refused. Evaluating it sets the property on the element and restores it
in the same task; a page watching its own `style` attribute with a MutationObserver can see that.

A run stops at the first failing step, so in a run over several notes, notes after the first failure are not reached
and report `unknown`. Verify notes one at a time when you need an independent verdict for each.

Access is its own scope: `review:read` to list and read, `review:write` to claim, propose and report (it implies
read). It is separate from browsing: a client that may browse cannot read the review, and the reverse.

Where the review comes from:

| Deployment | Source | Notes resolved by a run are written to |
|---|---|---|
| Desktop app | the app's own project store | the store (the note shows as resolved in the app) |
| Standalone owner (`braiwser mcp`, `server.mjs`, proxy/OpenBot, containers) | `reviewDir`: a read-only directory of exported `.braiwser.json` bundles | `review-state.json` in the owner's data directory; the bundles are never written |

In the standalone source, ids are namespaced by bundle file (`<file>_<n>` for notes, `<file>_j<n>` for journeys). There
is no path yet that sends a standalone verdict back into a desktop store; re-export or verify in the app for that.

Verified: the whole loop (read, prove not fixed, fix, prove fixed, regress, re-open) runs in
`review-loop.test.mjs` through the real stdio sidecar and real headless Chromium against the standalone owner. The
desktop store source is covered by unit tests against the real repositories; it has not been driven by an external MCP
client against the running Electron app.

## Skills and runs

| Skill | Runs through `browser_run` | What it does |
|---|---|---|
| `verify-journey` 1.0.0 | yes | Compiles a saved recording into a closed plan and proves its assertions |
| `review-responsive` 1.0.0 | yes (Playwright driver; the Electron driver has no emulated viewport and refuses it before dispatch) | Fixed-viewport landmark checks; page and per-landmark captures are stored as evidence and never make a run pass |
| `compare-fix` 1.0.0 | no (library / CLI orchestration) | Same frozen assertions on a baseline and a candidate; reports fixed / regressed / not-fixed / not-reproduced, or why the comparison is unavailable |
| `extract-table` 1.0.0 | no (library) | Typed records with source refs (table, row, column, page) and missing-value markers; bounded pagination; never "complete" unless the end of the table was seen |
| `handoff-repro` 1.0.0 | no (library) | Builds a redacted issue/repro package; sending it elsewhere is a separate approved action |
| `verify-notes` 1.0.0 | yes | Compiles review notes that carry an exact change into assertions and proves them on the page; refuses notes with nothing checkable or no unique semantic target |

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
| Shadow DOM | open roots only | open roots only |
| Canvas | reported as a limitation | reported as a limitation |
| Popups | yes (see limits) | no |
| Downloads / uploads | no | no |
| Select | yes | yes: native single `<select>` (see limits) |
| Screenshots | yes | yes: viewport, a clip, or one element that fits in the viewport (see limits) |
| Request-level destination check | yes: every http(s) request and every redirect hop, before it is sent (see limits) | navigation only |
| Human takeover | visible: native in the desktop shell; headless: remote-view only while the supervised loopback viewer is attached. The Playwright driver itself still reports `humanHandoff: unsupported` | native, needs native confirmation |
| Live headless/visible switch | no | no |

What the MCP/CLI surface adds on top (verified against the real broker unless noted):

| Behavior | State |
|---|---|
| Typed errors, schema validation, owner checks, secret refusal, approvals, stale/ambiguous refusal | verified (tests) |
| Pinned runs, `requestKey` recovery, cancellation, owner-scoped manifest | verified (tests, fake driver) |
| Real headless Chromium against local fixtures | exercised by the benchmark harness; one machine, one build |
| Claude Code / Cursor clients | **untested** |
| Electron-embedded driver in real Electron: observe, click, `select`, screenshots, open shadow roots | verified (`electron.native.test.js`: a `WebContentsView` and a `<webview>`, Electron 44, Linux under Xvfb, device scale 1 / 1.5 / 2) |
| Electron-embedded driver: everything else, the desktop shell end to end, native takeover, macOS / Windows | **untested** here |

## Honest limits

- The desktop shell starts the bridge and the loopback viewer when the agent runtime is on. Connection management for scopes still lives in the Agent Runs drawer. Packaged builds keep sources inside `app.asar`, which plain Node cannot execute; run the sidecar and CLI from a checkout or an unpacked copy.
- Request-level destination check (Playwright driver): each request and each redirect hop is checked against the
  grant before it leaves the browser, for pages, popups, frames (also out-of-process ones), subresources and
  dedicated, shared and service workers. A redirect to an origin outside the grant fails in the browser
  (`ERR_BLOCKED_BY_CLIENT`) and that origin's server is never contacted; the hop before it, on a granted origin, was
  already sent, so the action is reported as uncertain, not as "nothing happened". Verified with headless Chromium
  against local servers only. **Not covered**: WebSocket and WebRTC traffic, `data:`/`blob:` documents, and DNS
  lookups themselves. The Electron-embedded driver still checks navigations only.
- Electron-embedded driver, `select`: only a native single `<select>`. The option is picked by exact value, or by
  exact label when no value matches; no match, a disabled option, or more than one match is refused before anything
  is dispatched (never "the first one"). The driver sets the option and fires `input` and `change` itself when the
  selection changed, as Playwright's `selectOption` does, so those two events are not browser-trusted events; the
  native popup is never opened. A `<select multiple>` gets no ref from the observer on either driver and cannot
  be targeted.
- Electron-embedded driver, screenshots: the pixels Electron's `capturePage` returns, at the device scale (a 2x
  display gives a 2x image; nothing is resized). One element can be captured only if it fits inside the viewport
  after scrolling to it; a larger one is refused, not cropped. A main-owned page that has not been given a rectangle
  yet (zero size) or is hidden has no pixels and is refused. There is still no emulated viewport on this driver, so
  `review-responsive` stays Playwright-only.
- Electron-embedded driver, shadow DOM: open roots only, like Playwright. Frames are still main-frame only, so a
  shadow root inside a child frame is not reached.
- `browser_pages` lists a session's pages, so a popup or new tab can be observed and acted on by its page id. A popup
  that is already somewhere outside the grant is listed as `blocked`.
- `setViewport` (240..4096) exists on the Playwright driver only. It is a state change: refs and observations die
  with the document epoch, it needs the `interact` class and is ledgered like any action.
- Tables are observed as one bounded payload per table/grid node: at most 50 rows x 12 columns, 80 characters per
  cell, 20 KiB per table, 20 tables/lists per frame. Anything beyond that is marked (`truncated`), never silently
  dropped; merged cells (`merged`) and secret-looking columns or cells (`withheld`, `null`) are flagged and their
  content is not returned. A page with more rows than that makes `extract-table` stop with `PAGE_ROWS_TRUNCATED`.
  Lists are observed the same way (30 items); navigation menus and link-only lists are skipped.
- Pagination hints (`pagination.next` / `prev`) are found by accessible name only (Next, Next page, Older, Previous,
  Newer, arrows...). Two candidates for one direction yield no ref and an `ambiguous` marker.
- Delta observations (`sinceObservationId`) are not exposed.
- Recordings made from this version on carry a semantic locator per step (a test id, or a role and accessible name)
  whenever it names exactly one element, so ordinary journeys migrate. A step is still refused when its element has no
  unique name (two buttons called "Delete", a click on a bare `div`); older recordings without locators fall back to the
  previous rule (`data-testid`, an `aria-label` on a button or field, or a button's own text). Re-record those.
- The `style` assertion kind exists in plans and in-app replay. The Playwright export does not emit it.
- Recording-derived typed values come from the resolver's `inputs` result; the broker merges them itself, only for keys
  the plan declares in `inputKeys`, only strings, at most 10000 characters. Structured skill arguments (for example
  `review-responsive`'s `landmarks`) are accepted only for keys the resolver reports in `argumentKeys`.
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
| `BRAIWSER_AGENT_SCOPES` | desktop app | Comma-separated scopes for the default client file, e.g. `class:observe,class:navigate,origin:http://localhost:3000,review:read,review:write`. Only `observe`, `navigate`, `interact`, exact http(s) origins and the two review scopes are accepted; anything else is dropped |
| `BRAIWSER_POLL_MS`, `BRAIWSER_WAIT_MS` | `run.mjs` | Poll interval (default 750 ms) and client wait budget (default 5 min) |

## Tests and benchmark

```
node --test "test/agent-runtime/automation/*.test.mjs"      # adapters, bridge, skills, corpus, real-broker integration
npm run bench:agent -- --self-check                        # validate the 30-task corpus
npm run bench:agent -- --adapters braiwser-mcp,braiwser-cli
ANTHROPIC_API_KEY=... npm run bench:agent -- --adapters braiwser-mcp-model --token-budget 2000000   # a model drives the tools
```

`braiwser-mcp` and `braiwser-cli` use a scripted agent (no model). `braiwser-mcp-model` hands the task goal and the
MCP tools to a Claude model (`BRAIWSER_BENCH_MODEL`, default `claude-fable-5-2`) and lets it drive; the same oracles
grade it and its token counts are the API's usage fields. It needs `ANTHROPIC_API_KEY`, runs only when named, and is
reported `unmeasured` without a key. Its loop is unit-tested against a stubbed model
(`test/agent-runtime/automation/corpus-model.test.mjs`); **it has not been run against a real model yet.**

The one scripted run that has been recorded, with its raw counts, the machine it ran on and the list of what was not
measured, is in [`BENCHMARKS.md`](BENCHMARKS.md). It is a record of one run, not a claim about other machines.
