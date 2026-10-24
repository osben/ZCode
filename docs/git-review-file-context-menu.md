# Git Review File Context Menu Spec

## Background

Git review file rows previously only expanded their diff. While reviewing a file, the common next steps are locating the real file, copying the path, or jumping to its place in the left file tree. The file tree already offers these actions; this change brings the same file actions to Git review file rows.

## User behavior

- Right-clicking a Git review file row shows a context menu.
- Menu items: reveal in system file manager, copy file path, reveal in file tree.
- Clicking the row itself keeps the existing expand/collapse diff behavior.

## Module boundaries

- `GitPaneChangeCard` only renders the file row and menu; it does not touch Electron, `window.zcode`, or file-tree state.
- `GitPane` resolves `GitPaneFileChange` into a file action target: absolute path, workspace-relative path, deleted state.
- Shared file actions live in a UI hook handling clipboard, system file manager, logging, and toasts.
- `WorkspaceShellLayout` only receives the "reveal in file tree" intent and reuses the existing `fileTreeOpenRequest` to open the left file tree.
- Platform capabilities keep going through `IPlatformService`; the UI never calls desktop preload directly.
- The "system file manager" capability is passed in explicitly as a local-desktop capability bit; the hook then adds remote-workspace / deleted checks, so plain Web or mobile Web never reaches a local file-manager path.

## Path rules

- Real file operations use `change.path`; if not absolute, join it with `workspacePath`.
- "Reveal in system file manager" opens the parent directory for file targets and the directory itself for directory targets; never hand a file path to the system default-open logic.
- Display keeps using `change.workspaceRelativePath`.
- Workspace isolation keeps `workspaceIdentity?.trim() || workspacePath`; identity is never used as a real file path.

## Platform boundaries

- macOS local desktop shows "Reveal in Finder".
- Windows local desktop shows "Reveal in File Explorer".
- Linux local desktop shows "Reveal in file manager".
- Plain Web, mobile Web remote control, and remote workspaces disable the system file manager item and keep copy-path and file-tree reveal; the check must not rely on `workspaceRemoteSessionId` alone — the local-desktop capability bit must also be true.
- Deleted files keep copy-path and file-tree reveal, with the system file manager item disabled, so we never try to open a nonexistent local file.

## Verification

- Local desktop: right-click copies the path, reveals in the file manager, and jumps to the file tree.
- Remote workspace / Web remote control: the system file manager item is disabled; copy-path and file-tree reveal work.
- Deep paths: the file tree auto-expands parent directories and scrolls to the target file.
- Run `pnpm typecheck` and `pnpm lint`.
