import type { ZCodeTaskMeta } from "@zcode/shared";

function hasOwnTaskMetaField<T extends keyof ZCodeTaskMeta>(task: ZCodeTaskMeta, key: T) {
  return Object.prototype.hasOwnProperty.call(task, key);
}

function isPlaceholderTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return normalizedTitle.length === 0 || normalizedTitle === "new session";
}

// Title recency (docs/ui/task-title-authority.md "Title recency"): a present titleUpdatedAt is newer than an absent one; two present values compare by magnitude.
// titleUpdatedAt never selects the preferred candidate, so status/model/unread keep the updatedAt-based choice.
function isTitleNewer(candidate: ZCodeTaskMeta, other: ZCodeTaskMeta): boolean {
  const candidateAt = candidate.titleUpdatedAt;
  if (candidateAt === undefined) {
    return false;
  }
  return other.titleUpdatedAt === undefined || candidateAt > other.titleUpdatedAt;
}

interface MergedTaskTitle {
  title: string;
  titleUpdatedAt: number | undefined;
}

function pickTitleCandidate(candidate: ZCodeTaskMeta): MergedTaskTitle {
  return { title: candidate.title, titleUpdatedAt: candidate.titleUpdatedAt };
}

function resolveMergedTaskTitle(
  preferredTask: ZCodeTaskMeta,
  fallbackTask: ZCodeTaskMeta,
): MergedTaskTitle {
  if (fallbackTask.titleOverridden && !preferredTask.titleOverridden) {
    return pickTitleCandidate(fallbackTask);
  }
  // session/send is acknowledged immediately, so readSession after the first ACK may arrive before the background first_input title projection.
  // The snapshot may then return the agent's default placeholder "New session"; if its updatedAt is newer, the old merge logic would briefly overwrite
  // the optimistic title from the user's query. Treat only empty/default-placeholder titles as unable to replace a real title; generated titles still overwrite normally.
  if (isPlaceholderTaskTitle(preferredTask.title) && !isPlaceholderTaskTitle(fallbackTask.title)) {
    return pickTitleCandidate(fallbackTask);
  }
  // Recency may pick the fallback title only when it does not drop a manual title for a non-manual one, and never lets a placeholder replace a real title.
  const fallbackCanReplace =
    (!preferredTask.titleOverridden || fallbackTask.titleOverridden === true) &&
    !(isPlaceholderTaskTitle(fallbackTask.title) && !isPlaceholderTaskTitle(preferredTask.title));
  if (fallbackCanReplace && isTitleNewer(fallbackTask, preferredTask)) {
    return pickTitleCandidate(fallbackTask);
  }
  return pickTitleCandidate(preferredTask);
}

export function mergeTaskWithOptimisticMeta(
  task: ZCodeTaskMeta,
  optimisticTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  // Length is a tie-break only when neither side carries title recency; otherwise a newer titleUpdatedAt decides the updatedAt tie.
  const optimisticWinsTie =
    optimisticTask.titleUpdatedAt !== undefined || task.titleUpdatedAt !== undefined
      ? isTitleNewer(optimisticTask, task)
      : optimisticTask.title.length > task.title.length;
  const shouldKeepOptimisticTask =
    optimisticTask.updatedAt > task.updatedAt ||
    (optimisticTask.updatedAt === task.updatedAt && optimisticWinsTie);
  const preferredTask = shouldKeepOptimisticTask ? optimisticTask : task;
  const fallbackTask = shouldKeepOptimisticTask ? task : optimisticTask;
  const mergedTitle = resolveMergedTaskTitle(preferredTask, fallbackTask);

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
    // The title and its recency come from the same candidate; the spread above would otherwise carry preferredTask's titleUpdatedAt with a fallback title.
    title: mergedTitle.title,
    titleUpdatedAt: mergedTitle.titleUpdatedAt,
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

/**
 * Renderer-only optimistic stamp for a manual rename. The rename RPC sends only {taskId, title}; this value stays in the overlay and is never sent to the Host.
 * Stamping with the renderer clock makes the local rename win the title over an older Host echo (docs/ui/task-title-authority.md "Title recency").
 */
export function withOptimisticTitleRecency(
  task: ZCodeTaskMeta,
  now: number = Date.now(),
): ZCodeTaskMeta {
  return { ...task, titleUpdatedAt: now };
}
