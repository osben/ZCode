# Command Center Cmd+K Initial State

## Goal

The Command Center opened with `Cmd/Ctrl+K` serves both as a workspace shortcut entry and as an entry to the current task context. On default open it first shows the current task's recent changes, recent tasks and command groups split by meaning; once a search term is typed the existing mixed commands / tasks / files search is reused.

## Default content

With an empty search and scope `All`, it shows in this order:

1. `Recent changes`
   - Data source is the already-loaded assistant messages of the current active task.
   - Same source as the per-turn `summary changes` in the chat area: file-change summaries are parsed from the `raw` / `input` / `output` / `display` structures of assistant tool calls.
   - Does not read the sqlite `summary_*` fields or `ZCodeTaskMeta.changeSummary`, and has no fallback from `perTurnFileChangesByTaskId` / `perTurnSummariesByTaskId`.
   - Shows only files the current task recently modified, never the Git unstaged/staged changes of the whole workspace.
   - Shows at most 3 by default.
   - Each row shows a file icon, the workspace-relative path and `+added -removed`.
   - The group is hidden when the current task has no change summary.

2. `Recent tasks`
   - Data source is the already-loaded task list of the current workspace.
   - Shows at most 3 recently updated tasks by default.
   - Clicking switches to that task.

3. Command groups
   - The former single `Quick actions` is split into `Suggested`, `Chat`, `Navigation`, `Panels`, `Configure`, `App`.
   - The group model stays stable; a group with no default command in this round shows no empty title, but must not be removed from the registry / i18n / section order.
   - `Suggested` shows only `New task`, `Open workspace`, `Settings`.
   - `Chat` and `Navigation` have no default command items for now; later conversation and navigation actions return to their category.
   - `Panels` shows `Toggle sidebar`, `Toggle terminal`, `Toggle preview`, `Add terminal tab`, `Add browser tab`, `Add review tab`.
   - `Configure` shows `Settings`, `Switch theme to light/dark`, `Skills`, `MCP Servers`.
   - `App` shows `Feedback`, `Community`, `Product docs`, `Connect/Disconnect`.

## Scope tabs

Scope tabs `All`, `Actions`, `Tasks`, `Files` are always shown below the search box. The tabs are a scope filter, not just a pre-search prefix shortcut, so even with no input, switching a tab must show the default content of that scope.

- `All`
  - With an empty search it shows the full default home: `Recent changes`, `Recent tasks`, command groups, where context groups show at most a 3-item preview.
  - After a search term is typed it mixes search of actions, tasks and files; task and file results collapse at the home-preview rhythm.
- `Actions`
  - With an empty search it shows only the command groups: `Suggested`, `Chat`, `Navigation`, `Panels`, `Configure`, `App`.
  - After a search term it searches actions only.
- `Tasks`
  - With an empty search it shows only recent tasks, not the 3-item preview limit of the `All` home.
  - After a search term it searches tasks only and shows the task result list directly, without the 3-item preview limit of `All`.
- `Files`
  - With an empty search it shows only the files modified by the current active task, i.e. `Recent changes`, not the 3-item preview limit of the `All` home.
  - After a search term it searches workspace files only and shows the file result list directly, without the 3-item preview limit of `All`.
  - Workspace files reuse the same Host-side `listWorkspaceFiles` index and [default filter](../superpowers/specs/2026-08-07-workspace-file-search-default-filter-design.md) as the Composer `@` file candidates; the UI keeps no separate blacklist and this phase offers no custom rule configuration entry.

Visually the search box and scope tabs belong to the same header block, which uses compact 8px horizontal padding with no divider between them; only a faint separator is used below the tabs before the result list. The search box itself is a bordered capsule input shell following the input background, border, hover and focus tokens. The tabs are small capsule buttons, kept compact and horizontally scrollable, so long copy on mobile does not squeeze the search box.

## Search state

After a search term is typed the existing Command Center search semantics are kept:

- Without a prefix it searches commands, tasks and files together.
- `>` restricts to commands.
- `#` restricts to tasks.
- `@` restricts to files.
- Results are still grouped by command, task and file, and search history is kept.

## Task row selection identity

- cmdk is the sole holder of the panel selection state; both the React `key` and the cmdk `value` must use a stable row identity.
- A recent task's `value` is `recent-task:${workspaceKey}:${taskId}`; a task search result uses `task-result:${row.key}`, where `row.key` already contains the workspace identity, the task ID and, when there is a body snippet, the snippet index.
- Title, workspace display name and search snippet are used only for display and the existing search matching, never as selection identity, because same-named tasks in one workspace would get identical text, and cmdk judging selection by `value` would highlight several rows at once and disturb keyboard positioning.
- After a mouse move or keyboard up/down, only the target row may be `aria-selected=true`; Enter and click keep opening the matching task/body snippet through that row's original callback.
- A local task uses the path fallback and a remote task uses `workspaceIdentity?.trim() || workspacePath`; different remote workspaces with the same path, same title or even the same task ID must not share a selection value.
- This is a row-identity fix inside shared UI; it adds no persistence or migration and does not change the task data and event boundaries of desktop continuous, mobile replayable, Host/CLI.

```text
mouse move / keyboard up-down -> cmdk keeps a unique row value -> only the target row is selected -> original task open callback
```

### Regression cases

| ID           | Setup and action                                                                             | Assertion                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CC-SELECT-01 | Recent tasks has three same-named tasks in one workspace; hover, up/down keys, Enter in turn | Always only the target row is selected, and the target task opens                                                                         |
| CC-SELECT-02 | Search returns different tasks with the same title, workspace display name and body snippet  | Each row can be selected independently; different remote identities and different snippets of one task can also be selected independently |

Component regression: `packages/ui/test/commandCenterSelection.test.ts`. Desktop interaction candidate: `packages/desktop/test/e2e/ui-shell/manual-review/pending/command-center-selection.test.ts`, verifying the real indexed list and cmdk mouse/keyboard interaction; no model request is sent.

## Visual details

- When the search box is focused only the outer capsule's focus border and background are used, and the inner input element shows no extra rectangular outline; light/dark themes and narrow screens are consistent. Globally, outlines are no longer forced per dialog, remote control or settings navigation, and the command center keeps no matching `!important` local override. `ui-shell/manual-review/pending/command-center-focus.test.ts` (CC-FOCUS-01) independently checks that the inner outline is zero and the outer border is kept, without depending on task list data.
- List items of Command Center and QuickPick use `rounded-xl`, making keyboard-selected and hover states softer.
- The underlying `CommandItem` keeps the `rounded-lg` default; Cmd+K/QuickPick override it to a larger radius through a shared item class so other command lists are unaffected.
- Command icons prefer the Lucide icon of the matching existing entry; the same action must not use icons of different meaning in Header, Sidebar, Side pane and Cmd+K.

## Compatibility boundary

- The UI must be compatible with desktop and Web.
- The main shortcut follows platform rules: Command on macOS, Ctrl on Windows/Linux.
- Recent tasks of local and remote workspaces still go through the existing task list service boundary; the UI does not read session JSON directly.
- `workspaceIdentity?.trim() || workspacePath` remains the isolation key of tasks and history.
