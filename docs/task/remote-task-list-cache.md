# Remote Task List Cache

## Background

The global pinned and timeline views show tasks from local and remote workspaces together. After a remote workspace connects, the window's active services may point to remote services; reusing the current `useServices()` for global lists would let remote context empty the local timeline or write cache to the wrong scope.

## Current Chain

1. Local task lists are read through `useGlobalTaskList`, which uses `useBaseWorkspaceServices()` and accepts only the local workspace scopes returned by `useLocalWorkspaceScopes()`.
2. Remote pinned uses `remotePinnedTaskStore` and remote timeline uses `remoteTimelineTaskStore`; both key workspaces by `workspaceIdentity?.trim() || workspacePath`.
3. After a remote workspace connects or reconnects, the root layer prefetches the first screen for pinned and timeline separately.
4. "Show more" in the timeline view raises the read limit of local and remote timeline lists in steps of 10 (10, 20, 30); the full set is never read at once.
5. Task operations pin / unpin / archive / rename / unread maintain both the remote pinned and timeline stores synchronously so neither global list keeps stale membership.

## Constraints

- Remote workspace task queries must pass `workspaceIdentity`; isolation cannot rely on `workspacePath` alone.
- The UI layer never calls the repo directly; all task reads/writes go through the corresponding workspace's `zcodeTaskService`.
- Remote supplementary read failures only log warnings and store errors; they do not block workspace restoration.
