import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskNavEntry } from "@/lib/taskNavigationHistory.js";
import type { TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export function taskNavigationTargetExists(params: {
  entry: TaskNavEntry;
  visibleTasks: readonly Pick<ZCodeTaskMeta, "taskId">[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
}): boolean {
  if (params.visibleTasks.some((task) => task.taskId === params.entry.taskId)) {
    return true;
  }

  const cachedTask = params.taskMetaByEntityKey[buildTaskEntityKey(params.entry)];
  if (!cachedTask) {
    return false;
  }

  // After task lists moved to the task query cache, the old taskListCache may be empty.
  // Back/forward cannot rely only on old visibleTasks or valid history targets may be discarded, making the buttons appear unresponsive.
  return cachedTask.taskId === params.entry.taskId;
}
