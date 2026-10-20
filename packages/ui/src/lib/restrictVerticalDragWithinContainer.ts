import type { Modifier } from "@dnd-kit/core";

/* Vertical-list drag constraints: lock horizontal displacement and clamp the dragged row to its container (activeNode.parentElement)
   rectangle. Keep this in a standalone lib instead of inlining it in SortableWorkspaceSidebar: group-internal dragging in the Idle-time sidebar
   (spec off-peak) needs the same constraint, while SortableWorkspaceSidebar carries the entire
   WorkspaceSidebarItem dependency chain and is not suitable for direct import by display components, so this was extracted into a standalone lib. */
export const restrictVerticalDragWithinContainer: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  const clampedY = Math.min(Math.max(transform.y, minY), maxY);

  return {
    ...transform,
    x: 0,
    y: clampedY,
  };
};
