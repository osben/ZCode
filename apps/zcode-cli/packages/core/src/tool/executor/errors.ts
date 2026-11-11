import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import type { ErrorAttribution } from "@zcode/contracts";
import {
  projectExecutionErrorPayload,
  selectExecutionErrorMessage,
} from "../../errors/error-payload.js";
import { truncateMiddleForModel } from "../result-persistence-format.js";
import type {
  ExecutableToolCall,
  ToolErrorAttribution,
  ToolExecutionResult,
  ToolHandlerFailure,
} from "../types.js";
import { getInitialInputValidationModelContent } from "./validation.js";

export function createErrorResult(
  toolCall: ExecutableToolCall,
  error: Error,
  durationMs?: number,
  options?: {
    /** 工具补充给模型的说明，接在模型可见原文之后；不改 `error.message`。 */
    modelNote?: string;
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
  const ownModelContent =
    getInitialInputValidationModelContent(error) ??
    (handlerFailure ? `<tool_use_error>${handlerFailure.message}</tool_use_error>` : undefined);
  // Subagent/turn/model errors often wrap the provider's actual cause in a cause chain.
  // The tool result is shared by the parent model and UI hover, so project it to a
  // readable summary here.
  const projectedError = projectExecutionErrorPayload(error);
  const attribution = toToolErrorAttribution(projectedError.attribution);
  const reasonSource =
    isCoreError(error) &&
    (error.context?.reasonSource === "plan_approval_feedback" ||
      error.context?.reasonSource === "workflow_refine_feedback")
      ? error.context.reasonSource
      : undefined;
  const preservesReason = reasonSource !== undefined || options?.preserveReasonFormatting === true;
  // User feedback for ExitPlanMode / workflow Refine is temporarily stored in
  // PermissionDenied.message and later passed unchanged as steer input. Do not truncate
  // it in the display summarizer, or oversized feedback will not trigger input_too_large.
  // Preserve free-form feedback attached to ordinary denials (preserveReasonFormatting)
  // unchanged for the same reason.
  const message = preservesReason ? error.message : projectedError.message;
  // Other errors reach the model as the original text of the same frame: keep newlines and
  // truncate the middle only past 10k characters; not stored separately when equal to the summary.
  // Fix reason: when the model received the UI summary, whitespace was collapsed and it was cut
  // at 500 characters, losing the details of multi-line errors.
  const errorText = preservesReason
    ? undefined
    : truncateMiddleForModel(selectExecutionErrorMessage(error));
  const fullErrorText = errorText !== undefined && errorText !== message ? errorText : undefined;
  // Without the provider's terminal facts the parent model invents causes and retry plans
  // for a failed child (e.g. 405/3012 read as a concurrency limit). Stored as modelContent
  // so persistence and cold resume replay the same text the live run sent.
  const providerFactsLine =
    ownModelContent === undefined && reasonSource === undefined
      ? formatTerminalProviderFailureFacts(attribution)
      : undefined;
  const errorModelContent =
    ownModelContent ??
    (providerFactsLine ? `${fullErrorText ?? message}\n\n${providerFactsLine}` : fullErrorText);
  // Tool-supplied notes follow the model-visible original text; without a separate model text the model sees message.
  const modelContent = options?.modelNote
    ? `${errorModelContent ?? message}\n\n${options.modelNote}`
    : errorModelContent;
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    error: {
      type: isCoreError(error) ? error.type : error.name,
      message,
      ...(attribution ? { attribution } : {}),
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

function toToolErrorAttribution(
  attribution: ErrorAttribution | undefined,
): ToolErrorAttribution | undefined {
  if (!attribution) return undefined;
  const { providerErrorCode, retryable, source, statusCode } = attribution;
  if (providerErrorCode === undefined && retryable === undefined && statusCode === undefined) {
    return undefined;
  }
  return {
    ...(source !== undefined ? { source } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

/**
 * A terminal upstream failure whose facts the parent model should see. Every CoreError defaults to
 * retryable=false, so only an explicit provider source marks it; tool or runtime errors must not be
 * labelled as provider facts. Callers branch on this structured check, never on the rendered text.
 */
function isTerminalProviderFailure(attribution: ToolErrorAttribution | undefined): boolean {
  return (
    attribution?.source === "provider" &&
    attribution.retryable === false &&
    (attribution.statusCode !== undefined || attribution.providerErrorCode !== undefined)
  );
}

function formatTerminalProviderFailureFacts(
  attribution: ToolErrorAttribution | undefined,
): string | undefined {
  if (!attribution || !isTerminalProviderFailure(attribution)) return undefined;
  const { providerErrorCode, statusCode } = attribution;
  const parts = [
    ...(statusCode !== undefined ? [`status=${statusCode}`] : []),
    ...(providerErrorCode !== undefined ? [`provider_error_code=${providerErrorCode}`] : []),
    "retryable=false",
  ];
  return `Provider failure: ${parts.join(" ")}`;
}

/**
 * Spec 0.15: appends the tool-supplied reconciliation note to timeout and in-flight cancellation errors.
 *
 * Only these two errors are matched: only they can interrupt the handler after the request may already
 * have been accepted. An error the handler throws itself happens where it can return a structured
 * result, so it is not matched here. The annotated error is a new error of the same type that copies the
 * original's fields; the original object is not mutated (a handler-thrown error may be shared), and no
 * extra cause layer is added, since that would repeat the text twice in the error details.
 */
export function annotateUnsettledCall(
  error: Error,
  entry: { describeUnsettledCall?: (input: unknown, toolCallId: string) => string | undefined },
  input: unknown,
  toolCallId: string,
): Error {
  if (!isCoreError(error)) return error;
  if (error.type !== CoreErrorType.ToolTimeout && error.type !== CoreErrorType.ToolCancelled) {
    return error;
  }
  const note = entry.describeUnsettledCall?.(input, toolCallId);
  if (!note) return error;
  const annotated = createCoreError(error.type, `${error.message} ${note}`, {
    ...(error.cause instanceof Error ? { cause: error.cause } : {}),
    ...(error.context ? { context: error.context } : {}),
    recoverable: error.recoverable,
    retryable: error.retryable,
  });
  annotated.stack = error.stack;
  return annotated;
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
