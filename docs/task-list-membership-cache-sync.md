# Task List Membership Cache Sync

## Background

After archiving, unarchiving, pinning, unpinning and deleting a task, the sidebar or remote-control
task list refreshed as a whole. These operations broadcast `workspace_task_list_changed`, but the UI had
no unified local membership-change handling chain and could only invalidate the query cache and request
the list again on receiving the event.

## Goals

- On the desktop `desktop-continuous` main path, archive / unarchive / pin / unpin / delete of a task
  does not trigger a whole-list refresh.
- When mobile remote control `web-remote-replayable` receives a shared-host push, it keeps syncing list
  membership from broadcast events without bypassing the replayable task-snapshot recovery boundary.
- Caches such as search results, whose membership cannot be judged precisely from task meta alone, may
  be marked stale but must not clear the visible list.
- tasks-index metadata not carried by sessions-index (currently `unreadAt`, historical terminal state,
  manual title and `cronAutomationId`) must be back-filled through the unified join, so switching the
  list data source does not lose the unread dot, status, title or the scheduled-task clock icon.

## Approach

- When the service deletes a task it broadcasts an explicit `task_deleted` reason, so the UI does not
  misjudge a delete as an ordinary `task_meta_changed`.
- When the UI receives `task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` carrying
  `taskMeta`, it infers the old membership from the list holding the task in the current query cache and
  then moves it to the target list with the existing `applyTaskQueryCacheMutation`.
- On `task_deleted` the UI removes the task from all query caches by `workspace + taskId` and also
  cleans the workspace task list cache / optimistic meta.
- `workspace_task_list_changed` is handled by one event-level coordinator shared by the global list and
  the workspace rows; a membership / delete broadcast runs the query cache mutation only once and later
  subscribers reuse the first refresh decision, so an already-handled delete event is not misjudged as a
  hidden-item delete.
- Ordinary meta / status broadcasts do not take part in coordinator dedupe: such writes are idempotent,
  and applying twice is safer than swallowing consecutive title, error-detail or summary updates within
  2 seconds.
- A delete event that hits the current visible query cache triggers no whole-list refresh; a hidden/paged
  item that misses the visible cache cannot have its membership inferred from `taskId`, so a refresh
  fallback is kept to correct `total` / `hasMore`.
- The refresh fallback is kept only when the event lacks the necessary task information or the deleted
  item misses the visible cache.
- `task_meta_changed` bumps the membership join cache generation; after an existing session first gets a
  `cronAutomationId`, the workspace, grouped, timeline and pinned/archived lists must all see that
  identity in the same refresh round.
- tasks-index `deleted=1` is a persisted negative membership. The membership read must explicitly return
  the set of deleted task ids, and all lists derived from sessions-index exclude them uniformly before
  the kind decision; "not appearing in archivedIds" must not be used to infer that a task is still an
  ordinary member.
- Besides removing the visible query cache at once, `task_deleted` must also bump the membership join
  cache generation. So even if a later live sessions-index upsert, App/CLI cold start or mobile
  replayable recovery sees the still-existing CLI session again, the task matching the tombstone is not revived.

## Delete tombstone boundary rulings

| Boundary | Ruling | Pruning reason |
| --- | --- | --- |
| Data ownership | The CLI session store keeps owning session content; tasks-index `deleted` owns task-list invisibility | Deleting an archived task does not mean physically erasing session storage, avoiding a wider data-destruction scope |
| List surface | regular, pinned, archived, timeline, workspace and grouped all exclude deleted | `deleted` is a negative guard before every list kind, with no per-kind duplicate implementation |
| Archive contrast | `archived=1, deleted=0` still shows only in the archived list | Prevents the fix from hiding normal archives |
| session type | interactive, fork and workflow parent share the same deleted guard; side chat/subagent/workflow child are still excluded by the task-type guard | Task type decides whether it can be a task, deleted decides whether an existing task is still visible; the two dimensions are orthogonal |
| client/delivery | desktop continuous and mobile replayable converge to the same final membership | Delivery only changes how facts arrive and creates no second deleted state |
| workspace | Reads and events keep using `workspaceIdentity?.trim() || workspacePath` | A remote workspace with the same path must not cross-contaminate tombstones |

Confirmation trail: the user reported "conversations deleted after archiving all came back after
restart" and confirmed a direct change. The chosen approach keeps CLI session content and adds a deleted
membership field; no physical deletion is performed.

## Verification points

- Local desktop archive/pin/delete must not re-fetch the workspace row or the global list as a whole.
- After a membership change initiated from the remote-control side, the desktop list syncs incrementally through events.
- After deleting an archived task, the archived list removes the target at once and does not restore it to the ordinary list.
- After an App/CLI restart or mobile replayable recovery, a deleted task, even if still in the CLI
  session store, must not appear in any task list; an ordinary archived task in the same scope stays in the archived list.
- When tasks-index has persisted `cronAutomationId` but the sessions-index summary lacks that field, each
  list should still show the clock icon on the left of the time.
