# Built-in plugin: zcode-guide (usage and self-diagnosis guide)

> Spec v2 · 2026-07-01 · verified against the staging branch source

## Goal

Provide an official plugin `zcode-guide` that is **bundled and enabled by default**, whose skill set lets **agents and users**:

1. Correctly configure the five kinds of ZCode extension resources: MCP, commands, skills, hooks, plugins.
2. When configuration goes wrong, **locate** (localization) and **self-repair** the problem **per kind**.

Final goal: **from the skills of this plugin alone, an agent can diagnose and fix configuration problems itself** — without depending on external docs, with every action landing on an executable `zcode` subcommand and an explicit config file edit.

## Why a bundled, default-enabled plugin

- Like `skill-creator` / `document-skills`, it is a **content-only** plugin (only `skills/`, no MCP, no system dependency), so it can safely be `defaultEnabled: true` and work out of the box.
- It reuses the existing official plugin seed chain: on first start the plugin in the bundle is materialized to `<storageRoot>/cache/zcode-plugins-official/<name>/<version>/` and written to the official marketplace.json.
- Users can disable it in the plugin management page (a built-in plugin can only be disabled, not uninstalled).

## Registration change points (only two manual lists)

| File                                                                          | Change                                                       | Effect                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`    | Add an `OFFICIAL_PLUGIN_DEFINITIONS` entry, `defaultEnabled: true` | Runtime seed + automatically enters `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`; both readers (CLI `resolveZCodePlugins`, app startup `resolveStartupPlugins`) enable it by default                                   |
| `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs`          | Add an `officialSeaPlugins` entry, `requiresRuntime: false`  | Packed into the SEA single executable; `requiresRuntime:false` skips the `dist/mcp/server.js` check                                                                                                            |

The other readers (the `bundled-plugins.ts` seed, `writeOfficialMarketplace`, the recoverable built-in list of `getZCodePluginsOverview`, plugin root injection for skills/commands) are all derived automatically from `OFFICIAL_PLUGIN_DEFINITIONS` and need no change.

> Warning: a built-in plugin has several read entries. Default enablement depends on the `officialPluginsEnabledByDefault` set being passed through by **every** discovery entry. Historically `resolveStartupPlugins` missed passing it (commit c0120fa), so `zcode plugins list` showed enabled but `/skill <name>` in a session reported not found. Acceptance must run both the CLI list **and** a real session.

## Plugin directory structure

```
apps/zcode-cli/packages/zcode-guide-plugin/
├── .zcode-plugin/plugin.json      # manifest: name=zcode-guide, skills="skills"
├── package.json                   # @zcode/zcode-guide-plugin (the SEA script reads it by packageName)
├── README.md
└── skills/
    ├── zcode-configuration-guide/SKILL.md   # overview: locations/priority of the five resources + routing to diagnosing skills
    ├── diagnosing-mcp/SKILL.md
    ├── diagnosing-skills/SKILL.md
    ├── diagnosing-commands/SKILL.md
    ├── diagnosing-hooks/SKILL.md
    └── diagnosing-plugins/SKILL.md
```

## Skill design

> The skill bodies are for **users and external agents**, written in **formal, professional English**, and **contain no internal source references** (no `file:line`, function names, commit numbers, internal registration flow). What is kept is what users really need: CLI commands, config file paths, priority and merge rules, diagnostic codes. This spec and the code comments were written in Chinese.

### zcode-configuration-guide (overview)
One overview table of the **location, scope, priority and merge rules** of the five resource kinds, plus a "where should I configure" selection guide; at the end it routes each kind of problem to the matching `diagnosing-*` skill.

### diagnosing-* (five diagnosis skills)
A uniform structure, each directly executable:
1. **Config location and priority** — the exact file paths and override order read at the user/project levels for each resource kind.
2. **Check commands** — structured diagnostic entries such as `zcode <plugins|skills|commands> list --json` / `inspect --json` (the skeleton of self-repair).
3. **Common pitfalls table** — symptom -> root cause -> code detection point -> fix action.
4. **Localization flow** — ordered commands + file checks, converging to one explicit fix action.
5. **Self-repair actions** — the exact edit or command for each pitfall.

## Key facts (aligned with the source, correcting old docs)

- **The user main config is `~/.zcode/cli/config.json`** (not `~/.zcode/config.json`). The project config is `<repo>/.zcode/config.json` or `<repo>/zcode.json`.
- **MCP `.agents/mcp.json` difference (CLI vs client)**: the `apps/zcode-cli` CLI runtime does not read `.agents/mcp.json`; but the **desktop client does** (`AGENTS_MCP_DESCRIPTOR` of `packages/desktop/src/main/mcpUserDirectory/index.ts`), as a fallback of the same scope (read only when the `.zcode` of that scope has no MCP server, with the top-level key `mcpServers`), and feeds it to running sessions. The skills target the client, so they are written per client behavior. Project-level MCP is **untrusted** by default and does not connect automatically; `/mcp connect` is required. MCP override order is `cli > env > user > project > system` (user overrides project).
- **MCP has no headless subcommand**: `/mcp` and `/mcp connect` are TUI interactive commands, with no `--json`. The closest structured view is `zcode plugins list --json` (lists only plugin MCP names, no connection state).
- **skills/commands discovery order**: explicit -> user `.zcode` -> user `.agents` -> project `.zcode` (cwd up to the git root) -> project `.agents` -> enabled plugins. skills take the **path** as identity, and at load time the **first same-name wins**; commands dedupe by **normalized command name**, **first come first served**, recording the loser as `custom_command_duplicate_name`.
- **Nested command names are joined with `:`**: `review/code.md` -> `/review:code` (not `/review/code`). The command name regex is `^[a-z0-9][a-z0-9_:-]{0,63}$`.
- **Diagnostics are hidden by default**: for `zcode commands|skills|plugins list` in human mode `--verbose` is needed to print diagnostics; `--json` always includes them.
- **The hooks trust gate has been removed** (commit bfde6ff44): `canRunPluginHooks` is now always `true`, and third-party plugin hooks **also execute**. The old "only official executes / third-party diagnostics only" statement is outdated; `marketplace.ts` still has a misleading leftover `plugin_unsupported_component` warning. Config-file hooks require an explicit `hooks.enabled=true`; with any plugin hook present the runner is forced on.
- **hooks event names** (exactly 7): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`. `matcher` is a **case-sensitive regex**, matching tool names for tool events (including aliases `Task→Agent`, `Write|Edit→ApplyPatch`). The `timeout` of a `command` is in **seconds**, the `timeoutMs` of a `process` is in **milliseconds**; the `async` field is currently a runtime no-op.
- **The git proxy recognizes only `ZCODE_HTTP_PROXY`** (not a bare `http_proxy`) — check this first when a marketplace clone fails.
- The disabled state is persisted in `plugins.enabledPlugins[id]` of `~/.zcode/cli/config.json`; a built-in "uninstall" writes `plugins.suppressedBuiltins`; disabling a skill/command by path uses `skill["/abs/SKILL.md"].enable=false`.

## Acceptance

- `pnpm typecheck` + `pnpm lint` pass.
- `zcode plugins list --json` shows `zcode-guide` with `enabled:true`.
- In a real session (not only the CLI) skills such as `/skill diagnosing-mcp` load.
