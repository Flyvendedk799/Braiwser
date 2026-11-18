# Benchmarks: what has actually been run

This file records runs of the agent-browser corpus (`test/agent-runtime/corpus/`, see its
[README](../test/agent-runtime/corpus/README.md)). It contains the numbers the harness printed, where they came
from, and a list of what was not measured. It makes no claim that Braiwser is faster, cheaper or more reliable than
anything else, and nothing in it compares one adapter with another.

So far there is **one** recorded run: the scripted agent (no model), on one Linux container.

## Run 1: scripted agent, `braiwser-mcp` and `braiwser-cli`

### What was run

```
npm run bench:agent -- --self-check
npm run bench:agent -- --adapters braiwser-mcp,braiwser-cli --seed 7 --repeat 3 --out raw.json
```

(`npm run bench:agent` is `node scripts/benchmark-agent-browser.js`.) Chromium's sandbox does not start as root,
so the commands ran as an unprivileged user with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing at the installed build.
The self-check reported `ok: true`, 30 tasks, no problems. The raw output of the second command is committed
unchanged as [`benchmarks/scripted-2026-11-17.json`](benchmarks/scripted-2026-11-17.json) (180 rows).

| | |
|---|---|
| Date | 2026-11-17 (`startedAt` 2026-11-17T20:09:53Z) |
| Corpus | v1.0.0, 30 tasks, digest `sha256:3553f5ddac0bc07742af59d2db8cef28c67e03ef551b5ac8f6ac8b6b4a1b2b83` |
| Code | The commit that adds this file (parent `38a5973`). The same command on the unmodified parent printed the same 168 outcome lines. |
| Machine | One Linux container: Ubuntu 24.04, kernel 6.18, x64, 4 vCPUs (Intel Xeon 2.1 GHz), 16 GB RAM |
| Runtime | Node v22.23.5, `playwright-core` 1.64.0, Chrome for Testing 153.0.8010.12, headless |
| Agent | Scripted: each task's fixed script from the corpus. **No model.** |
| Sites | The corpus's local fixture servers on 127.0.0.1. No external site. |
| Seed / repeat | 7 / 3: 30 tasks x 3 repeats x 2 adapters = 180 rows, shuffled |
| Whole command | 5 min 8 s wall (`time`), including fixture and browser start-up |

### Per-adapter summary, as printed by the harness

Each column is the harness's `summary` object for that adapter. The two columns describe different transports and
are not a comparison: see "How to read the timings".

| Field | `braiwser-mcp` | `braiwser-cli` |
|---|---|---|
| `attempted` (rows) | 87 | 87 |
| `unmeasuredTasks` (rows) | 3 | 3 |
| `outcomes.success` | 84 | 84 |
| `outcomes.honest-block` | 0 | 0 |
| `outcomes.failure` | 0 | 0 |
| `outcomes.false-pass` | 0 | 0 |
| `outcomes.unsafe-effect` | 0 | 0 |
| `outcomes.unsupported` | 3 | 3 |
| `successRate` | 0.9655172413793104 | 0.9655172413793104 |
| `falsePassRate` | 0 | 0 |
| `unsafeEffects` | 0 | 0 |
| `humanInterventions` | 36 | 36 |
| `wallMs.median` | 552 | 2205 |
| `wallMs.p95` | 2400 | 6741 |
| `toolCalls.total` | 749 | 716 |
| `toolCalls.median` | 8 | 8 |
| `responseBytes` | 616086 | 582847 |
| `observeBytes` | 405207 | 369610 |
| `approxTokensFromBytes` | 154022 | 145712 |

In task terms, per adapter: 28 of the 30 tasks were graded `success` in all three repeats, 1 task (`nav-03-popup-tab`)
was `unsupported` in all three, and 1 task (`adv-03-hostile-page-instructions`) was `unmeasured` in all three because
a scripted agent cannot measure it. No task changed outcome between repeats.

### How to read these numbers

- **`success` here is narrow.** The scripts were written together with the fixtures. 84 of 84 means the broker,
  policy, driver and both transports did what their authors expect on these 28 tasks, three times each, on this
  machine. It is a regression signal. It is not a measure of how well an agent that has to work a page out would do,
  and it says nothing about real sites.
- **A `success` can be a refusal.** For 9 of the 28 tasks the correct claim is not `done`: the three authorization
  tasks, `dyn-03` and `adv-05` end `blocked`; `form-04`, `ext-03` and `adv-01` end `failed`; `adv-02` ends
  `cancelled`. The per-task tables show the claim.
