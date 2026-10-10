import { useShallow } from "zustand/react/shallow";
import {
  getWorkspaceDisplayedTaskState,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
  type WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStore.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { hasBusyTaskInWorkspaceProvider } from "@/lib/workspaceBusyTaskLock.js";

type WorkspaceShellZCodeState = Pick<
  WorkspaceZCodeUIState,
  | "activeTaskId"
  | "draftFocusVersion"
  | "modelSwitchPending"
  | "modelSwitchStage"
  | "selectedProvider"
  | "selectedSupplierKey"
  | "configOptions"
  | "optimisticTaskListByTaskId"
  | "workspaceInit"
> &
  ReturnType<typeof getWorkspaceDisplayedTaskState>;

export function useWorkspaceShellZCodeState(workspaceAbsPath: string, workspaceIdentity?: string) {
  // The app previously subscribed to all of workspaceZCodeState, where each streaming chunk updated taskMessagesByTaskId.
  // This pulled the sidebar, Header, and derived Git logic into synchronous rerenders, amplifying the long tasks in performance traces.
  // Narrow the selector to the fields the shell actually uses and compare them shallowly so message streams do not affect unrelated UI.
  const workspaceShellZCodeState = useZCodeSessionStore(
    useShallow((state): WorkspaceShellZCodeState => {
      const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
      const displayedTaskState = getWorkspaceDisplayedTaskState(workspaceState);
      return {
        activeTaskId: workspaceState.activeTaskId,
        draftFocusVersion: workspaceState.draftFocusVersion,
        modelSwitchPending: workspaceState.modelSwitchPending,
        modelSwitchStage: workspaceState.modelSwitchStage,
        selectedProvider: workspaceState.selectedProvider,
        selectedSupplierKey: workspaceState.selectedSupplierKey,
        configOptions: workspaceState.configOptions,
        optimisticTaskListByTaskId: workspaceState.optimisticTaskListByTaskId,
        workspaceInit: workspaceState.workspaceInit,
        taskStatus: displayedTaskState.taskStatus,
        taskError: displayedTaskState.taskError,
      };
    }),
  );

  const reloadSessionDisabled = useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
    const actionScope = resolveWorkspaceModelConfigSyncScope(workspaceState);
    return hasBusyTaskInWorkspaceProvider(
      actionScope.provider,
      workspaceState.taskRuntimeByTaskId,
      workspaceState.optimisticTaskListByTaskId,
      workspaceState.taskListCache,
      workspaceState.activeTaskId,
    );
  });

  return { workspaceShellZCodeState, reloadSessionDisabled };
}
