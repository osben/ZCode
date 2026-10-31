import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  ErrorPayloadRole,
  projectExecutionErrorPayload,
  withErrorPayloadRole,
} from "../../errors/error-payload.js";
import { isModelContextExceededError } from "./model-errors.js";

export { projectExecutionErrorPayload } from "../../errors/error-payload.js";

interface TurnAbortScope {
  dispose: () => void;
  signal: AbortSignal;
}

const EXTERNAL_TURN_FAULT_MARKER = "zcode.externalTurnFault";
const PRESERVE_QUEUE_AUTO_DRAIN_CANCEL_MARKER = "zcode.preserveQueueAutoDrainOnCancel";

/**
 * Abort reason for a caller-controller cancel. preserveQueueAutoDrainOnCancel=true (Steer) attaches the no-hold
 * intent as a non-enumerable marker, so it stays out of JSON and cause logs. A Stop never attaches it.
 */
export function createTurnCancelReason(
  message: string,
  options: { preserveQueueAutoDrainOnCancel: boolean },
): Error {
  const error = new Error(message);
  if (options.preserveQueueAutoDrainOnCancel) {
    Object.defineProperty(error, "zcodeCancelIntent", {
      value: PRESERVE_QUEUE_AUTO_DRAIN_CANCEL_MARKER,
      enumerable: false,
    });
  }
  return error;
}

/** Walks the cause chain like findExternalTurnFault; true when the abort reason carries the steer intent. */
export function hasPreserveQueueAutoDrainCancelIntent(reason: unknown): boolean {
  let current = reason;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.zcodeCancelIntent === PRESERVE_QUEUE_AUTO_DRAIN_CANCEL_MARKER) return true;
    current = record.cause;
  }
  return false;
}

interface ExternalTurnFaultError extends Error {
  code: string;
  zcodeTurnFault: typeof EXTERNAL_TURN_FAULT_MARKER;
}

/** Narrow entry the host uses to abort a turn while requiring core to persist a TurnError rather than a user cancel. */
export function createExternalTurnFaultError(code: string, message = code): Error {
  return Object.assign(new Error(message), {
    code,
    zcodeTurnFault: EXTERNAL_TURN_FAULT_MARKER as typeof EXTERNAL_TURN_FAULT_MARKER,
  }) satisfies ExternalTurnFaultError;
}

/** Whether the abort reason is a host-side external fault (e.g. projection limit exceeded). */
export function isExternalTurnFault(reason: unknown): boolean {
  return findExternalTurnFault(reason) !== null;
}

function findExternalTurnFault(error: unknown): ExternalTurnFaultError | null {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.zcodeTurnFault === EXTERNAL_TURN_FAULT_MARKER &&
      typeof record.code === "string" &&
      current instanceof Error
    ) {
      return current as ExternalTurnFaultError;
    }
    current = record.cause;
  }
  return null;
}

export function createTurnAbortScope(parentSignal?: AbortSignal): TurnAbortScope {
  const controller = new AbortController();

  const abortTurn = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal?.aborted) {
    abortTurn();
    return { dispose: () => {}, signal: controller.signal };
  }

  parentSignal?.addEventListener("abort", abortTurn, { once: true });

  return {
    dispose: () => {
      parentSignal?.removeEventListener("abort", abortTurn);
    },
    signal: controller.signal,
  };
}

export function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createTurnCancelledError(signal.reason);
}

export function createTurnFailureError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  fallbackMessage: string,
) {
  const externalFault = findExternalTurnFault(abortSignal?.reason) ?? findExternalTurnFault(error);
  if (externalFault) {
    return createCoreError(CoreErrorType.UnknownError, externalFault.message, {
      cause: externalFault,
      recoverable: true,
    });
  }
  if (isTurnCancellationError(error, abortSignal)) {
    return createTurnCancelledError(error);
  }

  if (
    isCoreError(error) &&
    (error.type === CoreErrorType.ModelContextExceeded ||
      (fallbackMessage === "Turn execution failed" && error.type === CoreErrorType.ModelError))
  ) {
    return error;
  }

  if (isModelContextExceededError(error)) {
    return createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Model request exceeded the provider context window.",
      { cause: error instanceof Error ? error : undefined, recoverable: true, retryable: true },
    );
  }

  return createCoreError(CoreErrorType.UnknownError, fallbackMessage, {
    cause: error instanceof Error ? error : undefined,
    // A turn-level UnknownError is only a uniform lifecycle wrapper; the UI / error payload
    // must show the user-readable root cause from the underlying provider/tool, so generic text must not take over the summary.
    context: withErrorPayloadRole(undefined, ErrorPayloadRole.Wrapper),
  });
}

