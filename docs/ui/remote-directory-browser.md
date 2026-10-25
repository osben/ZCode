# Remote Directory Browser

The directory picker shown after a remote connection succeeds reuses `DirectoryBrowser` and browses the
remote file system through the current remote workspace session's `systemService` and `fileService`.

## Start Path

- On first entry, `DirectoryBrowser` calls `systemService.info()` of the current service set.
- The start path is the returned `homedir`: usually `/root` when the SSH user is `root`, otherwise
  `/home/<user>`.
- The path input shows and submits remote absolute paths, never local paths.

## Directory Display

- Contents are read on demand with `fileService.readdir({ path })`.
- Only entries with `type === "directory"` are listed; files never appear.
- The service layer follows directory symlinks and returns `type === "directory"` when the target is a
  directory, so the picker must show them and allow entering.
- A directory symlink only changes the list icon (`isSymbolicLink === true` shows the symlink-directory
  icon); click and select behavior stay directory behavior.
- A single click on a directory enters it and refreshes the path input and child list; the bottom
  "Open workspace in this directory" confirms the current browse path. A directory item must not merely
  toggle a selected style, or users lose the step-by-step entry into subdirectories.
- `..` is a UI-provided up-level entry, not a real `readdir` entry.
- When no directory remains after filtering, show "No subdirectories" (无子目录).

## Hidden Directories

- Default behavior is unchanged: `includeHidden` is not passed, and dot directories such as `.ssh`,
  `.config`, `.cache` are hidden to keep the remote home initial view quiet.
- The directory input area offers a "Show hidden directories" button.
- When enabled, the current path is re-read with `fileService.readdir({ path, includeHidden: true })`
  and only hidden directories are additionally shown; hidden files returned by the service are still
  filtered out by the picker.
- When disabled, the current path is re-read with default rules and hidden directories vanish again.

## Scope

Only the `DirectoryBrowser` UI display and the `fileService.readdir` parameters change. Remote
connection, remote workspace session, workspace identity, task realtime stream, desktop continuous and
web remote replayable semantics are untouched.
