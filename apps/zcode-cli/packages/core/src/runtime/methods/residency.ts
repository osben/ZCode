import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Register runtime-owned work that outlives the current synchronous call stack.
 *
 * The session residency pool previously observed only active turns and the task registry; detached Promises such as title generation, MCP startup,
 * and ledger writes were outside both, so a runtime could be closed as idle while they were still accessing it.
 * Increment the count in the same synchronous segment that starts the Promise and release it only in finally.
 */
export function trackResidencyBlockingWork<T>(
  this: AgentRuntimeInternal,
  work: Promise<T>,
): Promise<T> {
  this.residencyBlockingWorkCount += 1;
  return work.finally(() => {
    this.residencyBlockingWorkCount = Math.max(0, this.residencyBlockingWorkCount - 1);
  });
}

/** The session residency pool consumes only this count, so adding a sidecar no longer requires changing a guessed list in bootstrap. */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0 ||
    (this.memoryExtractionScheduler?.hasPendingWork() ?? false)
  );
}
