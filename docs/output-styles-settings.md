# Output Styles: user-editable agent tone profiles

Status: implemented (phase 1 runtime + storage, phase 2 settings UI). Not yet manually QA'd in a running app.

## Problem

The app ships an output-style concept in three disconnected pieces:

- `packages/services/src/output-style/outputStyleService.ts` manages styles, but reads and
  writes `~/.claude/` (Claude Code compatibility port) and lists built-in styles with empty
  content, so activating `explanatory` or `learning` injects nothing.
- The agent runtime accepts `AgentRuntimeConfig.outputStyle` (`OutputStylePromptConfig`) and
  `ContextBuilder` renders it (`# Output Style: <name>`, identity intro swap), but no
  production path ever sets it. The field is exercised by tests only.
- No settings UI section exists (subagents, hooks, commands, memory, and instructions all
  have one; output styles do not).

Result: a user cannot change the agent's response style at all.

## Design principles

1. **Defaults live in code as constants.** Built-in style prompts are TypeScript constants in
   `packages/shared/src/output-style.ts`. When no user file exists, the constant is the
   effective text. This keeps the code the source of truth, makes "Restore default" trivial
   (delete the file), and avoids upstream merge friction: fork changes concentrate in one
   small shared module plus a new bootstrap file.
2. **Files are the contract between UI and runtime.** The desktop service writes files under
   `~/.zcode/`; the CLI bootstrap reads the same files at session start. No protocol field,
   no desktop-to-CLI push, and remote workspaces work unchanged (the service instance bound
   to a remote connection writes the remote host's `~/.zcode`, and the CLI on that host reads
   its own `~/.zcode`).
3. **A file overrides the built-in constant with the same key.** The style id (file name
   without `.md`) is the key. Creating `~/.zcode/output-styles/explanatory.md` overrides the
   `explanatory` built-in; deleting the file restores the constant. Custom styles are simply
   ids that have no built-in constant.
4. **Scalars may live in settings.** The only scalar is the active style id, stored in
   `~/.zcode/settings.json` under `outputStyle` (same key Claude Code uses).

## Storage layout

| Path                                                  | Owner                             | Content                      |
| ----------------------------------------------------- | --------------------------------- | ---------------------------- |
| `~/.zcode/settings.json`                              | service (write), bootstrap (read) | `{ "outputStyle": "<id>" }`  |
| `~/.zcode/output-styles/<id>.md`                      | service (write), bootstrap (read) | markdown style (see format)  |
| `~/.claude/settings.json`, `~/.claude/output-styles/` | read-only legacy fallback         | pre-fork data still resolves |

Read precedence is `~/.zcode` first, `~/.claude` second. Writes go to `~/.zcode` only.

### Style file format

```markdown
name: Concise Reviews
description: Short review-focused responses

<prompt body — everything after the header block is the effective prompt>
```

The parser (`parseOutputStyleFile` in `packages/shared/src/output-style.ts`) strips the
leading `name:` / `description:` header lines; the remainder is the prompt. A missing name
falls back to the file name.

## Runtime wiring

- `bootstrap/src/output-style.ts` exposes `loadPersistedOutputStyle({ storageRoot })`:
  resolve the active id from settings (zcode → claude), then the prompt from an override
  file (zcode → claude) or the built-in constant. Returns `undefined` for absent, `default`,
  or empty-prompt styles — `undefined` keeps the stock system prompt byte-identical.
- `resolveAppRuntimeConfig` takes `persistedOutputStyle` (same pattern as `persistedMode`)
  and applies `options.runtimeConfig?.outputStyle ?? persistedOutputStyle`. Explicit
  per-session config always wins over disk.
- Loading happens once per session start in `create-app.ts`.

## Rollback

- Per style: deleting the override file restores the built-in constant ("Restore default");
  deleting a custom style removes it.
- The settings UI shows, for every style, the effective text (constant when no file exists),
  a diff before saving, and a "Customized" badge when an override file exists. No version
  history.

## Settings UI (phase 2, implemented)

- `packages/ui/src/settings/OutputStylesSection.tsx` (+ `OutputStylesEditorCard.tsx`): list,
  activate, create/edit, delete, restore-default, diff preview, collision warnings, save-time
  conflict dialog. Desktop-only, mirroring the Instructions section; it edits the host of the
  active workspace and pins it while a draft is dirty.
- `packages/ui/src/hooks/useOutputStyles.ts`: single owner of the section state; reloads after
  every write so the list always shows the same effective text the runtime resolves.
- `listStyles` folds a file named after a built-in id into that built-in's entry
  (`isOverridden: true`, effective content, file path) instead of listing a duplicate custom
  row; `content` is always the parsed prompt body, never the raw file.
- Deleting the active custom style resets the active id to `default`.
- Empty custom prompts are warned about in the UI and resolve to "no style" at runtime.
- Names that slug-collide with a built-in id (would create an override) or another custom
  style (would overwrite its file) show an explicit warning before saving — only for new
  styles, since edits keep the existing file name and cannot overwrite anything.
- Locales: en-US, zh-CN, uk-UA (catalog parity test).

### Fresh-install transparency

On a fresh install no `output-styles/` directory and no files exist; built-ins render from the
code constants. The UI makes the file materialization explicit:

- The section header shows the storage directory path with a "show in file manager" action.
  Reading the path never creates the directory (`getUserStylesDirectory` is a pure lookup);
  the first style write materializes it.
- Customizing a built-in with no override file shows a banner in the editor: saving creates
  the override file at `<path>`; "Restore default" deletes it again. The editor prefills the
  constant text, so the constant literally becomes the file body.
- Creating a custom style shows the future file path live, derived from the name.
- The `default` style is not editable: the runtime loader ignores an override for id
  `default` (it means "no style"), so the row offers no edit action.

## Non-editable prompt surface

Output styles only replace the agent's tone intro and append an `# Output Style` section.
They must not open editing access to: the security notice, `# Harness`, peer-message
permission guidance, task-notification framing, the Explore read-only block, or the compact
summary structure. Those stay code constants with no file override path.

## Not yet covered

- E2E/manual QA of the section in a running app (unit, type, lint, and i18n parity verified).
- A `/output-style` style switcher inside a running session (today the style applies to new
  sessions; `updateConfig` already supports live changes if wanted later).
