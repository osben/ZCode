import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
} from "@/lib/zcodeTaskUsageFallback.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "@/root/botsTaskBroadcast.js";
import { resolveBotTaskStreamBroadcast } from "@/root/botsTaskStreamBroadcast.js";
import { insertTaskIntoTaskCaches, syncTaskMetaToTaskCaches } from "@/lib/taskListMetaSync.js";

export function syncBotTaskConfigOptionsToStore(params: {
  zcodeSessionStore: Pick<ReturnType<typeof useZCodeSessionStore.getState>, "setTaskConfigOptions">;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  configOptions: ZCodeConfigOption[];
}) {
  // Bugfix: Bot /mode does not go through ChatInputToolbar/useTaskStreamEvents.
  // setTaskConfigOptions decides whether to sync to workspace configOptions based on activeTaskId,
  // and the current mode is derived from configOptions, avoiding a second mode state in the UI.
  params.zcodeSessionStore.setTaskConfigOptions(
    params.workspacePath,
    params.taskId,
    params.configOptions,
    params.workspaceIdentity,
  );
}

export function shouldRefreshBotTaskList(event: string, hasTaskMeta: boolean): boolean {
  // Bugfix: When Bot creates a task, the created broadcast includes task metadata, so the current implementation skips a full table refresh.
  // But if the task query cache for that workspace has not been created, the incremental write has nowhere to go and the sidebar does not fetch the new task.
  // created events are infrequent, so retain one version bump as a fallback; other high-frequency events still prefer incremental cache updates to prevent list flicker.
  if (event === "created") {
    return true;
  }
  if (hasTaskMeta) {
    return false;
  }
  return event === "created" || event === "updated" || event === "completed" || event === "error";
}

export function shouldMirrorBotTaskStreamToStore(params: {
  activeTaskId: string | null;
  taskId: string;
  workspaceIdentity?: string;
}): boolean {
  if (params.activeTaskId !== params.taskId) {
    return true;
  }

  // Bugfix: A remote Bot task stream comes from the Bot runtime host and may not be received by the current ChatView’s ZCode Agent stream subscription.
  // Previously, active Bot tasks skipped the broadcast, so their messages appeared only after switching tasks and fetching a new snapshot.
  return Boolean(params.workspaceIdentity?.trim());
}

