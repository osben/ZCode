# Wide-Screen Web Remote Control Task List

## Background

The mobile `/remote` narrow screen already has an independent task home page, using `listWorkspaces()`
returning `WebRemoteControlWorkspaceListResult` as the cross-workspace task fact source. The wide-screen
`/remote` still reuses the desktop sidebar shell, but its left task list area must follow the same remote
control fact source; otherwise the tasks, search, view switching and archive entries users see in wide-screen
remote control would be inconsistent with each other.

## Scope

- Affects only the left task list area of the wide-screen Web remote control shell.
- The desktop sidebar keeps using `WorkspaceGroupedTasksSection`, `WorkspaceTimelineTasksSection`,
  `WorkspaceArchivedTasksFlatSection`, `WorkspacePinnedTasksSection` and the continuous real-time path.
- Does not change relay, desktop main, host process, task realtime, snapshot, queue or owner command semantics.
- The wide-screen Web remote control keeps accessing the existing desktop host through shared-host attachment
  and starts no independent runtime.

## Behavior

The wide-screen remote control keeps the existing view, sorting, search and archive entries in the task
toolbar, but they consume the same task index returned by `listWorkspaces()` in remote control mode:

1. The `workspace` view is grouped by the workspace order returned by the desktop and shows only unpinned
   tasks; pinned tasks appear only in the independent pinned section to avoid duplication.
2. The `timeline` view shows unpinned tasks across all visible workspaces with the same two-layer sorting as
   the desktop: running before non-running; running sorted stably by `createdAt` descending; non-running
   sorted by the user-selected `created` or `updated` field. Running-layer membership =
   `displayStatus === "running"` or `hasBackgroundWork === true` (2026-09-09: when a session has a background
   workflow run only `updatedAt` advances and the icon does not change, so without joining the running layer
   the row would move with progress events). The task row draws a workflow run row below the title as on the
   desktop (`WebRemoteControlTaskTarget.workflowActivity`, 2026-09-14): Workflow icon + mini track light +
   current phase name; completed run rows are collapsed by the remote control's own confirmed collection and
   do not depend on desktop localStorage.
3. The archive view shows archived tasks of the remote control task index, sorted by the same field and
   keeping the workspace label, so it does not fall back to the current bridge workspace.
4. Search filters only tasks and workspace labels in the current wide-screen remote control task area, does
   not open the desktop Command Center, and an empty term restores the full list.
5. Collapse/expand all in the `workspace` view controls only the wide-screen remote control grouping
   expansion state and neither writes nor reuses the desktop sidebar's expansion state.
6. Switching sorting, view, search term or archive status must not change desktop task list behavior.
7. Hovering over normal and pinned task rows shows pin/unpin and archive entries aligned with the desktop
   sidebar: pinning toggles membership directly; archiving first enters a confirmation state and archives on
   the second click.
8. Task operations run through the `zcodeTaskService` resolvable by the current shared-host bridge. Local
   workspaces go through base services; remote workspaces are allowed only when remote session services are
   registered, so a remote `workspacePath` is never wrongly handed to the local host.
9. After success the wide-screen remote control local task index updates immediately by the returned
   membership and converges when the desktop renderer's later task snapshot sync arrives; on failure the
   original index is kept and the user is prompted.
10. Pin, unpin, archive and unarchive are task list membership changes. The service layer must broadcast
    explicit membership reasons; on receiving them the desktop renderer refreshes the corresponding task list;
    they must not be treated as ordinary `task_meta_changed` incremental membership retention.
11. After the Desktop renderer syncs the updated Web remote task snapshot to desktop main, desktop main only
    notifies the connected Web remote to re-adopt the latest `WebRemoteControlWorkspaceListResult` through the
    existing app payload channel. Relay and main add no task business state; they only forward the task index
    snapshot the renderer already synced.

## Data conventions

The `pinned` field of `WebRemoteControlTaskTarget` marks the pinned section; `archived` marks the archive
section. Old clients may lack `archived` and default to a normal task. The wide-screen remote control model
filters these two flags at the UI layer without changing the protocol and realtime data flow.

Pin/archive actions add no relay business protocol and do not sink task state to desktop main. Mobile Web
still calls task services through the already-attached host/service; desktop main keeps providing the index
snapshot of `workspace-list-request` and `rpc-frame` passthrough. When the desktop renderer calls
`syncWebRemoteControlTasks` because of task list membership changes, desktop main can send a
`workspace-list-updated` app payload pushing the same `buildWorkspaceListResult()` snapshot to the Web remote
control, so the Web client does not keep showing the old list.

## Tests

- Unit tests cover sorting field switching, pin dedup, timeline cross-workspace, archive cross-workspace,
  search filtering, grouping collapse and task membership updates after operations.
- Unit tests cover `task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` triggering cross-end
  list refreshes, and the service broadcasting these explicit reasons.
- Unit tests cover desktop main pushing `workspace-list-updated` after task snapshot membership changes, and
  the Web payload schema accepting the message.
- Layout tests cover wide-screen remote control task rows rendering the pin and archive operation entries.
- Run `pnpm typecheck` and `pnpm lint`.
