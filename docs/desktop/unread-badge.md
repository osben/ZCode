# Desktop unread badge

## Goal

Desktop shows the unread count of ZCode tasks on the app Dock / launcher badge. The measure is the task meta
`unreadAt`, i.e. "the number of tasks that finished in the background and have not been opened yet".

## Data flow

1. The persisted unread authority of a task is `unreadAt` in the tasks-index meta. The V4 `sessions-index` does
   not carry this organizational field; the list reads it in parallel through `taskListMembershipSets` and joins
   it onto the session summary.
2. The UI's `countAllUnreadTasks` counts unread tasks from each workspace's visible task meta and de-duplicates
   by `workspaceIdentity?.trim() || workspacePath + taskId`; it falls back to the old temporary map only while
   the list has not loaded.
3. `useRootPlatformEffects` calls `IPlatformService.syncWindowUnreadCount(count)`, syncing only the current
   window's total, so the UI never knows about Electron.
4. The Desktop preload / renderer bridge sends it to main through `PlatformChannels.SyncWindowUnreadCount`.
5. Main keeps a `windowId -> unreadCount` map, recomputes the app total when a window updates or closes, then
   calls `app.setBadgeCount(totalUnread)`; whether Windows displays it is decided by the platform
   implementation, with no special-case branch in the UI.

## Constraints

- The badge is not mixed with other UI states such as failure red dots or permission requests, to avoid
  semantic drift.
- When an automation schedule / manual run receives a terminal state (`succeeded`, `failed` or `stopped`)
  matching this run's `traceId`, the host must persist the associated task's `unreadAt` through
  `setTaskUnread(..., true)`. This rule does not infer "being read" from the renderer's active session; when the
  user explicitly clicks the task, `useWorkspaceTaskNavigation` clears the persisted state and syncs the
  optimistic value of the task query cache.
- Web keeps an empty implementation, so desktop / web share one `IPlatformService` interface.
- Closing a window clears its unread record, so the badge cannot get stuck.

## Current code entry points

- `packages/ui/src/lib/unreadTaskCount.ts`
- `packages/ui/src/lib/taskListMembershipSets.ts`
- `packages/ui/src/root/useRootPlatformEffects.ts`
- `packages/desktop/src/main/desktopMainIpcPlatform.ts`
- `packages/desktop/src/main/desktopWindowLifecycle.ts`
- `packages/desktop/src/main/unreadBadge.ts`
