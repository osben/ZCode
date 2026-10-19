import type { SessionPullRequestsTaskInput, SessionPullRequestStatus } from "@zcode/shared";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";

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
 * - a failed probe drops the workspace's entries — indicators reliably
 *   disappear instead of freezing stale;
 * - repeated failures warn once per workspace.
 */
export function createPullRequestStatusProber(
  store: PullRequestProbeStore,
  warnings: { warn: (message: string, detail: unknown) => void } = { warn: logger.warn },
) {
  const writeSequenceByWorkspaceKey = new Map<string, number>();
  const warnedWorkspaceKeys = new Set<string>();

  async function probe(
    targets: readonly PullRequestStatusTarget[],
    options?: { force?: boolean; forceTaskIds?: string[] },
  ): Promise<void> {
    await Promise.allSettled(
      targets.map(async (target) => {
        if (target.tasks.length === 0) {
          return;
        }
        const forceTaskIds = options?.force
          ? target.tasks.map((task) => task.input.taskId)
          : (options?.forceTaskIds ?? []).filter((taskId) =>
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
            warnings.warn(
              `session pull request status unavailable for ${target.workspaceKey}`,
              error instanceof Error ? error.message : error,
            );
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
