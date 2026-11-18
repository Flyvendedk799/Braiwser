# Claude Code

Braiwser's coding-agent surface is the MCP sidecar. The bridge token stays in the connection file named by `BRAIWSER_BRIDGE_INFO`. It does not go in Claude's config.

Without the desktop app, one command starts a headless supervised browser limited to the sites you name:

```
claude mcp add braiwser -- npx -y github:Flyvendedk799/Braiwser braiwser mcp --origin http://localhost:3000 --review ./review
```

`--review` is a folder of project bundles exported from Braiwser; with it Claude can read your notes (`review_notes`), prove them with a `verify-notes` run and attach the result (`review_note_report`). This form has been exercised with the MCP SDK client, not with Claude Code itself.

From a checkout, with Braiwser already running and `BRAIWSER_AGENT_RUNTIME=1`:

```
claude mcp add --transport stdio --scope project braiwser --env BRAIWSER_BRIDGE_INFO="C:\Users\you\AppData\Roaming\Braiwser\agent-bridge.json" -- node "C:\path\to\braiwser\src\main\services\automation\sidecar.mjs"
```

That writes a project `.mcp.json` entry. User scope is the top-level `mcpServers` object in `%USERPROFILE%\.claude.json`. A JSON entry that has `url` and no `type` is rejected by Claude Code.

Official references: https://code.claude.com/docs/en/mcp and https://code.claude.com/docs/en/mcp-quickstart.md

After `browser_handoff`, poll `browser_handoff_status`. Resume only after the broker records a one-use grant. This client does not open the takeover viewer.