export function useBotBroadcastEffects(
  services: IServiceAccessor,
  tabStoreApi: ReturnType<typeof useTabStoreApi>,
) {
  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      const stream = resolveBotTaskStreamBroadcast(message, tabStoreApi.getState().tabs);
      if (stream) {
        const zcodeSessionStore = useZCodeSessionStore.getState();
        const workspaceState = zcodeSessionStore.getWorkspaceState(
          stream.workspacePath,
          stream.workspaceIdentity,
        );
        if (
          !shouldMirrorBotTaskStreamToStore({
            activeTaskId: workspaceState.activeTaskId,
            taskId: stream.taskId,
            workspaceIdentity: stream.workspaceIdentity,
          })
        ) {
          return;
        }

        // When a Bot task runs in the background or on a remote runtime, this window may not subscribe to the same stream.
        // Message bodies are no longer replayed into the renderer’s local store. After a Bot prompt
        // enters through a v4 command, the conversation projection (for panes subscribed to the session) renders it naturally;
        // this only synchronizes runtime state, permissions, and usage for the sidebar and dialogs.
        const event = stream.event;
        switch (event.type) {
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "tool_call":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "permission_request":
            zcodeSessionStore.setTaskPermissionRequest(
              stream.workspacePath,
              stream.taskId,
              event,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          case "task_complete":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "completed",
              undefined,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(
              stream.workspacePath,
              stream.taskId,
              null,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              null,
              stream.workspaceIdentity,
            );
            break;
          case "task_error": {
            const normalizedError = normalizeZCodeUiError(
              {
                message: event.error,
                detail: event.detail,
                code: event.code,
              },
              {
                fallbackCode: event.code ?? "UNKNOWN",
                traceId: event.traceId,
                taskId: event.taskId,
              },
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "failed",
              normalizedError.message,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(
              stream.workspacePath,
              stream.taskId,
              null,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizedError,
              stream.workspaceIdentity,
            );
            break;
          }
          case "task_warning":
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizeZCodeUiError(
                {
                  message: event.warning,
                  detail: event.detail,
                  code: event.code,
                },
                {
                  fallbackCode: event.code ?? "WARNING",
                  traceId: event.traceId,
                  taskId: event.taskId,
                },
              ),
              stream.workspaceIdentity,
            );
            break;
          case "usage_update":
            {
              const workspaceState = zcodeSessionStore.getWorkspaceState(
                stream.workspacePath,
                stream.workspaceIdentity,
              );
              const previousUsage =
                workspaceState.taskRuntimeByTaskId[stream.taskId]?.usage ?? null;
              // taskMessagesByTaskId was retired along with message replay; usage estimates do not need the latest message.
              // For user input, use the fallback estimate (this branch only affects the usage dialog’s proportional display fallback).
              const incomingUsage = {
                size: event.size,
                used: event.used,
                cost: event.cost,
                ...(event.cache ? { cache: event.cache } : {}),
                ...(event.breakdown ? { breakdown: event.breakdown } : {}),
              };
              const nextUsage = buildTaskContextUsageFromUsageUpdate({
                currentUsage: previousUsage,
                incomingUsage,
              });
              recordTaskContextUsageUpdate({
                workspacePath: stream.workspacePath,
                workspaceIdentity: stream.workspaceIdentity,
                taskId: stream.taskId,
                size: event.size,
                used: event.used,
              });
              zcodeSessionStore.setTaskContextWindow(
                stream.workspacePath,
                stream.taskId,
                event.size,
                stream.workspaceIdentity,
              );
              zcodeSessionStore.setTaskUsage(
                stream.workspacePath,
                stream.taskId,
                nextUsage,
                stream.workspaceIdentity,
              );
            }
            break;
          case "session_info_update":
            if (event.apiRetry !== undefined) {
              zcodeSessionStore.setTaskApiRetryStatus(
                stream.workspacePath,
                stream.taskId,
                event.apiRetry ?? null,
                stream.workspaceIdentity,
              );
            }
            break;
        }
        return;
      }

      const refresh = resolveBotTaskBroadcastRefresh(message, tabStoreApi.getState().tabs);
      if (!refresh) {
        return;
      }
      // Bots create and advance tasks on the host, without mounting the chat view’s stream subscription.
      // Therefore, in addition to refreshing the list, synchronize task runtime state; otherwise the sidebar shows the new task without its in-progress status.
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const workspaceState = zcodeSessionStore.getWorkspaceState(
        refresh.workspacePath,
        refresh.workspaceIdentity,
      );
      const provider = refresh.task?.provider ?? refresh.provider;
      const shouldSyncVisibleTaskConfig = workspaceState.activeTaskId === refresh.taskId;
      if (provider && shouldSyncVisibleTaskConfig) {
        // Bugfix: /model and /mode can change the current task’s real ZCode Agent state through a third-party Bot.
        // These operations do not go through ChatInputToolbar, so the local store previously did not synchronize provider/configOptions,
        // leaving the UI dropdown showing the old state after the Bot confirmed the change.
        zcodeSessionStore.bindRuntimeProvider(
          refresh.workspacePath,
          provider,
          refresh.workspaceIdentity,
        );
      }
      if (refresh.configOptions) {
        syncBotTaskConfigOptionsToStore({
          zcodeSessionStore,
          workspacePath: refresh.workspacePath,
          workspaceIdentity: refresh.workspaceIdentity,
          taskId: refresh.taskId,
          configOptions: refresh.configOptions,
        });
      }
      zcodeSessionStore.setTaskRuntimeState(
        refresh.workspacePath,
        refresh.taskId,
        resolveBotTaskBroadcastRuntimeStatus(refresh.event),
        undefined,
        refresh.workspaceIdentity,
      );
      if (refresh.task) {
        // Bugfix: Bot state changes previously triggered a full refetch through bumpTaskListVersion.
        // Consecutive prompt_sent / completed events repeatedly changed the sidebar queryKey, briefly invalidating the old cache and causing list flicker.
        // When task metadata is available, write incrementally to the task/query cache; keep full-table refresh only as a fallback for older broadcasts without metadata.
        const membership = { pinned: false, archived: false };
        if (refresh.event === "created") {
          insertTaskIntoTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
          });
        } else {
          syncTaskMetaToTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
            ensureInWorkspaceTaskCache: true,
          });
        }
      }
      // prompt_sent no longer writes a user message into the renderer’s local store: Bot messages
      // enter the session event log through v4 commands, so the conversation projection subscribed to that session
      // displays them naturally; local message assembly (zcodeChatMessages) was retired with the old ChatView.
      if (refresh.event === "permission_request" && refresh.permissionRequest) {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.permissionRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "permission_resolved" && refresh.requestId) {
        zcodeSessionStore.removeTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_request" && refresh.elicitationRequest) {
        // Bugfix: After the Bot channel consumes AskUserQuestion, the next question first arrives only at the Bot runtime.
        // The current UI window may not subscribe to the same ZCode Agent stream, so explicitly write the new elicitation_request back to the store.
        zcodeSessionStore.setTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.elicitationRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_resolved" && refresh.requestId) {
        // Bugfix: When a Bot submits an AskUserQuestion response for the user, the current UI window may not receive the ZCode Agent stream’s
        // elicitation_response. Explicitly synchronize requestId dequeue through bots:task so the Q&A dialog does not remain open indefinitely.
        zcodeSessionStore.removeTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "completed" || refresh.event === "error") {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          null,
          refresh.workspaceIdentity,
        );
      }
      if (shouldRefreshBotTaskList(refresh.event, Boolean(refresh.task))) {
        zcodeSessionStore.bumpTaskListVersion(refresh.workspacePath, refresh.workspaceIdentity);
      }
    });
    return () => disposable.dispose();
  }, [services.broadcastService, tabStoreApi]);
}
