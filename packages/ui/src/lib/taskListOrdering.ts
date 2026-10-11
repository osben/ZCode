import type { ZCodeTaskMeta } from "@zcode/shared";
import { isTaskListRowActive } from "@/v4/taskListRowActivity.js";

export type TaskListTimeSortBy = "created" | "updated";

interface TaskListSortableItem {
  taskId: string;
  createdAt: number;
  updatedAt: number;
}

function compareTaskListItemsByTime(
  left: TaskListSortableItem,
  right: TaskListSortableItem,
  sortBy: TaskListTimeSortBy,
): number {
  if (sortBy === "created") {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.taskId.localeCompare(left.taskId);
  }

  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.taskId.localeCompare(left.taskId);
}

/**
 * Two-tier task ordering: running tasks stay pinned at the top and sort stably by creation time; non-running tasks follow the user's time preference.
 *
 * A running original task and its fork child update updatedAt alternately. If the running layer still reads
 * updatedAt (including as a secondary sort), every streaming/tool event can swap their positions.
 * The running layer includes tasks with an active turn and those with background work (such as a dynamic workflow run):
 * the latter's turn has settled, but background events still advance activity time, so excluding them would recreate the same swapping behavior.
 */
export function compareTaskListItemsWithRunningFirst<T extends TaskListSortableItem>(
  left: T,
  right: T,
  sortBy: TaskListTimeSortBy,
  isRunning: (task: T) => boolean,
): number {
  const leftRunning = isRunning(left);
  const rightRunning = isRunning(right);
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    // Do not use updatedAt as a tie-break in the running layer; taskId is stable across events.
    return right.taskId.localeCompare(left.taskId);
  }
  return compareTaskListItemsByTime(left, right, sortBy);
}

export function compareZCodeTaskListItems(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  sortBy: TaskListTimeSortBy,
): number {
  return compareTaskListItemsWithRunningFirst(left, right, sortBy, isTaskListRowActive);
}
