import { memo, useCallback, useMemo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WorkspaceSidebarItem, type SortableBindings } from "./WorkspaceSidebarItem.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type { SortableBindings };

// Vertical drag-container constraints have moved into lib (Idle-time sidebar group dragging needs to reuse them without taking on this module's dependency chain).
export { restrictVerticalDragWithinContainer } from "@/lib/restrictVerticalDragWithinContainer.js";

export const SortableWorkspaceSidebarItem = memo(function SortableWorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  activateTab,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  mobileActiveTaskKey,
  isWebRemoteControl = false,
  workspaceKey,
  onShowMoreWorkspaceTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  taskListLiveWorkflowCount?: number;
  mobileActiveTaskKey?: string | null;
  isWebRemoteControl?: boolean;
  workspaceKey: string;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // Streaming task events cause frequent parent sidebar refreshes; dnd-kit may return a new transform object even when the displacement is unchanged.
  // Derive stable props from primitive values here to preserve row-level memoization.
  const transformString = useMemo(() => {
    if (!transform) {
      return undefined;
    }

    return CSS.Transform.toString({
      ...transform,
      // Without DragOverlay, dnd-kit uses the current over node's rect to apply scaleX/scaleY to the active node.
      // Workspace rows have variable heights, so dragging over an item with a different expanded/collapsed height temporarily squashes or stretches the active item,
      // making the dragged content appear to change height. Clamp sidebar drag scaling back to 1;
      // keep only the translation and do not scale the real node to match the target height.
      scaleX: 1,
      scaleY: 1,
    });
  }, [transform?.x, transform?.y]);

  const style = useMemo<CSSProperties>(
    () => ({
      transform: transformString,
      transition,
      zIndex: isDragging ? 10 : undefined,
      // After drag start, the real workspace node temporarily collapses and its visual content is handled by
      // DragOverlay; continuing to show the real node would create duplicate project headers and interfere with drop-target detection.
      opacity: isDragging ? 0 : 1,
    }),
    [isDragging, transition, transformString],
  );
  const sortableBindings = useMemo<SortableBindings>(
    () => ({ attributes, listeners }),
    [attributes, listeners],
  );
  const handleShowMoreTasks = useCallback(() => {
    onShowMoreWorkspaceTasks(workspaceKey);
  }, [onShowMoreWorkspaceTasks, workspaceKey]);

  return (
    <WorkspaceSidebarItem
      tab={tab}
      isActiveWorkspace={isActiveWorkspace}
      isExpanded={isExpanded}
      activateTab={activateTab}
      closeTab={closeTab}
      toggleWorkspaceExpanded={toggleWorkspaceExpanded}
      onSelectTask={onSelectTask}
      onStartDraftInWorkspace={onStartDraftInWorkspace}
      taskItems={taskItems}
      taskListLoading={taskListLoading}
      taskListHasMore={taskListHasMore}
      taskListHasUnread={taskListHasUnread}
      taskListLiveWorkflowCount={taskListLiveWorkflowCount}
      mobileActiveTaskKey={mobileActiveTaskKey}
      isWebRemoteControl={isWebRemoteControl}
      onShowMoreTasks={handleShowMoreTasks}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      reconnectingRemoteWorkspaceLogsByWorkspaceKey={reconnectingRemoteWorkspaceLogsByWorkspaceKey}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      onOpenFileTree={onOpenFileTree}
      itemRef={setNodeRef}
      itemStyle={style}
      sortableBindings={sortableBindings}
      isDragging={isDragging}
    />
  );
});
SortableWorkspaceSidebarItem.displayName = "SortableWorkspaceSidebarItem";
