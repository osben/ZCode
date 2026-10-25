# Side Pane Terminal Tabs

## Background

A Workspace now has a bottom Terminal panel and right side pane tabs. Users want to create a Terminal tab
directly from the side pane `+` menu, so the terminal can sit side by side with Browser, Review, Code Viewer
and other content in the right tab container.

## Behavior

- The side pane gets a new `terminal` tab type.
- Each click on Terminal in the `+` menu creates a new side pane Terminal tab; no singleton reuse.
- The outer side pane Terminal tab is named after the current workspace name: first `workspace-name`, second
  `workspace-name 2`, third `workspace-name 3`. The workspace name is the last directory level of the current
  workspace path; when it cannot be resolved it falls back to `Terminal`.
- Each side pane Terminal tab maps to an independent terminal instance, with no nested terminal tabs inside
  and no second-level new-terminal button.
- A side pane Terminal tab reuses the underlying `TerminalSession` capability, so it still supports the xterm
  theme, link opening and copy/paste behavior.
- The bottom Terminal panel keeps its original behavior and shares no terminal session state with side pane
  Terminal tabs.
- Closing a side pane Terminal tab unmounts the `TerminalSession` inside it and releases the matching terminal
  process; switching to another side pane tab or collapsing the side pane keeps it mounted and does not
  interrupt a running command.

## Compatibility Boundary

- Workspace naming keeps using the current workspace path; remote/local service isolation is still carried by
  the current window's services and the `workspaceIdentity` context.
- A remote workspace keeps creating terminals through the current window's services and `workspacePath`,
  adding no separate Agent runtime, local host, or SSH/WSL/Docker session.
- The feature only changes where the UI is hosted; it does not modify the ZCode session/task realtime message
  flow nor involve the `desktop-continuous` and `web-remote-replayable` transport boundaries. Mobile Web remote
  reuses the existing side pane overlay render path; the Terminal tab does not change replayable recovery
  semantics.

## Implementation Entry Points

- `packages/ui/src/lib/workspaceSidePane.ts`: adds the `TerminalSidePaneTab` state type and creation function.
- `packages/ui/src/hooks/useAppPanels.ts`: adds the handler that opens a Terminal side pane tab and generates a
  unique title from the workspace name.
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`: wires the single-instance Terminal into the `+` menu
  and the tab content area.
- `packages/ui/src/SidePaneTerminalPane.tsx`: hosts a single `TerminalSession` without embedded tabs.
- `packages/ui/src/app-shell/SidePaneTabTrigger.tsx` / `SidePaneTabOverview.tsx`: add title, icon and search
  labels.
