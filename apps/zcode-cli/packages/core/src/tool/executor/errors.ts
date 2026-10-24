import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import type { ErrorAttribution } from "@zcode/contracts";
import { projectExecutionErrorPayload } from "../../errors/error-payload.js";
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
  // User feedback for ExitPlanMode / workflow Refine is temporarily stored in
  // PermissionDenied.message and later passed unchanged as steer input. Do not truncate
  // it in the display summarizer, or oversized feedback will not trigger input_too_large.
  // Preserve free-form feedback attached to ordinary denials (preserveReasonFormatting)
  // unchanged for the same reason.
  const message =
    reasonSource !== undefined || options?.preserveReasonFormatting === true
      ? error.message
      : projectedError.message;
  // Without the provider's terminal facts the parent model invents causes and retry plans
  // for a failed child (e.g. 405/3012 read as a concurrency limit). Stored as modelContent
  // so persistence and cold resume replay the same text the live run sent.
  const providerFactsLine =
    ownModelContent === undefined && reasonSource === undefined
      ? formatTerminalProviderFailureFacts(projectedError.attribution)
      : undefined;
  const modelContent =
    ownModelContent ?? (providerFactsLine ? `${message}\n\n${providerFactsLine}` : undefined);
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
  const { providerErrorCode, retryable, statusCode } = attribution;
  const subset: ToolErrorAttribution = {
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
  return Object.keys(subset).length > 0 ? subset : undefined;
}

function formatTerminalProviderFailureFacts(
  attribution: ErrorAttribution | undefined,
): string | undefined {
  // Every CoreError defaults to retryable=false, so only an explicit provider source marks a
  // terminal upstream failure; tool or runtime errors must not be labelled as provider facts.
  if (attribution?.source !== "provider" || attribution.retryable !== false) return undefined;
  const { providerErrorCode, statusCode } = attribution;
  if (providerErrorCode === undefined && statusCode === undefined) return undefined;
  const parts = [
    ...(statusCode !== undefined ? [`status=${statusCode}`] : []),
    ...(providerErrorCode !== undefined ? [`provider_error_code=${providerErrorCode}`] : []),
    "retryable=false",
  ];
  return `Provider failure: ${parts.join(" ")}`;
}

/** True when createErrorResult built modelContent from terminal provider facts. */
export function hasProviderFailureModelContent(result: ToolExecutionResult): boolean {
  return (
    typeof result.modelContent === "string" &&
    result.error !== undefined &&
    result.modelContent.startsWith(`${result.error.message}\n\nProvider failure: `)
  );
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
