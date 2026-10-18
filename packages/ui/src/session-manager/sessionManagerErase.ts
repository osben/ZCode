import type { IZCodeTaskService, ZCodeTaskEraseResult, ZCodeTaskTreeCounts } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { sumTreeCounts } from "@/lib/taskTreeCounts.js";
import { logger } from "@/logger.js";
import type { SessionManagerRow } from "./sessionManagerModel.js";

type RowServiceResolver = (row: SessionManagerRow) => IZCodeTaskService | null;

function groupByWorkspace(rows: readonly SessionManagerRow[]): SessionManagerRow[][] {
  const groups = new Map<string, SessionManagerRow[]>();
  for (const row of rows) {
    groups.set(row.workspaceKey, [...(groups.get(row.workspaceKey) ?? []), row]);
  }
  return [...groups.values()];
}

function workspaceScope(row: SessionManagerRow) {
  return {
    workspacePath: row.task.workspacePath,
    ...(row.task.workspaceIdentity ? { workspaceIdentity: row.task.workspaceIdentity } : {}),
  };
}

/** Exact tree totals for the rows; null when any workspace cannot count (remote, older CLI, failure). */
export async function countRowTrees(
  rows: readonly SessionManagerRow[],
  resolveRowServices: RowServiceResolver,
): Promise<ZCodeTaskTreeCounts | null> {
  try {
    const counts = await Promise.all(
      groupByWorkspace(rows).map(async (group) => {
        const service = resolveRowServices(group[0]!);
        if (!service?.countTaskTrees) return null;
        return service.countTaskTrees({
          ...workspaceScope(group[0]!),
          taskIds: group.map((row) => row.task.taskId),
        });
      }),
    );
    return sumTreeCounts(counts);
  } catch (error) {
    logger.warn("[SessionManager] tree count failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Second step of "Delete + erase": the rows are already hidden (tombstoned), so a failure anywhere here
 * leaves them hidden. Erase runs per workspace because the host owns the running guard per process.
 */
export async function eraseHiddenRows(
  hiddenRows: readonly SessionManagerRow[],
  deps: {
    resolveRowServices: RowServiceResolver;
    reportError: (error: unknown, action: string, row: SessionManagerRow) => void;
    formatMessage: (id: string, values?: Record<string, string | number>) => string;
  },
): Promise<void> {
  let erased = 0;
  let kept = 0;
  let unsupported = 0;
  let fileFailures = 0;
  for (const group of groupByWorkspace(hiddenRows)) {
    const first = group[0]!;
    const service = deps.resolveRowServices(first);
    if (!service?.eraseTasks) {
      unsupported += group.length;
      continue;
    }
    try {
      const result: ZCodeTaskEraseResult | null = await service.eraseTasks({
        ...workspaceScope(first),
        taskIds: group.map((row) => row.task.taskId),
      });
      if (!result) {
        unsupported += group.length;
        continue;
      }
      erased += result.erasedTaskIds.length;
      fileFailures += result.fileFailureCount;
      kept +=
        result.skippedTaskIds.length +
        result.blockedRunningTaskIds.length +
        result.failedTaskIds.length;
    } catch (error) {
      deps.reportError(error, "erase", first);
      kept += group.length;
    }
  }
  if (unsupported > 0 && erased === 0 && kept === 0) {
    toast(deps.formatMessage("sessionManager.erase.unsupported"));
  } else if (kept > 0 || unsupported > 0) {
    toast(
      deps.formatMessage("sessionManager.erase.result", {
        erased: String(erased),
        kept: String(kept + unsupported),
      }),
    );
  }
  // File cleanup failures are reported separately from retained sessions: the affected tasks are in
  // `kept` (their rows are still stored) and can be retried, but the user needs to know why.
  if (fileFailures > 0) {
    toast(deps.formatMessage("sessionManager.erase.filesFailed"));
  }
}
