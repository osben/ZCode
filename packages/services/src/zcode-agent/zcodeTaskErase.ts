import { zcodeTaskEraseResultSchema } from "@zcode/shared";
// Permanent erase of hidden tasks (specs/session-deletion-cascade.md §3-§4).
// The task index owns tombstones and durable worktree facts; the CLI owns conversation content.
// Permanent Delete preserves the existing tombstone lane, then erases content and eligible worktrees.
import type { ZCodeProvider } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { TaskIndexRepo, TaskIndexWorktreeOwnerFact } from "#src/session/taskIndexRepo.js";
import type {
  ZCodeTaskEraseResult,
  ZCodeTaskTreeCounts,
  ZCodeTaskWorktreeCleanupResult,
} from "#src/session/zcodeTaskService.js";
import type { IZCodeAgentService, ZCodeAgentRuntimePolicy } from "./zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "./zcodeTaskIndexSyncer.js";
import { createTaskWorktreeCleanup } from "./zcodeTaskWorktreeCleanup.js";
import type { IGitService } from "#src/git/git.js";

const logger = createServiceLogger("zcode-task-erase");

/** Roots per protocol call; a call blocked by a running session is retried root by root. */
const ERASE_CHUNK_SIZE = 50;
/** Matches the protocol's per-request id cap with headroom. */
const COUNT_CHUNK_SIZE = 1000;

interface WorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskEraseOperations {
  countTaskTrees(
    params: WorkspaceScope & { taskIds: string[] },
  ): Promise<ZCodeTaskTreeCounts | null>;
  eraseTasks(params: WorkspaceScope & { taskIds: string[] }): Promise<ZCodeTaskEraseResult | null>;
  getDeletionCapability(params: WorkspaceScope): Promise<{ supported: boolean }>;
  countHiddenTaskContent(): Promise<{ sessions: number; worktrees: number } | null>;
  eraseHiddenTaskContent(): Promise<ZCodeTaskEraseResult | null>;
}

type SessionEraseOutcome = NonNullable<
  Awaited<ReturnType<NonNullable<IZCodeAgentService["eraseSessionTrees"]>>>
>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function emptyResult(): ZCodeTaskEraseResult {
  return {
    erasedTaskIds: [],
    skippedTaskIds: [],
    blockedRunningTaskIds: [],
    failedTaskIds: [],
    fileFailureCount: 0,
    filesRetainedCount: 0,
    worktreeCleanup: emptyWorktreeCleanup(),
  };
}

function emptyWorktreeCleanup(): ZCodeTaskWorktreeCleanupResult {
  return {
    removed: [],
    retained: [],
    failed: [],
    removedCount: 0,
    retainedCount: 0,
    failedCount: 0,
  };
}

function isRemote(params: WorkspaceScope): boolean {
  return Boolean(params.workspaceIdentity?.trim());
}

