# Sidebar UI polish

## Contract

The project action menu shows icons for pin/unpin, customization, and GitHub navigation. Opening it stops the trigger's pointer-down from reaching the sortable sensor, so moving the pointer after opening cannot start a row drag. While this menu is open, its project row does not register sortable drag listeners or show a grab cursor; closing the menu restores dragging. The menu owns its existing open state; no new persistence or protocol fields are introduced.

The conversation pinned-message strip keeps its accessible title on the container and its existing navigation/unpin actions, while omitting the redundant leading pin icon.

## Acceptance

- Opening a project action menu suppresses row drag activation; closing it restores the existing drag binding.
- A pointer move beyond the drag activation distance after pressing the menu trigger does not reorder the project row.
- Menu actions retain their labels and behavior.
- Pinned messages retain navigation, removal, and an accessible strip label.

## Sidebar task relative time labels

- Relative time labels on sidebar task rows (for example "8m", "3h") refresh at least every minute while the window is visible, even when the task's data does not change; a single shared minute ticker (`useNowMinute` in `lib/taskListItemPresentation.ts`) owns "now" for all rows, rendered through `TaskRelativeTimeLabel`, and it pauses while the document is hidden and refreshes immediately when it becomes visible again.
- Time labels are display-only: sort order and grouping keys never read the ticker's "now", so a label refresh cannot reorder rows (session-management invariant I6).
- Acceptance: with fake timers, a row label changes from "now" to "1m" after 60 s while visible, and does not change while hidden.

## Distinct names for the two "New task" entry points

The sidebar has two task-creation entry points with different destinations:

- The top "New task" control (`taskList.newThread` in the sidebar, `sidebar.newTask` on the collapsed-sidebar overlay) starts a draft in the active workspace (the project the user is working in).
- The "Tasks" section's add button (`TID_VIRTUAL_PROJECT_NEW_TASK`, rendered as `virtual-project-new-task`) starts a draft in the app-owned conversation workspace. The composer then shows "Select project" and no Git destination chip, by design.

Both used to carry the same accessible name and tooltip ("New task"), so screen readers, keyboard users and automation that select by role and name could not tell them apart (the QA MINOR-3 symptom, RT3-C7obs, was clicking the conversation button by that name).

### Contract

- The conversation-section button uses its own message key, `workspaceSidebar.newTaskOutsideProject`, for both its `aria-label` and its tooltip title. The wording reuses the composer's existing "outside a project" phrasing (`chat.empty.workOutsideProject`).
- In every shipped locale, that label differs from both `taskList.newThread` and `sidebar.newTask`, so only the top entry point is named plain "New task".
- Behavior, test id (`TID_VIRTUAL_PROJECT_NEW_TASK`), icon, and placement are unchanged. The upstream key `workspaceSidebar.newConversation` stays in the locale tables untouched.

### Acceptance

- With each locale's real message table, the mounted sidebar's conversation button has an accessible name that differs from that locale's `taskList.newThread` and `sidebar.newTask`.
- Clicking the button still calls the conversation-task handler.

## Project menu: Open on GitHub and Manage sessions

Both entries extend the upstream project menu in `ProjectNodeContent` (context and "more" menus share one
action list). Wiring lives in `ProjectSidebarNode`, next to the existing device-settings action.

- **Open on GitHub** (`workspaceSidebar.openOnGitHub`, `virtual-project-open-on-github` test id): shown only for
  local projects whose primary root has a GitHub remote. The remote is read lazily when a project menu opens
  (never on mount: a sidebar can hold dozens of projects) through the workspace `gitService.getRepositoryRemotes`
  resolved by `useWorkspaceServices`, converted with `gitRemoteUrlToWebUrl`, and accepted only when it starts
  with `https://github.com/`. A failed lookup hides the item. The URL opens through `IPlatformService.openExternal`.
  Remote-host projects do not show it (no local git service for their primary root).
- **Manage sessions** (label `quickPick.command.manageSessions`, test id `virtual-project-manage-sessions`): sets the settings
  intent `setPendingSettingsSectionIntent("sessions", { sessionsScope })` and opens the settings tab, per
  `manage-sessions-table.md`. The scope is the project's primary root (`workspacePath`) plus, for remote-host
  projects, the remote workspace identity built from host id and root. Projects without roots hide the item.

Status dots use design tokens: the draft task row dot is `bg-success`, the unread dot in grouped task rows is
`bg-icon-blue` (no raw palette colors).

Acceptance: the menu lists both items only under the conditions above; Manage sessions passes the project scope;
Open on GitHub calls `openExternal` with the converted URL; no lookup happens before a menu opens.
