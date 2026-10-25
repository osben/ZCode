# Task Search

The sidebar offers a "Search" entry below "New task", with the shortcut `Cmd/Ctrl+K`. It opens the
unified Command Center. With an empty query it shows recent changes to the current task, recent tasks
and group commands; once a keyword is typed it matches commands, task body text and files against the
active tasks and files of the currently open workspaces.

Search data is still obtained through `zcodeTaskService.listTaskList` of each workspace scope: a local
workspace goes through this window's shared Local Host and queries are isolated by workspaceKey; a
remote workspace queries the Remote Host that owns the corresponding remote session. A workspace scope
does not mean a separate Host process. The UI does not read session JSON directly, so the desktop / web
remote service boundary is not bypassed.

To support body search, the task sqlite index gains a `searchable_text` column. Saving a task syncs the
message body; old sessions are back-filled from the session snapshot in schema migration 3. The body
index keeps at most 200000 characters, so a long session cannot grow `tasks-index.sqlite` without bound.
