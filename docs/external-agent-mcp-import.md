# External Agent MCP Server Import

## Background

The settings pages already support importing skills, commands, and plugins from external agents. MCP servers are not directory resources, so symlink/copy semantics do not apply; the import target is `mcp.servers` in ZCode config files.

The MCP migration inside the onboarding flow only handles the legacy generic MCP config migration. The settings page's manual import independently scans external agents' MCP config files and merges the user-selected servers into ZCode config.

## Goal

- An "import from external agent" entry on the MCP servers settings page.
- The dialog reuses the existing external-import dialog: source scope, refresh, two-level source list, per-item selection, global/project target, import result list.
- MCP import shows no "symlink/copy" option — it only merges config objects.
- Targets:
  - Global: `mcp.servers` of `~/.zcode/cli/config.json`
  - Project: `mcp.servers` of `<workspace>/.zcode/config.json`
- A same-named server keeps the existing ZCode config; the external server is marked skipped, never overwritten.
- Gemini-related directories are not scanned.

## Scan scope

First-batch external MCP sources:

| Agent        | Global                            | Project                                                            | Format                        |
| ------------ | --------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| Claude Code  | `~/.claude/settings.json`         | `<workspace>/.claude/settings.json`, `<workspace>/.mcp.json`       | `mcpServers` JSON             |
| Codex CLI    | `~/.codex/config.toml`            | `<workspace>/.codex/config.toml`                                   | `mcp_servers` / `mcpServers` TOML |
| OpenCode     | `~/.config/opencode/opencode.json`| `<workspace>/.opencode/opencode.json`                              | `mcp` JSON                    |
| OpenClaw     | `~/.openclaw/settings.json`       | `<workspace>/settings.json`                                        | `mcpServers` JSON             |
| Qwen Code    | `~/.qwen/settings.json`           | `<workspace>/.qwen/settings.json`                                  | `mcpServers` JSON             |
| Qoder        | `~/.qoder/settings.json`          | `<workspace>/.qoder/settings.json`                                 | `mcpServers` JSON             |
| Qoder CN     | `~/.qoder-cn/settings.json`       | `<workspace>/.qoder/settings.json`                                 | `mcpServers` JSON             |
| Trae         | `~/.trae/settings.json`           | `<workspace>/.trae/settings.json`                                  | `mcpServers` JSON             |
| Kiro CLI     | `~/.kiro/settings.json`           | `<workspace>/.kiro/settings.json`                                  | `mcpServers` JSON             |
| Roo Code     | `~/.roo/settings.json`            | `<workspace>/.roo/settings.json`                                   | `mcpServers` JSON             |
| CodeBuddy    | `~/.codebuddy/settings.json`      | `<workspace>/.codebuddy/settings.json`                             | `mcpServers` JSON             |
| Generic `.agents` | `~/.agents/mcp.json`         | `<workspace>/.agents/mcp.json`                                     | `mcpServers` JSON             |

## Compatibility

- JSON reads/writes use structured parsing that preserves other top-level fields of the target file.
- TOML is read-only as an external source; writes always target ZCode JSON.
- OpenCode's `command: string[]` converts to the ZCode/Claude-compatible `command + args`.
- The Project target is disabled without a workspace.
