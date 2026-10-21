# UI upstream sync 3.16.1: UI-2b ledger (sidebar fork re-application)

Spec: `specs/ui-sidebar-fork-reapplication.md`. Base: `claude/upstream-sync-ui` (PR #215, `0a845b0c`).
Baseline (before UI-2b edits): `tsc -b` clean; `node scripts/run-vitest.mjs run packages/ui/test` -> 1188 files passed, 3 skipped; 10983 tests passed, 21 skipped.

## Ported in this PR

- `project-sidebar/grouped/task-row.tsx`: two-step inline archive on the hover action (`handleArchiveAction`, armed state, Escape / pointer-down outside / pending-interaction reset, focus handoff for keyboard). Fork label `taskList.archive` / `common.confirm`. Source: fork `workspace-grouped-tasks/task-row.tsx` (`9c2434f7`). Fork behavior changed, so the fork test is the spec.
- `project-sidebar/grouped/task-row.tsx`: worktree marker, PR marker, incognito marker in the metadata span; `ChildSessionCountsMarker` outside the hover-suppressed span; child-session expansion (per-device localStorage) and `TaskChildSessionRows`. Fork components reused from `components/` and `workspace-grouped-tasks/task-child-sessions.tsx` (fork leaf; see Open items).
- `test/groupedTaskRowArchiveConfirm.test.ts`: retargeted to `project-sidebar/grouped/task-row.js`; wrapped in `TooltipProvider` because upstream rows rely on the ambient provider (same as upstream tests). 8/8 pass.

Verification so far: `tsc -b packages/ui` 0 errors; related tests (groupedTaskRowArchiveConfirm, groupedTaskRowTooltip, groupDragOverlay, taskGroupedView, groupedRenameFocus, groupedLegacyInteraction, workspaceGroupedTasksVirtualization, workspaceGroupedTaskPermissionTag, childSessionCountsMarker, childSessionCountsMarkerRender, incognitoTaskMarker, taskRowActionButton, buildGroupedTaskViewFromSessions, projectSidebarNavigation): 14 files, 59 tests pass.

## Already present (verified by grep, no port needed)

- Incognito marker and task hover card on project and pinned rows: shared `TaskListItem.tsx`.
- Unread: `project-sidebar/view.ts` collapsed-project unread projection; `useProjectUnreadSignals.ts` (desktop base owner); `useProjectTaskActions.unread`.
- Pin intent owner: `useProjectPinIntent.ts`; project pin (`project.pinned`) in `ProjectSidebarNode.tsx`.
- Hover card for remote identity: `RemoteIdentityHoverCard.tsx`.
- Archive two-step on Project/Pinned rows: shared `TaskListItem` path (the fork's `archive` confirm on grouped rows is now ported above).

## Ledgered (not ported in UI-2b)

Each row names the reason. Rows marked "design owner" need a decision before code.

1. Pinned workspaces (`fork_workspace_pins`, `listPinnedWorkspaceKeys`/`setWorkspacePinned`, `TID_WORKSPACE_PIN_DIVIDER`, `orderWorkspaceTabsByPinned`, `isWorkspaceDragAcrossPinnedBoundary`, toast `workspaceSidebar.pinFailed`): design owner needed. Upstream models pins as project `pinned` (Host tree). The fork workspace pin is a second persisted set. Not ported; `lib/workspacePinPreference.ts` remains and is unused by project-sidebar.
2. Drag overlay display name and colour (`workspaceDisplayStore`, `WORKSPACE_ICON_COLOR_CLASS`) in `project-sidebar/grouped/group-drag-overlay.tsx` and `WorkspaceDragOverlay.tsx`: not ported; low-medium value; needs the store read in the overlay.
3. Session-manager entry from the sidebar (`setPendingSettingsSectionIntent("sessions", { sessionsScope })`): upstream sidebar navigation has no entry; owner decision on placement.
4. Merged-session highlight (`specs/merged-session-highlight.md`): not verified in this PR.
5. Turn-navigator pin highlight: depends on `ConversationTimeline onPinChange` (ledger-b7 S6); not verified.
6. Task-index light select (`specs/task-index-light-select.md`): not verified.
7. Review tab directory grouping: not verified.
8. Themes in sidebar footer (zai themes, `specs/themes.md`): upstream footer not reviewed in this PR.
9. Message change summary tree view (`specs/message-change-summary-tree-view.md`): side pane, not the sidebar; out of UI-2b sidebar scope; owner is side pane.
10. Worktree notices and open button on sidebar rows: not verified in this PR.
11. Fork `workspace-grouped-tasks/` directory: still imported by upstream `project-sidebar/grouped/*` (`TaskRowActionButton`, `task-child-sessions`), `TaskListItem.tsx`, `TaskSidebarHoverCard`, `WorkspaceCustomizeDialog`. Ported code imports the fork leaf modules. Retiring the directory needs a move of the leaf modules into `project-sidebar/grouped/`; not done here.
12. Archived bulk-delete flow (`TaskDeleteConfirmationDialog` / `eraseTasks`, fork behavior): test `archivedTasksActionsMenu.test.ts` `it.skip` (line ~72) imports fork-only `WebRemoteControlTaskIndex`. Fork behavior changed, so port is needed; not in this PR.
13. Off-peak grouped system group (`groupedOffPeakSystemGroup.test.ts` it.skip, reads fork `WorkspaceGroupedTasksSection.tsx`): the assertion (group-header "+" routes to Automations; projection dedupe retired) needs a rewrite against `project-sidebar/grouped/`. Not in this PR.
14. Idle-time editor toolbar layout (`offPeakFigmaLayout.test.ts` it.skip): upstream rebuilt the toolbar; owner is the off-peak work. Not in this PR.
15. `/plan` shortcut (`v4SlashCommands.test.ts` two `it.skip`, row UI2-PLAN-SHORTCUT): decision row; not restored (per task: composerPlanTransition / /plan not restored).
16. SSH dialog (`sshDialogDirectorySelection.test.ts` describe.skip; `sshDialogFlow.test.ts` zh rows): owned by the remote-connection flow, not the sidebar; out of UI-2b.
17. Removed `TEMPORARY(UI-2)` test files: `webRemoteControlTaskIndexLayout` (relay unit: skipped by task instruction), `workspaceSidebarItemRenderStability`, `workspaceSidebarRemoteNotice`, `workspaceSidebarTaskViewSwitcher`, `workspacePinnedTasksSection`, `useGroupedTaskView`, `taskTimelineGroups`, `composerPlanTransition` (not restored: /plan), `chatEmptyWorktreeTaskToggle`, `automationTypographyTokens`, `webRemoteControlMobileTaskHome`. Status: NOT restored in this PR. Each needs a per-test comparison against the new components; the fork test files are at `9c2434f7`. Planned as UI-2b follow-up; no per-test verdict yet.
18. `describe.skip` `workspaceSidebarProjectPins.test.ts` and `workspaceSidebarNewTaskEntryNames.test.ts`: depend on items 1 and 3 above; stay skipped with `TEMPORARY(UI-2)` markers until those rows are decided.

## Test rule applied

- Fork changed behavior (archive label and two-step confirm, grouped markers, child counts): fork test is the spec, retargeted to the upstream row (`groupedTaskRowArchiveConfirm`).
- Fork == base elsewhere: upstream wins; no fork test restored for those rows.

## Open items

- Tooling-level checks not yet run in this PR: `pnpm lint`, `pnpm architecture:check`, `pnpm fmt:check`, `pnpm test:pre-push`, `pnpm test`, `scripts/fork-format-pending.mjs`, `scripts/check-test-copy.mjs`, and the staged-file tests. Results will be recorded here before handoff.
- The grouped row is now larger than before this PR; `.staged-file-size-exemptions` handling is pending (block `# TEMPORARY upstream 3.16.1 sync (ui 2b)`).

## Restoration audit (fork sidebar restore PR)

Restored: row PR markers (probes mounted in `WorkspaceShellLayout`), project color in the project editor (`ProjectColorField`), see `workspace-sidebar-customization.md`.

Checked against the current UI:

- Item 2 (drag overlay colour): no surface. Project rows drag in place (`SortableProjects` has no
  `DragOverlay`), so the row's tinted icon moves with it; `WorkspaceDragOverlay.tsx` has no mount and
  grouped `group-drag-overlay.tsx` renders task groups, not projects. Nothing to port.
- Item 3 (session-manager entry): still reachable unscoped from quick-pick (`openSessionManager`);
  the per-project scoped menu entry (`sessionManager.openFromProjectMenu`, 0 usages) is lost. Owner
  decision on scope semantics.
- Item 4 (merged-session highlight): superseded by task PR status (`sidebar-pr-status.md`); branch
  merge probes remain unmounted by design.
- Item 5 (turn-navigator pin): `onPinChange` is wired in `v4/SessionPane.tsx`; not exercised manually.
- Item 7 (review directory grouping): `GitPane/directoryRowModel.ts` present; not exercised manually.
- Item 10 (worktree notice): `ConversationWorktreeCreatedNotice` mounted in `SessionPane`; the
  sidebar-row open-worktree button is lost.
- Project menu "Open on GitHub" (`workspaceSidebar.openOnGitHub`, 0 usages): lost; needs a git service
  for the project's primary root on its host (`getRepositoryRemotes`). Owner decision.
- `workspaceSidebar.newTaskOutsideProject` (0 usages): the conversation-section "+" button no longer
  exists in the project sidebar (`onCreateConversationTask` is not consumed by `project-sidebar`), so
  the distinct name has no surface.
