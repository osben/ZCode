// Map sessions-index SessionSummary → live sidebar detail ZCodeTaskMeta.
// These objects do not independently determine list-row existence; the persistent rows from tasks-index.sqlite are joined as the left side later.
// Note: summary.sessionEnded means “successful turn settled” (true for completedSuccess), not deletion;
// session.removed only removes live detail, while persistent-row deletion is still determined by the tasks-index row/tombstone.
import type { TraceId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  attachTaskListRowActivity,
  type TaskListMetaWithActivity,
} from "@/v4/taskListRowActivity.js";

/** phase → persisted sidebar status (running/completed/error); draft has no result status. */
function phaseToStatus(phase: SessionSummary["phase"]): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined; // draft
  }
}

export interface MapSessionSummaryOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Existing local metadata (preserve manual title/provider and other old values so list refresh does not overwrite them). */
  previous?: ZCodeTaskMeta;
}

/**
 * SessionSummary → live detail ZCodeTaskMeta. Fields not carried by sessions-index
 * (traceId/mode/provider) use reasonable defaults or reuse previous values; actual persisted fields come from the task row during the join.
 */
export function mapSessionSummaryToTaskMeta(
  summary: SessionSummary,
  options: MapSessionSummaryOptions,
): TaskListMetaWithActivity {
  const previous = options.previous;
  const status = phaseToStatus(summary.phase);
  const summaryTitleIsCustom = summary.titleSource === "custom";
  // If the old task-index already has a manual title with titleOverridden=true,
  // the sessions-index cold-start summary may still contain the first_input/generated title. Treat summary.title as the new manual-title authority only when the v4 session
  // store explicitly marks it custom.
  const title =
    previous?.titleOverridden === true && !summaryTitleIsCustom
      ? previous.title
      : summary.title || previous?.title || "";
  const titleOverridden =
    summaryTitleIsCustom || previous?.titleOverridden === true ? true : undefined;
  return attachTaskListRowActivity(
    {
      taskId: summary.sessionId,
      traceId: (previous?.traceId ?? `session-${summary.sessionId}`) as TraceId,
      title,
      ...(titleOverridden ? { titleOverridden } : {}),
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      createdAt: summary.createdAt || previous?.createdAt || 0,
      updatedAt: summary.lastActivityAt || previous?.updatedAt || 0,
      mode: previous?.mode ?? "default",
      ...(previous?.model ? { model: previous.model } : {}),
      ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
      ...(previous?.provider ? { provider: previous.provider as ZCodeProvider } : {}),
      ...(status ? { status } : {}),
      ...(summary.pendingInteraction
        ? {
            pendingInteraction: {
              interactionId: summary.pendingInteraction.interactionId,
              kind: summary.pendingInteraction.kind,
              ...(summary.pendingInteraction.toolName
                ? { toolName: summary.pendingInteraction.toolName }
                : {}),
              ...(summary.pendingInteraction.autoResolution
                ? { autoResolution: summary.pendingInteraction.autoResolution }
                : {}),
            },
          }
        : {}),
      ...(previous?.unreadAt ? { unreadAt: previous.unreadAt } : {}),
    },
    {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  );
}
