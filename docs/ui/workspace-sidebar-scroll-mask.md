# Workspace Sidebar Scroll Mask

## Goal

When the workspace list in the workspace sidebar has a vertical scrollbar, apply top and bottom fade `mask-image` to the list scroll container itself to show that more content can be scrolled into view.

## Current Behavior

- The mask is shown only when the list content is taller than the visible area.
- The top mask shows while content remains above; it disappears at the top.
- The bottom mask shows while content remains below; it disappears at the bottom.
- The mask applies only to the workspace list scroll area and does not affect the bottom account/settings footer.

## Implementation

- Location: the list scroll container and its mask live in `packages/ui/src/WorkspaceSidebar.tsx`.
- `scrollTop / clientHeight / scrollHeight` of the scroll container decide whether it can still scroll up or down. A direction's `mask-image` is kept only while it can scroll that way and removed at the boundary.
- Both the scroll container and the content container are observed for size changes, so the mask state stays in sync after expanding a workspace, a task count change, or a window resize.
