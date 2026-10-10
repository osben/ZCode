import { create } from "zustand";

/**
 * Request-bridge store for opening the "Model call trace" sidebar.
 *
 * Background: entry points live in task context menus / Header menus, deep in the component tree, while sidebar tab state is held by
 * each workspace's useAppPanels. To avoid threading a new callback through the entire task-list tree,
 * use a lightweight singleton store as a bridge: the menu writes a pending request, and the target workspace's
 * useAppPanels subscribes and consumes it (matched by workspaceKey to avoid cross-wiring multiple workspace instances).
 */
interface ModelTrajectoryOpenRequest {
  /** Unique request id so repeated clicks on the same task still trigger consumption. */
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath, used to locate the target workspace sidebar. */
  workspaceKey: string;
  title?: string | null;
}

interface ModelTrajectoryStoreState {
  pendingRequest: ModelTrajectoryOpenRequest | null;
  requestOpen: (request: Omit<ModelTrajectoryOpenRequest, "requestId">) => void;
  consumeRequest: (requestId: string) => void;
}

declare global {
  interface Window {
    __zcodeModelTrajectoryStoreE2E?: typeof useModelTrajectoryStore;
  }
}

let requestSeq = 0;

export const useModelTrajectoryStore = create<ModelTrajectoryStoreState>((set) => ({
  pendingRequest: null,
  requestOpen: (request) => {
    requestSeq += 1;
    set({
      pendingRequest: { ...request, requestId: `model-trajectory-open:${requestSeq}` },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));

// E2E needs to verify the full request bridge → target workspace side pane flow directly in a dual-workspace shell.
// The Header menu is bound only to the current header's activeTaskId and is not a stable test entry point for split-pane shells.
// Follow the same pattern as __zcodeSessionStoreE2E: expose the store itself instead of creating a separate test-only business implementation.
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
