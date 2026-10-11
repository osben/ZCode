import { resolveWorkspaceKey, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";

const IDENTITY_QUERY_BATCH_SIZE = 64;

/** Older versions added cold-restored children to the main list; clean up only derived indexes with confirmed authoritative identity, not Agent transcripts. */
export async function repairSubagentTaskIndex(params: {
  target: ZCodeAgentWorkspaceTarget;
  visibleSessionIds: ReadonlySet<string>;
  agentService: Pick<IZCodeAgentService, "listSessions">;
  taskIndexRepo: Pick<TaskIndexRepo, "listTaskMetas" | "updateTaskState">;
  isCurrent: () => boolean;
  onRemoved: () => void;
}): Promise<void> {
  const { target, taskIndexRepo, agentService, isCurrent } = params;
  const rows = await taskIndexRepo.listTaskMetas({ ...target, provider: ZCODE_AGENT_PROVIDER });
  const ids = rows
    .filter((row) => !params.visibleSessionIds.has(row.taskId))
    .map((row) => row.taskId);
  for (let offset = 0; offset < ids.length; offset += IDENTITY_QUERY_BATCH_SIZE) {
    if (!isCurrent()) return;
    const batch = ids.slice(offset, offset + IDENTITY_QUERY_BATCH_SIZE);
    const sessions = await agentService.listSessions({
      ...target,
      sessionIds: batch,
      includeArchived: true,
      runtimePolicy: "existing-only",
    });
    // Older Agents fail directly when they do not support the parameter; missing records, cross-identity results, and expired subscriptions are not grounds to infer deletion.
    for (const session of sessions) {
      if (!isCurrent()) return;
      if (
        session.sessionKind !== "subagent_child" ||
        !batch.includes(session.sessionId) ||
        resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(target)
      )
        continue;
      await taskIndexRepo.updateTaskState({
        ...target,
        taskId: session.sessionId,
        patch: { deleted: true },
      });
      if (isCurrent()) params.onRemoved();
    }
  }
}
