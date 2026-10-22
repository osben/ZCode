import { useEffect } from "react";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

/**
 * Subscribe to "open model call trajectory" requests and forward them to the current workspace's sidebar controller.
 *
 * The trigger is deep in the task context/Header menus and starts a request through a singleton store. Match by workspaceKey,
 * call onOpen to open the sidebar tab, then consume the request so multiple workspace instances do not open each other's tabs.
 */
export function useModelTrajectoryOpenBridge(
  ownWorkspaceKey: string,
  onOpen: (params: { taskId: string; title?: string | null; kind?: "v1" | "v2" }) => void,
): void {
  useEffect(() => {
    const handlePending = (
      pendingRequest: ReturnType<typeof useModelTrajectoryStore.getState>["pendingRequest"],
    ) => {
      if (!pendingRequest || pendingRequest.workspaceKey !== ownWorkspaceKey) {
        return;
      }
      onOpen({
        taskId: pendingRequest.taskId,
        title: pendingRequest.title,
        kind: pendingRequest.kind,
      });
      useModelTrajectoryStore.getState().consumeRequest(pendingRequest.requestId);
    };

    // A request may already be pending when subscribing (click and mount can race), so handle the current value once first.
    handlePending(useModelTrajectoryStore.getState().pendingRequest);
    return useModelTrajectoryStore.subscribe((state) => {
      handlePending(state.pendingRequest);
    });
  }, [onOpen, ownWorkspaceKey]);
}
