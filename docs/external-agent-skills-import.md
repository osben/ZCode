# External Agent Skills Import

## Goal

The Settings "Skills" page supports one-click import from external agents' local skill directories into ZCode. Phase one imports skills only — no MCP servers, plugins, commands, or model providers.

## Source scope

The import entry auto-scans these local sources:

- Claude Code: user `~/.claude/skills` and workspace `<workspace>/.claude/skills`
- Codex CLI: user `~/.codex/skills` and workspace `<workspace>/.codex/skills`
- OpenCode: user `~/.config/opencode/skills` and workspace `<workspace>/.opencode/skills`
- OpenClaw: user `~/.openclaw/skills` and workspace `<workspace>/skills`
- Augment: user `~/.augment/skills` and workspace `<workspace>/.augment/skills`
- Continue: user `~/.continue/skills` and workspace `<workspace>/.continue/skills`
- Goose: user `~/.config/goose/skills` and workspace `<workspace>/.goose/skills`
- Qwen Code: user `~/.qwen/skills` and workspace `<workspace>/.qwen/skills`
- Qoder: user `~/.qoder/skills` and workspace `<workspace>/.qoder/skills`
- Qoder CN: user `~/.qoder-cn/skills` and workspace `<workspace>/.qoder/skills`
- Windsurf: user `~/.codeium/windsurf/skills` and workspace `<workspace>/.windsurf/skills`
- Trae: user `~/.trae/skills` and workspace `<workspace>/.trae/skills`
- Trae CN: user `~/.trae-cn/skills` and workspace `<workspace>/.trae/skills`
- Kiro CLI: user `~/.kiro/skills` and workspace `<workspace>/.kiro/skills`
- Roo Code: user `~/.roo/skills` and workspace `<workspace>/.roo/skills`
- CodeBuddy: user `~/.codebuddy/skills` and workspace `<workspace>/.codebuddy/skills`

Gemini is unsupported.

## Import policy

- Only skill directories containing `SKILL.md` are handled.
- The import target is chosen in the import button's dropdown:
  - `Global` writes to `~/.zcode/skills/<skill-dir>/`.
  - `Project` writes to `<workspace>/.zcode/skills/<skill-dir>/`.
- The import mode is switched at the bottom of the dialog:
  - `软链` (symlink): create a symbolic link at the target pointing at the source skill directory; default. On Windows, directory links use `junction`.
  - `直接复制` (direct copy): copy the whole skill directory.
- `Project` is unavailable without an open workspace.
- User-level sources still scan and import without a workspace; workspace-level sources participate only when a `workspacePath` exists.
- An existing target directory with the same name, or an existing ZCode skill with the same `name`, is skipped — existing ZCode skills are never overwritten.
- Symlink mode applies only to newly imported skills: an existing plain-copy target directory is not replaced by a link; it still counts as "target directory exists" and is skipped.
- Results aggregate per source into `importedCount` / `skippedCount` / `failedCount`.
- After import, the skill list refreshes so new skills appear in settings immediately.

## UI behavior

- The "Skills" settings page shows an import icon button next to the create button.
- Clicking opens the import dialog, which scans and lists importable skill sources by default.
- The dialog borrows the onboarding wizard's rounded corners, spacing, and workspace-panel styling but stays single-column; the title row keeps the scope Select and refresh button on the right with no descriptive subtitle. The scope Select shows no extra label — just the current `Global` / `Project` value. The view uses a two-level source tree: level one shows the agent and scan path; level two shows that path's skills, collapsed by default, expandable via arrow or source text. Both scopes are always selectable; an empty scope shows an empty state in the list area.
- Users check skills individually at level two, which lists only importable skills: already-imported, existing-target, or same-name skills are filtered out of the list. A `version` in `SKILL.md` frontmatter renders as a version badge next to the name; paths are not shown. Level-one checkboxes select/deselect all importable skills of that source with a partial state when some are selected.
- A select-all/deselect-all checkbox at the top controls only the current `Global` / `Project` scope's importable skills without touching the other scope's selections. Opening the dialog or rescanning defaults to `Global`, but neither scope's sources are pre-checked.
- The import button is split: the left side imports selected skills with the current target and mode; the right dropdown only switches the import target without triggering import. Same-name or same-`name` skills keep being skipped. The bottom dropdown switches between `直接复制` and `软链`; the adjacent exclamation icon explains the current mode's effect via tooltip on hover.
- The completion page downplays the top statistics and lists the skills involved: each shows a status icon, name, and optional version — no file paths; skipped items explain themselves via the icon tooltip.
- An empty scan keeps the dialog open with a "nothing to import" hint, so the button never looks broken.

## Compatibility and boundaries

- `settings-sync` keeps owning the import state machine; this feature adds the `skills` category and external agent sources without changing onboarding's default `providers` visibility.
- The dialog does not scan `.agents/skills` (user or project level) — the ordinary skill list already reads the `.agents` skill directory directly; import only copies other external agent sources into ZCode skill directories.
- The workspace skill list walks from the current directory up to the worktree root, merging `.zcode/skills` and `.agents/skills` at every level, matching the Agent runtime's default roots; `.agents/skills` is never skipped as a whole just because same-level `.zcode/skills` has skills. Two roots hitting the same realpath keep one copy; same-name skills at different paths stay as separate install entries. The deprecated `.zcode/cli/skills` and `.claude/skills` do not participate in discovery.
- The user-level skill list reads both `~/.zcode/skills` and `~/.agents/skills`, so importing one global skill does not hide the remaining external-agent global skills from settings; if a skill under `.agents` was already copied to `.zcode/skills` (same directory name or same `name`), the list shows the `.zcode` copy to avoid duplicates.
- Agent runtime and the settings page must share one semantics for `SKILL.md` frontmatter: `description` supports YAML single-line scalars, `>` folded blocks, and `|` literal blocks. Hand-written skills in `~/.agents/skills` commonly use `description: >` for multi-line trigger notes; reading only the literal top-level `>` and dropping indented lines would leave settings showing a full description while the Agent's injected skills list contains only `>`.
- Remote workspaces use only paths the current host process can access; identity isolation still passes `workspaceIdentity`, path execution uses `workspacePath`.
- Direct copy does not reference external directories, so later external deletion/modification cannot affect ZCode; symlink keeps pointing at the external directory — suitable for users who want to follow external agent changes.

## Verification

- Cover missing directories, empty directories, same-name skips, user-level import, workspace-level import.
- Cover same-level `.zcode/skills` + `.agents/skills` both being discoverable, and `.zcode/cli/skills` / `.claude/skills` staying ignored.
- Cover `description: >` / `description: |` multi-line frontmatter in `.agents/skills`, keeping Agent runtime discovery consistent with settings.
- UI covers the import button, dialog source list, and post-import refresh.
- `pnpm typecheck` and `pnpm lint` must run.
