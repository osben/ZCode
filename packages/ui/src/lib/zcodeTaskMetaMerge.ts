import type { ZCodeTaskMeta } from "@zcode/shared";

function hasOwnTaskMetaField<T extends keyof ZCodeTaskMeta>(task: ZCodeTaskMeta, key: T) {
  return Object.prototype.hasOwnProperty.call(task, key);
}

function isPlaceholderTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return normalizedTitle.length === 0 || normalizedTitle === "new session";
}

function resolveMergedTaskTitle(preferredTask: ZCodeTaskMeta, fallbackTask: ZCodeTaskMeta): string {
  if (fallbackTask.titleOverridden && !preferredTask.titleOverridden) {
    return fallbackTask.title;
  }
  // session/send is acknowledged immediately, so readSession after the first ACK may arrive before the background first_input title projection.
  // The snapshot may then return the agent's default placeholder "New session"; if its updatedAt is newer, the old merge logic would briefly overwrite
  // the optimistic title from the user's query. Treat only empty/default-placeholder titles as unable to replace a real title; generated titles still overwrite normally.
  if (isPlaceholderTaskTitle(preferredTask.title) && !isPlaceholderTaskTitle(fallbackTask.title)) {
    return fallbackTask.title;
  }
  return preferredTask.title;
}

export function mergeTaskWithOptimisticMeta(
  task: ZCodeTaskMeta,
  optimisticTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const shouldKeepOptimisticTask =
    optimisticTask.updatedAt > task.updatedAt ||
    (optimisticTask.updatedAt === task.updatedAt &&
      optimisticTask.title.length > task.title.length);
  const preferredTask = shouldKeepOptimisticTask ? optimisticTask : task;
  const fallbackTask = shouldKeepOptimisticTask ? task : optimisticTask;

  const unreadAt = hasOwnTaskMetaField(optimisticTask, "unreadAt")
    ? optimisticTask.unreadAt
    : (preferredTask.unreadAt ?? fallbackTask.unreadAt);

  return {
    ...preferredTask,
    changeSummary: preferredTask.changeSummary ?? fallbackTask.changeSummary,
    model: preferredTask.model ?? fallbackTask.model,
    provider: preferredTask.provider ?? fallbackTask.provider,
    // Worktree sessions may carry the fact in one candidate (sessions-index join) only; do not swallow it.
    executionWorktree: preferredTask.executionWorktree ?? fallbackTask.executionWorktree,
    title: resolveMergedTaskTitle(preferredTask, fallbackTask),
    titleOverridden:
      preferredTask.titleOverridden === true || fallbackTask.titleOverridden === true
        ? true
        : (preferredTask.titleOverridden ?? fallbackTask.titleOverridden),
    // The remote-control home page relies on task.meta.status as a fallback for “running” when it has no runtime subscription.
    // Previously, after optimistic metadata advanced updatedAt, if it had no status of its own, it overwrote the persisted status with undefined,
    // making the list incorrectly show idle. Fall back to status here so the optimistic layer does not swallow running/completed/error.
    status: preferredTask.status ?? fallbackTask.status,
    unreadAt,
  };
}

export function mergeTaskMetaCandidates(
  ...candidates: Array<ZCodeTaskMeta | null | undefined>
): ZCodeTaskMeta | undefined {
  let merged: ZCodeTaskMeta | undefined;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    merged = merged ? mergeTaskWithOptimisticMeta(candidate, merged) : candidate;
  }
  return merged;
}
