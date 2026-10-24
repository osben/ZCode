# UI upstream sync: ledger (1 of 3)

Upstream-deleted `packages/ui` files that the fork had edited. Fork feature = fork commit subjects
touching the file (first 3). Re-apply target is TBD until the successor is ported. Recover the fork
version with `git show 9c2434f7:<file>`.

## Upstream-deleted files the fork edited (rows 1-50)

- `packages/ui/src/ChatEmptyState.tsx`: worktree failure return follow-ups from #177 review (keep raw worktree error text out of creation logs; clear frozen retry destination on legacy) (re-apply: TBD)
- `packages/ui/src/SortableWorkspaceSidebar.tsx`: forward `onOpenSessionManager` through `SortableWorkspaceSidebarItem`; address sidebar child session review; pin and customize sidebar workspaces (re-apply: TBD)
- `packages/ui/src/WebRemoteControlDialog.tsx`, `packages/ui/src/WebRemoteControlMobileTaskHome.tsx`: comment translation and design-token fixes only (re-apply: TBD)
- `packages/ui/src/WebRemoteControlTaskIndex.tsx`: block remote archived bulk deletion; permanently delete sessions and safely clean worktrees; child-aware delete copy and permanent erase of hidden sessions (re-apply: TBD)
- `packages/ui/src/WebRemoteControlTaskIndexRow.tsx`: permanently delete sessions and safely clean worktrees; design-token fixes (re-apply: TBD)
- `packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`, `packages/ui/src/WorkspacePinnedTasksSection.tsx`: permanently delete sessions and safely clean worktrees; child-aware delete copy and permanent erase of hidden sessions (re-apply: TBD)
- `packages/ui/src/WorkspaceGroupedTasksSection.tsx`: preserve child session sidebar behavior; address sidebar child session review (re-apply: TBD)
- `packages/ui/src/WorkspaceSidebarItem.tsx`, `packages/ui/src/WorkspaceTimelineTasksSection.tsx`: PR 183 review (stable dialog loaders, remote/web-remote delete guards, quiet usage); stabilize task deletion callback; permanently delete sessions and safely clean worktrees (re-apply: TBD)
- `packages/ui/src/hooks/useGroupedTaskView.ts`, `packages/ui/src/hooks/useWorkspaceTaskLists.ts`, `packages/ui/src/hooks/workspaceTaskListDisplayGroups.ts`, `packages/ui/src/hooks/workspaceTaskListOptimisticOverlay.ts`, `packages/ui/src/lib/buildGroupedTaskViewFromSessions.ts`, `packages/ui/src/lib/taskListWorkspaceEventCoordinator.ts`, `packages/ui/src/lib/taskRuntimeDisplayStatus.ts`, `packages/ui/src/lib/webRemoteControlTaskIndex.ts`, `packages/ui/src/lib/webRemoteControlTaskSync.ts`, `packages/ui/src/v4/ConversationShareSelectionDock.tsx`, `packages/ui/src/v4/composer/composerPermissionGrant.ts`, `packages/ui/src/v4/composer/composerPlanTransition.ts`: comment translation only (re-apply: TBD)
- `packages/ui/src/hooks/workspaceTaskListRefreshSignatures.ts`: gate incognito creates and project the incognito marker; worktree review findings (re-apply: TBD)
- `packages/ui/src/lib/taskFileTreeTarget.ts`: improve worktree task UX (re-apply: TBD)
- `packages/ui/src/v4/buildTaskListResultFromSessions.ts`: persist incognito marker in tasks-index meta so the sidebar shows it without an observer; gate incognito creates and project the incognito marker; address sidebar child session review (re-apply: TBD)
- `packages/ui/src/workspace-grouped-tasks/task-context-menu-content.tsx`: show pull requests in the hover card and task context menus (re-apply: TBD)
- `packages/ui/test/appQuickPickCommandStability.test.ts`, `packages/ui/test/appTaskQueryCacheSubscription.test.ts`: reduce unit suite setup and waiting time (re-apply: TBD)
- `packages/ui/test/appearanceSettingsLayout.test.ts`: migrate UI tests to en-US copy convention and add copy guard; remove source-grep and locale-literal tests (re-apply: TBD)
- `packages/ui/test/assistantMarkdownTypeScale.test.ts`, `packages/ui/test/automationConversationWorkspacePresentation.test.ts`, `packages/ui/test/automationCustomRepeatTestIds.test.ts`, `packages/ui/test/automationEditSubtitle.test.ts`: copy-convention and source-grep test migration (re-apply: TBD)

## Resolved (deleted 2026-10-23, PR #325)

No fork behavior, only upstream code plus translated comments; content recoverable from `8724e0c1`:

`packages/ui/src/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.tsx`,
`packages/ui/src/hooks/chatActionHelpers.ts`, `packages/ui/src/hooks/useActiveTaskSnapshotMeta.ts`,
`packages/ui/src/hooks/useLocalWorkspaceScopes.ts`, `packages/ui/src/lib/chatStatus.ts`,
`packages/ui/src/lib/restrictVerticalDragWithinContainer.ts`, `packages/ui/src/lib/sidebarTaskPreferences.ts`,
`packages/ui/src/lib/taskListRefreshPolicy.ts`, `packages/ui/src/lib/taskStatusUnreadSync.ts`,
`packages/ui/src/lib/unreadTaskCount.ts`, `packages/ui/src/lib/webRemoteControlMobileTaskHome.ts`,
`packages/ui/src/lib/workspaceRemovalSafety.ts`, `packages/ui/src/lib/workspaceRuntimeRelease.ts`,
`packages/ui/src/lib/workspaceSidebarDrag.ts`, `packages/ui/src/store/remotePinnedTaskStore.ts`,
`packages/ui/src/store/remoteTimelineTaskStore.ts`.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger.md
