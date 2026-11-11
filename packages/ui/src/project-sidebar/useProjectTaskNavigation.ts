import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  ProjectSidebarProps,
  ProjectTree,
  IRemoteProjectService,
  ProjectTaskNavigation,
  ProjectTaskNavigationResult,
} from "@/project-sidebar/contract.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { openWebRemoteControlTask } from "@/hooks/useWebRemoteControlTaskOpen.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceConnectionGate } from "@/project-sidebar/useRemoteWorkspaceConnectionGate.js";

/** Only opening a task binds a workspace; list mutations must not create scopes via navigation. */
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
  remoteService?: IRemoteProjectService,
): ProjectTaskNavigation {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const tabStore = useTabStoreApi();
  const waitForConnection = useRemoteWorkspaceConnectionGate(props.reconnectingRemoteWorkspaceKeys);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const latest = useRef({ props, tree, remoteService, activeWorkspaceIdentity, waitForConnection });
  useLayoutEffect(() => {
    latest.current = { props, tree, remoteService, activeWorkspaceIdentity, waitForConnection };
  });
  return useCallback(
    (path, taskId, identity, remoteSessionId, unreadAt, options) => {
      const request = ++sequence.current;
      const cancelled: ProjectTaskNavigationResult = {
        status: "unavailable",
        reason: "project.navigation-cancelled",
      };
      const { props, tree, remoteService, activeWorkspaceIdentity, waitForConnection } =
        latest.current;
      const readFocus = () =>
        props.workspacePath
          ? useZCodeSessionStore
              .getState()
              .getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
          : undefined;
      const originFocus = readFocus();
      // Child sessions are not top-level tree rows; their parent owns the workspace attachment.
      const ownerTaskId = options?.parentTaskId ?? taskId;
      let selecting = false;
      let supersededByNavigation = false;
      const navigationObserver = onTaskNavigationCommitted(() => {
        if (!selecting) supersededByNavigation = true;
      });
      // Switching tasks or starting a new draft inside the same directory also invalidates the old connection, so comparing workspace identity alone is not enough.
      const isCurrent = () =>
        !options?.signal?.aborted &&
        !supersededByNavigation &&
        sequence.current === request &&
        latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
        readFocus()?.activeTaskId === originFocus?.activeTaskId &&
        readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion &&
        (!identity ||
          latest.current.tree.tasks.some(
            (task) => task.taskId === ownerTaskId && task.workspaceIdentity === identity,
          ));
      const selectionResult = (): ProjectTaskNavigationResult => {
        const state = tabStore.getState();
        // The original callback rejects the selection while the model rebuilds or the remote scope is unavailable; a delivered event must not pass for an actual open.
        return (state.activeWorkspaceIdentity || state.activeWorkspacePath) ===
          (identity || path) &&
          useZCodeSessionStore.getState().getWorkspaceState(path, identity).activeTaskId === taskId
          ? { status: "opened" }
          : { status: "unavailable", reason: "project.navigation-rejected" };
      };
      const open = async (): Promise<ProjectTaskNavigationResult> => {
        if (options?.signal?.aborted) return cancelled;
        const task = tree.tasks.find(
          (item) =>
            item.taskId === ownerTaskId &&
            (item.workspaceIdentity || item.workspacePath) === (identity || path),
        );
        if (props.webRemoteControlWorkspaceSwitcher) {
          if (!task) throw new Error("project.task-not-found");
          await openWebRemoteControlTask({
            switcher: props.webRemoteControlWorkspaceSwitcher,
            activeWorkspacePath: props.workspacePath,
            activeWorkspaceIdentity: activeWorkspaceIdentity ?? undefined,
            activeTaskId: null,
            task: {
              ...task,
              workspacePath: path,
              workspaceIdentity: identity,
              taskId,
              unreadAt,
              workspaceLabel: path,
              workspaceKind: task.hostId === "local" ? "local" : "remote",
            },
            markTaskReadOnOpen: true,
            mobileNavigationIntent: "chat",
            onSelectTask: props.onSelectTask,
            onTaskOpen: props.onWebRemoteTaskOpen,
            onSwitchingChange: props.onWebRemoteTaskSwitchingChange,
            setError: (error) => {
              if (error) toast(error);
            },
          });
          return selectionResult();
        }
        if (identity && task && remoteService) {
          const directory = await remoteService.readDirectory();
          if (!isCurrent()) return cancelled;
          if (directory.hosts.some((host) => host.id === task.hostId)) {
            remoteSessionId = await attachRemoteProjectWorkspace({
              hostId: task.hostId,
              workspacePath: path,
              workspaceIdentity: identity,
              remoteService,
              isCurrent,
              findSession: (key) =>
                Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
                  (session) => session.workspaceIdentity === key,
                ),
              waitForPendingConnection: waitForConnection,
              connect: props.onConnectRemote,
              bind: (sessionId, workspacePath, guard) =>
                props.onSelectRemoteProject(sessionId, workspacePath, undefined, identity, guard),
              cancel: props.onCancelRemoteProject,
            });
          }
        }
        // Remote binding may legitimately change workspace/focus; before committing the selection, only re-check this request's cancellation and generation.
        if (options?.signal?.aborted || sequence.current !== request || supersededByNavigation)
          return cancelled;
        // Observe the full navigation commit produced by this call; the cached activeTaskId may still belong to a draft that was left.
        let committed = false;
        const subscription = onTaskNavigationCommitted((target) => {
          if (
            sequence.current === request &&
            !options?.signal?.aborted &&
            target.taskId === taskId &&
            (target.workspaceIdentity || target.workspacePath) === (identity || path)
          )
            committed = true;
        });
        try {
          selecting = true;
          // Child sessions carry their capability (side chat -> restricted commands) through to the shell.
          await props.onSelectTask(path, taskId, identity, remoteSessionId, unreadAt, options);
          if (sequence.current !== request || options?.signal?.aborted) return cancelled;
          return committed
            ? selectionResult()
            : { status: "unavailable", reason: "project.navigation-rejected" };
        } finally {
          subscription.dispose();
        }
      };
      return open()
        .catch((error): ProjectTaskNavigationResult => {
          // Bug cause: clicking several tasks while the first connection is pending made superseded clicks throw navigation-cancelled, or share
          // the new click's connection failure, surfacing an error every time. Superseding is the user's new intent; only the latest navigation reports the outcome.
          if (
            options?.signal?.aborted ||
            supersededByNavigation ||
            sequence.current !== request ||
            (error instanceof Error && error.message === "project.navigation-cancelled")
          )
            return cancelled;
          logger.error("[project-sidebar] 打开任务失败", error);
          toast(String(error));
          return {
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        })
        .finally(() => navigationObserver.dispose());
    },
    [tabStore],
  );
}
