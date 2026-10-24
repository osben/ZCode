# Workspace Sidebar Navigation

## Goal

- The sidebar lists all open workspaces as a two-level `workspace -> task` menu.
- New task, menu `File > New task` and `Cmd/Ctrl+N` all land on the most recently active workspace.
- Open workspace, menu `File > Open Workspace` and `Cmd/Ctrl+O` all run the root-level open-workspace action.

## State Design

- `packages/ui/src/store/tabStore.ts`
  - Stores the order of open workspaces in the window (`workspaceTabs`), used for session restore and cross-window dedup.
  - `activeWorkspacePath` is the current or most recently activated workspace.
  - Opening a workspace no longer switches to a standalone intermediate page; the menu, shortcut and sidebar entry all run the root-level open action directly.

## Interaction Constraints

- The top of the sidebar home offers "Automations" and "Plugins" shortcuts. "Plugins" sits below "Automations", uses the same puzzle icon as the settings page, and opens the settings page at the `plugins` section. Mobile `/remote` does not host Automations and keeps only the "Plugins" entry.
- The left sidebar lists all open workspaces; task lists are expanded by default.
- Each expanded workspace shows only 5 ordinary tasks at first. "Show more" adds the next 5 until all tasks are visible, then the entry is hidden. There is no "Show less".
- Pagination progress is renderer-local transient state, isolated per `workspaceKey = workspaceIdentity?.trim() || workspacePath`; loading more in one workspace never changes the visible count of another.
- Progress is cleared when a single workspace collapses, the project section collapses, everything collapses, the user leaves the workspace view, or the workspace is removed; expanding again starts at the default 5. Switching created/updated sort does not reset the visible count.
- The "Task list / 任务列表" overall title uses `text-ui-base + font-medium + text-foreground-subtle`.
- "Pinned", "Projects" and "Tasks" are same-level sidebar group titles and use `text-ui-base + font-medium + text-foreground-subtlest`; title size does not change with collapsibility or draggability.
- Clicking a workspace row acts as the trigger that toggles that workspace's task list and also makes it the active workspace.
- The "New task" button and shortcut first try to return to `activeWorkspacePath`, then enter the draft state.
- The sidebar "New task" button shows the platform shortcut hint on its right: `Cmd+N` on macOS, `Ctrl+N` on Windows / Linux.
- On desktop, `Cmd/Ctrl+O` sends the `OpenWorkspace` platform event through the native menu accelerator; on Web a root-level `keydown` fallback intercepts the browser's default open-file behavior.
- If there is no workspace, Root creates the default workspace as a fallback, so there is never a blank page or an intermediate open-workspace page.
- `SettingsPage` offers a "Back to workspace" entry when a recent active workspace exists.

## Remote Project Device Info and Actions

Projects stay in a flat list; identity, ordering and path isolation follow `workspaceIdentity`. A project row shows only a five-state icon, the project name and a width-limited device label; an offline label is replaced by a short status, and actions appear on hover/focus. Clicking the device label, or hovering it for 400ms, opens a full-row detail panel on the right: connect keeps the original directory, disconnect is a device-level action, edit uses the existing form, and manage jumps once to the device card on the settings page.

