import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import { projectExecutionErrorPayload } from "../../errors/error-payload.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolHandlerFailure } from "../types.js";
import { getInitialInputValidationModelContent } from "./validation.js";

export function createErrorResult(
  toolCall: ExecutableToolCall,
  error: Error,
  durationMs?: number,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  const handlerFailure =
    isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure)
      ? error.context.toolHandlerFailure
      : undefined;
  // Building provider text by tool name in the generic error layer would create a
  // reverse dependency on concrete tools. Handlers return their own code/message; this
  // layer assembles the envelope and preserves the raw message for the UI and logs.
  const modelContent =
    getInitialInputValidationModelContent(error) ??
    (handlerFailure ? `<tool_use_error>${handlerFailure.message}</tool_use_error>` : undefined);
  // Subagent/turn/model errors often wrap the provider's actual cause in a cause chain.
  // The tool result is shared by the parent model and UI hover, so project it to a
  // readable summary here.
  const projectedError = projectExecutionErrorPayload(error);
  const reasonSource =
    isCoreError(error) &&
    (error.context?.reasonSource === "plan_approval_feedback" ||
      error.context?.reasonSource === "workflow_refine_feedback")
      ? error.context.reasonSource
      : undefined;
  // User feedback for ExitPlanMode / workflow Refine is temporarily stored in
  // PermissionDenied.message and later passed unchanged as steer input. Do not truncate
  // it in the display summarizer, or oversized feedback will not trigger input_too_large.
  // Preserve free-form feedback attached to ordinary denials (preserveReasonFormatting)
  // unchanged for the same reason.
  const message =
    reasonSource !== undefined || options?.preserveReasonFormatting === true
      ? error.message
      : projectedError.message;
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    error: {
      type: isCoreError(error) ? error.type : error.name,
      message,
      ...(handlerFailure
        ? { code: String(handlerFailure.errorCode) }
        : projectedError.code
          ? { code: projectedError.code }
          : {}),
      ...(projectedError.detail ? { detail: projectedError.detail } : {}),
      ...(reasonSource ? { reasonSource } : {}),
      stack: error.stack,
    },
    ...(modelContent === undefined ? {} : { modelContent }),
    durationMs: durationMs ?? 0,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

export function createToolHandlerFailureError(
  toolCall: ExecutableToolCall,
  failure: ToolHandlerFailure,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, failure.message, {
    context: {
      code: failure.errorCode,
      toolHandlerFailure: failure,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    recoverable: true,
  });
}

export function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ToolHandlerFailure>;
  return (
    candidate.result === false &&
    typeof candidate.errorCode === "number" &&
    Number.isFinite(candidate.errorCode) &&
    typeof candidate.message === "string"
  );
}

export function isToolHandlerFailureError(error: unknown): boolean {
  return isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure);
}

export function createPermissionErrorResult(
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  context: Record<string, unknown>,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  return createErrorResult(
    toolCall,
    createCoreError(
      CoreErrorType.PermissionDenied,
      reason ?? `Permission denied for ${toolCall.name}`,
      {
        context: {
          ...context,
          toolName: toolCall.name,
        },
        recoverable: true,
      },
    ),
    undefined,
    options,
  );
}
