# Workspace Layout

The current workspace main UI has a three-part structure: the left side is a fixed `WorkspaceSidebar`; the
right side has the workspace `Header` on top and the main content area below.

Additional constraints:

- The sidebar toggle entry hangs on the outermost shell of `packages/ui/src/App.tsx`, not inside
  `WorkspaceSidebar`, so after the sidebar is hidden the top left still keeps a "re-expand" entry and the
  restore action is not hidden together.
- The entry is absolutely positioned over the shell's top left, fixed `h-11` high, with width following the
  button content. macOS must leave an extra left safe area for the traffic lights, so the button does not
  overlap the window controls.
- The expanded state shows only `PanelLeftClose`; the collapsed state shows `PanelLeftOpen` and
  `MessageCirclePlus`, the latter triggering a new task directly.
- The default width and draggable minimum width of `WorkspaceSidebar` are both `264px` (256px content width
  plus an 8px safety margin); drag, keyboard Home and `aria-valuemin` must share this boundary.
- The global Pinned area shows only when there are pinned tasks or pinned tasks are loading, with
  `taskList.pinnedSection` as an independent title above the list.
- `WorkspaceSidebar` offers a file tree entry in the right action area of each workspace row, between the
  more menu and new task; clicking slides the whole task list left and slides `WorkspaceFileTree` in from the
  right. File tree details: `docs/ui/workspace-file-tree.md`.

The main content area splits into two layers: the upper layer is a two-column layout (left `Conversation`,
right `Browser`); the lower layer is a `Terminal` spanning the whole row.

Layout principles:

- `Header` belongs only to the right workspace area and no longer mixes with the left `WorkspaceSidebar`.
- When `Browser` opens it takes an independent column on the upper right and no longer competes with
  `Terminal` for bottom space.
- `Terminal` sits independently across the bottom row, with vertical drag against the upper content area.
- `PreviewPane` remains an outermost additional panel, avoiding overlap of duties with `Browser`.
