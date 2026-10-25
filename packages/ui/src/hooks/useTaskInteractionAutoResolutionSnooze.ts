import { useCallback, useRef } from "react";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

interface TaskConversationCommandTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

type TaskConversationCommandSender = (envelope: CommandEnvelope) => Promise<CommandAck>;

/**
 * Sidebar tasks may come from local/remote, timeline, or pinned lists. Resolve the original Host by workspace identity
 * for conversation commands; do not send them to the current window's service just because a different tab is active.
 * Returns null while the target Host is not attached.
 */
function useTaskConversationCommandSender(
  target: TaskConversationCommandTarget,
): TaskConversationCommandSender | null {
  const contextServices = useOptionalServices();
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = target.remoteSessionId?.trim() || undefined;
  const isRemoteTarget = Boolean(workspaceIdentity || remoteSessionId);
  const selectTargetServices = useCallback(
    (state: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>) => {
      if (!isRemoteTarget) {
        return state.baseServices ?? contextServices;
      }

      const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
        {
          workspacePath: target.workspacePath,
          workspaceIdentity,
          remoteSessionId,
          // This hook's target type carries only task-routing fields. The presence of remoteSessionId is enough to show
          // that legacy data may use path-compatible recovery; do not fabricate a specific RemoteTarget.
          remoteTarget: remoteSessionId ? true : undefined,
        },
        state,
      );
      if (resolvedRemoteSessionId) {
        return state.sessionsById[resolvedRemoteSessionId]?.services ?? null;
      }
      // If the original Host for a remote task cannot be found, do not fall back to the local service; the same taskId
      // could be sent to the wrong workspace. Keep a retryable failure and wait for the remote attachment to recover.
      return null;
    },
    [contextServices, isRemoteTarget, remoteSessionId, target.workspacePath, workspaceIdentity],
  );
  const agentService = useRemoteWorkspaceSessionStore(selectTargetServices)?.zcodeAgentService;
  const send = useCallback<TaskConversationCommandSender>(
    async (envelope) => {
      if (!agentService) throw new Error("task-conversation-command.target-unavailable");
      await ensureAgentV4ConnectionHandshake(agentService);
      return agentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        envelope,
      });
    },
    [agentService, target.workspacePath, workspaceIdentity],
  );
  return agentService ? send : null;
}

export interface TaskInteractionAutoResolutionTarget extends TaskConversationCommandTarget {
  sessionId: string;
}

/** Sidebar pause command, routed to the task's own Host (see useTaskConversationCommandSender). */
export function useTaskInteractionAutoResolutionSnooze(
  target: TaskInteractionAutoResolutionTarget,
) {
  const loggedInteractionIdsRef = useRef(new Set<string>());
  const sendCommand = useTaskConversationCommandSender(target);
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;

  return useCallback(
    async (interactionId: string): Promise<boolean> => {
      if (!sendCommand) {
        logger.warn("[task-interaction] 暂停自动结束时目标 workspace 未连接", {
          interactionId,
          sessionId: target.sessionId,
          workspaceKey: workspaceIdentity ?? target.workspacePath,
        });
        return false;
      }
      if (!loggedInteractionIdsRef.current.has(interactionId)) {
        loggedInteractionIdsRef.current.add(interactionId);
        logger.debug("[task-interaction] 用户从侧栏请求暂停自动结束", {
          interactionId,
          sessionId: target.sessionId,
          source: "taskBadge",
        });
      }

      return sendInteractionAutoResolutionSnooze({
        sessionId: target.sessionId,
        interactionId,
        source: "taskBadge",
        sendCommand,
      });
    },
    [sendCommand, target.sessionId, target.workspacePath, workspaceIdentity],
  );
}
