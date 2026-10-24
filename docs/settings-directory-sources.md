# Settings directory sources

`command`, `mcp`, and `hooks` now read from the ZCode Agent's conventional directories. Settings only labels config as `workspace` or `user`; directory names are no longer shown as CLI/provider sources.

## Read order

`command` and `mcp` use this fixed order:

1. `<workspace>/.zcode/*`
2. `<workspace>/.agents/*` (fallback only when workspace `.zcode` has no valid entries)
3. `~/.zcode/*`
4. `~/.agents/*` (fallback only when user `.zcode` has no valid entries)

`command` and `mcp` no longer read `.claude`. The current workspace is the project-level config boundary; the settings service does not scan up the directory tree.

`hooks` keeps the compatible read order: `<workspace>/.zcode/*`, `<workspace>/.agents/*`, `<workspace>/.claude/*`, `~/.zcode/*`, `~/.agents/*`, `~/.claude/*`.

## Command

- workspace: prefer `<workspace>/.zcode/commands`; fall back to `<workspace>/.agents/commands` when there are no valid commands
- user: prefer `~/.zcode/commands`; fall back to `~/.agents/commands`
- Settings shows the directory path, not individual command file paths
- Create/edit writes only `.zcode/commands`, choosing user or workspace via dropdown; `.agents` stays a read-only compatible fallback source
- Disabling a command does not touch the markdown file; it writes to `~/.zcode/cli/config.json`: `command[absolute path of command file].enable = false`; re-enabling deletes the override

## MCP

The MCP settings page and runtime use the ZCode Agent MCP source uniformly. The old generic MCP config is migrated once into the user-level `.zcode` main config; generic locations are not read afterwards.

- workspace `.zcode`: `mcp.servers` in `<workspace>/.zcode/config.json`
- workspace `.agents`: `mcpServers` in `<workspace>/.agents/mcp.json`, fallback only when workspace `.zcode` has no MCP server
- user `.zcode`: `mcp.servers` in `~/.zcode/cli/config.json`
- user `.agents`: `mcpServers` in `~/.agents/mcp.json`, fallback only when user `.zcode` has no MCP server
- Create/edit writes only the `.zcode` main config, choosing user or workspace via dropdown; compatible fallback sources stay read-only
- Disabling an MCP server writes back into the config object that holds it: `mcp.servers[serverName].enable = false` or `mcpServers[serverName].enable = false`; re-enabling deletes that `enable` field

## Hooks

- workspace `.zcode`: `hooks` in `<workspace>/.zcode/config.json`
- workspace `.agents`: `hooks` in `<workspace>/.agents/settings.json`
- workspace `.claude`: `hooks` in `<workspace>/.claude/settings.json`
- user `.zcode`: `hooks` in `~/.zcode/cli/config.json`
- user `.agents`: `hooks` in `~/.agents/settings.json`
- user `.claude`: `hooks` in `~/.claude/settings.json`
- Create/edit writes only `.zcode` hooks, choosing user or workspace via dropdown; compatible-source hooks are read-only
- The form preserves extra JSON fields of process hooks so saving from Settings does not lose hook fields the current UI does not model
- Disabling a hook writes to `~/.zcode/cli/config.json`: `hooks[config directory path][hook signature].enable = false`; the signature is built from `event`, `matcher`, `command`, and `args`; re-enabling deletes the override
