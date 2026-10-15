# Remote Task List Cache

## Background

The global pinned and timeline views need to simultaneously display tasks from local and remote workspaces. After a remote workspace connects, the active services in the current window may point to remote services; if global lists directly reuse the current `useServices()`, the local list would be affected by remote service context, causing an empty local timeline or cache written to the wrong scope.

## Current Chain

- Local task lists are read through `useGlobalTaskList`, which internally uses `useBaseWorkspaceServices()` and only accepts local workspace scopes returned by `useLocalWorkspaceScopes()`.
- Remote pinned uses `remotePinnedTaskStore`, remote timeline uses `remoteTimelineTaskStore`, both generating workspace keys by `workspaceIdentity?.trim() || workspacePath`.
- After remote workspace connection or reconnection succeeds, the root layer prefetches the first screen data for pinned and timeline separately.
- When the timeline view clicks "show more", the read limits for local and remote timeline lists increase in steps of 10, e.g., 10, 20, 30; the full amount is not read at once.
- Task operations such as pin / unpin / archive / rename / unread synchronously maintain both the remote pinned and timeline stores to avoid both global lists retaining stale memberships.

## Constraints

- Remote workspace task queries must pass `workspaceIdentity`; isolation cannot rely on `workspacePath` alone.
- The UI layer does not directly call the repo; all task reads/writes continue through the corresponding workspace's `zcodeTaskService`.
- Remote supplementary read failures only log warnings and store errors; they do not block workspace restoration.
