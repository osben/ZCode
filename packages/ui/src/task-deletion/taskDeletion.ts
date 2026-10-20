import type { IGitService, IZCodeTaskService, ZCodeTaskTreeCounts } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { sumTreeCounts } from "@/lib/taskTreeCounts.js";
import { logger } from "@/logger.js";
import type { TaskDeleteDialogRow, TaskDeleteWorktreePreview } from "./taskDeletionTypes.js";

export interface TaskDeleteTarget extends TaskDeleteDialogRow {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskDeleteServices {
  taskService: IZCodeTaskService;
  gitService: IGitService;
}

export type ResolveTaskDeleteServices = (target: TaskDeleteTarget) => TaskDeleteServices | null;

function workspaceParams(target: Pick<TaskDeleteTarget, "workspacePath" | "workspaceIdentity">) {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

function groupTargets(rows: readonly TaskDeleteTarget[]) {
  const groups = new Map<string, TaskDeleteTarget[]>();
  for (const row of rows) {
    const key = buildTaskWorkspaceKey(row.workspacePath, row.workspaceIdentity);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

export async function taskDeletionSupported(
  rows: readonly TaskDeleteTarget[],
  resolveServices: ResolveTaskDeleteServices,
): Promise<boolean> {
  try {
    const results = await Promise.all(
      groupTargets(rows).map(async (group) => {
        const services = resolveServices(group[0]!);
        if (!services?.taskService.getDeletionCapability) return false;
        const result = await services.taskService.getDeletionCapability(workspaceParams(group[0]!));
        return result.supported;
      }),
    );
    return results.length > 0 && results.every(Boolean);
  } catch (error) {
    logger.warn("[TaskDeletion] capability lookup failed", { error });
    return false;
  }
}

export async function countTaskDeletionTrees(
  rows: readonly TaskDeleteTarget[],
  resolveServices: ResolveTaskDeleteServices,
): Promise<ZCodeTaskTreeCounts | null> {
  try {
    const results = await Promise.all(
      groupTargets(rows).map(async (group) => {
        const services = resolveServices(group[0]!);
        if (!services?.taskService.countTaskTrees) return null;
        return services.taskService.countTaskTrees({
          ...workspaceParams(group[0]!),
          taskIds: group.map((row) => row.taskId),
        });
      }),
    );
    return sumTreeCounts(results);
  } catch (error) {
    logger.warn("[TaskDeletion] tree count failed", { error });
    return null;
  }
}

export async function loadTaskDeletionWorktreePreview(
  rows: readonly TaskDeleteTarget[],
  resolveServices: ResolveTaskDeleteServices,
): Promise<TaskDeleteWorktreePreview[] | null> {
  const targets = new Map<string, { row: TaskDeleteTarget; path: string; branchName?: string }>();
  for (const row of rows) {
    const path = row.executionWorktree?.path.trim();
    if (path) {
      targets.set(path, {
        row,
        path,
        ...(row.executionWorktree?.branchName
          ? { branchName: row.executionWorktree.branchName }
          : {}),
      });
    }
  }
  if (targets.size === 0) return [];

  try {
    const previews = await Promise.all(
      [...targets.values()].map(async ({ row, path, branchName }) => {
        const services = resolveServices(row);
        if (!services || row.workspaceIdentity?.trim())
          throw new Error("Worktree status unavailable");
        const [staged, unstaged] = await Promise.all([
          services.gitService.getChanges({ workspacePath: path, sourceId: "staged" }),
          services.gitService.getChanges({ workspacePath: path, sourceId: "unstaged" }),
        ]);
        const files = new Map<string, { path: string; status: string }>();
        for (const file of [...staged, ...unstaged]) {
          const status = file.isUntracked
            ? "??"
            : `${file.x && file.x !== "." ? file.x : " "}${file.y && file.y !== "." ? file.y : " "}`.trim() ||
              "M";
          files.set(`${status}:${file.workspaceRelativePath || file.path}`, {
            path: file.workspaceRelativePath || file.path,
            status,
          });
        }
        return { path, ...(branchName ? { branchName } : {}), files: [...files.values()] };
      }),
    );
    return previews;
  } catch (error) {
    logger.warn("[TaskDeletion] worktree preview failed", { error });
    return null;
  }
}

export interface TaskDeletionExecutionResult {
  tombstoned: number;
  erased: number;
  skipped: number;
  running: number;
  unsupported: number;
  failed: number;
  sessionFileFailures: number;
  filesRetained: number;
  worktreeCleanup: {
    removed: string[];
    retained: { targetPath: string; reason: string }[];
    failed: { targetPath: string; reason: string }[];
  };
}

function describeCleanupReason(reason: string, formatMessage: (id: string) => string): string {
  const key = /unavailable|inventory/.test(reason)
    ? "reasonUnavailable"
    : /content remains/.test(reason)
      ? "reasonContent"
      : /owned|ownership|branch|preparation|workspace opened|open in/.test(reason)
        ? "reasonInUse"
        : "reasonFailed";
  return formatMessage(`taskDelete.${key}`);
}

export function formatTaskDeletionResult(
  result: TaskDeletionExecutionResult,
  formatMessage: (id: string, values?: Record<string, string | number>) => string,
): string {
  return [
    formatMessage("taskDelete.result", {
      erased: String(result.erased),
      skipped: String(result.skipped),
      running: String(result.running),
      unsupported: String(result.unsupported),
      failed: String(result.failed),
    }),
    result.sessionFileFailures > 0
      ? formatMessage("taskDelete.sessionFileFailures", {
          count: String(result.sessionFileFailures),
        })
      : "",
    result.filesRetained > 0
      ? formatMessage("taskDelete.filesRetained", { count: String(result.filesRetained) })
      : "",
    result.worktreeCleanup.removed.length > 0
      ? formatMessage("taskDelete.worktreeRemoved", {
          paths: result.worktreeCleanup.removed.join(", "),
        })
      : "",
    result.worktreeCleanup.retained.length > 0
      ? formatMessage("taskDelete.worktreeRetained", {
          paths: result.worktreeCleanup.retained
            .map(
              (item) => `${item.targetPath} (${describeCleanupReason(item.reason, formatMessage)})`,
            )
            .join(", "),
        })
      : "",
    result.worktreeCleanup.failed.length > 0
      ? formatMessage("taskDelete.worktreeFailed", {
          paths: result.worktreeCleanup.failed
            .map(
              (item) => `${item.targetPath} (${describeCleanupReason(item.reason, formatMessage)})`,
            )
            .join(", "),
        })
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Tombstones through the existing task mutation lane, updates UI membership, then erases content. */
export async function permanentlyDeleteTasks(
  rows: readonly TaskDeleteTarget[],
  resolveServices: ResolveTaskDeleteServices,
  onTombstoned?: (target: TaskDeleteTarget) => void,
): Promise<TaskDeletionExecutionResult> {
  const result: TaskDeletionExecutionResult = {
    tombstoned: 0,
    erased: 0,
    skipped: 0,
    running: 0,
    unsupported: 0,
    failed: 0,
    sessionFileFailures: 0,
    filesRetained: 0,
    worktreeCleanup: { removed: [], retained: [], failed: [] },
  };
  await Promise.all(
    groupTargets(rows).map(async (group) => {
      const first = group[0]!;
      const services = resolveServices(first);
      if (!services?.taskService.getDeletionCapability) {
        result.unsupported += group.length;
        return;
      }
      try {
        const capability = await services.taskService.getDeletionCapability(workspaceParams(first));
        if (!capability.supported) {
          result.unsupported += group.length;
          return;
        }
        if (!services.taskService.countTaskTrees) {
          result.failed += group.length;
          return;
        }
        const counts = await services.taskService.countTaskTrees({
          ...workspaceParams(first),
          taskIds: group.map((row) => row.taskId),
        });
        if (!counts) {
          result.failed += group.length;
          return;
        }
        if (counts.running > 0) {
          result.running += group.length;
          return;
        }

        const tombstoned: TaskDeleteTarget[] = [];
        const archived = group.filter((row) => row.archived);
        const active = group.filter((row) => !row.archived);
        for (const row of active) {
          try {
            await services.taskService.deleteTask({
              ...workspaceParams(row),
              taskId: row.taskId,
            });
            tombstoned.push(row);
            removeTaskFromTaskCaches({ ...workspaceParams(row), taskId: row.taskId });
            onTombstoned?.(row);
            result.tombstoned += 1;
          } catch (error) {
            logger.warn("[TaskDeletion] task tombstone failed", { taskId: row.taskId, error });
            result.failed += 1;
          }
        }
        if (archived.length > 0) {
          try {
            const batch = await services.taskService.deleteArchivedTasks({
              ...workspaceParams(first),
              taskIds: archived.map((row) => row.taskId),
            });
            const deletedIds = new Set(batch.deletedTaskIds);
            const skippedIds = new Set(batch.skippedTaskIds);
            for (const row of archived) {
              if (deletedIds.has(row.taskId)) {
                tombstoned.push(row);
                removeTaskFromTaskCaches({ ...workspaceParams(row), taskId: row.taskId });
                onTombstoned?.(row);
                result.tombstoned += 1;
              } else if (skippedIds.has(row.taskId)) {
                result.skipped += 1;
              } else {
                result.failed += 1;
              }
            }
          } catch (error) {
            logger.warn("[TaskDeletion] archived task tombstone failed", {
              workspacePath: first.workspacePath,
              error,
            });
            result.failed += archived.length;
          }
        }
        if (tombstoned.length === 0) return;
        if (!services.taskService.eraseTasks) {
          result.unsupported += tombstoned.length;
          return;
        }
        try {
          const erased = await services.taskService.eraseTasks({
            ...workspaceParams(first),
            taskIds: tombstoned.map((row) => row.taskId),
          });
          if (!erased) {
            result.unsupported += tombstoned.length;
            return;
          }
          result.erased += erased.erasedTaskIds.length;
          result.skipped += erased.skippedTaskIds.length;
          result.running += erased.blockedRunningTaskIds.length;
          result.failed += erased.failedTaskIds.length;
          result.sessionFileFailures += erased.fileFailureCount;
          result.filesRetained += erased.filesRetainedCount;
          result.worktreeCleanup.removed.push(...erased.worktreeCleanup.removed);
          result.worktreeCleanup.retained.push(...erased.worktreeCleanup.retained);
          result.worktreeCleanup.failed.push(...erased.worktreeCleanup.failed);
        } catch (error) {
          logger.error("[TaskDeletion] erase failed after tombstone", {
            workspacePath: first.workspacePath,
            error,
          });
          result.failed += tombstoned.length;
        }
      } catch (error) {
        logger.warn("[TaskDeletion] pre-delete guard failed", {
          workspacePath: first.workspacePath,
          error,
        });
        result.failed += group.length;
      }
    }),
  );
  return result;
}
