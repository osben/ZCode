# External Agent Plugins Import

## Goal

The Settings "Plugin Management" page supports one-click import from external agents' local plugin directories into ZCode. Interaction matches the skills/commands imports, but the business directories, scan rules, target writes, and dedupe logic are maintained independently.

## Source scope

The import entry auto-scans these local sources:

- Claude Code: user `~/.claude/plugins` and workspace `<workspace>/.claude/plugins`
- Codex CLI: user `~/.codex/plugins` and workspace `<workspace>/.codex/plugins`
- OpenCode: user `~/.config/opencode/plugins` and workspace `<workspace>/.opencode/plugins`
- OpenClaw: user `~/.openclaw/plugins` and workspace `<workspace>/plugins`
- Augment: user `~/.augment/plugins` and workspace `<workspace>/.augment/plugins`
- Continue: user `~/.continue/plugins` and workspace `<workspace>/.continue/plugins`
- Goose: user `~/.config/goose/plugins` and workspace `<workspace>/.goose/plugins`
- Qwen Code: user `~/.qwen/plugins` and workspace `<workspace>/.qwen/plugins`
- Qoder: user `~/.qoder/plugins` and workspace `<workspace>/.qoder/plugins`
- Qoder CN: user `~/.qoder-cn/plugins` and workspace `<workspace>/.qoder/plugins`
- Windsurf: user `~/.codeium/windsurf/plugins` and workspace `<workspace>/.windsurf/plugins`
- Trae: user `~/.trae/plugins` and workspace `<workspace>/.trae/plugins`
- Kiro CLI: user `~/.kiro/plugins` and workspace `<workspace>/.kiro/plugins`
- Roo Code: user `~/.roo/plugins` and workspace `<workspace>/.roo/plugins`
- CodeBuddy: user `~/.codebuddy/plugins` and workspace `<workspace>/.codebuddy/plugins`

Gemini is unsupported, and user- or project-level `.agents/plugins` is not scanned.

## Recognition rules

- Plugin candidates are directories containing a manifest.
- Manifest priority:
  1. `.zcode-plugin/plugin.json`
  2. `.claude-plugin/plugin.json`
  3. `.codex-plugin/plugin.json`
- The manifest must be a JSON object with `name` a non-empty string; a missing `version` is simply not shown.
- Scanning covers only one level of plugin directories below the source root — no recursion into plugin internals.

## Import policy

- The import target is chosen in the import button's dropdown:
  - `Global` writes to `~/.zcode/plugins/<plugin-dir>/` and appends that absolute path to `plugins.dirs` of `~/.zcode/cli/config.json`.
  - `Project` writes to `<workspace>/.zcode/plugins/<plugin-dir>/` and appends that absolute path to `plugins.dirs` of `<workspace>/.zcode/config.json`.
- Import modes match skills and commands:
  - `软链` (symlink): create a symbolic link at the target pointing at the source plugin directory; default.
  - `直接复制` (direct copy): copy the plugin directory to the target.
- `Project` is unavailable without an open workspace.
- An existing target directory with the same name, or the same plugin id (`<manifest.name>@inline`) already in the target config, is skipped — existing plugins are never overwritten.
- Opening the dialog or rescanning defaults to `Global`, but neither scope's sources are pre-checked.

## UI behavior

- The "Plugin Management" settings page shows an import icon button next to the refresh button.
- Dialog structure, scope Select, refresh button, two-level source tree, select-all/deselect-all, split import button, import-mode dropdown, and completion result list match the skills/commands imports.
- The second level shows plugin names; a `version` in the manifest renders as a version badge next to the name.
- The completion page lists the plugins involved; each entry shows a status icon and plugin name, not file paths.

## Compatibility and boundaries

- `settings-sync` adds a `plugins` category with its own source table, derived from neither `skills` nor `commands`; scanning, dedupe, and import are likewise independent.
- Remote workspaces use only paths the current host process can access; identity isolation still passes `workspaceIdentity`, path execution uses `workspacePath`.
- Direct copy does not reference external directories; symlink keeps pointing at the external plugin directory — suitable for users who want to follow external agent changes.
- The ZCode runtime reads imported inline plugins via `plugins.dirs`; the import never writes the official marketplace cache.

## Verification

- Cover missing directories, empty directories, same-name skips, user-level import, workspace-level import, and copy/symlink modes.
- Cover both `.zcode-plugin/plugin.json` and `.claude-plugin/plugin.json` manifests.
- UI covers the import button, dialog source list, and post-import refresh.
- `pnpm typecheck` and `pnpm lint` must run.
