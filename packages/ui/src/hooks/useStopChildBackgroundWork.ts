import { useCallback } from "react";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  useTaskConversationCommandSender,
  type TaskConversationCommandTarget,
} from "@/hooks/useTaskConversationCommandSender.js";

/**
 * Sidebar Stop for a running background subagent (spec sidebar-child-conversation-counts §8.3): the
 * same cancelBackgroundWork command the status panel sends, addressed to the parent session on its
 * own Host. The row changes only when the next parent summary arrives (no optimistic removal).
 */
export function useStopChildBackgroundWork(
  parent: TaskConversationCommandTarget & { sessionId: string },
  // Rows receive intl as a prop (no provider in every render path), so the owner localizes.
  failureMessage: string,
): (workId: string) => Promise<void> {
  const sendCommand = useTaskConversationCommandSender(parent);
  return useCallback(
    async (workId: string) => {
      const fail = (reason: string) => {
        logger.warn("[sidebar-child] 停止后台子代理失败", {
          parentSessionId: parent.sessionId,
          workId,
          reason,
        });
        toast(failureMessage);
      };
      if (!sendCommand) {
        fail("target-unavailable");
        return;
      }
      const envelope = createCommandEnvelope({
        type: "cancelBackgroundWork",
        sessionId: parent.sessionId,
        payload: { workId },
      });
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
          fail(ack.reasonCode ?? ack.status);
          return;
        }
        logger.info("[sidebar-child] 已请求停止后台子代理", {
          parentSessionId: parent.sessionId,
          workId,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    [failureMessage, parent.sessionId, sendCommand],
  );
}
