# MCP config compatibility parsing and diagnostics

## Background

`~/.zcode/cli/config.json` can come from older versions, external agent imports, or hand editing. Two legacy MCP fields are common:

- stdio servers use `environment` for env vars.
- HTTP remote servers use `type: "remote"`.

The current runtime schema accepts only `env` and `type: "http" | "sse" | "stdio"`. Previously, any single failing MCP server invalidated the whole user config load, losing unrelated keys such as `plugins.enabledPlugins` and breaking the plugin management UI.

## Goals

- Accept `environment -> env` at the config entry.
- Accept `type: "remote" -> "http"` at the config entry.
- Parse MCP servers with per-server fault tolerance: an invalid server is skipped with diagnostics recorded.
- All non-MCP config keeps the original strict validation; unknown runtime structures are never silently passed into the system.

## Behavior

- Valid legacy MCP servers are normalized into `RuntimeConfigPatch.mcp.servers`.
- One invalid MCP server never blocks the whole `config.json`.
- Skipped servers are written to config-parse diagnostics with the JSON path and the concrete schema problem.
- `createConfig()` logs both config-load failures and MCP-server-skip diagnostics at warn level, so exported logs can locate migration issues.
- Top-level config errors still mark the file `loaded=false`, preventing partially applied illegal provider/model/UI config.
- `type: "remote"` normalizes to HTTP per the external-import convention; if the endpoint is actually SSE, write `type: "sse"` explicitly.
- Diagnostics docs and the built-in diagnosing-mcp skill must distinguish the two chains:
  - Direct CLI config reads go through the config-entry normalization, accepting `environment -> env`, `http_headers -> headers`, `enable -> enabled`, and `type: "remote" -> "http"`.
  - When desktop Settings / app-managed sessions deliver MCP, the UI first reads the user directory, then converts to ZCode Protocol `mcpServers`. This chain must not rely on legacy fields; troubleshooting should recommend the canonical fields first: `env`, `headers`, `enabled`, `type: "http"`.
- Pasting external MCP config into the JSON editor must warn that `command` must be a string: the OpenCode form `command: ["npx", "-y", "server"]` must be split into `command: "npx"` and `args: ["-y", "server"]`, or the settings form treats `command` as a string and triggers a runtime error.

## Verification

- Regression tests cover legacy `environment`, legacy `remote`, and one bad server not affecting `plugins.enabledPlugins`.
- The diagnosing-mcp skill covers the app-managed chain's compatibility differences and self-service repair wording.
- `pnpm typecheck` and `pnpm lint` as boundary checks.
