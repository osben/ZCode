import type { ZCodeTrajectoryV2ToolStatus, ZCodeTrajectoryV2ToolTiming } from "../contract.js";
import { asNumber, asString, type UnknownRecord } from "./values.js";

const STATUSES: readonly ZCodeTrajectoryV2ToolStatus[] = [
  "running",
  "completed",
  "error",
  "cancelled",
];

/** Rows of the CLI `tool_usage` table to timing entries; malformed rows are skipped. */
export function toToolTimings(rows: readonly UnknownRecord[]): ZCodeTrajectoryV2ToolTiming[] {
  const entries: ZCodeTrajectoryV2ToolTiming[] = [];
  for (const row of rows) {
    const toolCallId = asString(row.tool_call_id);
    const scheduledAt = asNumber(row.started_at);
    if (!toolCallId || scheduledAt === undefined) continue;
    const status = asString(row.status) as ZCodeTrajectoryV2ToolStatus | undefined;
    const entry: ZCodeTrajectoryV2ToolTiming = {
      toolCallId,
      toolName: asString(row.tool_name) ?? "tool",
      status: status && STATUSES.includes(status) ? status : "running",
      scheduledAt,
    };
    const approvalStatus = asString(row.approval_status);
    if (approvalStatus) entry.approvalStatus = approvalStatus;
    const turnId = asString(row.turn_id);
    if (turnId) entry.turnId = turnId;
    const errorType = asString(row.error_type);
    if (errorType) entry.errorType = errorType;

    const completedAt = asNumber(row.completed_at);
    const durationMs = asNumber(row.duration_ms);
    // started_at is the scheduling time (it includes permission wait); execution starts duration_ms before completion.
    if (completedAt !== undefined && durationMs !== undefined && durationMs >= 0) {
      entry.execEndedAt = completedAt;
      entry.execDurationMs = durationMs;
      entry.execStartedAt = Math.max(scheduledAt, completedAt - durationMs);
    }
    entries.push(entry);
  }
  return entries;
}
