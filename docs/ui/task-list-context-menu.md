# Task List Context Menu

Task list items have a context menu that carries the task-level shortcuts so not every action piles onto
hover buttons or the Header more menu.

## Current Menu Items

Pin task, Rename task, Archive task, Mark as unread, Open in Finder / File Explorer / File Manager, Copy
path, Copy log path, Go to config.

## Interaction

- `Pin task` persists to task metadata and survives refresh or restore; a pinned item shows `Unpin task`.
  Pinned tasks stay permanently in an independent `Pinned` group at the top of the list (not mixed with
  ordinary tasks) and are visible even when collapsed.
- `Rename task` uses a dialog: `Enter` submits, cancel closes.
- Rename has two equivalent entries: the task-row context menu, or a double-click on the task row (desktop mouse). Both open the same rename dialog prefilled with the current title; double-click adds no second title state.
- The first click of a double-click still opens the task at once as before; the second click does not open it again, avoiding duplicate navigation or duplicate remote connections. Inline buttons, interactive capsules, workflow run rows and the archive second-confirm state do not trigger double-click rename.
- The "By unread" view does not enable double-click rename: the first click clears unread and removes the row, so the second click has no target; that view keeps using the context menu.
- Touch devices (`hover: none`) do not enable double-click rename; single-click open and long-press menu stay.
- A read-only workspace (directory missing or inaccessible) does not open the rename dialog, with the same criterion as the context menu's disabled state.
- `Archive task` marks the task archived and hides it from the default task list. On row hover an inline
  archive entry appears; the first click enters a two-step confirm state. The confirm state is an explicit
  wait for the user's decision: the confirm button stays visible after the mouse leaves the row; clicking
  blank space outside the row or pressing `Esc` cancels it.
- Archive is offered only in the left sidebar (inline archive button, the close button of grouped rows, both context menus); the Header more-menu does not show archive. While a task is running (the same criterion as the sidebar spinner: sessions-index phase `prewarming` / `running`) these entries are disabled with the hint "Task is running; stop it before archiving" (zh-CN copy in the locale). Reason: archive only writes the task index and does not stop the agent turn; if archived while running, the agent still creates Browser tabs with that task's sessionId while the task has left the list, so no scope can show or close those tabs. The Header's task meta comes from tasks-index with no live phase, and a stale `status=running` would disable it wrongly, so the Header offers no archive.
- `Mark as unread` persists to task metadata; the blue dot survives an app restart and is cleared
  automatically when the task is opened.
- Rename persists to `tasks-index.sqlite` and updates the running task's in-memory meta; restore and
  snapshot write-back must obey [Task Title Authority](./task-title-authority.md), so a raw session
  snapshot cannot revert a manual title to an automatic one.
- pin / unread / archive also update the running task's in-memory meta, so a later session persistence does
  not write the old state back.
- `Copy path` points to the task's persisted snapshot file path.
- `Copy task path` (shared by the sidebar task menu, grouped task menu and Header more menu) shows only when
  the Host reports the snapshot file `exists`; while loading or when the file is missing the whole item is
  hidden. This is a fork divergence from upstream `0a1fc56d`, which always shows it.
- `Copy log path` points to the task's native log path; the ZCode Agent uses date-rolling structured JSONL
  logs.
- `Go to config` reuses the currently persisted editor preference; if it cannot open directly in the
  editor, it falls back to the file manager.
