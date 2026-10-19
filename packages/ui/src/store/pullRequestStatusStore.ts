import { create } from "zustand";
import type { SessionPullRequest, SessionPullRequestStatus } from "@zcode/shared";

/**
 * Read-only projection of per-task pull request observations
 * (specs/sidebar-pr-status.md). The single source of truth is the runtime git
 * service (TTL cache there); this store only mirrors the latest probe result
 * so every surface (row, hover, menu, header, Git tools, Session manager)
 * reads one entry per workspaceKey::taskId.
 */
interface PullRequestStatusState {
  statusByTaskKey: Record<string, SessionPullRequestStatus>;
  /**
   * Mutation signal: bumped after an in-app git mutation (commit/push) so
   * probes re-request immediately. The service cache owns the real cadence;
   * untouched tasks land in its TTL and stay cheap.
   */
  refreshVersion: number;
  /**
   * Explicit refresh signal: bumps a version with the task keys whose next
   * probe must bypass the service TTL (context menu "Refresh pull request
   * status").
   */
  forceRefresh: { version: number; taskKeys: string[] };
  /**
   * Merges one probe answer into the workspace's entries. Two drivers probe
   * the same workspace with different task sets (sidebar: all worktree tasks;
   * Session manager: visible rows only), so a write must never remove entries
   * another driver just reported; departures are cleaned by dropWorkspaceTasks.
   */
  setWorkspacePullRequestStatuses(
    workspaceKey: string,
    entries: Record<string, SessionPullRequestStatus>,
  ): void;
  dropWorkspaceTasks(workspaceKey: string): void;
  requestRefresh(): void;
  requestForceRefresh(taskKeys: string[]): void;
}

const TASK_KEY_SEPARATOR = "::";

export function buildPullRequestTaskKey(workspaceKey: string, taskId: string): string {
  return `${workspaceKey}${TASK_KEY_SEPARATOR}${taskId}`;
}

export const usePullRequestStatusStore = create<PullRequestStatusState>((set) => ({
  statusByTaskKey: {},
  refreshVersion: 0,
  forceRefresh: { version: 0, taskKeys: [] },
  setWorkspacePullRequestStatuses: (workspaceKey, entries) =>
    set((state) => {
      const prefix = `${workspaceKey}${TASK_KEY_SEPARATOR}`;
      let changed = false;
      const next: Record<string, SessionPullRequestStatus> = { ...state.statusByTaskKey };
      for (const [taskId, status] of Object.entries(entries)) {
        const taskKey = `${prefix}${taskId}`;
        if (next[taskKey] !== status) {
          next[taskKey] = status;
          changed = true;
        }
      }
      return changed ? { statusByTaskKey: next } : state;
    }),
  dropWorkspaceTasks: (workspaceKey) =>
    set((state) => {
      const prefix = `${workspaceKey}${TASK_KEY_SEPARATOR}`;
      const hasEntry = Object.keys(state.statusByTaskKey).some((taskKey) =>
        taskKey.startsWith(prefix),
      );
      if (!hasEntry) {
        return state;
      }
      const next: Record<string, SessionPullRequestStatus> = {};
      for (const [taskKey, status] of Object.entries(state.statusByTaskKey)) {
        if (!taskKey.startsWith(prefix)) {
          next[taskKey] = status;
        }
      }
      return { statusByTaskKey: next };
    }),
  requestRefresh: () => set((state) => ({ refreshVersion: state.refreshVersion + 1 })),
  requestForceRefresh: (taskKeys) =>
    set((state) => ({ forceRefresh: { version: state.forceRefresh.version + 1, taskKeys } })),
}));

export function selectTaskPullRequestStatus(
  state: PullRequestStatusState,
  workspaceKey: string,
  taskId: string,
): SessionPullRequestStatus | undefined {
  return state.statusByTaskKey[buildPullRequestTaskKey(workspaceKey, taskId)];
}

/** Primary pull request of a status entry; the service sorts primary first. */
export function selectPrimarySessionPullRequest(
  status: SessionPullRequestStatus | null | undefined,
): SessionPullRequest | null {
  if (!status || status.primaryNumber === null) {
    return null;
  }
  return (
    status.pullRequests.find((pullRequest) => pullRequest.number === status.primaryNumber) ?? null
  );
}
