# Global task search: settle the query before querying

## Problem

`TaskSearchDialog` passed the trimmed input straight into `useGlobalTaskList` on every keystroke. Each distinct query is a host RPC that runs `LOWER(searchable_text) LIKE ?` over the whole tasks index (up to 200 KB of body text per row), twice (COUNT and SELECT). With thousands of tasks, every keystroke stalled the host. `useDeferredValue` alone does not help here: it defers rendering but the query still reaches the hook for each intermediate value.

## Owner

- `packages/ui/src/TaskSearchDialog.tsx` owns the settled query (`settledQuery`). It is the only component that decides which query reaches `useGlobalTaskList`.
- `packages/ui/src/command-center/CommandCenterDialog.tsx` owns its own settled query (`settledSearchQuery`), with the same rule. It is the only other component that decides which query reaches the search `useGlobalTaskList`.
- `useGlobalTaskList` (`packages/ui/src/hooks/useGlobalTaskList.ts`) owns request ordering. It keeps a `requestSerialRef` so only the latest request writes results, and it keys `hasCurrentResult` by query. It is not changed by this spec.
- The input value and the match highlight stay on the live query and are not part of this contract.

## Product rules

1. The input field updates on every keystroke. Nothing about typing is delayed.
2. A query reaches the task list only after it has stopped changing for `TASK_SEARCH_QUERY_SETTLE_MS` (200 ms). Intermediate keystrokes never reach the RPC.
3. Clearing the input empties the result list at once. The previous settled query must not linger.
4. Results for a stale query must not overwrite results for a newer one. This is guaranteed by `useGlobalTaskList`'s request serial, and must not regress.
5. The index refresh that runs when a query is typed (`taskList.refresh`) runs once per settled query, not once per keystroke.
6. Expanded snippet groups reset when the settled query changes.
7. The list mode (search or recents wording, and whether snippets show) follows the typed query, not the settled one. Only the task-list RPC waits for the settle delay, so the list does not flip to recents while a query is settling.

## Acceptance scenarios

1. Typing `r`, `re`, `rev`, `revi`, `revie`, `review` in quick succession (each step under 200 ms apart) shows each value in the input immediately. The task list is never called with any intermediate value. After 200 ms of quiet it is called with `review` exactly once, and the refresh runs once.
2. Clearing the input after a settled query calls the task list with the empty query without waiting for the settle delay.
3. A query that is still changing when the dialog is closed does not leave a pending settle that updates a closed dialog. Closing the dialog clears the input, which clears the settled query.
4. Typing `review` from an empty input shows the search empty-state wording (`taskSearch.noResults`) at once, before the 200 ms settle, and the task list is still called with the empty query until the settle completes.

## Search scope: every local project of the Host (ISSUE-020)

Task search covers the local tasks of every project listed in the sidebar. It does not cover only the open workspace tabs: a task in a project whose tab is closed is visible in the sidebar, so it must be found.

### Scope owner and rule

- The scope is derived in `packages/ui/src/project-sidebar/taskSearchScope.ts` (in the project-sidebar module, which the architecture policy manages) from the sidebar's own project tree (`ProjectTree`, read through `ProjectDirectoryProvider`). It is the same local set that `useProjectTree` observes, so a task visible in the sidebar is searchable.
- The scope contains, deduplicated by workspace key (`workspaceIdentity?.trim() || workspacePath`):
  1. the root of every local project (`projects[].hostId === "local"`, `roots[].rootPath`), deleted projects included because their tasks stay visible in the timeline;
  2. the workspace key of every local task in `tree.tasks` (a task whose cwd is no longer a root of its project, and the task area, are covered this way);
  3. the open workspace tabs, as before.
- Remote sources keep today's rule and are not widened. A remote workspace is searched only when its tab is open, and the command center already drops remote tabs.
- Until the project tree is available (no directory provider, or still loading), the scope is the open tabs. This is the same as before the fix.
- The repo query stays `workspace_key IN (scope)`. Deleted rows and reservation placeholders stay excluded (`taskIndexRepo.queryTaskList`). The repo does not decide which workspaces are local: the caller passes the scope.

### Result label

- A result shows the name of its project. The project is the one the row's `project_id` names; the join is made by task identity against `tree.tasks[].projectId`, so one directory that belongs to several projects does not pick the wrong one by path.
- A task in the task area (`projectId` null), or a task not present in the loaded tree, falls back to the open-tab label, then to the workspace path.
- A deleted project keeps its name in results, because its tasks remain visible in the timeline.

### Stability

- The scope is keyed by content. A new tree object with the same scope does not change the search key, so it does not re-query.

### Acceptance scenarios (scope)

1. A task in a project whose tab is closed is returned for a matching query. Its row shows the project name.
2. A task whose cwd is outside the project roots, but which the sidebar lists under the project, is returned.
3. A deleted task, and a reservation placeholder, are not returned.
4. Restoring the open-tab-only scope makes scenario 1 fail (mutation check).

### Settle and cost

- The 200 ms settle applies to both `TaskSearchDialog` and `CommandCenterDialog`, the surface that ships.
- The command center settles the resolved query: the text after an optional `>`, `#` or `@` scope prefix. Commands, files, highlights and the recents list stay on the live input.
- Until the query settles, no workspace is queried: the search scope is empty for that query, so a keystroke never fans out one `listTaskList` per local workspace. Only the query that has settled is sent.
- The empty-state wording shows during the first settle, because there is no earlier result to keep. A later keystroke keeps the previous settled results until its own query settles.
- Clearing the input settles at once and cancels a pending settle.

## Opening a result from another project (ISSUE-069)

The widened scope returns tasks of local projects whose workspace tab is closed. Picking such a result must open it, the same way the sidebar opens it.

### Owner and path

- The tab store (`packages/ui/src/store/tabStore.ts`) owns which workspace is active. `useWorkspaceTaskNavigation.handleSelectTask` only activates an existing tab (`activateTabByPath`); when no tab matches it changes nothing visible, so on its own it cannot open a closed project.
- `ensureTaskNavigationWorkspace` (`packages/ui/src/app-shell/taskNavigationWorkspace.ts`) is the one rule for "make the target workspace visible": activate the exact tab, else open a local tab by path, else reject a remote identity that has no attachment in this window. The sidebar and the automation run history already use it.
- The command center's task pick (search results and recent tasks) goes through `selectTaskInNavigationWorkspace`, which runs that rule and then `handleSelectTask`. No second tab-opening path is added.

### Event order

```text
palette pick → ensureTaskNavigationWorkspace
                 ├─ exact tab exists → activate it
                 ├─ local, no tab    → addTab(workspacePath) (activates it)
                 └─ remote, no tab   → reject: toast, nothing selected
             → handleSelectTask(workspacePath, taskId, workspaceIdentity) → setActiveTaskId
→ closeDialog
```

- The web remote-control shell keeps its own switcher and does not open local tabs; there the pick goes straight to `handleSelectTask`, as before.
- Identity rule: the tab match uses `workspaceIdentity` when the result carries one. A remote result is never matched or reopened by path alone.

### Acceptance scenarios (open)

1. From workspace A, picking a search result of local project B whose tab is closed opens a tab for B, makes it active, and selects the task in B.
2. Picking a result whose workspace tab is open activates that tab and selects the task; no extra tab is added.
3. Picking a remote result whose attachment is missing in this window adds no tab, selects nothing, and shows `automations.runs.openSessionFailed`.
4. Removing the ensure step (calling `handleSelectTask` directly) makes scenario 1 fail: the active workspace stays A (mutation check).
