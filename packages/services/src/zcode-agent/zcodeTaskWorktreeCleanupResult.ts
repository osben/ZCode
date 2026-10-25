import type { TaskIndexRepo, TaskIndexWorktreeOwnerFact } from "#src/session/taskIndexRepo.js";
import type { ZCodeTaskWorktreeCleanupResult } from "#src/session/zcodeTaskService.js";

export function finalizeWorktreeCleanup(cleanup: ZCodeTaskWorktreeCleanupResult): void {
  cleanup.removed = [...new Set(cleanup.removed)];
  cleanup.retained = [
    ...new Map(
      cleanup.retained.map((entry) => [`${entry.targetPath}\0${entry.reason}`, entry]),
    ).values(),
  ];
  cleanup.failed = [
    ...new Map(
      cleanup.failed.map((entry) => [`${entry.targetPath}\0${entry.reason}`, entry]),
    ).values(),
  ];
  cleanup.removedCount = cleanup.removed.length;
  cleanup.retainedCount = cleanup.retained.length;
  cleanup.failedCount = cleanup.failed.length;
}

/** Clear recovery facts only after Git succeeds; a persistence failure remains a retryable outcome. */
export async function recordWorktreeRemoved(
  repo: TaskIndexRepo,
  owners: readonly TaskIndexWorktreeOwnerFact[],
  cleanup: ZCodeTaskWorktreeCleanupResult,
  targetPath: string,
): Promise<void> {
  cleanup.removed.push(targetPath);
  for (const owner of owners) {
    if (!owner.deleted) continue;
    try {
      await repo.scrubDeletedTaskContent({
        workspacePath: owner.workspacePath,
        workspaceIdentity: owner.workspaceIdentity,
        taskIds: [owner.taskId],
        clearExecutionWorktree: true,
      });
    } catch {
      cleanup.failed.push({
        targetPath,
        reason: "worktree removed but task-index cleanup state could not be saved",
      });
    }
  }
}
