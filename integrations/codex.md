# Codex

Add a stdio MCP server in `~/.codex/config.toml` or a project `.codex/config.toml`. The bridge token stays in the connection file.

```toml
[mcp_servers.braiwser]
command = "node"
args = ["C:/path/to/braiwser/src/main/services/automation/sidecar.mjs"]
env = { "BRAIWSER_BRIDGE_INFO" = "C:/Users/you/AppData/Roaming/Braiwser/agent-bridge.json" }
```

`codex mcp add` writes the same table. Start Braiwser with `BRAIWSER_AGENT_RUNTIME=1` first so the connection file exists.

Official references: https://learn.chatgpt.com/docs/extend/mcp

Use `browser_observe`, `browser_act`, `browser_run`, `browser_handoff` and `browser_handoff_status`. This setup does not require the standalone viewer. A handoff result is a pause plus a status you can poll; it is not a control credential.
