# Workspace Header Variants

## Goal

On desktop, the New Task draft and an existing Task use the same `WorkspaceHeader` component and the same
title-bar layout, so the draft state does not maintain a second lightweight header whose action entries,
window-control safe area and drag behavior would drift apart.

## State Model

```text
activeTaskId = null                       activeTaskId != null
        │                                        │
        ▼                                        ▼
WorkspaceHeader variant="draft"  ─────▶  WorkspaceHeader variant="task"
        │          first submit creates a task        │
        └──────── same component instance / same layout skeleton ──────┘
```

- `variant="draft"`: keeps the Header height, drag region, Help, Terminal, Side Pane and the platform
  caption menu; it does not show the left task title, the editor selector, workspace/branch context that
  depends on a stable task, the Task more menu, logs, rename, archive and similar actions. With the Side
  Pane collapsed the Header bottom divider is transparent; expanded, the default divider returns.
- `variant="task"`: shows the full Task title, workspace/branch context and Task actions.
- The draft's top file drag reuses the drop target controller exposed by the main Composer, shows an overlay
  only inside the Header and registers no second attachment entry.
- The Header error boundary resets only by workspace; when the draft's first submit yields an
  `activeTaskId`, the Header must not be rebuilt because the reset key changed.

## Multi-Device Boundary

- Desktop local and remote workspaces both use the variant model above and keep supporting macOS, Windows,
  Linux and both themes.
- Mobile Web remote keeps the existing side pane overlay and replayable recovery boundary; with no active
  task it renders no extra desktop title bar and creates no separate Agent runtime.

## Acceptance

- The New Task page has `WorkspaceHeader[data-workspace-header-variant="draft"]`, and the Side Pane button
  expands/collapses the existing tabs.
- The draft Header shows no task title, editor selector, Task more menu or workspace/branch context; the
  bottom divider is transparent when the Side Pane is collapsed and the default one shows when expanded.
- After the first submit enters a Task, the same Header switches to `variant="task"`, with no jump in title
  bar height or the position of the shared right-side actions.
- Unit tests cover variant pass-through and draft content trimming; desktop E2E covers the draft Header and
  Side Pane interaction.
