# Onboarding Migration Flow

## Entry Points

The migration wizard has no welcome view. Every entry opens the first step `Sessions` directly:

- Settings → Data & Stats → Data Sync → `Migrate` (desktop only).
- First run: when the settings-sync detection finds importable content, the wizard opens automatically.
- The occupation onboarding, when the user opts in to migration.

The first step's bottom-left button is `Cancel`; it closes the dialog and marks the first-run prompt as handled. The other steps keep `Back` / `Continue` / `Begin migration` / `Finish`.

The settings sidebar has no separate Onboarding entry. `General` → `Open onboarding` opens the occupation onboarding, not this wizard.

All entries go through the store request `requestOnboardingDialog()`; the dialog is mounted once in `Root.tsx`.

## Current Flow

Onboarding now uses a multi-step wizard:

1. `Sessions`
   - Only selects workspace scope for session migration.
   - Does not start importing.
2. `Agent Settings`
   - Only selects provider / skill / plugin categories.
   - Does not start importing.
3. `Migration`
   - Runs the unified import pipeline.
   - Shows shared progress while running.
   - Reuses the same step to show the final result summary after migration completes.

The current visible step order is:

1. `Sessions`
2. `Skills`
3. `MCP Servers`
4. `Commands`
5. `AGENTS.md`
6. `Migration`

## Session Scan Source

- Desktop onboarding / settings migration scan reads native Claude Code history from `{HOME}/.claude/projects/**/*.jsonl` (also tries `os.homedir()` and `ZCODE_DATA_BASE_DIR` as HOME candidates).
- Implementation: `packages/services/src/session/claude-native/claudeNativeSessionImportRepo.ts`, wired through `IZCodeTaskService.scanImportableClaudeSessions`.
- Imported tasks are indexed with `provider: "claude"` and `migrationSource: "claudeCode"`. ZCode Agent task lists filter to `glm` by default but also include rows with `migration_source = claudeCode`, so migrated history appears in the sidebar without mixing in stale non-migrated Claude index rows.

## Claude → ZCode Session Import

Native Claude Code `.jsonl` and the ZCode protocol snapshot are **not the same format**, so import normalizes in the services layer:

1. `claudeNativeSessionImportParser.ts` reads the jsonl, filters sidechain / synthetic assistant entries, and aggregates multiple assistant segments into one user turn + one assistant turn as `ZCodePersistedMessage[]`.
2. `session/create` supports `importedHistory`: the import service creates a real ZCode Protocol session and writes the normalized history into the zcode-cli session store. The imported `taskId` is the real `sessionId`, so later `sendPrompt`, `setModel` and `setMode` keep hitting the same runtime.
3. `buildImportedClaudeTaskFile.ts` still generates a migration backup snapshot; before generation it cleans source-side runtime fields by property path, filtering `meta.mode`, `meta.model`, `meta.provider` and `messages[].model` by default, so Claude Code's model/mode/provider do not pollute the runtime selection of the current ZCode workspace.
4. `persistImportedClaudeTask.ts` writes `~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json` (legacy snapshot backup) and syncs the sqlite task index + the `workspace_task_list_changed` broadcast. For the new import path, list metadata comes from the real ZCode session while `migrationSource: "claudeCode"` is kept.
5. The native jsonl copy is copied to `~/.zcode/v2/agent-config/claude/{workspaceHash}/projects/...` for the later Claude resume chain.

When opening a migrated task, the real ZCode session is restored first; only old data without a matching protocol session falls back to read-only history recovery from the **legacy session JSON**.

## Claude User Memory → ZCode Default AGENTS

- The `AGENTS.md` step checks the Claude user memory file at `{HOME}/.claude/CLAUDE.md`.
- If the source file exists, the step can copy that file to `{HOME}/.zcode/AGENTS.md`.
- `~/.zcode/AGENTS.md` is the user-level default instruction file. The runtime reads it when present and merges it before the workspace `AGENTS.md` resolved from the current working directory up to the project root.
- This migration is explicit and selected by the user in the wizard. It is not part of the generic skills / commands / MCP import selector because it intentionally overwrites one well-known default instruction file instead of importing only missing resources.
- Before the wizard enters the final `Migration` step, selecting this copy action must open a confirmation dialog. The copy action may replace an existing `{HOME}/.zcode/AGENTS.md`, so the dialog must clearly say that the default AGENTS configuration will be overwritten.
- The service layer performs the copy against the user's home directory. `workspacePath` / `workspaceIdentity` are only carried for logging / request correlation and must not be used as the target filesystem path.
- Remote and mobile remote-control paths must not introduce a separate runtime for this copy action. The action stays behind the existing host-process settings-sync service boundary.

## Implementation Notes

- `packages/ui/src/onboarding/OnboardingDialog.tsx`
  - Owns the wizard state and unified execution flow.
- `packages/ui/src/onboarding/useOnboardingAgentsFileMigration.ts`
  - Loads the Claude user memory migration status and executes the confirmed copy action.
- `packages/ui/src/onboarding/OnboardingDialogParts.tsx`
  - Owns shared wizard chrome such as sidebar, header, and footer.
- `packages/ui/src/onboarding/OnboardingFlowParts.tsx`
  - Owns per-step content rendering.
- `packages/services/src/settings-sync/settingsSyncService.ts`
  - Owns the filesystem operation that copies `{HOME}/.claude/CLAUDE.md` to `{HOME}/.zcode/AGENTS.md`.
- `apps/zcode-cli/packages/adapters/src/context/index.ts`
  - Resolves `{HOME}/.zcode/AGENTS.md` and workspace `AGENTS.md`, then merges both when both exist.

## UX Rules

- 首启检查和手动打开共用同一个向导，但异步结果只属于发起它的那次请求。手动打开、关闭、切换工作区（含 identity）或卸载都会使旧请求失效；旧成功和旧失败都不得再开关窗口、重置选择或覆盖迁移结果。
- 手动打开接管仍在进行的首启检查，并自行完成检测与 loading 收尾。不能仅保留 `open` 而留下永久 loading，也不能在 React 状态 updater 中发起检测。
- 没有手动接管时，已处理的首启提示和空检测结果仍保持关闭；首启提示的持久化含义不变。开始导入后，迟到的检测不得覆盖导入进度或结果。

- Selection steps never trigger import immediately.
- Import only starts after entering `Migration`.
- The `AGENTS.md` step is also a selection step. It must not copy files until the user starts migration and confirms the overwrite dialog.
- The `Migration` step owns both the running state and the completed result state.
- The settings page reopens the wizard from Data Sync → `Migrate`, always at the `Sessions` step.
