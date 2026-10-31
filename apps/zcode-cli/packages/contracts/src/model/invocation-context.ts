import type { RequestVerificationReason } from "@zcode/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
} from "./index.js";

/**
 * Capability tags the session has used; the adapter writes them into the attribution header
 * `x-zcode-session-features` (docs/design/v2/model/session-features-header.md).
 * The vocabulary is append-only with no renames; deprecated tags keep their constants and names are never reused. Values must be lowercase snake_case.
 */
export const ModelRequestSessionFeature = {
  /** Model code invoked the browser runtime via node_repl, success or not; the legacy path (core's built-in js tool) does not set it. */
  BrowserUse: "browser_use",
  /** Model code invoked the Computer Use runtime via node_repl, or called the legacy computer-use MCP tool, success or not. */
  ComputerUse: "computer_use",
  /** The model called ToolSearch (named LocalToolSearch in local mode) and it executed successfully. */
  ToolSearchCalled: "tool_search_called",
  /** The ToolSearch requested by the main loop actually took effect in local mode. */
  ToolSearchLocal: "tool_search_local",
  /** The ToolSearch requested by the main loop actually took effect in native mode. */
  ToolSearchNative: "tool_search_native",
  /** The model called CreateWorkflow and successfully started a background run. */
  WorkflowAuto: "workflow_auto",
  /** The user's built-in `/workflow` command input was expanded into a workflow template. */
  WorkflowCmd: "workflow_cmd",
} as const;

export type ModelRequestSessionFeature =
  (typeof ModelRequestSessionFeature)[keyof typeof ModelRequestSessionFeature];

const MODEL_REQUEST_SESSION_FEATURE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ModelRequestSessionFeature),
);

export function isModelRequestSessionFeature(value: unknown): value is ModelRequestSessionFeature {
  return typeof value === "string" && MODEL_REQUEST_SESSION_FEATURE_VALUES.has(value);
}

/**
  * Per-call execution information shared between Runtime and Adapter.
 *
 * This is not part of the business ModelRequest and does not let ordinary callers change the
 * Provider or model identity. Runtime sets it only at the unified model-call boundary, and the
 * Adapter reads it within the same asynchronous call chain.
 */
export interface ModelInvocationContext {
  metadata?: Record<string, unknown>;
  modelCall?: ModelApiCallObservation;
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Capability tags already used by this session; the runtime layer reads the owner's current set on every call. The
   * adapter writes the controlled attribution header, which provider static headers must not override; omitted or
   * empty sets are not sent.
   */
  modelRequestSessionFeatures?: readonly ModelRequestSessionFeature[];
  /** Retry-budget tier; runtime selects it by taskType, and the adapter uses it to adjust when to give up on transient failures. */
  modelRetryBudget?: ModelRetryBudget;
  /** Admission port; runtime passes it from deps, and the adapter acquires before each attempt. */
  modelRequestAdmission?: ModelRequestAdmission;
  statusSink?: ModelStatusSink;
  traceContext?: TraceContext;
  streamIdleTimeoutRetryNumber?: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  preserveProviderStreamBoundaries?: boolean;
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    attempt: number;
    reason?: RequestVerificationReason;
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

/** Dynamic authentication material used by the Adapter for one physical request attempt. */
export interface ModelRequestAuth {
  accountScope?: string;
  apiKey?: string;
  apiKeyId?: string;
  headers?: Record<string, string>;
}

export interface ModelRequestAuthSourceInput {
  attempt: number;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}

/** Execution-scoped authentication source bound when the Model is created and resolved before each physical request attempt. */
export interface ModelRequestAuthSource {
  resolve(input: ModelRequestAuthSourceInput): Promise<ModelRequestAuth | undefined>;
}

export interface ModelRequestDependencies {
  /** Presence of this property means the current Model must obtain request-scoped authentication; a missing Source also fails closed. */
  requestAuth?: {
    source?: ModelRequestAuthSource;
  };
}

const modelInvocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

export function getCurrentModelInvocationContext(): ModelInvocationContext | undefined {
  return modelInvocationStorage.getStore();
}

export function runWithModelInvocationContext<T>(context: ModelInvocationContext, run: () => T): T {
  const result = modelInvocationStorage.run(context, run);
  if (!isAsyncIterable(result)) return result;

  const source = result;
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) =>
          modelInvocationStorage.run(context, () => iterator.next(value as never)),
        return: (value?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.return
              ? iterator.return(value as never)
              : Promise.resolve({ done: true, value }),
          ),
        throw: (error?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      };
    },
  } as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}
