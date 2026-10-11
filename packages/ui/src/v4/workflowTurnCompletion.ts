import type { TurnHeaderRow, WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";

/**
 * Completion-card parsing: determine whether this turn is the one in which the main agent consumed a
 * **completed** workflow notification. Pure function, following the same seam as `resolveWorkflowTurnDigests`.
 *
 * Require all three: a background-result turn, workflow source, and terminal payload with `status === "completed"`.
 * Do not render a card for failed / cancelled (the notification row already reports the error and shows any partial artifact chips); escalation notices, batch turns (payload
 * entirely absent), and bash / subagent notifications do not qualify.
 *
 * **Use the notification payload as the base for the artifact list**: it is persisted with the notification and survives cold recovery; projection / journal only
 * add byte count, source, and board spec.
 */
export type WorkflowTerminalNotification = Extract<WorkflowNotificationMeta, { kind: "terminal" }>;

export interface WorkflowTurnCompletion {
  runId: string;
  /** Notification title (CLI's workflowTaskSubject, not localized), from the same source as the notification row's primaryText. */
  name: string;
  /** Wall-clock time in the notification; if absent, show `—` in the time cell. */
  durationMs?: number;
  artifacts: NonNullable<WorkflowTerminalNotification["artifacts"]>;
  /** Truncated at emission (over 8 or filtered), so the overflow count may be underreported. */
  artifactsTruncated: boolean;
  /** Run joined from the projection; if absent (evicted by the 8-item limit), show `—` in all three cells and omit ⤢. Restart no longer makes it absent: CLI cold materialization replays the projection from the journal. */
  summary: WorkflowRunCardSummary | undefined;
}

export function resolveWorkflowTurnCompletion(
  header: TurnHeaderRow | undefined,
  join: { byRunId?: ReadonlyMap<string, WorkflowRunCardSummary> },
): WorkflowTurnCompletion | undefined {
  if (header?.origin !== "backgroundResult") return undefined;
  const originMeta = header.originMeta;
  if (originMeta?.backgroundSource !== "workflow") return undefined;
  const notification = originMeta.workflowNotification;
  if (notification?.kind !== "terminal" || notification.status !== "completed") return undefined;
  const name = originMeta.title.trim();
  if (name.length === 0) return undefined;
  return {
    runId: originMeta.workId,
    name,
    ...(notification.durationMs === undefined ? {} : { durationMs: notification.durationMs }),
    artifacts: notification.artifacts ?? [],
    artifactsTruncated: notification.artifactsTruncated === true,
    summary: join.byRunId?.get(originMeta.workId),
  };
}
