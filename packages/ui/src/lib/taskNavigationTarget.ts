import type { TaskNavEntry } from "@/lib/taskNavigationHistory.js";
import type { TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export type DeletedTaskRef = {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
};

/**
 * Builds the tombstone key set from the project tree's `deletedTasks` (positive deletion facts).
 * Keys use the same identity rule as every other task entity: `workspaceIdentity?.trim() || workspacePath`.
 */
export function buildDeletedTaskKeySet(
  deletedTasks: readonly DeletedTaskRef[],
): ReadonlySet<TaskEntityKey> {
  return new Set(deletedTasks.map((task) => buildTaskEntityKey(task)));
}

/**
 * A history entry is purged only when the authoritative tree positively reports the task as deleted.
 * Absence from a query cache or from the visible list is not deletion: such a task is still navigable,
 * and handleSelectTask opens it.
 */
export function isTaskNavigationTargetDeleted(params: {
  entry: TaskNavEntry;
  deletedTaskKeys: ReadonlySet<TaskEntityKey>;
}): boolean {
  return params.deletedTaskKeys.has(buildTaskEntityKey(params.entry));
}
