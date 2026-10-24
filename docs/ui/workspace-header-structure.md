# Workspace Header Structure

The `packages/ui` workspace header has a left/right split:

- Left: task name, project name, editor shortcut button, more menu.
- Right: editor shortcut button, terminal toggle button, side pane toggle button.

Design constraints:

1. The task name is the main title; the project name is secondary information.
2. Terminal and browser entries are icon-only, visually aligned with the sidebar collapse/expand button.
3. The editor shortcut button shows the icon of the last selected editor; the main button opens the
   current workspace directly, the arrow button drops down to switch and persist the choice. The file
   manager entry stays in the more menu.
4. The header has no status panel toggle; expanding/collapsing the status panel is done by the panel's
   own collapse button and mini summary row.
5. A new-task draft (`activeTaskId === null`) does not show the full Workspace header; the main input
   keeps the top attention, and only the lightweight desktop title bar keeps a help entry and a Terminal
   toggle at the top right, until the first send creates a stable task and restores the header, workspace
   context and task menu.
6. The draft-state Terminal entry reuses the session-state button, shortcut hint, selected state and
   toggle behavior; on macOS/ordinary desktop it sits next to the help entry, on Windows/Linux next to the
   custom-drawn merged menu. Mobile Web remote control adds no such desktop title bar entry.
7. The side pane toggle button is icon-only and shows no Git `+added -removed` summary; the Git summary
   and commit / push entries live in the Git Tools of the Chat status panel.
8. The more menu centralizes copy of file manager, path, task and trace IDs to help troubleshooting.
9. The "Open provider config" item is plain text and reuses the external app currently selected at the
   top right; it keeps no editor state of its own.
10. Remote window behavior is not covered here (local desktop window only).

Current menu items:

- macOS: Open in Finder
- Windows: Open in File Explorer
- Other platforms: Open in File Manager
- Copy path
- Copy task ID
- Copy trace ID
- Copy session ID
- Copy log path
- Open provider config
