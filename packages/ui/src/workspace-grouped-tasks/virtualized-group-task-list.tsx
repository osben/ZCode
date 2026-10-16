import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskItem } from "@/workspace-grouped-tasks/task-item.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";

const GROUPED_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TASK_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TASK_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTasks(taskCount: number): boolean {
  return taskCount > GROUPED_TASK_VIRTUALIZATION_THRESHOLD;
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // At the start of a group expansion animation, the ancestor container may not yet have content to make scrollHeight > clientHeight.
      // Returning null then briefly leaves react-virtual without a scrollElement, so the content area has height but no rows render.
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

export function VirtualizedGroupedTaskList({
  tasks,
  groupId,
  groups,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  activeDragTaskKey,
  tooltipsDisabled,
}: {
  tasks: ZCodeTaskMeta[];
  groupId: string;
  groups: TaskGroupMenuItem[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
    options?: { readOnly?: boolean },
  ) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  activeDragTaskKey?: string | null;
  tooltipsDisabled?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTasks(tasks.length);
  const getItemKey = useCallback(
    (index: number) => taskKey(tasks[index] ?? { workspacePath: "", taskId: String(index) }),
    [tasks],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [groupId, shouldVirtualize, tasks.length, updateScrollMargin]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => GROUPED_TASK_ROW_ESTIMATE_PX,
    getItemKey,
    overscan: GROUPED_TASK_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // The virtual list inside a group shares the left-side scroll container with the top-level list.
    // When a group row remounts while scrolled midway, react-virtual defaults to initialOffset=0
    // and calls scrollTo(0) in _willUpdate. Read the actual scrollTop from the current DOM
    // to avoid caching 0 too early in the first layout effect before scrollElement state has been written back.
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const measureElement = rowVirtualizer.measureElement;

  const renderTask = useCallback(
    (task: ZCodeTaskMeta) => (
      <GroupedTaskItem
        key={taskKey(task)}
        task={task}
        groupId={groupId}
        groups={groups}
        remoteSessionId={getTaskRemoteSessionId(task)}
        workspaceLabel={getTaskWorkspaceLabel(task)}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        mobileActiveTaskKey={mobileActiveTaskKey}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={taskKey(task)}
        dragging={activeDragTaskKey === taskKey(task)}
        tooltipsDisabled={tooltipsDisabled}
      />
    ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupId,
      groups,
      mobileActiveTaskKey,
      onArchiveTask,
      onCloseTask,
      onMarkTaskAsUnread,
      onMoveTaskToGroup,
      onMoveTaskToTop,
      onOpenFileTree,
      onSelectTask,
      onStartRenameTask,
      activeDragTaskKey,
      tooltipsDisabled,
    ],
  );

  const renderedVirtualTasks = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const task = tasks[virtualRow.index];
        if (!task) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            // Row heights are no longer fixed: a session with a workflow-run row is 48px instead of 28px. The estimate is only an initial value;
            // measureElement must read the actual height or adjacent rows will overlap.
            ref={measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderTask(task)}
          </div>
        );
      }),
    [measureElement, renderTask, scrollMargin, tasks, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{tasks.map((task) => renderTask(task))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* Bugfix: large groups previously rendered every task row at once; 2,000 tasks created tens of thousands of DOM nodes and increased
          JavaScript/layout CPU usage. Mount only rows in the scroll window while keeping clicks and menus available. */}
      {/* Bugfix: virtual rows inside a group mount and unmount during scrolling. Browser scroll anchoring can mistake
          these absolutely positioned rows for stable anchors and reset scrollTop to the top when measurements are written back.
          Disable anchor selection for the virtual-list subtree so it does not conflict with react-virtual positioning. */}
      {renderedVirtualTasks}
    </div>
  );
}

export {
  GROUPED_TASK_ROW_ESTIMATE_PX,
  GROUPED_TASK_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTasks,
};
