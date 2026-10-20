# UI upstream sync 3.16.1: integration ledger

Branch: `claude/upstream-sync-ui` (from `claude/upstream-sync-ui-1`, merged b1-b8, extra, composer `bf6c4d26`).
Scope of this file: decisions and gaps made while integrating the ten port branches, not already in the bucket ledgers.

## Compile-level contracts completed

- `V4ChatPane`: `onCreateTaskInWorkspace` prop, forwarded to `SessionPane`.
- `App.tsx`: quick-pick handlers `openSessionManager`, `setThemeMode`, `setThemePalette`; `themeMode` / `themePalette` / `resolvedTheme`; git review state (`gitReviewExecutionTarget`, `gitRepositoryWorkspacePath`, `handleRefreshGitReview`, `gitPaneState`); `handleOpenGitReview(sourceId, executionWorkspacePath, executionSessionId)`; `handleCreateTaskInWorkspace`; `handleOpenModelTrajectory` from `useAppPanels`.
- `root/types.ts`: `openWorkspace` target is `{ workspacePath, workspaceIdentity? }` (fork signature; the upstream placeholder typed `WebRemoteControlTaskTarget` was reverted); `initialWebRemoteControlWorkspaceList`; `WorkspaceSettingsLayerProps.onOpenSession`. `RootWorkspaceContent` and `WorkspaceSettingsLayer` forward `onOpenSession` to `SettingsPage`.
- `services/hooks`: `loadHooks` / `saveHooks` accept `scope?: "all" | "user"` (user scope reads only the user home). Required by upstream `HooksSection`; the fork services never had it.
- `workspace-grouped-tasks/view.ts`: `GroupedDraftTaskPlacement` imported from `project-sidebar/grouped/types.ts`.
- `lib/taskListMetaSync.ts`: `removeTaskFromTaskCaches` restored.
- `ConversationComposer`: uses `useOptionalWorkspaceServicesResolution` (fork remote parity) instead of the base-only hook.
- `i18n`: fork keys referenced by UI code and absent upstream were copied from `9c2434f7` (commandCenter.worktree.error.\*, workflow getRun, plural families). Plural families are written as `<id>.one` / `<id>.other` (upstream `formatPlural` convention); the fork `<id>One` aliases are kept.
- `package.json`: `@streamdown/code ^2.0.0`, `shiki ^4.5.0`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` added; lockfile refreshed with `pnpm install --lockfile-only`. Review note: the lockfile diff also moves `@modelcontextprotocol/*` resolutions (ext-apps 2.0.3 -> 2.0.0); verify before merge.

## Decisions to confirm

- **Draft right-sidebar owner**: upstream protocol-v4 drafts have no `draftSessionId`. `App.tsx` uses `activeTaskId ?? null` as the side-pane owner, so drafts no longer get their own sidebar scope. Fork behaviour is UI-2 scope unless the owner says otherwise.
- **Theme**: `resolvedTheme` is `resolveTheme(theme)` (live system read); the fork's `systemResolvedTheme` state is not re-applied.
- **Quick-pick palette**: `setThemePalette` is wired to the store `setPalette`; no palette UI was re-checked here.

## Known open test failures (not yet ledgered as UI-2)

Last full run: `node scripts/run-vitest.mjs run packages/ui/test` -> 47 files failed, 161 tests failed of 10997.

Module-absent test files (their feature modules are not in the upstream-structured tree; UI-2 candidates):
`webRemoteControlTaskIndexLayout`, `workspaceSidebarItemRenderStability`, `workspaceSidebarRemoteNotice`, `workspaceSidebarTaskViewSwitcher`, `workspacePinnedTasksSection`, `webRemoteControlMobileTaskHome`, `useGroupedTaskView`, `taskTimelineGroups`, `composerPlanTransition` (see /plan shortcut decision), `chatEmptyWorktreeTaskToggle` (ChatEmptyState, bucket 1 ledger item 2), `automationTypographyTokens` (reads ChatEmptyState.tsx).

Assertion-level failures (fork expectations vs upstream structure), grouped by file: `subagentsSection` (service and workspace-services contracts), `projectTreeBackgroundUnread`, `conversationShareConfirmationDock`, `settingsPageConfig`, `memorySettingsSection`, `remoteConnectionFieldsDockerRefresh`, `savedWorkflowLaunchDialog`, `commandCenterSelection`, `workspaceHeaderTitleSection`, `useWorkspaceActiveTaskState`, `v4ConversationStatusPanel`, `taskListItemHoverActions`, `workspaceSidebarProjectPins`, and others. These are not yet classified one by one.

## Fixed in test files (test-side, fork behaviour kept)

- `v4ConversationTurnGroup.test.ts`: `useServices` mock for the throughput pipeline (fork test block restored).
- `subagentsSection.test.ts`: `useOptionalTabStore` mock.
- `projectTreeBackgroundUnread.test.ts`: `createWindowHostControllerRuntime` imported from `@zcode/services/window-controller` (moved out of desktop host).

## Oversize exemptions added

- `packages/ui/test/subagentsSection.test.ts`, `packages/ui/test/projectTreeBackgroundUnread.test.ts` (upstream-oversize, under the bucket-3 TEMPORARY block).
- `architecture-policy.yaml`: `packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts` max-file-lines (465 lines upstream).

## Not verified in this integration

- `pnpm test:pre-push`, `pnpm test` (node), `scripts/check-test-copy.mjs`, desktop/web tests, and the push hook are not run to green; the UI vitest failures above block the affected-test hook.

## Test triage (current state)

Ledgered UI-2 rows (skip or removal is tagged `TEMPORARY(UI-2)` in the file):

- UI2-MODULE-ABSENT: test files deleted because their feature modules are absent in the upstream-structured tree; restore from `9c2434f7` with the UI-2 port: `webRemoteControlTaskIndexLayout`, `workspaceSidebarItemRenderStability`, `workspaceSidebarRemoteNotice`, `workspaceSidebarTaskViewSwitcher`, `workspacePinnedTasksSection`, `webRemoteControlMobileTaskHome`, `useGroupedTaskView`, `taskTimelineGroups`, `composerPlanTransition`, `chatEmptyWorktreeTaskToggle`, `automationTypographyTokens`.
- UI2-SIDEBAR-PINS: `workspaceSidebarProjectPins.test.ts` `describe.skip` (old sidebar project pins).
- UI2-SIDEBAR-NEWTASK: `workspaceSidebarNewTaskEntryNames.test.ts` `describe.skip` (old sidebar entry names).
- UI2-PLAN-SHORTCUT: two `/plan` shortcut cases in `v4SlashCommands.test.ts` `it.skip` (shortcut decision).

Decision rows (not UI-2 work; need an owner decision):

- DEC-DESTRUCTIVE-ENTER: upstream `ConfirmDialog` does not confirm destructive dialogs on Enter from non-interactive content; the fork test expects confirm. One case `it.skip` in `confirmDialogEnterRouting.test.ts`.

Fork behaviour regressions accepted for now:

- Draft right-sidebar scope (see decision 1 above): drafts have no sidebar owner (UI-2 row: restore draft-scoped owner).

Fork test specs restored over upstream tests (the fork test passes against current source): `memorySettingsSection`, `taskListItemHoverActions` (oversize, exempted), `usePaneSessionPersistence`, `v4PendingCommandRegistry`, `v4ConversationComposerErrorBanner`.

Theme: `App.tsx` ports the fork's `systemResolvedTheme` state (OS scheme tracked as state so changes re-render); `themeTarget` derives from `resolvedTheme`.

Lockfile and manifest: `pnpm-lock.yaml` and `packages/ui/package.json` equal origin/integration (no upstream pin changes; fork pins kept).

Remaining failing tests at this point (not yet triaged to a fix or ledger row): about 117 across 27 files; main groups are `subagentsSection`, `projectTreeBackgroundUnread`, `v4ConversationStatusPanel`, `workspaceHeaderTitleSection`, `useWorkspaceActiveTaskState`, `conversationShareConfirmationDock`, `settingsPageConfig`, `remoteConnectionFieldsDockerRefresh`, `commandCenterSelection`, `useDraftConfigControl`, and about 15 single-case files.

## Decisions taken (confirmed by coordinator)

- DEC-DESTRUCTIVE-ENTER: upstream rule wins. Destructive confirm dialogs do not confirm on Enter from non-interactive content. The fork test case was adapted to assert that rule; the fork's Cancel/Close own-Enter guards are kept.
- Draft right-sidebar scope regression: accepted for now (UI-2 row).
- resolvedTheme: fork semantics (systemResolvedTheme state) ported.
