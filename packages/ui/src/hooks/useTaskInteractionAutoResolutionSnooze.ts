import { useCallback, useRef } from "react";
import { logger } from "@/logger.js";
import {
  useTaskConversationCommandSender,
  type TaskConversationCommandTarget,
} from "@/hooks/useTaskConversationCommandSender.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

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
