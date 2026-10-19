import type { SessionPullRequestsTaskInput, SessionPullRequestStatus } from "@zcode/shared";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildPullRequestTaskKey } from "@/store/pullRequestStatusStore.js";

export interface PullRequestStatusTaskCandidate {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  executionWorktree?: {
    branchName?: string | null;
    path?: string | null;
  };
}

export interface PullRequestStatusTargetTask {
  input: SessionPullRequestsTaskInput;
  /** Live running flag from the sessions index; drives the turn-end invalidation. */
  running: boolean;
}

export interface PullRequestStatusTarget {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  gitService: IGitService;
  /** Worktree tasks of this workspace; ordinary sessions never ride the probe. */
  tasks: readonly PullRequestStatusTargetTask[];
}

export function collectPullRequestStatusTaskCandidates<T extends PullRequestStatusTaskCandidate>(
  taskLists: readonly (readonly T[])[],
): T[] {
  const candidatesByTaskKey = new Map<string, T>();
  for (const task of taskLists.flat()) {
    if (task.executionWorktree === undefined) {
      continue;
    }
    candidatesByTaskKey.set(
      buildPullRequestTaskKey(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
        task.taskId,
      ),
      task,
    );
  }
  return [...candidatesByTaskKey.values()];
}

/** Minimal store surface the probe needs; keeps unit tests simple. */
export interface PullRequestProbeStore {
  setWorkspacePullRequestStatuses(
    workspaceKey: string,
    entries: Record<string, SessionPullRequestStatus>,
  ): void;
  dropWorkspaceTasks(workspaceKey: string): void;
  markWorkspaceTasksStale(workspaceKey: string, taskIds: readonly string[]): void;
}

/**
 * Pull request status probe orchestration without React/DOM — the hook wraps
 * it and unit tests drive it directly. The service owns the cadence (TTL +
 * forceTaskIds); there is no client-side TTL gate.
 *
 * Write rules:
 * - only the newest probe per workspace writes (stale-write guard);
 * - a successful probe merges its entries: the sidebar probes a workspace
 *   with all worktree tasks while the Session manager probes only visible
 *   rows, so one driver must never erase another's entries;
 * - the response must be an object (the web stub answers {}, an old host
 *   rejects);
 * - a failed probe marks only its own tasks' entries stale (the other driver's
 *   entries survive);
 * - repeated failures warn once per workspace, with a generic message and the
 *   error class only: workspace keys and error messages carry paths and remotes.
 */

/**
 * Task ids of the targets whose task key was explicitly requested (context menu "Refresh pull
 * request status"), grouped by workspace because task IDs are not globally unique.
 */
export function forceTaskIdsForRequestedKeys(
  targets: readonly PullRequestStatusTarget[],
  requestedKeys: readonly string[],
): Map<string, string[]> {
  const requested = new Set(requestedKeys);
  const result = new Map<string, string[]>();
  for (const target of targets) {
    const taskIds = [
      ...new Set(
        target.tasks
          .map((task) => task.input.taskId)
          .filter((taskId) => requested.has(buildPullRequestTaskKey(target.workspaceKey, taskId))),
      ),
    ];
    if (taskIds.length > 0) {
      result.set(target.workspaceKey, taskIds);
    }
  }
  return result;
}
/** Task keys of the targets whose live running flag is set (the turn-end diff's current side). */
export function runningPullRequestTaskKeys(
  targets: readonly PullRequestStatusTarget[],
): Set<string> {
  return new Set(
    targets.flatMap((target) =>
      target.tasks
        .filter((task) => task.running)
        .map((task) => buildPullRequestTaskKey(target.workspaceKey, task.input.taskId)),
    ),
  );
}

/**
 * Turn-end diff shared by both drivers: a task that was running at the previous diff and is not
 * running now yields one forced target. A task absent from `targets` (scrolled out of the Session
 * manager's virtualizer, or left the list) yields nothing, because it has no row to refresh.
 * The first diff has no previous set, so nothing is forced on activation.
 */
export function collectPullRequestTurnEndTargets(
  targets: readonly PullRequestStatusTarget[],
  previousRunningKeys: ReadonlySet<string>,
): { runningKeys: Set<string>; finishedTargets: PullRequestStatusTarget[] } {
  const runningKeys = runningPullRequestTaskKeys(targets);
  const finished = new Set([...previousRunningKeys].filter((key) => !runningKeys.has(key)));
  const finishedTargets =
    finished.size === 0
      ? []
      : targets
          .map((target) => ({
            ...target,
            tasks: target.tasks.filter((task) =>
              finished.has(buildPullRequestTaskKey(target.workspaceKey, task.input.taskId)),
            ),
          }))
          .filter((target) => target.tasks.length > 0);
  return { runningKeys, finishedTargets };
}

export type PullRequestStatusProber = ReturnType<typeof createPullRequestStatusProber>;

export function createPullRequestStatusProber(
  store: PullRequestProbeStore,
  warnings: { warn: (message: string, detail: unknown) => void } = { warn: logger.warn },
) {
  const writeSequenceByWorkspaceKey = new Map<string, number>();
  const warnedWorkspaceKeys = new Set<string>();

  async function probe(
    targets: readonly PullRequestStatusTarget[],
    options?: {
      force?: boolean;
      forceTaskIdsByWorkspace?: ReadonlyMap<string, readonly string[]>;
    },
  ): Promise<void> {
    await Promise.allSettled(
      targets.map(async (target) => {
        if (target.tasks.length === 0) {
          return;
        }
        const forceTaskIds = options?.force
          ? target.tasks.map((task) => task.input.taskId)
          : (options?.forceTaskIdsByWorkspace?.get(target.workspaceKey) ?? []).filter((taskId) =>
              target.tasks.some((task) => task.input.taskId === taskId),
            );
        const sequence = (writeSequenceByWorkspaceKey.get(target.workspaceKey) ?? 0) + 1;
        writeSequenceByWorkspaceKey.set(target.workspaceKey, sequence);
        try {
          const result = await target.gitService.getSessionPullRequests({
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            tasks: target.tasks.map((task) => task.input),
            ...(forceTaskIds.length > 0 ? { forceTaskIds } : {}),
          });
          if (writeSequenceByWorkspaceKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          if (result === null || typeof result !== "object" || Array.isArray(result)) {
            throw new Error("unexpected getSessionPullRequests response shape");
          }
          warnedWorkspaceKeys.delete(target.workspaceKey);
          store.setWorkspacePullRequestStatuses(target.workspaceKey, result);
        } catch (error) {
          if (writeSequenceByWorkspaceKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          if (!warnedWorkspaceKeys.has(target.workspaceKey)) {
            warnedWorkspaceKeys.add(target.workspaceKey);
            warnings.warn("session pull request status unavailable", {
              errorName: error instanceof Error ? error.name : "unknown",
            });
          }
          store.markWorkspaceTasksStale(
            target.workspaceKey,
            target.tasks.map((task) => task.input.taskId),
          );
        }
      }),
    );
  }

  function forget(workspaceKey: string): void {
    writeSequenceByWorkspaceKey.delete(workspaceKey);
    warnedWorkspaceKeys.delete(workspaceKey);
  }

  return { probe, forget };
}
