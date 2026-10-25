// Adapter from v4 ToolCallRow to the legacy ToolCallBlocks input shape (TaskChatToolCallTreeNode).
// Pure function: ToolCallBlock and its renderers (execute/read/edit/...) consume the legacy ZCode Agent
// TaskChatToolCall shape; each v4 row is self-contained, so fields map one-to-one without looking at other rows.
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";

// v4 status → legacy ChatToolCall.status (input vocabulary for mapToolStatus):
// pending/in_progress/completed/failed/stopped）。
// Treat pendingApproval as pending: approval input is already settled, and the row is shown as awaiting execution.
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** If input is absent, reconstruct full or partial streaming tool-argument preview from v4 inputText. */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const legacyStatus = STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // Structured display facts such as CUA live in output.display; top-level display is only the legacy Node REPL image channel.
  // Prefer canonical output while preserving compatibility with old snapshots and Browser turn-tail screenshots.
  const display = row.output?.display ?? row.display;
  // Historical CUA v1 display duplicates input; the tool-call row already owns the single input copy, so drop the old duplicate during adaptation.
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // ACP tool calls carry their own title; ZCode tools have none and keep the generic label.
      ...(row.title ? { title: row.title } : {}),
      // Keep kind compatible with the old aggregate categories: v4 has no legacy ZCode Agent snapshot shape, so use the fixed tool name directly.
      kind: row.toolName,
      input: inputPreview.input,
      status: legacyStatus,
      output: row.output?.text,
      // V4 ToolCallRow has no legacy taskNotification raw; terminal background Agent summaries
      // live only in output. The Agent renderer displays content, so bridge it explicitly on Agent/Task
      // rows to avoid showing an empty card when failure details are present in the projection.
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // A v4 row is a self-contained projection; some providers place tool failure text only in output,
      // and without restoring legacy error, ToolOutput cannot display the failure reason and shows only an empty failed summary card.
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        // R7: Running progress (MCP notifications/progress) is consumed by the progress bar in the McpToolCallBlock header.
        ...(row.progress ? { progress: row.progress } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
    },
    // A subagent does not embed child rows; v4 tool rows have no subtree, and nested tools in the legacy shape
    // are also represented by independent rows (subagent/toolCall).
    childToolCalls: [],
  };
}
