# Task List SQLite Storage and Cache

> Current state: this document describes the current boundary of the tasks-index SQLite and the sidebar
> list cache; conversation body state is still provided by the V4 projection. Task pin and archive are no
> longer written into task meta (an early `pinneds.json` / `archiveds.json` scheme was replaced by
> `tasks-index.sqlite` as the index source of truth).

## Persistence Rules

- Pin / unpin: the task snapshot file stays `{taskId}.json`; update the task's `pinned` state in
  `~/.zcode/v2/tasks-index.sqlite`.
- Archive: the snapshot file stays `{taskId}.json`; update the task's `archived` state in the sqlite; if it
  was pinned, the sqlite `pinned` state is cleared at the same time.

## Read Rules

- The global pin list comes from `listTaskList({ kind: "pinned", workspaceScopes })`, the global timeline
  list from `listTaskList({ kind: "timeline", workspaceScopes })`, the global archived list from
  `listTaskList({ kind: "archived", workspaceScopes })`, and workspace task lists from
  `listWorkspaceTaskLists({ workspaceScopes })`. All queries go through `tasks-index.sqlite`.
- Fixed sqlite query semantics: `pinned`: `pinned = 1 AND archived = 0`; `archived`: `archived = 1`;
  `timeline / workspace`: `pinned = 0 AND archived = 0`.
- Pin state no longer relies on old local task scanning; Header / Sidebar both come from the sqlite list
  queries.
- The task snapshot path is always the `{taskId}.json` returned by `getTaskSessionFilePath(workspacePath,
  taskId)`. Startup migration renames historical `_pinned.json` / `_archived.json` back to `{taskId}.json`.

## Frontend Cache Rules

- The Sidebar `pinned` section, when a workspace is added or switched, renders no blocking "fetching tasks"
  placeholder: cached tasks show directly and refresh in the background; when a workspace scope is added,
  existing scopes' tasks are kept; when a scope is removed, only its tasks are filtered out; a global query
  key switch must not publish an empty intermediate frame; only if there were no displayable tasks does the
  whole section stay hidden until the query result appears.
- The hover action area of a pinned task row offers a file tree entry that opens the file tree of the
  workspace owning that task. The entry does not modify SQLite pin membership; a remote task must match the
  connected tab with the same `workspaceIdentity` and carry its `remoteSessionId`, and must not cross to a
  local workspace by the same `workspacePath`.
- The query cache key consists of: list kind (`pinned / archived / timeline / workspace`), sort
  (`created / updated`), search term, current visible count (e.g. 5 / 10 / 15 for workspace tasks), and the
  set of `workspaceKey`s taking part in the query.
- `show more`: a workspace task list shows 5 on first screen and each click raises only the current
  workspace's visible limit by 5. While the cache of the new limit is not ready, the previous snapshot
  stays shown, rows are not cleared and no blocking loading appears. When all tasks are visible the entry
  hides; after a workspace collapses, paging progress returns to 5 and existing caches may be reused.
  `show more` of a workspace task updates only the current `workspaceKey`'s limit and does not re-query all
  opened workspaces.
- Frontend updates after task actions: `rename / read / unread` patch the current task's cache metadata
  directly without invalidating the whole sidebar; `pin / unpin / archive / unarchive` first patch the
  affected queries locally, then background-refetch only the necessary collapsed queries. Background
  refetch only covers cases where a collapsed list with hidden data may have changed boundaries, so the
  whole sidebar does not refresh.

## Related Implementation

- Persistence: `packages/services/src/session/taskIndexRepo.ts`
- Service interface: `packages/services/src/session/zcodeTaskService.ts`
- UI global list: `packages/ui/src/hooks/useGlobalTaskList.ts`
- UI workspace grouped list: `packages/ui/src/hooks/useWorkspaceTaskLists.ts`
- Frontend query cache: `packages/ui/src/store/taskQueryCacheStore.ts`
- Query key / descriptor: `packages/ui/src/lib/taskQueryCache.ts`
- Sidebar pinned section: `packages/ui/src/WorkspacePinnedTasksSection.tsx`
- Sidebar timeline section: `packages/ui/src/WorkspaceTimelineTasksSection.tsx`
- Sidebar archived section: `packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`
- Workspace grouped task section: `packages/ui/src/WorkspaceSidebarItem.tsx`
- Header more menu: `packages/ui/src/WorkspaceHeaderSections.tsx`
