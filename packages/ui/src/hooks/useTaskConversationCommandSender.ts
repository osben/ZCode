import { useCallback } from "react";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

export interface TaskConversationCommandTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type TaskConversationCommandSender = (envelope: CommandEnvelope) => Promise<CommandAck>;

/**
 * Sidebar tasks may come from local/remote, timeline, or pinned lists. Resolve the original Host by workspace identity
 * for conversation commands; do not send them to the current window's service just because a different tab is active.
 * Returns null while the target Host is not attached.
 */
export function useTaskConversationCommandSender(
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
