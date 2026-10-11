import type { ZCodeProvider, ZCodeTaskRuntimeStatus } from "@zcode/shared";

function isBusyTaskRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

function buildTaskProviderByTaskId(
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
): Record<string, ZCodeProvider | undefined> {
  const providerByTaskId: Record<string, ZCodeProvider | undefined> = {};

  for (const task of taskListCache ?? []) {
    if (!task.provider) {
      continue;
    }
    providerByTaskId[task.taskId] = task.provider;
  }

  for (const [taskId, meta] of Object.entries(optimisticTaskMetaByTaskId)) {
    if (!meta.provider) {
      continue;
    }
    providerByTaskId[taskId] = meta.provider;
  }

  return providerByTaskId;
}

export function hasBusyTaskInWorkspaceProvider(
  selectedProvider: ZCodeProvider,
  taskRuntimeByTaskId: Record<string, { status: ZCodeTaskRuntimeStatus; provider?: ZCodeProvider }>,
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
  activeTaskId?: string | null,
): boolean {
  const providerByTaskId = buildTaskProviderByTaskId(optimisticTaskMetaByTaskId, taskListCache);
  const normalizedActiveTaskId = activeTaskId?.trim() ?? "";

  for (const [taskId, runtimeState] of Object.entries(taskRuntimeByTaskId)) {
    if (!isBusyTaskRuntimeStatus(runtimeState.status)) {
      continue;
    }

    // The runtime map also contains non-optimistic tasks, so do not assign a missing provider to a fixed provider;
    // otherwise an unrelated task may be marked busy and the reload/sync menu may remain disabled.
    // The busy lock protects provider processes within the workspace. Prefer the runtime provider closest to current execution state,
    // then fall back to taskList/cache; if it is still unknown, apply the fallback lock only to the current activeTask.
    const taskProvider = runtimeState.provider ?? providerByTaskId[taskId];
    if (!taskProvider) {
      // During the first message send / runtime switch, the task provider may not yet be synced into taskList.
      // Treating it as “not busy” would allow changing models across suppliers while loading.
      // Apply a fallback busy lock to the current activeTask to prevent an accidental supplier switch during loading.
      if (normalizedActiveTaskId.length > 0 && normalizedActiveTaskId === taskId) {
        return true;
      }
      continue;
    }

    if (taskProvider === selectedProvider) {
      return true;
    }
  }

  return false;
}
