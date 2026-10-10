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
  setBranchMergeStatus: (workspaceKey: string, status: GitBranchMergeStatus) => void;
  dropWorkspace: (workspaceKey: string) => void;
}

export const useBranchMergeStatusStore = create<BranchMergeStatusState>((set) => ({
  statusByWorkspaceKey: {},
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
}));

export function selectBranchMergeStatus(
  state: BranchMergeStatusState,
  workspaceKey: string,
): GitBranchMergeStatus | undefined {
  return state.statusByWorkspaceKey[workspaceKey];
}
