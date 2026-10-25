# External Agent Commands Import

## Goal

The Settings "Commands" page supports one-click import from external agents' local commands directories into ZCode. Interaction matches the skills import; only command files are handled — no skills, MCP servers, or plugins.

## Source scope

The import entry auto-scans these local sources:

- Claude Code: user `~/.claude/commands` and workspace `<workspace>/.claude/commands`
- Codex CLI: user `~/.codex/commands` and workspace `<workspace>/.codex/commands`
- OpenCode: user `~/.config/opencode/commands` and workspace `<workspace>/.opencode/commands`
- OpenClaw: user `~/.openclaw/commands` and workspace `<workspace>/commands`
- Augment: user `~/.augment/commands` and workspace `<workspace>/.augment/commands`
- Continue: user `~/.continue/commands` and workspace `<workspace>/.continue/commands`
- Goose: user `~/.config/goose/commands` and workspace `<workspace>/.goose/commands`
- Qwen Code: user `~/.qwen/commands` and workspace `<workspace>/.qwen/commands`
- Qoder: user `~/.qoder/commands` and workspace `<workspace>/.qoder/commands`
- Qoder CN: user `~/.qoder-cn/commands` and workspace `<workspace>/.qoder/commands`
- Windsurf: user `~/.codeium/windsurf/commands` and workspace `<workspace>/.windsurf/commands`
- Trae: user `~/.trae/commands` and workspace `<workspace>/.trae/commands`
- Kiro CLI: user `~/.kiro/commands` and workspace `<workspace>/.kiro/commands`
- Roo Code: user `~/.roo/commands` and workspace `<workspace>/.roo/commands`
- CodeBuddy: user `~/.codebuddy/commands` and workspace `<workspace>/.codebuddy/commands`

Gemini is unsupported, and user- or project-level `.agents/commands` is not scanned — the command list already reads the `.agents` command directory directly.

## Import policy

- Only `.md` command files; hidden directories and files are skipped.
- The import target is chosen in the import button's dropdown:
  - `Global` writes to `~/.zcode/commands/`.
  - `Project` writes to `<workspace>/.zcode/commands/`.
- The file hierarchy relative to the source root is preserved; `review/code.md` imports as `review/code.md`.
- Import modes match skills:
  - `软链` (symlink): create a symbolic link at the target pointing at the source command file; default.
  - `直接复制` (direct copy): copy the command file to the target.
- `Project` is unavailable without an open workspace.
- Existing target files with the same name, or an existing ZCode command with the same slash-command name, are skipped — existing ZCode commands are never overwritten.
- Opening the dialog or rescanning defaults to `Global`, but neither `Global` nor `Project` sources are pre-checked; the user selects explicitly.

## UI behavior

- The "Commands" settings page shows an import icon button next to the create button.
- Dialog structure, scope Select, refresh button, two-level source tree, select-all/deselect-all, split import button, import-mode dropdown, and completion result list all match the skills import.
- The second level shows command names derived from the file's relative path as slash commands, e.g. `/review/code`.
- The completion page lists the commands involved; each entry shows a status icon and command name, not file paths.

## Compatibility and boundaries

- `settings-sync` adds a `commands` category with its own source table, not derived from `skills`; scanning, dedupe, and import are likewise independent of skills.
- Remote workspaces use only paths the current host process can access; identity isolation still passes `workspaceIdentity`, path execution uses `workspacePath`.
- Direct copy does not reference external directories; symlink keeps pointing at the external command file — suitable for users who want to follow external agent changes.

## Verification

- Cover missing directories, empty directories, same-name skips, user-level import, workspace-level import, and copy/symlink modes.
- UI covers the import button, dialog source list, and post-import refresh.
- `pnpm typecheck` and `pnpm lint` must run.
