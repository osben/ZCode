import {
  createRootTraceContext,
  createTraceId,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type SessionEventStorePort,
  type SessionId,
  type SessionTaskType,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import type { McpTelemetryTracker } from "@zcode/adapters";
import type { WorkspaceHookPolicyProvider } from "@zcode/core";
import type { AccountProviderConfigSnapshot } from "@zcode/provider";
import {
  zcodeProtocolErrorCodes,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeDeliveryKind,
  type ModelSelection,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolMessage,
  type ZCodeProtocolMethod,
  type ZCodeProtocolNotification,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolTrace,
  type ZCodeSessionMode,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import type { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionResidentPool, SessionResidentPoolOptions } from "./session-resident-pool.js";
import type { DynamicWorkflowMode } from "@zcode/shared";

export interface ParamsSchema<T> {
  parse(input: unknown): T;
}

export interface ZCodeProtocolAgentDependencies {
  createZCodeApp(options?: Omit<ZCodeAppOptions, "providerRegistry">): ZCodeApp | Promise<ZCodeApp>;
  /**
   * In-memory event store factory for each session record.
   * Default turn-window retention policy; tests may inject a spy or unbounded implementation for comparison.
   */
  createSessionEventStore?(sessionId: string): SessionEventStorePort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  mcpPort?: McpPort;
  /** Resource manager: `process/childProcesses` reads MCP child-process pids and plugin ownership. */
  mcpTelemetry?: Pick<McpTelemetryTracker, "listProcesses">;
  platform?: NodeJS.Platform | string;
  /** Used only to construct the mixed residency policy for one CLI/app-server; production defaults are defined by the pool. */
  sessionResidentPoolOptions?: SessionResidentPoolOptions;
  /** Compatibility for older tests/embedded callers; new code should configure low-water through sessionResidentPoolOptions. */
  sessionResidentTargetCount?: number;
  sessionStore?: SessionStorePort;
  version?: string;
  /** Hook policy managed by the trusted Host; workspace/project configuration cannot override it. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Sync the third-layer Config Overlay derived from Host account state to the process Registry. */
  syncAccountProviderConfig?: (snapshot: AccountProviderConfigSnapshot) => Promise<boolean>;
  /** Reread this process's Config Source and wait for Registry publication before testing the connection. */
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

export type ZCodeProtocolAgentResolvedDependencies = ZCodeProtocolAgentDependencies & {
  createSessionEventStore(sessionId: string): SessionEventStorePort;
  workspaceHookPolicyProvider: WorkspaceHookPolicyProvider;
};

export interface ZCodeProtocolEventSequenceState {
  lastSeq: number;
  seqBySourceEventKey: Map<string, number>;
}

export interface ZCodeProtocolToolInputTransmissionState {
  streamedToolCallIdsWithInput: Set<string>;
}

export interface ZCodeProtocolSessionRecord {
  app: ZCodeApp;
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  createdAt: number;
  deliveryKind?: ZCodeDeliveryKind;
  /**
   * Older session/subscribe has no unsubscribe RPC; set this only for an actual subscription.
   * Do not use deliveryKind, which is also written by session/read. Ending the connection destroys
   * the entire CLI process.
   */
  legacyStreamSubscribed?: boolean;
  eventStore: SessionEventStorePort;
  parentSessionId?: SessionId;
  persistence: ZCodeSessionPersistence;
  protocolEventSequences: Map<string, ZCodeProtocolEventSequenceState>;
  protocolToolInputTransmissions: Map<string, ZCodeProtocolToolInputTransmissionState>;
  stateRevision: number;
  taskType?: SessionTaskType;
  traceContext: TraceContext;
  unsubscribe?: () => void;
  updatedAt: number;
  workspace: ZCodeWorkspaceRef;
  activeAbortController?: AbortController;
  /** Reference count for persistence/snapshot/broadcast work still pending after a background runner releases the ready lock. */
  residencyFinalizationCount?: number;
  /** Automation-dispatched turn currently running; exists only during the turn and prevents recursive CronCreate. */
  activeAutomationId?: string;
  /** Off-Peak-dispatched turn currently running; exists only during the turn and prevents recursive OffPeakCreate. */
  activeOffPeakTaskId?: string;
  /** Stable callback URL for the current inbound Bot turn; only CronCreate may read it during this turn. */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  restoreWarning?: { message: string; type: string };
  /** Cold-recovery candidate for the initial projection only; clear it on a new model-selection event. It cannot replace Runtime execution binding. */
  restoredModelSelection?: ModelSelection;
}

export interface ZCodeProtocolClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: ZCodeProtocolTrace;
  reannounceIntervalMs?: number;
}

export interface ZCodeProtocolAgentServerContext {
  /** A late asynchronous materialization must not re-register a session while the process is exiting. */
  assertServing?: () => void;
  deps: ZCodeProtocolAgentResolvedDependencies;
  logger?: Logger;
  appRuntimePreferences: {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled: boolean;
    /** Host-synchronized Off-Peak tool gate; defaults to false (fail-closed) for paths without host parameters, such as v4 cold recovery. */
    offPeakToolEnabled: boolean;
    /**
     * Host-synchronized dynamic workflow rollout gate.
     * Defaults to false (fail-closed): while an older Host does not recognize this method or during
     * startup before synchronization, workflow tools, `/workflow`, and the dynamic-workflows skill
     * are all hidden.
     */
    dynamicWorkflowEnabled: boolean;
    /**
     * Rollout mode arriving alongside dynamicWorkflowEnabled (launch.md "On demand: activation").
     * Absent (older Hosts publish only a boolean) means alwaysOn; `onDemand` makes createRecord write
     * runtimeConfig.dynamicWorkflowToolsOnDemand.
     */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  };
  // Vertical slice: v4 conversation channel (subscription/frames/commands), coexisting with legacy
  // session/* methods. Optional fields resolve construction order (the gateway closure holds context);
  // assign them immediately after constructing the server.
  v4Gateway?: ConversationV4Gateway;
  // Convergence point for the v4 forward resolveInteraction command and reverse requests
  // (permission/AskUserQuestion). The broker registers deferred responses and the v4 command surface
  // delivers them (the binder injects this same instance into V4CommandCoreHost).
  v4Interactions: V4InteractionRegistry;
  // Single-CLI resident session pool. Cold recovery waits for old app.close to finish through
  // waitForDeactivation; protocol requests hold an operation lease to prevent async handlers from
  // racing with capacity reclamation.
  sessionResidentPool?: SessionResidentPool;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  notify(notification: ZCodeProtocolNotification): void;
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
}

/** Protocol error codes for failed server → client requests; thrown by server.ts and translated by the adapter layer, avoiding literals scattered through business logic. */
export const PROTOCOL_CLIENT_REQUEST_ERROR_CODES = {
  /** No ZCode Protocol client attached, so the request cannot be delivered. */
  noClientAttached: -32020,
  /** The request was cancelled before a response arrived. */
  cancelled: -32021,
  /** The request timed out waiting for a response. */
  timedOut: -32022,
} as const;

export class ProtocolRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

export function isRequest(message: ZCodeProtocolMessage): message is ZCodeProtocolRequest {
  return "method" in message && "id" in message;
}

export function isNotification(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(
  message: ZCodeProtocolMessage,
): message is { id: ZCodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

export function isErrorResponse(message: ZCodeProtocolMessage): message is {
  id: ZCodeProtocolRequestId;
  error: { code: number; message: string; data?: unknown };
} {
  return "id" in message && "error" in message;
}

/**
 * Extract a readable field-level summary from zod (or zod-like) validation errors and append it to
 * the "Invalid params" message. Returning only "Invalid params" gave no clue about the invalid
 * field, so the model (for example, browser evaluate receiving a function or NaN coordinates) could
 * not correct itself and would keep guessing. Read ZodError.issues by duck typing (no zod dependency)
 * and build actionable hints such as `expression: Expected string, received function`.
 */
function summarizeParamsError(error: unknown): string | undefined {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }
  const parts = issues.slice(0, 5).map((issue) => {
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message ?? "invalid"}`;
  });
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  return parts.join("; ") + more;
}

export function parseParams<T>(schema: ParamsSchema<T>, params: unknown): T {
  try {
    return schema.parse(params);
  } catch (error) {
    const detail = summarizeParamsError(error);
    throw new ProtocolRequestError(
      -32602,
      detail ? `Invalid params — ${detail}` : "Invalid params",
      error,
    );
  }
}

export function assertExpectedRevision(
  record: ZCodeProtocolSessionRecord,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== record.stateRevision) {
    throw new ProtocolRequestError(-32009, "Session state revision mismatch", {
      actualRevision: record.stateRevision,
      expectedRevision,
    });
  }
}

export function toProtocolError(error: unknown): {
  code: number;
  data?: unknown;
  message: string;
} {
  if (error instanceof ProtocolRequestError) {
    return { code: error.code, data: error.data, message: error.message };
  }
  if (error instanceof Error) {
    const businessCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      code: -32603,
      // Preserve business error codes such as ModelProtocolError across JSON-RPC for the UI.
      // The outer code remains a JSON-RPC internal error; put the stable business code in data.code
      // for banner localization. Do not forward error.context: upstream context is not guaranteed
      // to be JSON-safe, and diagnostics must not cause a second failure in the error response.
      data: {
        name: error.name,
        stack: error.stack,
        ...(businessCode ? { code: businessCode } : {}),
      },
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

export function createProtocolTraceId(_sessionId: SessionId): TraceContext["traceId"] {
  // Bugfix: traceId identifies an observation trace above the session level and should not be derived
  // from sessionId. Reuse the UUID algorithm from agent/contracts so app and agent use the same trace format.
  return createTraceId();
}

export function createProtocolRootTraceContext(
  sessionId: SessionId,
  trace?: ZCodeProtocolTrace,
): TraceContext {
  const context = createRootTraceContext({
    sessionId,
    traceId: (trace?.traceId ?? createProtocolTraceId(sessionId)) as TraceContext["traceId"],
  });
  if (trace?.spanId) {
    context.spanId = trace.spanId;
  }
  if (trace?.parentId) {
    context.parentId = trace.parentId;
    context.parentSpanId = trace.parentId;
  }
  return context;
}

export function protocolTraceFromTraceContext(context: TraceContext): ZCodeProtocolTrace {
  return {
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...((context.parentId ?? context.parentSpanId)
      ? { parentId: context.parentId ?? context.parentSpanId }
      : {}),
  };
}

export function requireSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  options: { deliveryKind?: ZCodeDeliveryKind; operation?: string } = {},
): ZCodeProtocolSessionRecord {
  const record = context.sessions.get(sessionId);
  if (!record) {
    // Diagnostic: readSession reads only active runtimes. When the record is missing, distinguish
    // "cold session not yet recovered" from "invalid ID"; identical error text would not show
    // whether the UI read too early or the task index supplied a stale reference.
    context.logger?.warn("ZCode Protocol session runtime missing", {
      activeSessionCount: context.sessions.size,
      event: "zcode_protocol.session.require_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      operation: options.operation ?? "unknown",
      ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
      sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session is not active: ${sessionId}`,
    );
  }
  return record;
}

export function createProtocolLogger(deps: ZCodeProtocolAgentDependencies): Logger | undefined {
  return deps.loggerFactory?.createLogger("zcode").child({
    module: "bootstrap.zcode_protocol",
  });
}
