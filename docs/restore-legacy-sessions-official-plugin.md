# Restore Legacy Sessions Official Plugin

## Background

Legacy ZCode session snapshots live in `~/.zcode/v2/sessions`. The migration capability was validated as a local skill: it can list legacy agents, workspaces, and conversations and restore selected history into the new ZCode task index and CLI session DB.

To avoid exposing a high-risk local migration capability by default, the skill ships as an official plugin that is disabled by default. Only after the user explicitly enables it do new sessions see the migration skill and command.

## Plugin identity

- Name: `restore-legacy-sessions`
- Id: `restore-legacy-sessions@zcode-plugins-official`
- Version: `0.1.0`
- Type: official bundled plugin
- Default state: disabled

The plugin is not in `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`, so like `ios-simulator` / `android-emulator` its capabilities inject only after explicit user enablement.

## Contents

The plugin package is at:

```text
apps/zcode-cli/packages/restore-legacy-sessions-plugin/
```

and contains:

```text
.zcode-plugin/plugin.json
README.md
package.json
skills/restore-legacy-sessions/SKILL.md
skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs
skills/restore-legacy-sessions/scripts/restore-conversation.mjs
commands/restore-legacy-sessions.md
```

It is a skill-only / command-only plugin: no `mcpServers`, no long-running MCP server. Migration scripts run on demand via local Node.js by the agent.

## Behavior boundaries

- Default source directory is `~/.zcode/v2/sessions`.
- `--legacy-dir <path>` overrides the source only when the user explicitly requests another directory.
- Destinations stay:
  - `~/.zcode/v2/tasks-index.sqlite`
  - `~/.zcode/cli/db/db.sqlite`
- A timestamped backup must be created before restoring.
- The restored legacy session's provider is always written as `glm`.
- Do not write `migration_source` or `meta_json.migrationSource`.
- Do not start the legacy runtime.
- Do not rewrite user follow-up messages inside existing new tasks.

## Enabling

CLI:

```sh
zcode plugins enable restore-legacy-sessions
```

In-session:

```text
/plugins enable restore-legacy-sessions
```

The change applies to new sessions. Once enabled, use:

```text
/restore-legacy-sessions
```

or invoke `$restore-legacy-sessions` directly.

## Packaging

The official plugin seed logic must discover the plugin in source runs, the Electron packaged layout, and the SEA runtime.

- `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` registers the official plugin root candidates.
- `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs` registers the SEA asset with `requiresRuntime: false`.
- With no MCP runtime, the seed phase does not rewrite `.zcode-plugin/plugin.json`.

## Verification

- `zcode plugins list` shows `restore-legacy-sessions@zcode-plugins-official`, disabled by default.
- While disabled, no skill roots or command roots are injected.
- After enablement, `skillCount = 1` and `commandRootCount = 1`.
- The SEA asset manifest contains `skills/restore-legacy-sessions/SKILL.md`, both scripts, and `commands/restore-legacy-sessions.md`.
- `pnpm typecheck`
- `pnpm lint`