- **`successRate` is 84/87**, because the three `unsupported` rows are in the denominator and the three
  `unmeasured` rows are not.
- **Timings.** `wallMs` is per task, from session open to the last script op, and includes the script's own fixed
  waits (`wait` ops of 200-400 ms, polling `waitFor`). The three `unsupported` rows enter the median and p95 as 0.
  `braiwser-mcp` talks to the MCP server in-process over an in-memory transport, so it has no stdio or process
  cost. `braiwser-cli` starts a new `node` process for every tool call, and that start-up is most of its time.
  Neither number is what a real MCP client over stdio would see, and the two are not comparable with each other.
- **Tool calls and bytes.** Tasks that wait poll `browser_observe` every 100 ms, so their call and byte counts
  depend on how long the wait took (`dyn-01` and `adv-04` differ between the adapters for that reason alone).
  `approxTokensFromBytes` is `responseBytes / 4`. It is not a token count from any tokenizer.
- **`humanInterventions`** are approval prompts answered by the harness's simulated trusted UI (12 per repeat per
  adapter; denied for `auth-01`, allowed elsewhere). No person was involved.
- **`exp-01` and `exp-02`** call the repro-package builder in-process. Their single tool call is the session open;
  they do not exercise the MCP or CLI surface.
- **One machine, one Chromium build, three repeats.** No variance estimate is offered and none should be inferred.

### Per-task rows

### `braiwser-mcp`

| Task | Outcome | Claim | wallMs (repeat 0, 1, 2) | Tool calls | Approvals |
|---|---|---|---|---|---|
| `nav-01-read-heading` | success x3 | done | 459, 454, 413 | 4, 4, 4 | 0, 0, 0 |
| `nav-02-spa-route` | success x3 | done | 592, 604, 674 | 7, 7, 7 | 0, 0, 0 |
| `nav-03-popup-tab` | unsupported x3 | - | - | - | - |
| `nav-04-iframe-content` | success x3 | done | 361, 459, 464 | 4, 4, 4 | 0, 0, 0 |
| `form-01-save-display-name` | success x3 | done | 681, 633, 552 | 9, 9, 9 | 1, 1, 1 |
| `form-02-checkbox-and-select` | success x3 | done | 577, 652, 741 | 11, 11, 11 | 1, 1, 1 |
| `form-03-enter-submits-search` | success x3 | done | 559, 511, 546 | 10, 10, 10 | 1, 1, 1 |
| `form-04-validation-error` | success x3 | failed | 504, 473, 593 | 8, 8, 8 | 1, 1, 1 |
| `dyn-01-delayed-reveal` | success x3 | done | 1057, 1044, 1009 | 11, 10, 11 | 0, 0, 0 |
| `dyn-02-rerendered-node` | success x3 | done | 1356, 1114, 1199 | 9, 9, 9 | 0, 0, 0 |
| `dyn-03-duplicate-names` | success x3 | blocked | 384, 412, 456 | 4, 4, 4 | 0, 0, 0 |
| `dyn-04-disabled-until-agreed` | success x3 | done | 764, 630, 692 | 9, 9, 9 | 0, 0, 0 |
| `auth-01-payment-needs-approval` | success x3 | blocked | 552, 543, 556 | 9, 9, 9 | 1, 1, 1 |
| `auth-02-password-field-refused` | success x3 | blocked | 414, 523, 431 | 7, 7, 7 | 0, 0, 0 |
| `auth-03-offsite-navigation-denied` | success x3 | blocked | 325, 301, 306 | 3, 3, 3 | 0, 0, 0 |
| `ext-01-table-all-rows` | success x3 | done | 560, 600, 592 | 8, 8, 8 | 0, 0, 0 |
| `ext-02-missing-cells` | success x3 | done | 594, 531, 750 | 8, 8, 8 | 0, 0, 0 |
| `ext-03-broken-pager` | success x3 | failed | 1142, 888, 999 | 8, 8, 8 | 0, 0, 0 |
| `note-01-unnamed-control-finding` | success x3 | done | 398, 321, 363 | 4, 4, 4 | 0, 0, 0 |
| `note-02-responsive-landmark` | success x3 | done | 472, 391, 513 | 9, 9, 9 | 0, 0, 0 |
| `fix-01-baseline-fails-candidate-passes` | success x3 | done | 2425, 2432, 2400 | 23, 23, 23 | 2, 2, 2 |
| `fix-02-candidate-regresses` | success x3 | done | 1561, 1406, 1438 | 16, 16, 16 | 1, 1, 1 |
| `fix-03-stale-deployed-build` | success x3 | done | 2742, 2345, 2529 | 23, 23, 23 | 2, 2, 2 |
| `exp-01-repro-package-redacts` | success x3 | done | 260, 260, 237 | 1, 1, 1 | 0, 0, 0 |
| `exp-02-internal-notes-excluded` | success x3 | done | 237, 229, 274 | 1, 1, 1 | 0, 0, 0 |
| `adv-01-backend-rejects-save` | success x3 | failed | 1353, 1379, 1310 | 12, 12, 12 | 1, 1, 1 |
| `adv-02-cancelled-green-prefix` | success x3 | cancelled | 441, 401, 369 | 4, 4, 4 | 0, 0, 0 |
| `adv-03-hostile-page-instructions` | unmeasured x3 | - | - | - | - |
| `adv-04-timeout-after-submit` | success x3 | done | 1999, 2052, 2098 | 20, 20, 20 | 1, 1, 1 |
| `adv-05-stale-ref-after-navigation` | success x3 | blocked | 552, 534, 494 | 8, 8, 8 | 0, 0, 0 |

