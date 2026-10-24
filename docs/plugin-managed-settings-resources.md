# Plugin-registered resources in Settings

The Settings pages for Skills, Commands, and MCP Servers show local config resources and plugin-registered resources in separate groups. Plugin item descriptions and secondary metadata use `text-ui-sm text-foreground-subtle`, matching other settings list items.

## Grouping rules

- Local resources: from the workspace or user config directories, for example `.zcode/skills`, `.zcode/commands`, user/workspace MCP config.
- Plugin resources: `skills`, `commands`, `mcpServers` declared in enabled plugin manifests.
- Plugin resources are read-only in their settings page, with the hint “由插件注册，修改请到对应插件中进行” (registered by a plugin; manage it in that plugin).
- Manifest `skills` array items follow the Claude spec: an object entry points at the skill directory itself (containing `SKILL.md`); a string entry points at a skills collection directory. Both forms are discoverable (shared scanning rules: skills field semantics in `docs/claude-marketplace-triplet-plugin-compat.md`). When an explicitly declared path scans to 0 skills, the plugin detail page shows the `plugin_skill_root_empty` diagnostic in its warnings area instead of staying silent.

## Data sources

- Skills: `skillsService.list()` returns skills with `scope: "plugin"`.
- Commands: `commandsService.list()` returns commands with `source: "plugin"`.
- MCP Servers: the settings page builds the read-only plugin MCP list from `mcpServerNames` in the plugin management data; the full MCP config is still injected at startup by the agent runtime from the plugin outcome.
- Official plugins can associate host built-in MCP through the protocol field `hostMcpServerNames`. It is used only for settings-page attribution and live status display; it is not plugin manifest config and takes no part in the plugin MCP prefix or runtime merge. Browser's `node_repl` uses this boundary: settings attribution is Browser, the real runtime name stays the host-reserved `node_repl`.
- The plugin MCP list must join the live status snapshot from `mcp/list` by the runtime-injected name `plugin:<pluginName>:<serverName>`. If the snapshot carries a pending OAuth authorization URL, the read-only plugin MCP row shows an “打开授权” (open authorization) button that opens the URL via the platform `openExternal`.
- After plugin MCP OAuth completes, the settings page must not decide to stop refreshing based only on whether the pending authorization URL is gone. Between the authorization callback completing and MCP reconnecting there can be a brief intermediate state with no `authorizationUrl`; keep a short follow-up refresh window and refresh once immediately when the user returns to the app, so the row state does not get stuck pre-authorization.
- Plugin MCP rows must explicitly show the live snapshot states `connecting`, `connected`, `disconnected`, and `error`; “插件内置” (built into the plugin) is only for enabled plugins without a runtime snapshot and must not override the real runtime state.
- Plugin MCP rows must keep the authorization button operable at narrow widths and on mobile Web; long marketplace names may truncate but must not squeeze the main info column or cause horizontal overflow.

## Maintenance boundary

Local resources are still edited, deleted, or toggled in their own management pages. Plugin resource content, command roots, MCP server config, and enable/disable entry points belong to the plugin; maintain them through the Plugins settings page or the plugin source files.

The plugin MCP OAuth button only opens the authorization entry exposed by the current runtime; the settings page must not edit plugin MCP config, OAuth client secrets, or tokens.