export function createTaskEraseOperations(options: {
  agent: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
  provider: ZCodeProvider;
  gitService?: Pick<
    IGitService,
    "getRepositorySummary" | "resolveWorktreePathIdentities" | "removeWorktree"
  >;
  taskIndexSyncer?: Pick<ZCodeTaskIndexSyncer, "listWorktreePreparations">;
  getOpenWorkspacePaths?: () => Promise<string[]>;
}): TaskEraseOperations {
  const { agent, taskIndexRepo, provider } = options;

  async function listLocalTaskMetas(): Promise<TaskIndexWorktreeOwnerFact[]> {
    return await taskIndexRepo.listLocalWorktreeOwnerFacts({ provider });
  }

  async function getDeletionCapability(params: WorkspaceScope) {
    if (isRemote(params) || !agent.eraseSessionTrees || !agent.countSessionTrees) {
      return { supported: false };
    }
    try {
      const probe = await agent.countSessionTrees({
        workspacePath: params.workspacePath,
        sessionIds: ["__zcode_deletion_capability_probe__"],
        runtimePolicy: "start-if-needed",
      });
      return { supported: probe !== null };
    } catch {
      return { supported: false };
    }
  }

  /** Chunked count; null when the CLI does not support it. Throws when the agent cannot be reached. */
  async function countIds(
    scope: WorkspaceScope,
    taskIds: string[],
    runtimePolicy: ZCodeAgentRuntimePolicy,
  ): Promise<ZCodeTaskTreeCounts | null> {
    const total: ZCodeTaskTreeCounts = {
      total: 0,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 0,
    };
    for (const ids of chunk(taskIds, COUNT_CHUNK_SIZE)) {
      const counts = await agent.countSessionTrees!({
        workspacePath: scope.workspacePath,
        sessionIds: ids,
        runtimePolicy,
      });
      if (!counts) return null;
      for (const key of Object.keys(total) as Array<keyof ZCodeTaskTreeCounts>) {
        total[key] += counts[key];
      }
    }
    return total;
  }

  async function countTaskTrees(params: WorkspaceScope & { taskIds: string[] }) {
    if (isRemote(params) || !agent.countSessionTrees || params.taskIds.length === 0) return null;
    return countIds(params, params.taskIds, "start-if-needed");
  }

  const worktreeCleanup = createTaskWorktreeCleanup({
    agent,
    taskIndexRepo,
    gitService: options.gitService,
    taskIndexSyncer: options.taskIndexSyncer,
    getOpenWorkspacePaths: options.getOpenWorkspacePaths,
    listLocalTaskMetas,
    countTaskTrees: (scope, taskIds, runtimePolicy) => countIds(scope, taskIds, runtimePolicy),
  });

  /**
   * Erase one chunk of roots for a workspace; falls back to root-by-root when a running session blocks it.
   * "unsupported" = the CLI predates the method; "unavailable" = existing-only found no runtime, nothing
   * was recorded so the caller may retry the same ids through another client.
   */
  async function eraseChunk(
    /** Workspace whose agent answers. */
    clientScope: WorkspaceScope,
    /** Workspace that owns the task-index rows of these ids (differs when a client is shared). */
    taskScope: WorkspaceScope,
    taskIds: string[],
    result: ZCodeTaskEraseResult,
    runtimePolicy: ZCodeAgentRuntimePolicy,
  ): Promise<"done" | "unsupported" | "unavailable"> {
    let unavailable = false;
    const erase = async (ids: string[]) => {
      try {
        return await agent.eraseSessionTrees!({
          workspacePath: clientScope.workspacePath,
          sessionIds: ids,
          runtimePolicy,
        });
      } catch (error) {
        if (runtimePolicy === "existing-only") {
          unavailable = true;
          return undefined;
        }
        logger.warn(undefined, "[TaskErase] erase request failed", {
          error,
          requestedCount: ids.length,
        });
        result.failedTaskIds.push(...ids);
        return undefined;
      }
    };
    // Erased sessions lose the conversation text the task index kept for them; the tombstone stays.
    const recordErased = async (ids: string[], outcome: SessionEraseOutcome) => {
      result.erasedTaskIds.push(...ids);
      result.fileFailureCount += outcome.fileFailureCount;
      result.filesRetainedCount += outcome.filesRetainedCount;
      await taskIndexRepo.scrubDeletedTaskContent({
        workspacePath: taskScope.workspacePath,
        workspaceIdentity: taskScope.workspaceIdentity,
        taskIds: ids,
      });
    };
    // Files are removed before the rows, so a file failure erases nothing and the tasks stay retryable.
    const needsRetryPerRoot = (outcome: SessionEraseOutcome) =>
      outcome.blockedRunningSessionIds.length > 0 ||
      (outcome.erasedSessionIds.length === 0 && outcome.fileFailureCount > 0);
    const outcome = await erase(taskIds);
    if (unavailable) return "unavailable";
    if (outcome === undefined) return "done";
    if (outcome === null) return "unsupported";
    if (!needsRetryPerRoot(outcome)) {
      await recordErased(taskIds, outcome);
      return "done";
    }
    if (taskIds.length === 1) {
      if (outcome.blockedRunningSessionIds.length > 0) {
        result.blockedRunningTaskIds.push(...taskIds);
      } else {
        result.failedTaskIds.push(...taskIds);
        result.fileFailureCount += outcome.fileFailureCount;
      }
      return "done";
    }
    for (const taskId of taskIds) {
      const single = await erase([taskId]);
      if (single === undefined) continue;
      if (single === null) return "unsupported";
      if (!needsRetryPerRoot(single)) {
        await recordErased([taskId], single);
      } else if (single.blockedRunningSessionIds.length > 0) {
        result.blockedRunningTaskIds.push(taskId);
      } else {
        result.failedTaskIds.push(taskId);
        result.fileFailureCount += single.fileFailureCount;
      }
    }
    return "done";
  }

  async function eraseTasks(params: WorkspaceScope & { taskIds: string[] }) {
    if (isRemote(params) || !agent.eraseSessionTrees) return null;
    const requested = [...new Set(params.taskIds)];
    const result = emptyResult();
    if (requested.length === 0) return zcodeTaskEraseResultSchema.parse(result);
    const hidden = new Set(
      await taskIndexRepo.listDeletedTaskIds({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider,
      }),
    );
    const eligible = requested.filter((taskId) => hidden.has(taskId));
    result.skippedTaskIds = requested.filter((taskId) => !hidden.has(taskId));
    const taskMetas = await listLocalTaskMetas();
    for (const taskIds of chunk(eligible, ERASE_CHUNK_SIZE)) {
      const outcome = await eraseChunk(params, params, taskIds, result, "start-if-needed");
      if (outcome === "unsupported") return null;
    }
    await worktreeCleanup.cleanupWorktrees(taskMetas, new Set(eligible), result);
    logger.info(undefined, "[TaskErase] batch completed", {
      requested: requested.length,
      erased: result.erasedTaskIds.length,
      skipped: result.skippedTaskIds.length,
      blockedRunning: result.blockedRunningTaskIds.length,
      failed: result.failedTaskIds.length,
      fileFailures: result.fileFailureCount,
      filesRetained: result.filesRetainedCount,
      worktreesRemoved: result.worktreeCleanup.removedCount,
      worktreesRetained: result.worktreeCleanup.retainedCount,
      worktreesFailed: result.worktreeCleanup.failedCount,
    });
    return zcodeTaskEraseResultSchema.parse(result);
  }

  async function listHiddenByWorkspace(): Promise<Map<string, string[]>> {
    const refs = await taskIndexRepo.listLocalDeletedTaskRefs({ provider });
    const byWorkspace = new Map<string, string[]>();
    for (const ref of refs) {
      const bucket = byWorkspace.get(ref.workspacePath) ?? [];
      bucket.push(ref.taskId);
      byWorkspace.set(ref.workspacePath, bucket);
    }
    return byWorkspace;
  }

  /**
   * Session ids are global in the CLI store, so counting never needs one agent per workspace: prefer a
   * runtime that is already alive, and only when none exists start a single one in the first workspace
   * that can host it. A workspace whose folder is gone must not stop its tombstones from being counted.
   */
  async function countHiddenTaskContent() {
    let worktreeCount = 0;
    try {
      const metas = await listLocalTaskMetas();
      const paths = metas.flatMap((task) =>
        task.deleted && task.executionWorktree?.path ? [task.executionWorktree.path] : [],
      );
      if (paths.length > 0 && options.gitService) {
        const identities = await options.gitService.resolveWorktreePathIdentities({ paths });
        worktreeCount = new Set(identities).size;
      } else {
        worktreeCount = new Set(paths).size;
      }
    } catch (error) {
      logger.warn(undefined, "[TaskErase] hidden worktree count failed", { error });
      return null;
    }
    if (!agent.countSessionTrees) return { sessions: 0, worktrees: worktreeCount };
    const byWorkspace = await listHiddenByWorkspace();
    const workspaces = [...byWorkspace.keys()];
    if (workspaces.length === 0) return { sessions: 0, worktrees: worktreeCount };
    const allIds = [...byWorkspace.values()].flat();
    for (const runtimePolicy of ["existing-only", "start-if-needed"] as const) {
      for (const workspacePath of workspaces) {
        try {
          const counts = await countIds({ workspacePath }, allIds, runtimePolicy);
          return counts ? { sessions: counts.total, worktrees: worktreeCount } : null;
        } catch (error) {
          if (runtimePolicy === "start-if-needed") {
            logger.warn(undefined, "[TaskErase] hidden content count failed", { error });
          }
        }
      }
    }
    return null;
  }

  /**
   * Workspaces with a live runtime erase through it, so its running guard sees its own sessions. The rest
   * share one started client (see countHiddenTaskContent) instead of one process per workspace.
   */
  async function eraseHiddenTaskContent() {
    if (!agent.eraseSessionTrees) return null;
    const taskMetas = await listLocalTaskMetas();
    const byWorkspace = await listHiddenByWorkspace();
    const result = emptyResult();
    const withoutRuntime: Array<{ workspacePath: string; taskIds: string[] }> = [];
    for (const [workspacePath, taskIds] of byWorkspace) {
      let unavailable = false;
      for (const ids of chunk(taskIds, ERASE_CHUNK_SIZE)) {
        if (unavailable) {
          withoutRuntime.push({ workspacePath, taskIds: ids });
          continue;
        }
        const outcome = await eraseChunk(
          { workspacePath },
          { workspacePath },
          ids,
          result,
          "existing-only",
        );
        if (outcome === "unsupported") return null;
        if (outcome === "unavailable") {
          unavailable = true;
          withoutRuntime.push({ workspacePath, taskIds: ids });
        }
      }
    }
    const candidates = [...new Set(withoutRuntime.map((entry) => entry.workspacePath))];
    let scopeIndex = 0;
    for (const entry of withoutRuntime) {
      let handled = false;
      while (!handled && scopeIndex < candidates.length) {
        const before = result.failedTaskIds.length;
        const fileFailuresBefore = result.fileFailureCount;
        const outcome = await eraseChunk(
          { workspacePath: candidates[scopeIndex]! },
          { workspacePath: entry.workspacePath },
          entry.taskIds,
          result,
          "start-if-needed",
        );
        if (outcome === "unsupported") return null;
        if (
          result.failedTaskIds.length > before &&
          result.fileFailureCount === fileFailuresBefore
        ) {
          // The client could not be started here: drop the failures and try the next workspace.
          result.failedTaskIds.length = before;
          scopeIndex += 1;
          continue;
        }
        handled = true;
      }
      if (!handled) result.failedTaskIds.push(...entry.taskIds);
    }
    await worktreeCleanup.cleanupWorktrees(
      taskMetas,
      new Set(
        taskMetas
          .filter((task) => task.deleted && task.executionWorktree?.path)
          .map((task) => task.taskId),
      ),
      result,
    );
    return zcodeTaskEraseResultSchema.parse(result);
  }

  return {
    countTaskTrees,
    getDeletionCapability,
    eraseTasks,
    countHiddenTaskContent,
    eraseHiddenTaskContent,
  };
}
