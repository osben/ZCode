import {
  executionOutputPreviewSchema,
  type ConversationDelta,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallProgressPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";

/** Progress may update only a running Bash; do not create a row or revive a terminal/background task. */
export function projectToolActivity(
  event: SessionEvent,
  row: ToolCallRow | undefined,
): ConversationDelta[] {
  if (!row) return [];
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          status: "running",
          startedAt: event.timestamp.getTime(),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
    ];
  }
  if (row.toolName !== "Bash" || row.status !== "running" || row.backgrounded) return [];
  const parsed = executionOutputPreviewSchema.safeParse(
    (event.payload as ToolCallProgressPayload).outputPreview,
  );
  if (!parsed.success) return [];
  return [{ op: "row.upserted", row: { ...row, outputPreview: parsed.data } }];
}

/** Clear the preview within the projection transaction for result/error, Stop, backgrounding, and turn completion. */
export function clearSettledOutputPreviews(deltas: ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (
      (delta.op !== "row.upserted" && delta.op !== "row.appended") ||
      delta.row.kind !== "toolCall" ||
      !delta.row.outputPreview ||
      (delta.row.status === "running" && !delta.row.backgrounded)
    )
      return delta;
    const { outputPreview: _preview, ...row } = delta.row;
    return { ...delta, row };
  });
}
