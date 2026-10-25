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
- `Archive task` marks the task archived and hides it from the default task list. On row hover an inline
  archive entry appears; the first click enters a two-step confirm state. The confirm state is an explicit
  wait for the user's decision: the confirm button stays visible after the mouse leaves the row; clicking
  blank space outside the row or pressing `Esc` cancels it.
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
