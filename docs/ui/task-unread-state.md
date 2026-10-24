# Task Unread State

## Current Constraints

- The single source of truth for task unread is the tasks-index membership `unreadAt`.
- The UI blue dot, Dock badge and the read-clear after selecting a task all work only around `unreadAt`.
- Task query rows consume `unreadAt` through the membership join; the old `taskUnreadByTaskId`,
  `taskListCache` and `optimisticTaskListByTaskId` are no longer a basis for sidebar decisions.
- `lastActivityAt` only drives Updated sorting; it does not take part in deriving or clearing unread.

## Key Chains

### Manual Mark as Unread

- Entry: task context menu, Header more menu. Action: `zcodeTaskService.setTaskUnread(..., true)`.
- The renderer applies only an `{ unreadAt }` field overlay to the query row; after success it reconciles
  with tasks-index membership, and must not overwrite session activity/status with the whole returned task
  meta.

### Passive Mark as Unread

- Entry: a real-time completion signal from the Host that explicitly carries `background_terminal`;
  ordinary status, history reads and replay create no unread.
- Action: the desktop base's single directory writer judges the viewing state, then writes tasks-index via
  the original mutation route; after persistence succeeds the tree refreshes, and no UI-only unread is
  created first.
- After the v4 sessions-index refactor, background run state is no longer held by the old renderer monitor;
  the host `taskIndexSyncer` only converges phase terminal states into `task_status_changed` and does not
  judge whether some renderer is viewing the task.
- The viewing state accepts the desktop full navigation address, or the same task actually shown in the
  foreground by a connected Web. Home, background, draft, covered chat and disconnect do not count; it
  cannot rely on activeTaskId or the last navigation position alone.
- Main's transient `mobileTaskView` is pushed per event after verification of connection generation,
  sequence number and bridge identity; wide and narrow screens share the report, and Web does not become a
  second automatic writer. `mobileViewState` is kept for navigation recovery.
- For the same task, the completion write and a new viewing read/CAS are serialized inside the single
  writer: an in-flight write uses its own returned marker; once the write finished, the marker is read
  exactly from the owner and then CAS'd. A slow read cannot clear a new completion after the user left, and
  a repeated valid viewing state does not erase a manual unread. Detailed timing and owner-generation
  contract: [task list refresh semantics](../task-list-refresh-semantics.md).
- `task_status_changed` itself still does not trigger a membership re-fetch; only the `task_meta_changed`
  emitted by the following `setTaskUnread` drives the task-index membership join to re-fetch `unreadAt`.
- Leave catch-up and auto-clear for foreground completion: if the user is viewing when the completion
  signal arrives (desktop full navigation address or a valid Web foreground), unread is not written at once
  and only that "foreground completion" is recorded; on window blur, minimize or page hide, unread is
  written, so taskbar bubble, tray red dot and blue dot light up after the user leaves (covering "watch
  the task finish, then minimize and leave"). When the user returns (refocus / visible again) and the task
  is still in front, it auto-clears by the exact marker returned from the catch-up write, so the blue dot
  never sticks on the open task forcing the user to click away and back; if the user looked at another task
  meanwhile, the unread stays as a reminder to handle on return. Never catch up while focused; opening the
  task after catch-up clears per the existing read contract. Known boundary: if the same task is reopened
  and left again before the catch-up, it is still written on leaving; an in-flight catch-up before closing
  the whole app is best effort and not guaranteed to persist. Implementation: `useProjectUnreadSignals`.

### Clearing on View

- Desktop entry: `useWorkspaceTaskNavigation`. Action: activate the target tab first, then resolve the exact
  service instance by the active tab's `remoteSessionId`.
- Read `unreadAt` from the current task query row; if present, first apply an `{ unreadAt: undefined }`
  field overlay, then call `zcodeTaskService.setTaskUnread(..., false)`. On success reconcile with
  tasks-index membership and remove the overlay; on failure remove the overlay, re-fetch membership and let
  the blue dot return.
- Desktop scheduled-task execution sessions reuse the same read contract: while the user stays on the
  Automations route, the scheduler's background terminal state marks the execution session carrying
  `cronAutomationId` unread; an automation that explicitly picked "不在项目中工作" (Work outside a project)
  must put the execution session in the "Tasks" section of the canonical conversation workspace. Clicking
  the blue dot or task row must read `unreadAt` from the clicked query row and clear by the exact
  `workspaceKey + taskId`, not depend on the current active session nor skip because of cron identity.
- This flow must preserve sessions-index `lastActivityAt`; opening a task or clearing unread must not jump
  a historical task to the top.
- Mobile Web remote entry: the `WebRemoteControlTaskTarget.unreadAt` clicked on the task home is this
  user-visible snapshot. If present, call
  `zcodeTaskService.setTaskUnread(..., false, expectedUnreadAt=task.unreadAt)` through the current bridge
  for the same workspace, or through the target bridge once established for a cross-workspace entry; it
  must not depend on the phone Root's query cache hydration.
- Mobile read uses compare-and-clear: it clears only if the tasks-index current `unreadAt` still equals
  `expectedUnreadAt`; if the task got a new terminal unread after the click, a late old clear must be a
  no-op returning the current meta. The comparison and the write must be in the same repository atomic
  boundary, not check-then-write in Web/UI.
- `unreadAt` also serves as the CAS marker of this unread; each unread write on the same task must get a
  strictly increasing value generated by the repository inside the SQLite write transaction. If system time
  does not advance or goes back, use the previous value plus one; callers must not use `Date.now()` as the
  sole version. Clearing `unreadAt` changes only unread membership and must not reset the repository's
  persisted last allocated marker.
- A failed mobile read write does not block opening the task; on returning home the tasks-index
  authoritative snapshot is adopted again. The desktop `useWorkspaceTaskNavigation` query-cache overlay and
  the `desktop-continuous` chain are unchanged.

## UI Read Basis

- Task list blue dot: the joined `membership.unreadAt` of the task query row.
- Dock badge: `countAllUnreadTasks()`.

Both entries consume only tasks-index `unreadAt`; the aggregate helper may be reused during migration, but
the old `taskUnreadByTaskId` must not return as a business fact.
