import type { WorkspaceTabState } from "@/store/tabStore.js";

/**
 * Stable partition of the manual tab order for rendering: pinned workspaces first, then the rest.
 * Pinned membership is passed as tab ids (derived at the call site from the persisted workspace-key
 * pin set), because tab ids are not stable across restarts while workspace keys are.
 */
export function orderWorkspaceTabsByPinned(
  tabs: readonly WorkspaceTabState[],
  pinnedTabIds: ReadonlySet<string>,
): WorkspaceTabState[] {
  return [...tabs].sort(
    (left, right) => Number(pinnedTabIds.has(right.id)) - Number(pinnedTabIds.has(left.id)),
  );
}

/**
 * Chrome pinned-tabs rule: a drag may reorder only within one block. A pinned project dropped
 * onto an unpinned one (or the reverse) crosses the boundary and must be ignored; drag never
 * changes pin state implicitly.
 */
export function isWorkspaceDragAcrossPinnedBoundary(
  pinnedTabIds: ReadonlySet<string>,
  activeId: string,
  overId: string,
): boolean {
  return pinnedTabIds.has(activeId) !== pinnedTabIds.has(overId);
}
