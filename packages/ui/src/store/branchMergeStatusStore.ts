import { create } from "zustand";
import type { GitBranchMergeStatus } from "@zcode/shared";

/**
 * Read-only projection of per-workspace merge observations.
 *
 * The single source of truth is the runtime git service (TTL cache there);
 * this store only mirrors the latest probe result for sidebar rows so every
 * row of one workspace shares one subscription-free snapshot.
 */
interface BranchMergeStatusState {
  statusByWorkspaceKey: Record<string, GitBranchMergeStatus>;
  /**
   * Счётчик запросов на re-proбу после успешной мутации git (смена ветки,
   * создание ветки, коммит). In-app мутация инвалидирует сервисный кэш, но
   * сама по себе не будит пробу — этот счётчик и есть сигнал «мутация
   * прошла, опроси заново». Глобальный: untouched workspace'ы всё равно
   * попадают в сервисный TTL-кэш и стоят один symbolic-ref.
   */
  refreshVersion: number;
  setBranchMergeStatus: (workspaceKey: string, status: GitBranchMergeStatus) => void;
  dropWorkspace: (workspaceKey: string) => void;
  requestRefresh: () => void;
}

export const useBranchMergeStatusStore = create<BranchMergeStatusState>((set) => ({
  statusByWorkspaceKey: {},
  refreshVersion: 0,
  setBranchMergeStatus: (workspaceKey, status) =>
    set((state) => {
      const previous = state.statusByWorkspaceKey[workspaceKey];
      if (previous === status) {
        return state;
      }
      return {
        statusByWorkspaceKey: { ...state.statusByWorkspaceKey, [workspaceKey]: status },
      };
    }),
  dropWorkspace: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.statusByWorkspaceKey)) {
        return state;
      }
      const next = { ...state.statusByWorkspaceKey };
      delete next[workspaceKey];
      return { statusByWorkspaceKey: next };
    }),
  requestRefresh: () => set((state) => ({ refreshVersion: state.refreshVersion + 1 })),
}));

export function selectBranchMergeStatus(
  state: BranchMergeStatusState,
  workspaceKey: string,
): GitBranchMergeStatus | undefined {
  return state.statusByWorkspaceKey[workspaceKey];
}
