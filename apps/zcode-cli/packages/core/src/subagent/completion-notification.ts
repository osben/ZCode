import {
  dropTrailingHighSurrogate,
  type ModelUsage,
  type SubagentResultMeta,
  type SubagentStopOptions,
} from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

export type LocalAgentTaskNotificationStatus = "completed" | "failed" | "killed";

const UNKNOWN_ERROR = "Unknown error";
/** Cap for the structured error, same as the workflow row's error. */
const SUBAGENT_RESULT_ERROR_MAX_CHARS = 2_000;

export interface LocalAgentTaskNotificationInput {
  agentId: string;
  description: string;
  error?: string;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  /** Who stopped it when killed; absence means a system stop. */
  stoppedBy?: SubagentStopOptions["initiator"];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(
  input: LocalAgentTaskNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    summary: `Agent "${input.description}" ${formatLocalAgentOutcome(input)}`,
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    // Only completed notifications carry <usage>; failed / killed do not.
    usage:
      input.status === "completed"
        ? {
            durationMs: input.totalDurationMs,
            modelUsage: input.usage,
            toolUseCount: input.totalToolUseCount,
            totalTokens: input.totalTokens,
          }
        : undefined,
  });
}

/**
 * Structured final state generated from the same input as the notification text, delivered
 * with originMeta. The App's "execution failed" hover reads the error here instead of parsing
 * the summary text.
 */
export function localAgentSubagentResult(
  input: Pick<LocalAgentTaskNotificationInput, "error" | "status">,
): SubagentResultMeta {
  return input.status === "failed"
    ? { status: "failed", error: boundStructuredError(failureReason(input.error)) }
    : { status: input.status };
}

// Fix rationale: the structured error enters the turn header and every frame snapshot via
// originMeta; copying an over-long provider message verbatim would bloat snapshots and
// persisted metadata. Truncate only here; the model-visible summary stays full text.
function boundStructuredError(error: string): string {
  if (error.length <= SUBAGENT_RESULT_ERROR_MAX_CHARS) return error;
  return `${dropTrailingHighSurrogate(error.slice(0, SUBAGENT_RESULT_ERROR_MAX_CHARS - 1))}…`;
}

// Fix rationale: with an `||` fallback, a whitespace-only error never became Unknown error;
// the summary ended with "failed: " plus whitespace, and the hover showed blank.
function failureReason(error: string | undefined): string {
  return error?.trim() ? error : UNKNOWN_ERROR;
}

// Summary wording. The failure reason follows "failed: " directly, identical to
// localAgentSubagentResult's error.
function formatLocalAgentOutcome(
  input: Pick<LocalAgentTaskNotificationInput, "error" | "status" | "stoppedBy">,
): string {
  if (input.status === "completed") return "finished";
  if (input.status === "failed") return `failed: ${failureReason(input.error)}`;
  // TaskStop means the model stopped itself.
  if (input.stoppedBy === "model") return "was stopped by ZCode";
  if (input.stoppedBy === "user") return "was stopped by user";
  return "was stopped";
}