export function createTurnCancelledError(error: unknown) {
  if (isCoreError(error) && error.type === CoreErrorType.TurnCancelled) {
    return error;
  }

  return createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.", {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}

// A user-initiated interrupt (TurnCancelled) is a normal end and must not be recorded as an error.
// The turn/compact/rewind catches all used to emit TurnError unconditionally, which reducers/UI/desktop
// uniformly mapped to turn.failed (status:error plus an appended error message).
// Unified here: on cancellation emit TurnComplete(resultType:"cancelled") instead so state returns
// cleanly to idle; only real errors emit TurnError.
// Callers remain responsible for rethrowing coreError upward and recording usage.
export async function appendTurnOutcomeEvent(
  runtime: AgentRuntimeInternal,
  params: {
    coreError: ReturnType<typeof createTurnFailureError>;
    events: SessionEvent[];
    durationMs: number;
    turnPhase: string;
    inputId?: string;
    highspeedCardId?: string;
    highspeedFallbackUnavailable?: boolean;
    traceContext: TraceContext;
    fallbackMessage: string;
    logEvent: string;
    logLabel: string;
    preserveQueueAutoDrainOnCancel?: boolean;
    backgroundSubagentResultConsumed?: boolean;
    workflowResultConsumed?: boolean;
    historyRoundCount?: number;
  },
): Promise<void> {
  const { coreError, events, traceContext, turnPhase, inputId } = params;
  const cancelled = coreError.type === CoreErrorType.TurnCancelled;
  const externalFault = findExternalTurnFault(coreError);
  const projectedError = projectExecutionErrorPayload(coreError, params.fallbackMessage);

  const outcomeEvent = cancelled
    ? runtime.createEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(events),
          toolCallCount: 0,
          historyRoundCount: params.historyRoundCount ?? 0,
          duration: params.durationMs,
          resultType: "cancelled",
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          ...(params.preserveQueueAutoDrainOnCancel
            ? { preserveQueueAutoDrainOnCancel: true }
            : {}),
        },
        traceContext,
      )
    : runtime.createEvent(
        SessionEventType.TurnError,
        {
          error: {
            type: externalFault?.code ?? coreError.type,
            // coreError.message is often generic; the real provider/network cause hides in the cause chain.
            // Write readable payload fields so both the desktop and the recovery path can show the root cause.
            ...projectedError,
            attribution: {
              ...projectedError.attribution,
              // Bug root cause: no userInput row exists at creation time. Every new error publishes
              // string/null so the renderer can tell a "normal turn" from an "older agent without this field".
              highspeedCardId: params.highspeedCardId ?? null,
              // With nowhere to fall back there is no fallback event, and a request-phase failure's code is a
              // provider error code (e.g. 3402); the renderer cannot infer card fallback from error codes.
              // Core publishes "attributed with no fallback available" as a structured fact.
              ...(params.highspeedFallbackUnavailable
                ? { highspeedFallbackUnavailable: true }
                : {}),
            },
            stack: coreError.stack,
          },
          turnPhase,
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        },
        traceContext,
      );
  await runtime.appendEvent(outcomeEvent, traceContext);
  events.push(outcomeEvent);

  runtime.logger?.error(`${params.logLabel} failed`, coreError, {
    ...traceContextToLogContext(traceContext),
    event: params.logEvent,
    module: "core.runtime",
    status: cancelled ? "cancelled" : "failed",
    turnPhase,
  });
}

export function isTurnCancellationError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (findExternalTurnFault(abortSignal?.reason) || findExternalTurnFault(error)) return false;
  if (abortSignal?.aborted) return true;

  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.TurnCancelled) {
      return true;
    }

    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (
      type === CoreErrorType.TurnCancelled ||
      code === CoreErrorType.TurnCancelled ||
      code === "MODEL_REQUEST_CANCELLED" ||
      code === "model_request_cancelled" ||
      code === "ABORT_ERR" ||
      name === "AbortError"
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}
