---
name: braiwser-verify
description: Reproduce and verify an existing Braiwser journey against an explicitly selected browser session. Use when checking a reported UI defect or verifying a fix with saved review evidence.
compatibility: Requires an installed Braiwser MCP bridge, Node.js, and an approved browser session.
metadata:
  version: "1.0.0"
  braiwser-protocol: "1"
---

# Verify a Braiwser journey

1. Read the selected review and identify its recording ID. Do not choose the active tab implicitly.
2. Use the browser session and page the user selected. Check driver capabilities before requesting headless execution or human takeover.
3. Inspect the journey and proposed effects. A recording is evidence of past actions, not permission to repeat purchases, messages, uploads or account changes.
4. Start `verify-journey` version `1.0.0` with a stable request key. Use `scripts/run.mjs` for bounded polling and cancellation, or call the equivalent MCP tools.
5. If the run needs approval or human input, present the exact blocked action. Do not fabricate an approval token or complete secrets through chat tools.
6. On stale or ambiguous targets, refresh the observation. Do not guess, silently select the first match or repeat an uncertain mutation.
7. Wait for a terminal state. Report planned versus executed steps and any pending, failed, skipped or unknown results.
8. Claim the defect is fixed only when the registered postconditions pass and the evidence manifest exists. Include the run ID and the permitted evidence link. A click receipt is not proof of the desired outcome.

Resume with the existing run ID. Do not start a new run to bypass a blocked or uncertain step.
