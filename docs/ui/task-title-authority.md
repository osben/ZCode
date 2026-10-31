# Task Title Authority

Task title can come from several places during a session lifecycle. Renderer code must treat them as ordered candidates instead of letting the newest snapshot string always win.

## Title priority

1. User-renamed title with `titleOverridden=true`.
2. Agent-generated title from the session/title update pipeline.
3. First user query title used as the initial optimistic title.
4. The agent default placeholder `New session`.

## Renderer restore rule

- CLI owns persisted titles and title source; `tasks-index.sqlite` contains their read-only Host projection.
- The active header reads the existing workspace-scoped `ZCodeTaskService.getTaskMeta` and refreshes on Host metadata events. It does not depend on a sidebar/query-cache row or call `readSession` to obtain a title. Historical and archived sessions can have metadata before their CLI runtime is active.
- `readSession` / `resumeSession` returns a raw agent snapshot. Its projected task meta is only a runtime candidate and can be missing app-side `titleOverridden`.
- Restore and remaining task cache sync paths must merge raw snapshot meta with indexed/query-cache meta before writing renderer caches. The active header uses Host metadata directly; existing optimistic metadata is used only before the indexed record arrives.
- A raw snapshot title must not overwrite a title whose existing meta has `titleOverridden=true`.
- `New session` must not overwrite a non-placeholder title, even when the snapshot has a newer `updatedAt`.
- Generated titles may replace the first query title when there is no user override.
- While the active task's Host metadata is pending, the header leaves its title empty. An ordinary task with no title also stays empty; the renderer must not insert the localized `taskList.newThread` action label as a task title. Keep the existing untitled-fork label once fork metadata is known. Preserve the header layout and render the authoritative title when it arrives, without retaining another task's title or adding a timer/cache.

## Ordering time is CLI time

- `updated_at` and `cli_updated_at` are CLI activity time. Rename, title echoes, pin, archive, and unread never change them, so a renamed task keeps its sidebar position.
- The only writer of CLI time is `applyCliFacts`. Host-side patches may carry `updatedAt` only as a copy of the CLI summary's `lastActivityAt` (terminal status), never a Host wall-clock value.
- Manual rename changes only `title` and `titleOverridden`.

## Title recency

- A title carries `titleUpdatedAt` (ms). Its CLI source is the session row's `time_title_updated`, written on every title change. When that column is null (rows that predate it), the CLI reports the session's `time_created`, the earliest time the CLI observed the title.
- `titleUpdatedAt` is optional and additive everywhere it appears: the sessions-index summary and reconcile result, the task meta schema (`zcodeTaskMetaSchema`), and the renderer optimistic overlay.
- Renderer title selection: the title with the larger `titleUpdatedAt` wins. A candidate without the field is treated as older than one with it. Only when both candidates lack the field does the existing length tie-break apply (on an `updatedAt` tie). Equal present values keep the preferred candidate.
- The `titleOverridden` guard and the placeholder guard (`New session`) run before recency, so a generated or placeholder title cannot win on a larger timestamp alone.
- `titleUpdatedAt` never changes ordering. It does not choose the candidate that supplies `updatedAt`, `status`, `model`, or unread state; those keep the `updatedAt`-based preference (I6). It only selects which title, and which `titleUpdatedAt`, the merged meta carries.
- The renderer overlay sets `titleUpdatedAt = Date.now()` on an optimistic manual rename only. The rename RPC sends `{ taskId, title }`; the UI clock value is never sent to or persisted by the Host. On remote workspaces the overlay uses the UI clock and the CLI uses its own clock, so the overlay is a local tie-breaker until the CLI value arrives.

Owner and event order for a manual rename:

```text
UI rename        -> optimistic overlay titleUpdatedAt = UI clock (renderer only)
Host renameSession -> RPC {taskId, title}, no timestamp
CLI renameSession  -> time_title_updated = CLI clock
CLI reconcile/summary -> titleUpdatedAt = time_title_updated
Host task-facts mirror -> applyCliFacts (CLI facts only)
Renderer merge     -> larger titleUpdatedAt supplies the title
```

## Compatibility

- Workspace-scoped title lookup uses `workspaceIdentity?.trim() || workspacePath`, matching remote workspace isolation. The active read also belongs to its scoped service/attachment and task ID; late responses cannot overwrite a newer target or request.
- The rule applies to desktop `desktop-continuous` restore and web remote `web-remote-replayable` restore. Replayable recovery can use snapshots to refill runtime fields, but it must not bypass the same title authority merge.