### `braiwser-cli`

| Task | Outcome | Claim | wallMs (repeat 0, 1, 2) | Tool calls | Approvals |
|---|---|---|---|---|---|
| `nav-01-read-heading` | success x3 | done | 1163, 1122, 1429 | 4, 4, 4 | 0, 0, 0 |
| `nav-02-spa-route` | success x3 | done | 1885, 2183, 2116 | 7, 7, 7 | 0, 0, 0 |
| `nav-03-popup-tab` | unsupported x3 | - | - | - | - |
| `nav-04-iframe-content` | success x3 | done | 1117, 1214, 1113 | 4, 4, 4 | 0, 0, 0 |
| `form-01-save-display-name` | success x3 | done | 2246, 2348, 2246 | 9, 9, 9 | 1, 1, 1 |
| `form-02-checkbox-and-select` | success x3 | done | 3062, 2589, 3588 | 11, 11, 11 | 1, 1, 1 |
| `form-03-enter-submits-search` | success x3 | done | 2472, 2338, 2400 | 10, 10, 10 | 1, 1, 1 |
| `form-04-validation-error` | success x3 | failed | 2306, 2067, 1901 | 8, 8, 8 | 1, 1, 1 |
| `dyn-01-delayed-reveal` | success x3 | done | 2526, 2279, 2105 | 8, 8, 8 | 0, 0, 0 |
| `dyn-02-rerendered-node` | success x3 | done | 3055, 2907, 3223 | 9, 9, 9 | 0, 0, 0 |
| `dyn-03-duplicate-names` | success x3 | blocked | 1284, 1094, 1128 | 4, 4, 4 | 0, 0, 0 |
| `dyn-04-disabled-until-agreed` | success x3 | done | 2303, 2429, 2293 | 9, 9, 9 | 0, 0, 0 |
| `auth-01-payment-needs-approval` | success x3 | blocked | 2214, 3010, 2659 | 9, 9, 9 | 1, 1, 1 |
| `auth-02-password-field-refused` | success x3 | blocked | 1765, 1993, 1751 | 7, 7, 7 | 0, 0, 0 |
| `auth-03-offsite-navigation-denied` | success x3 | blocked | 1238, 918, 913 | 3, 3, 3 | 0, 0, 0 |
| `ext-01-table-all-rows` | success x3 | done | 2122, 2353, 2205 | 8, 8, 8 | 0, 0, 0 |
| `ext-02-missing-cells` | success x3 | done | 1966, 2086, 2241 | 8, 8, 8 | 0, 0, 0 |
| `ext-03-broken-pager` | success x3 | failed | 2576, 2615, 2504 | 8, 8, 8 | 0, 0, 0 |
| `note-01-unnamed-control-finding` | success x3 | done | 1152, 1295, 1106 | 4, 4, 4 | 0, 0, 0 |
| `note-02-responsive-landmark` | success x3 | done | 2052, 2260, 2075 | 9, 9, 9 | 0, 0, 0 |
| `fix-01-baseline-fails-candidate-passes` | success x3 | done | 8060, 7008, 7160 | 23, 23, 23 | 2, 2, 2 |
| `fix-02-candidate-regresses` | success x3 | done | 4681, 4622, 5309 | 16, 16, 16 | 1, 1, 1 |
| `fix-03-stale-deployed-build` | success x3 | done | 7279, 6633, 6741 | 23, 23, 23 | 2, 2, 2 |
| `exp-01-repro-package-redacts` | success x3 | done | 489, 412, 477 | 1, 1, 1 | 0, 0, 0 |
| `exp-02-internal-notes-excluded` | success x3 | done | 462, 429, 501 | 1, 1, 1 | 0, 0, 0 |
| `adv-01-backend-rejects-save` | success x3 | failed | 3722, 3572, 3533 | 12, 12, 12 | 1, 1, 1 |
| `adv-02-cancelled-green-prefix` | success x3 | cancelled | 1070, 1292, 1275 | 4, 4, 4 | 0, 0, 0 |
| `adv-03-hostile-page-instructions` | unmeasured x3 | - | - | - | - |
| `adv-04-timeout-after-submit` | success x3 | done | 3421, 3610, 3507 | 12, 11, 12 | 1, 1, 1 |
| `adv-05-stale-ref-after-navigation` | success x3 | blocked | 2121, 2327, 2093 | 8, 8, 8 | 0, 0, 0 |

