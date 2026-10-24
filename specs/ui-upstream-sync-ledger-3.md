# UI upstream sync: ledger (3 of 3)

Upstream-deleted files that the fork had edited (continued from ledger 2). For every file, the fork
changes named after the colon are still to be re-applied (re-apply: TBD); none has a per-file
verdict yet.

- `packages/ui/test/rootWebRemoteTaskSyncBoundary.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/selectTriggerStyle.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsBackButtonContract.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui | test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsBreadcrumbReplacesBackNavigation.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsCloseToTrayI18n.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsCommandRowContent.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/settingsEditFormDeleteAction.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsFrameContentLayout.test.ts`: (no subject found)
- `packages/ui/test/settingsHelpMenuEntry.test.ts`: (no subject found)
- `packages/ui/test/settingsHookRowContent.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/settingsHttpProxyI18n.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsListCardColors.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsListCreateAction.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsListHeaderActionSize.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/settingsListRowActionSize.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/settingsResourceRowNavigation.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui | test(ui): align cursor contract for skill cards
- `packages/ui/test/settingsSyncProviderBoundary.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/settingsUsageProviderTabs.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/sidePaneTerminalPersistentProfileTheme.test.ts`: fix(ui): preserve font preferences and terminal profiles
- `packages/ui/test/sidePaneToggleEmptyState.test.ts`: (no subject found)
- `packages/ui/test/sidebarInterfaceModeMenu.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/sshDialogDirectorySelection.test.ts`: wip(translation): translate cli/test Chinese comments (part 2, salvaged)
- `packages/ui/test/tabsLayoutSpacing.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/taskFileTreeTarget.test.ts`: feat: improve worktree task UX
- `packages/ui/test/taskTimelineGroups.test.ts`: Migrate UI tests to en-US copy convention and add copy guard
- `packages/ui/test/toolCallPresentationVocabulary.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/toolCommandTypography.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/useGroupedTaskView.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/v4ConversationDraftEmptyStateLogo.test.ts`: Migrate UI tests to en-US copy convention and add copy guard
- `packages/ui/test/v4ConversationTimelineHeaderSlot.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/v4ConversationTimelineScrollbarGutter.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/webRemoteControlMobileTaskHome.test.ts`: Migrate UI tests to en-US copy convention and add copy guard | test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/webRemoteControlTaskIndexLayout.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui | style: fix oxfmt formatting in contract test; merge integration | test(ui): make WebRemoteControlTaskIndex dep-array assertion formatting-agnostic
- `packages/ui/test/webRemoteControlTaskIndexRowHoverActions.test.ts`: feat: permanently delete sessions and safely clean worktrees
- `packages/ui/test/workspaceArchivedTaskActionTooltip.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/workspaceFileTreeStickyLayout.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/workspacePinnedTasksSection.test.ts`: Fix PR 182 review findings in UI test copy migration | Migrate UI tests to en-US copy convention and add copy guard
- `packages/ui/test/workspaceShellRenderStabilitySource.test.ts`: test: reduce unit suite setup and waiting time
- `packages/ui/test/workspaceShellResizeAutoCollapse.test.ts`: test: reduce unit suite setup and waiting time
- `packages/ui/test/workspaceShellSidebarResizePerformance.test.ts`: (no subject found)
- `packages/ui/test/workspaceSidebarItemRenderStability.test.ts`: style(ui): polish project menus and simplify pinned messages
- `packages/ui/test/workspaceSidebarNewTaskRouting.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/workspaceSidebarNewTaskTooltip.test.ts`: test: remove remaining source-grep tests in desktop, services, cli and ui
- `packages/ui/test/workspaceSidebarRemoteNotice.test.ts`: Migrate UI tests to en-US copy convention and add copy guard | Cut redundant React re-renders during streaming and store no-op writes | fix(ui): replace off-scale font sizes and raw colors with design tokens
- `packages/ui/test/workspaceSidebarTaskViewSwitcher.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/workspaceSidebarTerminologyI18n.test.ts`: test: remove source-grep and locale-literal tests
- `packages/ui/test/workspaceTaskPagination.test.ts`: fix(worktree): address review findings