"Projects + -> Open remote project" lists devices from the device-management snapshot (including online devices with no project yet). The selected connection priority comes from the unified display model; after connecting or reusing, the user picks a directory; the last item creates a new remote connection. Session and draft headers and the input-box project menu use the same device display name, and task rows share the device label style. Full contract and acceptance: [RDUX-12 navigation contract](../remote/project-first-remote-navigation-spec.md#21a-侧栏详情与设备菜单rdux-12).

## Ordering Rules

- The "Projects / Tasks" second-level sections are reordered through a dedicated handle. Order and each section's expanded state persist in renderer-local `zcode-sidebar-purpose-section-preferences`; the default order is "Projects -> Tasks".
- The workspace list supports drag reordering; the order reuses the `workspaceTabs` subsequence in `tabStore`.
- When a workspace drag starts, only the dragged project's task list collapses temporarily and the project header is shown in a separate drag overlay; after drop or cancel the pre-drag expansion semantics are restored. The temporary collapse is renderer-local drag-derived state and is never written to `expandedWorkspacePaths` or `localStorage`.
- Sibling displacement during project reorder is computed from the fully collapsed geometry: project row `32px` plus project gap `8px`, so `40px`. Never use the full row height with the task list expanded, otherwise dragging upward first pushes the project above to its old position and then snaps back.
- Task items in the project section may be dragged into the Workbench / split view with native drag, but do not take part in in-project task ordering; the project reorder drag entry remains the project header only. The native drag preview keeps the task item's own content and reuses only the background, border and shadow of the Grouped task drag overlay.
- The workspace drag overlay keeps the background, border, shadow, text and pointer styles of the Grouped group drag overlay. Its size matches the project list button, `h-8 px-2.5 gap-2`, and preview icons are constrained with `[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0`.
- Workspace drag position is previewed against the currently visible project subsequence, but the commit must map the project id back to the global index in `workspaceTabs`, so filtered items such as the conversation workspace cannot change the drop position.
- A newly opened workspace is inserted at the top of the list so the latest project is easy to return to.
- The expanded/collapsed state is also persisted to `localStorage` as `workspacePath -> expanded`, so restoring the same workspaces keeps the last sidebar open/closed state.
- Tasks support drag reordering only within their own workspace; cross-workspace dragging is not allowed.
- Task order persists per workspace in local storage. New tasks not yet manually ordered are shown before the manual ordering history so they are not buried by the old order.

## Workspace Task Pagination Acceptance

| Case      | Setup                            | Action                          | Assertion                                                            | Status   |
| --------- | -------------------------------- | ------------------------------- | -------------------------------------------------------------------- | -------- |
| `WSTP-01` | workspace has 0-5 ordinary tasks | Expand the workspace            | All existing tasks shown, no "Show more"                             | accepted |
| `WSTP-02` | workspace has 6 ordinary tasks   | Expand, click "Show more" once  | Visible count goes 5 to 6, entry disappears                          | accepted |
| `WSTP-03` | workspace has 12 ordinary tasks  | Click "Show more" repeatedly    | Visible count goes `5 -> 10 -> 12`, entry disappears at end          | accepted |
| `WSTP-04` | workspaces A/B both exceed 5     | Click "Show more" in A only     | A grows by 5, B stays at the default 5                               | accepted |
| `WSTP-05` | workspace shows more than 5      | Collapse by any path, re-expand | Back to the default 5                                                | accepted |
| `WSDR-01` | workspaces A and B expanded      | Start dragging A                | Only A collapses temporarily; B stays expanded; overlay has no tasks | accepted |
| `WSDR-02` | workspace A expanded             | Drag A, then drop               | Order committed; A re-expands; expansion preference not rewritten    | accepted |
| `WSDR-03` | workspace A expanded             | Drag A, then cancel             | Order unchanged; A re-expands                                        | accepted |
| `WSDR-04` | workspace A was collapsed        | Drag A and finish               | A stays collapsed throughout                                         | accepted |

Timeline, pinned, archived, grouped and the Web remote-control independent task index do not reuse this pagination state; they are pruned from scope. This pagination/drag work does not change the conversation, desktop continuous or mobile replayable data flows.

## Sidebar Title Font Size Acceptance

- `Task list`, `Pinned`, `Projects` and `Tasks` all use the base font size; the overall title and group titles keep their existing color, spacing and interaction.
- `command-center-focus.test.ts` checks that the overall title and group titles equal `--ui-font-size` (size difference 0) and verifies light/dark themes and narrow screens.
- Verification order is `pnpm typecheck`, then the E2E build, then the E2E run. Do not run the first two in parallel: `tsconfig.host.json` emits unbundled JS into `out/host`, which shares the directory with the desktop bundle, and the Host may then load workspace TS directly and exit because the `.js` modules do not exist. Rebuild after type checking; do not change Host product logic to work around the polluted output.

## Task Back / Forward History (ISSUE-033)

- History is one global linear stack maintained by the pure functions in `packages/ui/src/lib/taskNavigationHistory.ts`; `zcodeSessionStoreNavigation.ts` is the only writer.
- Entries are pushed only by user-initiated entry points: selecting a task from the sidebar / search / command palette (via `setActiveTaskId`), and the Automations and plugin-marketplace main views. Back/forward replay never changes stack contents; it only moves the cursor.
- Adjacent entries with the same identity are not pushed twice (identity = full key of `workspaceIdentity` and `workspacePath`). Non-adjacent duplicates are kept because they represent a new visit.
- Selecting a new entry truncates the forward history after the cursor (browser semantics).
- Only authoritative deletion facts clear history entries. The deletion facts are owned by the project directory owner (`useProjectTree` -> `ProjectDirectoryProvider`) and come from the directory tree's `ProjectTree.deletedTasks` (`readTree({ includeDeletedTasks: true })`, i.e. `deleted=1 OR cli_deleted=1`). The owner keeps the latest deletion facts per member Host by `hostId`: a successful Host read replaces them (so restored tasks drop out); a failed or offline read keeps the previous result; they are discarded only when the Host leaves the directory membership. Replay reads them at command time through the public entry `project-sidebar/index.js` `useOptionalProjectDirectory().isTaskKnownDeleted`; the session store does not copy these facts. In embedded panes and tests without a Provider, replay never clears anything (everything counts as navigable); the production Root always mounts the Provider. The key is `workspaceIdentity?.trim() || workspacePath` + `taskId`, like other task entities.
- "Not in the task query cache and not in the current workspace's visible list" is not deletion evidence. Tasks in the sidebar project view are often in neither and remain navigable; `handleSelectTask` opens them. A Host that has never been read successfully (for example offline at cold start) has no deletion facts, so its tasks count as navigable (unknown means navigable) and there is no timeout.
- When back or forward hits an entry for a confirmed-deleted task, all entries of that task are cleared. Clearing and cursor positioning happen in one pure-function computation, and the search continues in the original direction for the next valid entry, without skipping or reordering the other entries.
- Archived tasks: the archive transition is handled by the existing owner (the archive cleanup in `useProjectTree`), which calls `removeTaskState` and thereby clears the task's history entries; this behavior is unchanged. Navigation replay itself does not clear entries because of archiving.
- At the end (no valid target) the history keeps only the entries already cleared as invalid, the cursor stays on the current entry, and no navigation happens.
- Deleting a task (`removeTaskState`) clears its entries; the cursor lands on the first retained entry after the pre-delete position (same as the old behavior).
- On in-app delete or archive, `removeTaskState` remains the owner of immediate clearing and clears entries by full identity (`workspaceIdentity?.trim() || workspacePath` + `taskId`); replay clears lazily, only when it meets a confirmed-deleted entry. Entries with the same `taskId` in different workspaces do not affect each other.

| Case         | Precondition                                                                                                           | Action                | Expected                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `NAV-033-01` | Stack `[Auto, PS, A(stale), B, C]`, cursor on PS                                                                       | Forward               | Navigate to B; A cleared; cursor on B                            |
| `NAV-033-02` | Stack `[A(stale), B]`, cursor on B                                                                                     | Back                  | A cleared; no target; cursor stays on B, no navigation           |
| `NAV-033-03` | Stack `[A, A, X, A, Y, Z]`, cursor on the 4th A                                                                        | Delete task A         | Cursor on Y (first retained entry after the pre-delete position) |
| `NAV-033-04` | Stack `[PS, A, B, C]`, A/B/C absent from the visible list and query cache but alive in the project tree (no tombstone) | Back 3 times in a row | Go to B, A, PS in turn; no history entries cleared               |
| `NAV-033-05` | Same as NAV-033-04, but project tree `deletedTasks` contains A                                                         | Back from C           | All entries of A cleared; go to B, then PS                       |