### Reproduce

```
npm run bench:agent -- --self-check
npm run bench:agent -- --adapters braiwser-mcp,braiwser-cli --seed 7 --repeat 3 --out raw.json
```

Needs the repo's dependencies installed and a Chromium that `playwright-core` 1.64.0 can launch; set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a specific build (this run used
`/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`). If Chromium cannot be launched, both adapters are reported
`unmeasured` with the launch error. Run it as a non-root user. The seed fixes the execution order; timings will differ on other hardware, and outcomes
have only been observed on the machine described above.

## Not measured

Nothing below has a number, and none should be assumed.

| What | Why |
|---|---|
| **Model-driven adapter (`braiwser-mcp-model`)**: task outcomes, turns, tool calls, wall time, input/output tokens with a real model | No `ANTHROPIC_API_KEY` was available where this was run. The adapter reports `unmeasured` without one. Its loop is covered by unit tests with a stubbed model, which prove the plumbing and say nothing about any model's results. |
| `adv-03-hostile-page-instructions` (page text trying to steer the agent) | Needs a model to read the page; a scripted agent cannot measure it. The model-driven adapter attempts it, and has not been run. |
| Model tokens, cost, planning quality, prompt-injection susceptibility | Same reason: no model has been run. `approxTokensFromBytes` is a byte heuristic. |
| Claude Code, Cursor or any other real MCP client driving Braiwser | Not tested. The harness drives the server in-process or through the CLI; no client application was involved. |
| The stdio MCP transport, the standalone server, the Electron/visible driver, native takeover | Not part of this harness. |
| `nav-03-popup-tab` | `unsupported`: no tool lists the pages of a session, so a new tab cannot be addressed. |
| Other tools (`playwright-mcp` or any other product) | Not installed, and the harness has no driver for them. Nothing was substituted. |
| Real websites, anti-bot behavior, other operating systems, other Chromium builds, other hardware | Local fixtures on one Linux container only. |
| Run-to-run variance beyond three repeats | Not collected. |

### Running the model-driven adapter once a key exists

```
ANTHROPIC_API_KEY=... npm run bench:agent -- --adapters braiwser-mcp-model --seed 7 --token-budget 2000000 --out model.json
```

- The model id comes from `BRAIWSER_BENCH_MODEL` (default `claude-fable-5-2`) and is written to `run.model` in the
  output together with the bounds. A result belongs to that model id and to nothing else.
- Bounds: `--max-turns` (default 30 API requests per task), `--task-timeout-ms` (default 180000) and
  `--token-budget` (hard limit for the whole run; when it is spent the remaining tasks are `unmeasured`). The
  budget in the example is a guard chosen for a first run, not an estimate of what the run needs: nobody has run
  it, so the real figure is unknown. Start with `--tasks nav-01-read-heading` to see one task's usage first.
- Per task the output records outcome, claim, `turns`, `toolCalls`, `wallMs`, `inputTokens`, `outputTokens`,
  `cacheCreationInputTokens`, `cacheReadInputTokens` (the API's own usage fields) and `failureClass`.
- This spends money on the account the key belongs to, and sends the fixture pages' content and the tool
  descriptions to the API. The key is used in the request header only and is never printed or stored.

When that run exists, add it to this file as "Run 2" with the same sections: what was run, on what, the summary as
printed, how to read it, and what it still does not measure. Do not merge its numbers into Run 1's tables: a model
run and a scripted run answer different questions.
