# Wide-Screen Web Remote Control Task List

## Background

The mobile `/remote` narrow screen already has an independent task home page, using `listWorkspaces()` returning `WebRemoteControlWorkspaceListResult` as the cross-workspace task fact source. The wide-screen `/remote` still reuses the desktop sidebar shell, but the left task list area needs to comply with the same remote control fact source; otherwise, the tasks, search, view switching, and archive entries seen by users in the wide-screen remote control would be inconsistent with each other.

## Scope

- Only affects the left task list area of the wide-screen Web remote control shell.
- The desktop sidebar continues to use the existing `WorkspaceGroupedTasksSection`, `WorkspaceTimelineTasksSection`, `WorkspaceArchivedTasksFlatSection`, `WorkspacePinnedTasksSection`, and the continuous real-time path.
- Does not change relay, desktop main, host process, task realtime, snapshot, queue, or owner command semantics.
- The wide-screen Web remote control continues to access the existing desktop host through shared-host attachment, without starting an independent runtime.

## Behavior

The wide-screen Web remote control retains the existing view, sorting, search, and archive entries within the task toolbar, but these entries must consume the same task index returned by `listWorkspaces()` in the remote control mode:

1. The `workspace` view is grouped by the workspace order returned by the desktop, only displaying unpinned tasks; pinned tasks are only displayed in the independent pinned section to avoid duplication.
2. The `timeline` view displays unpinned tasks across all visible workspaces, using a two-layer sorting consistent with the desktop: running before non-running, running sorted stably by `createdAt` in descending order, non-running sorted by the user-selected `created` or `updated` fields. The running layer membership = `displayStatus === "running"` or `hasBackgroundWork === true` (2026-09-09 note: when the session has a background workflow run, only `updatedAt` advances, the icon does not change, and without joining the running layer, it moves with progress events). The task row draws a workflow run row consistent with the desktop below the title (`WebRemoteControlTaskTarget.workflowActivity`, 2026-09-14 note): Workflow icon + mini track light + current phase name; completed run rows are collapsed by the remote control's own confirmed collection, without depending on the desktop localStorage.
3. The archive view displays archive tasks from the remote control task index. Archive tasks are still sorted by the same sorting field and retain the workspace label, avoiding falling back to the current bridge workspace.
4. Search only filters tasks and workspace labels within the current wide-screen remote control task area, without opening the desktop Command Center; when the search term is empty, the full list is restored.
5. Collapse/expand all in the `workspace` view only controls the wide-screen remote control grouping expansion state, without writing or reusing the desktop sidebar's expansion state.
6. Switching sorting, views, search terms, or archive status must not change the desktop task list behavior.
7. Hovering over normal and pinned task rows displays pin/unpin and archive entries; the interaction semantics align with the desktop sidebar: pinning directly toggles membership; archiving first enters the confirmation state, and only archives on the second click.
8. Task operations are executed through the `zcodeTaskService` resolvable by the current shared-host bridge. Local workspaces go through base services; remote workspaces are only allowed operations when remote session services have been registered, avoiding incorrectly handing the remote `workspacePath` to the local host.
9. After the operation succeeds, the wide-screen remote control local task index immediately updates according to the returned membership, waiting for the desktop renderer's subsequent task snapshot sync to converge; on failure, the original index is retained and the user is prompted.
10. Pin, unpin, archive, and unarchive are task list membership changes. The service layer must broadcast explicit membership reasons; when the desktop renderer receives them, it re-refreshes the corresponding task list; these events cannot be treated as ordinary `task_meta_changed` incremental retention of membership.
11. After the Desktop renderer synchronizes the updated Web remote task snapshot to the desktop main, the desktop main only notifies the connected Web remote to re-adopt the latest `WebRemoteControlWorkspaceListResult` through the existing app payload channel. The relay and main do not add new task business state; they only forward the task index snapshot already synchronized by the renderer.

## Data Conventions

The `pinned` field of `WebRemoteControlTaskTarget` indicates that the task belongs to the pinned section; `archived` indicates that the task belongs to the archive section. Old clients may not have the `archived` field; the default is treated as a normal task. The wide-screen remote control model filters these two flags at the UI layer without changing the protocol and realtime data flow.

The wide-screen remote control's pin/archive actions do not add relay business protocols, nor do they sink task state to the desktop main. The mobile Web still calls task services through the already-attached host/service; the desktop main continues to provide the index snapshot of `workspace-list-request` and `rpc-frame` passthrough. When the desktop renderer calls `syncWebRemoteControlTasks` due to task list membership changes, the desktop main can send a `workspace-list-updated` app payload, pushing the same `buildWorkspaceListResult()` snapshot to the Web remote control, avoiding the Web client continuing to display the old list.

## Test Requirements

- Unit tests cover sorting field switching, pin deduplication, timeline cross-workspace, archive cross-workspace, search filtering, grouping collapse, and task membership updates after operations.
- Unit tests cover `task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` triggering cross-end list refreshes, and cover the service broadcasting these explicit reasons.
- Unit tests cover the desktop main pushing `workspace-list-updated` after task snapshot membership changes, and the Web payload schema accepting the message.
- Layout tests cover wide-screen remote control task row rendering of pin and archive operation entries.
- Run `pnpm typecheck` and `pnpm lint`.
