import type { AgentRuntimeInternal } from "../internal.js";
import { getOffPeakExecution } from "../off-peak/runtime.js";

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
  this.residencyBlockingWork.add(work);
  this.residencyBlockingWorkCount = this.residencyBlockingWork.size;
  return work.finally(() => {
    this.residencyBlockingWork.delete(work);
    this.residencyBlockingWorkCount = this.residencyBlockingWork.size;
    for (const notify of this.workChanged) notify();
  });
}

/** The session residency pool consumes only this count, so adding a sidecar no longer requires changing a guessed list in bootstrap. */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    getOffPeakExecution(this)?.lifecycle.terminal === false ||
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0 ||
    (this.memoryExtractionScheduler?.hasPendingWork() ?? false) ||
    (this.memoryRecallPrefetch !== undefined && !this.memoryRecallPrefetch.settled)
  );
}
