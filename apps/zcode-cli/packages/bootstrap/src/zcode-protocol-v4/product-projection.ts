import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// ProductProjection — the second authoritative reducer in the CLI projection.
// Input: the CLI event log (SessionEvent, the source of truth); output: ConversationDelta[].
// Snapshot advancement reuses the protocol's canonical apply function (applyConversationDeltas).
// Byte-for-byte agreement between projection evolution and the delta stream is guaranteed by
// construction, then cross-checked by independent replay in golden tests.
//
// Covers session/turn lifecycle, streamed text/reasoning, the tool-call state machine,
// permission interactions, the turn-steer queue, usage, error states, rejection of late terminal
// events, compact markers, the goal state machine, and fork markers. The transport wrapper
// (TopicFrame/subscribe) is handled in a later slice.
import type {
  AssistantFeedbackUpdatedPayload,
  RowPinnedUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  CompactLifecyclePayload,
  DynamicWorkflowRunProgressPayload,
  HookRunLifecyclePayload,
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelSelectedPayload,
  TurnExecutionModelFallbackPayload,
  ModelStreamingPayload,
  ModelUsage,
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  SessionEvent,
  SessionForkedPayload,
  SessionInputPromotedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolResultDisplayPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnInputIntentMetadata,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  CoreErrorType,
  SessionEventType,
  getModelUsageContextTokens,
} from "@zcode/contracts";
import {
  clearSettledOutputPreviews,
  projectToolActivity,
} from "./product-projection-bash-progress.js";
// The review monotonicity decision has one source of truth; the projection only applies the
// policy (accept advance/no_current, ignore other verdicts, and clear onSessionResumed across flows).
// Import directly from the monotonicity subpath: this re-export from the discovery barrel fails in
// the packages/ui Desktop build chain, preventing the app from opening after restart.
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isHighspeedProviderId,
  isZCodeFileStreamingToolInputPreviewTool,
  isZCodeModelRetryRecoveryProgressPayload,
  parseZCodeBackgroundTaskNotificationText,
  resolveZCodeBackgroundTaskControlKind,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type {
  ApiRetryState,
  AssistantTextRow,
  BackgroundWorkSummary,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
  ConversationSnapshot,
  CuaAppIdentity,
  GoalState,
  HookExecutionProjection,
  HookInvocationRow,
  MutableConversationSnapshotAccumulator,
  PendingInteraction,
  QueueItem,
  ReasoningRow,
  RunningSubagentSummary,
  SessionControl,
  SessionUsageState,
  StatePatch,
  SubagentProjectionState,
  SubagentRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallDisplay,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
  UserInputQuestionPayload,
  UserInputRow,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workspaceHookReviewRequestPayloadSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  parseListAppsSnapshot,
  readOfficialCuaAction,
  resolveCuaAppIdentity,
} from "./cua-app-snapshot.js";
import {
  normalizeConversationEvent,
  type CanonicalAssistantSegmentFact,
  type CanonicalConversationFact,
  type CanonicalModelStream,
  type CanonicalOpenSegmentIdentity,
  type CanonicalUserIntentFact,
  type ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import {
  buildToolOutput,
  buildTurnHeaderRow,
  mapCompactMarkerOrigin,
  mapCompactMarkerStatus,
  mapGoalStatus,
  mapTurnResultToHeaderState,
} from "./projection-rows.js";
import {
  HYDRATION_TRACE_ID,
  computeAvailability,
  computeInputRouting,
  createInitialConversationSnapshot,
  deltaBumpsRevision,
} from "./projection-state.js";

type HookInvocationRowContent = Omit<
  HookInvocationRow,
  | "actions"
  | "createdAt"
  | "createdAtSeq"
  | "entityId"
  | "productTurnId"
  | "rowId"
  | "turnId"
  | "visibility"
>;

interface PendingSessionHookInvocation {
  firstEvent: SessionEvent;
  content: HookInvocationRowContent;
}

const HOOK_SCRIPT_RUNNERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "node.exe",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);
const USER_PROMPT_HOOK_BLOCK_ERROR_TYPE = "hooks_prompt_block";

function unquoteHookDisplayToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, -1);
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return token;
}

function hookCommandLabel(commandDisplay: string): string | undefined {
  const tokens = commandDisplay.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? [];
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = unquoteHookDisplayToken(executableToken).split(/[\\/]/u).at(-1);
  if (!executable) return undefined;
  const scriptToken = tokens[1];
  if (!HOOK_SCRIPT_RUNNERS.has(executable.toLowerCase()) || !scriptToken) return executable;
  const script = unquoteHookDisplayToken(scriptToken);
  if (!script || script.startsWith("-")) return executable;
  const scriptName = script.split(/[\\/]/u).at(-1);
  return scriptName ? `${executable} · ${scriptName}` : executable;
}

function hookExecutionDisplayName(
  descriptor: NonNullable<HookRunLifecyclePayload["descriptor"]>,
  hookIndex: number,
): string {
  const executable = hookCommandLabel(descriptor.commandDisplay);
  return (
    descriptor.statusMessage?.trim() ||
    (descriptor.pluginName && executable
      ? `${descriptor.pluginName} · ${executable}`
      : descriptor.pluginName || executable) ||
    `Hook #${hookIndex + 1}`
  );
}

/**
 * Config seed: initial values injected from runtime truth after projection initialization or cold
 * recovery.
 * Relationship to event write paths (ModelSelected / SessionModeChanged): seeds fill only fields
 * untouched by events; replayed log values always take precedence ("the log is the final authority").
 */
export interface SessionConfigSeed {
  permissionGrant?: { interactionId: string };
  planEnabled?: boolean;
  modelSelection?: ModelSelectedPayload["modelSelection"];
  provider?: string;
  model?: string;
  thought?: string;
  thoughtLevels?: readonly string[];
  mode?: string;
}

export interface SessionUsageSeed {
  contextWindow: Omit<NonNullable<SessionUsageState["contextWindow"]>, "maxTokens"> & {
    maxTokens: number | null;
  };
  cumulative?: Partial<SessionUsageState["cumulative"]>;
}

interface ContextWindowProjectionState {
  maxTokens: number | null;
  touchedByEvent: boolean;
  usedTokens: number;
}

function invalidateResolvedContextBudgetThresholds(
  contextWindow: NonNullable<SessionUsageState["contextWindow"]>,
): NonNullable<SessionUsageState["contextWindow"]> {
  const {
    autoCompactThresholdTokens,
    autoCompactThresholdAuthoritative,
    microcompactThresholdTokens,
    ...remaining
  } = contextWindow;
  return {
    ...remaining,
    // Keep the required legacy field populated for old V4 clients. Numeric thresholds are stale
    // after a model switch; only an authoritative disabled null survives with its authority bit.
    autoCompactThresholdTokens: null,
    ...(autoCompactThresholdTokens === null && autoCompactThresholdAuthoritative === true
      ? { autoCompactThresholdAuthoritative: true }
      : {}),
    ...(microcompactThresholdTokens === null ? { microcompactThresholdTokens: null } : {}),
  };
}

export interface SessionSubagentsSeed {
  revision: number;
  childSessionIds: string[];
  running: RunningSubagentSummary[];
}

export interface StableForkCandidate {
  productTurnId: string;
  transcriptTurnId: string;
  startMessageId: string | null;
  boundaryMessageId: string;
}

function cloneSparseModelSelection(
  selection: ModelSelectedPayload["modelSelection"],
): ModelSelectedPayload["modelSelection"] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function sameSparseModelSelection(
  left: ModelSelectedPayload["modelSelection"] | undefined,
  right: ModelSelectedPayload["modelSelection"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export type StableForkCandidateResolution =
  | { ok: true; candidate: StableForkCandidate }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };

export interface ConversationEditTarget {
  entityId: string;
  productTurnId: string;
  transcriptMessageId: string;
  coveredByStableCompact: boolean;
  intent: {
    inputOrigin?: "desktop" | "mobile";
    conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
    botGroupSource?: CanonicalUserIntentFact["botGroupSource"];
    kind: "sendText" | "sendGoalCommand";
    text: string;
    sourceCommandId?: string;
    clientId?: string;
    attachments?: CanonicalUserIntentFact["attachments"];
    queueItemId?: string;
    admissionSeq?: number;
    admittedAt?: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    admittedDelivery?: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
    modelSelection?: TurnInputIntentMetadata["modelSelection"];
    mode?: TurnInputIntentMetadata["mode"];
    planEnabled?: boolean;
    provenance?: CanonicalUserIntentFact["provenance"];
  };
}

export type ConversationRowTargetAction =
  | "forkAssistant"
  | "editUserQuery"
  | "retryTurn"
  | "applyFileRewind"
  | "fileChanges"
  | "fileRewindPreview"
  | "setAssistantFeedback"
  | "setRowPinned"
  | "setHighspeedMetrics";

export type ConversationRowTargetResolution =
  | {
      ok: true;
      action: ConversationRowTargetAction;
      row: ConversationRow;
      editTarget?: ConversationEditTarget;
      messageId?: string;
      messageIds?: string[];
    }
  | {
      ok: false;
      status: "stale" | "rejected";
      reasonCode: "proto.staleTarget" | "guard.actionUnavailable";
    };

// Old events have no retryable field, so preserve the historical UI retry behavior; new events must
// respect an explicit false.
const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;

function modelRetryReasonCode(
  reason: Extract<ModelNetworkStatusPayload, { type: "model_retry_scheduled" }>["reason"],
): string {
  switch (reason) {
    case "rate_limited":
      return "fault.provider.rateLimited";
    // Off-peak queueing (429/3105) means "the upstream asked us to wait"; the UI groups it with
    // recoverable rate-limit states.
    case "offpeak_queued":
      return "fault.provider.rateLimited";
    case "provider_overloaded":
    case "server_error":
      return "fault.provider.serverError";
    case "timeout":
      return "fault.network.timeout";
    case "stream_idle_timeout":
      return "fault.network.sseStalled";
    case "stale_connection":
      return "fault.network.sseDisconnected";
    case "network_error":
      return "fault.network.unreachable";
    case "auth_refresh":
    case "reasoning_signature_repair":
      return "fault.provider.requestFailed";
  }
}

function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

interface HighspeedToolInterval {
  startedAt: number;
  endedAt?: number;
}

type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

export class ProductProjection {
  private snapshot: ConversationSnapshot;
  // Keep the reducer's rowId lookup synchronized with rows.window. Cold recovery previously scanned
  // the entire table on every find, with worse degradation as tool/turn terminal events accumulated.
  // Normal reduction maintains it incrementally; only rewind rebuilds it.
  private rowIndexById = new Map<number, number>();
  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;
  private nextRowId = 1;
  private streamingTextRowId: number | null = null;
  private streamingReasoningRowId: number | null = null;
  // An output-token Continue is request-level recovery within the same product turn and must not
  // leak into a new body row. Keep only the previous text row satisfying the length/zero-tool/
  // visual-adjacency conditions; any real boundary clears it.
  private outputContinuationTextRowId: number | null = null;
  private toolRowIdByCallId = new Map<string, number>();
  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();
  // The snapshot is authoritative; this Set is only a derived index for the TurnComplete fallback
  // when terminal state is missing, avoiding a full-table scan on every turn.
  private openForegroundToolCallIds = new Set<string>();
  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();
  private subagentRowIdByAgentId = new Map<string, number>();
  private hookRowIdByInvocationId = new Map<string, number>();
  // A resumed SessionStart has no turnId. Keep it in the CLI projection until the next real
  // user-intent TurnStarted arrives, then assign rowId/turnId. Do not create a synthetic
  // session-hooks:* turn.
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();
  // An async Hook terminal may arrive late after rewind. Keep an invocation tombstone so a deleted
  // old branch is not appended again by the terminal-only compatibility path when its original row
  // cannot be found.
  private rewoundHookInvocationIds = new Set<string>();
  // A cold-recovery transcript may contain a ghost child that an older version published before
  // persistence failed. Keep excluding it after the store seed rather than overriding one snapshot;
  // otherwise the next unrelated event can materialize it again from a historical row.
  private invalidSubagentChildSessionIds = new Set<string>();
  // Side table mapping rowId to authoritative messageId. forkAssistant/editUserQuery command
  // payloads address rows by rowId, while legacy fork/rewind operations use messageId (the history
  // target); the bridge translates through this table. Keep it out of the row schema: clients send
  // only rowId, while messageId is a server-internal anchor, preserving the frozen row structure.
  private messageIdByRowId = new Map<number, string>();
  // After Continue reuses rowId, advance the action anchor to the last assistant message. Older
  // partial messageIds must still resolve to the same row for compact coverage, rewind, and
  // full-turn file-fact recovery.
  private outputContinuationRowIdByMessageId = new Map<string, number>();
  private entityIdByRowId = new Map<number, string>();
  // Canonical command targets address only stable entity identities. rowId is a transient lookup
  // for this materialization, so changes after refresh/replay do not change target identity.
  private editTargetByEntityId = new Map<string, ConversationEditTarget>();
  private currentEditableEntityId: string | null = null;
  private stableCompactCoverageBoundaryRowId: number | null = null;
  private turnHeaderRowIdByTurnId = new Map<string, number>();
  private compactMarkerRowIdByOperationId = new Map<string, number>();
  // Goal verification boundary identity = targetId_goalIteration.
  // verificationId is only an attempt alias: a retry in the same iteration carries a new
  // verificationId, and the old keying by verificationId created a second marker.
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();
  // Queue drain creates a new product turn within the same runtimeTurn. Map runtimeTurnId to the
  // current productTurnId; turnIdOf assigns later event rows to the latest productTurn. A steer
  // (guide) does not split the turn and stays inline.
  private productTurnIdByRuntimeTurnId = new Map<string, string>();
  private runtimeTurnIdByProductTurnId = new Map<string, string>();
  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();
  private currentProductTurnStartedAtMs: number | null = null;
  // The CLI aggregates real durations needed by Highspeed sharing so split data is not lost after the renderer exits.
  private highspeedModelDurationByTurnId = new Map<string, number>();
  private highspeedToolIntervalsByTurnId = new Map<string, Map<string, HighspeedToolInterval>>();
  // Side table for delivery semantics: record the event payload (or followupMode fallback) when
  // TurnSteerQueued arrives, then choose between splitting a turn and inlining at drain time. Once
  // the ledger is persisted, it becomes authoritative.
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();
  private currentTurnId: string | null = null;
  // Whether the current runtime turn was created by a model-only TurnStarted (maintenance turns
  // such as manual /compact or goal continuation). Pending summaries from SessionStart must not be
  // settled against a maintenance turn; wait for the next real user-visible turn.
  private currentTurnStartedModelOnly = false;
  // When contextWindow=null, the protocol exposes neither the denominator nor usage, but the
  // reducer must retain the latest context usage so the registry can atomically rebuild usage if a
  // known capacity is restored later, instead of incorrectly resetting it to zero.
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };
  // Generate the modelChange marker when the next turn starts.
  // silentInitial keeps the ordinary first Main turn silent; sourceLess represents an explicit
  // ∅→X transition; known stores the provider/model actually used in the previous turn. Record
  // thought alongside the baseline, but do not let it trigger a model-identity change.
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };
  // Seed guard: do not let seeds overwrite config sections touched by events (the authoritative log).
  private configModelTouchedByEvent = false;
  // Old ModelSelected events do not include the capability set. A separate guard lets runtime seeds
  // fill gaps in old logs while preventing later seeds from overwriting model capabilities already
  // atomically published by a newer event.
  private configThoughtLevelsTouchedByEvent = false;
  private configModeTouchedByEvent = false;
  // Assistant conservation: count body-stream events rejected outside a running state; the gateway
  // uses this to mark the projection stale.
  private droppedContentStreamEventCount = 0;
  // The legacy fallback during reads must be observable; otherwise a missing normalizer field still
  // degrades into content that is visible but cannot be addressed.
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  /** Assistant conservation: rejected body-stream event count (>0 means the projection may be incomplete and needs rehydration). */
  getDroppedContentStreamEventCount(): number {
    return this.droppedContentStreamEventCount;
  }

  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.normalizationDiagnostics;
  }

  /** Bounded incremental estimate for the publisher only; null means exact validation against a candidate snapshot is required. */
  establishedStreamingAppend(event: SessionEvent): string | null {
    if (event.type !== SessionEventType.ModelStreaming || !this.isRunning()) return null;
    const payload = event.payload as ModelStreamingPayload;
    if (payload.kind === "text_delta" && this.streamingTextRowId !== null) return payload.delta;
    if (payload.kind === "reasoning_delta" && this.streamingReasoningRowId !== null) {
      return payload.delta;
    }
    if (
      payload.kind === "tool_input_delta" &&
      this.toolRowIdByCallId.has(String(payload.toolCallId))
    ) {
      const state = this.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
      if (state) {
        if (
          state.lastPublishedAt !== null &&
          this.ms(event) - state.lastPublishedAt <
            ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
        ) {
          return "";
        }
        // The upper-bound estimate must include the suffix accumulated in the window; counting only
        // the current delta would underestimate the next wire snapshot.
        return `${state.pendingAppend}${payload.delta}`;
      }
      return payload.delta;
    }
    return null;
  }

  /**
   * Inject config seeds.
   *
   * The initial snapshot hard-coded empty provider/model values plus mode="build". ModelSelected
   * was emitted only after switchModelConfig, while SessionCreated intentionally emitted no delta,
   * so runtime truth (the startup default model, persisted project mode, and the last model selected
   * in a historical session) never entered the projection. Consequences: (1) a new session's model
   * picker was empty; (2) when the persisted project mode was yolo, the UI showed build, and
   * selecting yolo hit a same-value no-op in the handler (which checks runtime truth), so the UI
   * could never converge and the CAS invariant "unchanged revision iff unchanged state" broke.
   *
   * Why this fix: seeds update snapshot.config directly without producing a delta or incrementing
   * revision/seq, preserving the draft's "no visible delta" decision. Skip sections touched by
   * events (when replay follows the seed, log values take precedence). Idempotent: safe to call
   * repeatedly after ensurePublisher/hydration.
   */
  seedConfig(seed: SessionConfigSeed): void {
    const config = { ...this.snapshot.config };
    let changed = false;
    if (!config.permissionGrant && seed.permissionGrant) {
      config.permissionGrant = seed.permissionGrant;
      changed = true;
    }
    if (!this.configModelTouchedByEvent) {
      if (
        Object.hasOwn(seed, "modelSelection") &&
        !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
      ) {
        // A restored empty selection has explicit meaning too; do not preserve an old event's
        // selection just because the restored value is falsy.
        config.modelSelection = seed.modelSelection
          ? cloneSparseModelSelection(seed.modelSelection)
          : undefined;
        changed = true;
      }
      if (seed.provider !== undefined && config.provider !== seed.provider) {
        config.provider = seed.provider;
        changed = true;
      }
      if (seed.model !== undefined && config.model !== seed.model) {
        config.model = seed.model;
        changed = true;
      }
      if (seed.thought !== undefined && config.thought !== seed.thought) {
        config.thought = seed.thought;
        changed = true;
      }
    }
    const seedThoughtLevels = seed.thoughtLevels;
    if (
      !this.configThoughtLevelsTouchedByEvent &&
      seedThoughtLevels !== undefined &&
      (config.thoughtLevels.length !== seedThoughtLevels.length ||
        config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
    ) {
      config.thoughtLevels = [...seedThoughtLevels];
      changed = true;
    }
    if (!this.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
      config.mode = seed.mode;
      changed = true;
    }
    if (
      !this.configModeTouchedByEvent &&
      seed.planEnabled !== undefined &&
      config.planEnabled !== seed.planEnabled
    ) {
      config.planEnabled = seed.planEnabled;
      changed = true;
    }
    if (changed) {
      this.snapshot = { ...this.snapshot, config };
    }
  }

  /**
   * Read-only seed for the source of imported shared context.
   *
   * shared_context is a provider-only message and must not be materialized as a user bubble. Send
   * the source marker through an additive snapshot field so Desktop can show a persistent notice
   * after opening a new session. This field is not part of conversation rows and does not increment
   * revision/seq, avoiding a fabricated conversation turn.
   */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    const title = source?.title.trim();
    if (!title) return;
    if (
      this.snapshot.sharedContextImport?.title === title &&
      (source as { contextId?: string }).contextId ===
        (this.snapshot.sharedContextImport as { contextId?: string }).contextId &&
      (source as { status?: string }).status ===
        (this.snapshot.sharedContextImport as { status?: string }).status
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      sharedContextImport: {
        ...source,
        title,
      },
    };
  }

  /** Runtime-less worktree preparations are Host-owned metadata, not transcript rows or turns. */
  seedWorktreePreparation(
    preparation: ConversationSnapshot["meta"]["worktreePreparation"] | null | undefined,
  ): void {
    if (!preparation) {
      // A null seed means the preparation no longer exists (activated/cancelled/cleared on the
      // Host), so a re-subscribed client must not keep seeing the stale preparing/failed marker.
      if (this.snapshot.meta.worktreePreparation !== undefined) {
        const { worktreePreparation: _cleared, ...restMeta } = this.snapshot.meta;
        this.snapshot = { ...this.snapshot, meta: restMeta };
      }
      return;
    }
    const current = this.snapshot.meta.worktreePreparation;
    if (
      current?.status === preparation.status &&
      current.branchName === preparation.branchName &&
      current.targetPath === preparation.targetPath &&
      current.failureMessage === preparation.failureMessage
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      meta: { ...this.snapshot.meta, worktreePreparation: { ...preparation } },
    };
  }

  seedUsage(seed: SessionUsageSeed): void {
    const current = this.snapshot.usage;
    const currentContextWindow = current.contextWindow;
    if (currentContextWindow) {
      this.contextWindowState.usedTokens = currentContextWindow.usedTokens;
    }
    // Internal usage facts exist even when capacity is unknown; a late recovery seed must not
    // overwrite the real ModelComplete/Compact watermark.
    if (this.contextWindowState.usedTokens > 0) {
      return;
    }
    const seededContextWindow = seed.contextWindow;
    if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
      return;
    }
    const cumulative = {
      inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
      outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
      cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
      cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
    };
    if (this.contextWindowState.touchedByEvent) {
      // Same guard: explicit ModelSelected.contextWindow (including null) is the log's authoritative
      // capacity. A hydration seed may restore more accurate token facts, but must not overwrite
      // maxTokens or make null visible again.
      this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
      this.snapshot = {
        ...this.snapshot,
        usage: {
          contextWindow: currentContextWindow
            ? {
                ...currentContextWindow,
                usedTokens: seededContextWindow.usedTokens,
              }
            : null,
          cumulative,
        },
      };
      return;
    }
    if (
      seededContextWindow.maxTokens !== null &&
      (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
    ) {
      return;
    }

    // Synthetic history events contain only a zero-usage placeholder; seeds restore the real
    // watermark, and unknown capacity does not prevent retaining tokens internally.
    this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    this.contextWindowState.maxTokens = seededContextWindow.maxTokens;
    this.snapshot = {
      ...this.snapshot,
      usage: {
        contextWindow:
          seededContextWindow.maxTokens === null
            ? null
            : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
        cumulative,
      },
    };
  }

  /**
   * Validation seed from the subagent store during cold recovery. The transcript can restore a
   * visible row, but only the session store can prove that a child was persisted as
   * subagent_child. Replace the manifest with this seed before the candidate publisher publishes
   * it, so ghost children left by older versions never enter authoritative UI state.
   */
  seedSubagents(seed: SessionSubagentsSeed): void {
    const childSessionIds = [...new Set(seed.childSessionIds)];
    const allowed = new Set(childSessionIds);
    this.invalidSubagentChildSessionIds = new Set(
      this.snapshot.rows.window.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
          ? [row.childSessionId]
          : [],
      ),
    );
    const running = seed.running.filter((item) => allowed.has(item.childSessionId));
    this.snapshot = {
      ...this.snapshot,
      subagents: {
        // A non-empty cold manifest must start at 1 or later. The renderer uses 0 to mean that
        // authoritative state has not been established; otherwise a legacy session with
        // stateRevision=0 would permanently skip child-tab synchronization.
        revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
        childSessionIds,
        running,
        endedTotal: Math.max(0, childSessionIds.length - running.length),
      },
    };
  }

  /**
   * Map rowId to authoritative messageId. When the bridge executes forkAssistant/editUserQuery, it
   * translates the command payload's internal rowId to the messageId required by core. Return null
   * for an unknown rowId (not an assistant/user row or a late request), allowing the bridge to
   * respond with rejected.
   */
  getMessageIdForRow(rowId: number): string | null {
    return this.messageIdByRowId.get(rowId) ?? null;
  }

  getEntityIdForRow(rowId: number): string | null {
    return this.entityIdByRowId.get(rowId) ?? null;
  }

  resolveEditTarget(rowId: number): ConversationEditTarget | null {
    if (!this.isLatestEditableUserRow(rowId)) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    return entityId ? this.resolveEditTargetByEntityId(entityId) : null;
  }

  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null {
    if (entityId !== this.currentEditableEntityId) return null;
    const target = this.editTargetByEntityId.get(entityId);
    return target ? { ...target, intent: { ...target.intent } } : null;
  }

  /**
   * The sole resolver for V3 row actions. Both the displayed rowId and stable entityId must match
   * the current projection. Read action availability directly from row.actions generated by the
   * same materialization; handlers/previews must not recalculate it from position, phase, or text.
   */
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    const row = this.findRow(target.rowId);
    if (!row || this.entityIdByRowId.get(target.rowId) !== target.entityId) {
      return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
    }
    if (action === "editUserQuery") {
      const editTarget = this.resolveEditTargetByEntityId(target.entityId);
      if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, editTarget };
    }
    if (action === "retryTurn") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      const userRow = this.snapshot.rows.window.find(
        (candidate) =>
          candidate.turnId === row.turnId &&
          candidate.kind === "userInput" &&
          candidate.origin === "realUser",
      );
      const userEntityId = userRow ? this.entityIdByRowId.get(userRow.rowId) : undefined;
      const editTarget = userEntityId ? this.editTargetByEntityId.get(userEntityId) : undefined;
      if (row.actions?.canRetry !== true || !messageId || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId, editTarget };
    }
    if (action === "forkAssistant") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.actions?.canFork !== true || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setAssistantFeedback") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "assistantText" || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setRowPinned") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      // Pins address the human bookmark on the final assistant text segment or the user's own input;
      // both need the transcript anchor. A streaming/failed assistant row cannot be pinned yet, and
      // system-generated user rows (background result / mailbox / synthetic / workflow launch) are
      // outside the v1 boundary (docs/chat-message-pins.md).
      if (
        !messageId ||
        (row.kind !== "assistantText" && row.kind !== "userInput") ||
        (row.kind === "assistantText" && row.state !== "complete") ||
        (row.kind === "userInput" && row.origin !== "realUser")
      ) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setHighspeedMetrics") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "userInput" || !row.highspeed || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (row.kind !== "turnHeader") {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    if (
      (action === "applyFileRewind" || action === "fileRewindPreview") &&
      (!row.fileChanges || row.actions?.canRewindFiles !== true)
    ) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return {
      ok: true,
      action,
      row,
      messageIds: this.getMessageIdsForTurnRow(row.rowId),
    };
  }

  /**
   * File-summary undo starts from the turn rowId. The server resolves every messageId in the same
   * product turn, covering multiple assistant segments/checkpoints; the UI does not expose internal
   * messageIds.
   */
  getMessageIdsForTurnRow(rowId: number): string[] {
    const row = this.findRow(rowId);
    if (!row) return [];
    const messageIds = new Set<string>();
    const runtimeTurnId = this.runtimeTurnIdByProductTurnId.get(row.turnId);
    // Cause: a model-only turn creates no visible userInput row, so scanning rows missed the hidden
    // user messageId used by checkpoints. When a new turn has a persisted message, productTurnId is
    // that messageId; using it as an exact anchor avoids broadening the runtime-turn fallback.
    if (runtimeTurnId && runtimeTurnId !== row.turnId) {
      messageIds.add(row.turnId);
    }
    for (const candidate of this.snapshot.rows.window) {
      if (candidate.turnId !== row.turnId) continue;
      const messageId = this.messageIdByRowId.get(candidate.rowId);
      if (messageId) messageIds.add(messageId);
    }
    for (const [messageId, continuationRowId] of this.outputContinuationRowIdByMessageId) {
      const continuationRow = this.findRow(continuationRowId);
      if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
    }
    return [...messageIds];
  }

  /**
   * Core-side strict validation: is rowId the final assistantText segment of its productTurn? The
   * flattened UI exposes the fork action only on the final segment; this is a defensive gate so
   * direct command callers/legacy clients cannot fork from a middle segment.
   */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") return false;
    for (let index = this.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
      const candidate = this.snapshot.rows.window[index]!;
      if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
        return candidate.rowId === rowId;
      }
    }
    return false;
  }

  /**
   * Synchronous projection gate for a running fork: resolve only row/product-turn and message
   * boundaries here. The host fills in the complete orderedMessageIds using the authoritative
   * session-store order and persists the anchor.
   */
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    if (this.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
      return { ok: false, reasonCode: "guard.compactOperationLock" };
    }
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") {
      return { ok: false, reasonCode: "guard.forkAssistantOnly" };
    }
    const headerRowId = this.turnHeaderRowIdByTurnId.get(row.turnId);
    const header = headerRowId === undefined ? undefined : this.findRow(headerRowId);
    if (
      row.state !== "complete" ||
      row.actions?.canFork !== true ||
      header?.kind !== "turnHeader" ||
      header.state !== "completedSuccess" ||
      !this.isLatestAssistantSegmentRow(rowId)
    ) {
      return { ok: false, reasonCode: "guard.forkTargetNotStable" };
    }
    const boundaryMessageId = this.messageIdByRowId.get(rowId);
    if (!boundaryMessageId) {
      return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
    }
    const startMessageId =
      this.snapshot.rows.window
        .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
        .map((candidate) => this.messageIdByRowId.get(candidate.rowId))
        .find((messageId): messageId is string => Boolean(messageId)) ?? null;
    return {
      ok: true,
      candidate: {
        productTurnId: row.turnId,
        transcriptTurnId: this.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
        startMessageId,
        boundaryMessageId,
      },
    };
  }

  /** latestAssistantRetryOnly: retry may target only the latest assistantText in the full timeline that has a realUser cause. */
  isLatestRetryAssistantRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "assistantText" &&
      row.actions?.canRetry === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** latestQueryEditOnly: only the last realUser userInput row in the current projection may be edited. */
  isLatestEditableUserRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "userInput" &&
      row.origin === "realUser" &&
      row.actions?.canEdit === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** rowId → product turnId, used by the command layer to query the store for running edits without an assistant anchor. */
  getTurnIdForRow(rowId: number): string | null {
    return this.findRow(rowId)?.turnId ?? null;
  }

  /** Apply an authoritative event and return its delta sequence (possibly empty). */
  applyEvent(event: SessionEvent): ConversationDelta[] {
    return this.applyEventInternal(event, true);
  }

  /**
   * The cold-recovery batch path may be used only on an unpublished candidate projection. After
   * begin, rows.window advances in place to avoid copying a growing array for every event; the
   * publisher does not adopt the candidate until full validation succeeds.
   */
  beginHydrationReplay(): void {
    if (this.hydrationAccumulator) throw new Error("hydration replay already active");
    this.hydrationAccumulator = createMutableConversationSnapshotAccumulator(this.snapshot);
    this.snapshot = this.hydrationAccumulator.snapshot;
    this.rowIndexById = this.hydrationAccumulator.rowIndexById;
  }

  applyHydrationEvent(event: SessionEvent): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    return this.applyEventInternal(event, false);
  }

  /**
   * Reconcile command actions deferred during batching with the current snapshot. Actions are a
   * derived materialization of the same reducer and do not increment revision separately; the
   * structural/guard events that changed them have already been accounted for.
   */
  completeHydrationReplay(): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    const deltas = this.materializeCommandRowActions([]);
    applyConversationDeltasMutable(this.hydrationAccumulator, deltas);
    this.hydrationAccumulator = null;
    return deltas;
  }

  private applyEventInternal(
    event: SessionEvent,
    materializeActions: boolean,
  ): ConversationDelta[] {
    if (event.type === SessionEventType.SubagentSpawned) {
      const childSessionId = this.stringPayload(
        event.payload as Record<string, unknown>,
        "childSessionId",
      );
      // A live spawn has passed core's persist-before-publish gate. If it legally resumes an old
      // ghost, the new event makes it eligible again. During hydration, the seed has not established
      // the exclusion set yet, so historical references are not accidentally admitted.
      if (childSessionId) this.invalidSubagentChildSessionIds.delete(childSessionId);
    }
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    const productTurnId =
      event.type === SessionEventType.TurnStarted
        ? undefined
        : (this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
    const reduced =
      event.type === SessionEventType.AssistantFeedbackUpdated
        ? this.onAssistantFeedbackUpdated(event)
        : event.type === SessionEventType.RowPinnedUpdated
          ? this.onRowPinnedUpdated(event)
          : event.type === SessionEventType.HighspeedMetricsUpdated
          ? this.onHighspeedMetricsUpdated(event)
          : event.type === SessionEventType.TurnExecutionModelFallback
            ? this.onTurnExecutionModelFallback(event)
            : (() => {
                const fact = normalizeConversationEvent(event, {
                  productTurnId,
                  openAssistantSegments: this.openAssistantSegments(),
                });
                this.normalizationDiagnostics.push(...fact.diagnostics);
                return this.reduce(fact);
              })();
    const subagentDeltas = this.shouldMaterializeSubagentProjection(reduced)
      ? this.materializeSubagentProjection(reduced)
      : [];
    const reducedWithSubagents = [...reduced, ...subagentDeltas];
    // The row, command target, and actions must belong to the same materialization transaction.
    // The old implementation maintained only a side map/latest-row check while the UI inferred
    // actions elsewhere. Cold, tool-only, and failed turns could show an entry whose target could
    // not be resolved, and old entries remained after a new target appeared.
    const deltas = materializeActions
      ? [...reducedWithSubagents, ...this.materializeCommandRowActions(reducedWithSubagents)]
      : reducedWithSubagents;
    const finalDeltas = this.attachRevision(clearSettledOutputPreviews(deltas));
    if (this.hydrationAccumulator) {
      applyConversationDeltasMutable(this.hydrationAccumulator, finalDeltas);
      this.snapshot.seq = event.sequenceNumber;
    } else {
      const previousRowsLength = this.snapshot.rows.window.length;
      this.snapshot = {
        ...applyConversationDeltas(this.snapshot, finalDeltas),
        seq: event.sequenceNumber,
      };
      this.updateRowIndexAfterImmutableApply(previousRowsLength, finalDeltas);
    }
    this.updateToolIndexesAfterDeltas(finalDeltas);
    return finalDeltas;
  }

  /**
   * Reduce the event on an independent candidate projection and commit atomically only after validation.
   *
   * If the projection exceeds the logical frame assembly limit, mutating the current instance
   * before the wire encoder fails would leave authoritative memory permanently unable to send a
   * snapshot. The candidate also isolates the snapshot and reducer side maps; on rejection, the
   * current instance remains unchanged and clients can recover from the last transmittable snapshot.
   *
   * `accept` also receives the delta **actually produced** by this event. Some event categories can
   * use delta byte length as a reliable upper bound and avoid serializing the entire candidate
   * snapshot again (the publisher's fast ingest path). Pass actual output rather than a preview
   * because preview sizes are inaccurate: the projection also materializes subagent mirrors and
   * command actions on top of the reducer, and missing one item would weaken the 16 MiB gate.
   */
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
  ): ConversationDelta[] | null {
    const candidate = this.cloneProjection();
    const deltas = candidate.applyEvent(event);
    if (!accept(candidate.snapshot, deltas)) return null;
    this.adoptProjection(candidate);
    return deltas;
  }

  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.snapshot = this.snapshot;
    clone.rowIndexById = new Map(this.rowIndexById);
    clone.hydrationAccumulator = null;
    clone.nextRowId = this.nextRowId;
    clone.streamingTextRowId = this.streamingTextRowId;
    clone.streamingReasoningRowId = this.streamingReasoningRowId;
    clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
    clone.toolRowIdByCallId = new Map(this.toolRowIdByCallId);
    // Live publishing uses an atomic clone for each event; omitting this side table would lose a
    // successful list_apps snapshot at commit time.
    clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
    clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
    clone.fileToolInputPreviewByCallId = new Map(
      [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [
        toolCallId,
        { ...state },
      ]),
    );
    clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
    clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
    clone.pendingSessionHookInvocations = new Map(
      [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    );
    clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
    clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
    clone.messageIdByRowId = new Map(this.messageIdByRowId);
    clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
    clone.entityIdByRowId = new Map(this.entityIdByRowId);
    clone.editTargetByEntityId = new Map(this.editTargetByEntityId);
    clone.currentEditableEntityId = this.currentEditableEntityId;
    clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
    clone.turnHeaderRowIdByTurnId = new Map(this.turnHeaderRowIdByTurnId);
    clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
    clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
    clone.productTurnIdByRuntimeTurnId = new Map(this.productTurnIdByRuntimeTurnId);
    clone.runtimeTurnIdByProductTurnId = new Map(this.runtimeTurnIdByProductTurnId);
    clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
      this.productTurnSplitOrdinalByRuntimeTurnId,
    );
    clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
    clone.highspeedModelDurationByTurnId = new Map(this.highspeedModelDurationByTurnId);
    clone.highspeedToolIntervalsByTurnId = new Map(
      [...this.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
        turnId,
        new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
      ]),
    );
    clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
    clone.currentTurnId = this.currentTurnId;
    clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
    clone.contextWindowState = { ...this.contextWindowState };
    clone.lastTurnModel = { ...this.lastTurnModel };
    clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
    clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
    clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
    clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
    clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
    return clone;
  }

  private adoptProjection(candidate: ProductProjection): void {
    this.snapshot = candidate.snapshot;
    this.rowIndexById = candidate.rowIndexById;
    this.hydrationAccumulator = null;
    this.nextRowId = candidate.nextRowId;
    this.streamingTextRowId = candidate.streamingTextRowId;
    this.streamingReasoningRowId = candidate.streamingReasoningRowId;
    this.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
    this.toolRowIdByCallId = candidate.toolRowIdByCallId;
    this.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
    this.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
    this.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
    this.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
    this.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
    this.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
    this.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
    this.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
    this.messageIdByRowId = candidate.messageIdByRowId;
    this.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
    this.entityIdByRowId = candidate.entityIdByRowId;
    this.editTargetByEntityId = candidate.editTargetByEntityId;
    this.currentEditableEntityId = candidate.currentEditableEntityId;
    this.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
    this.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
    this.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
    this.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
    this.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
    this.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
    this.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
    this.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
    this.highspeedModelDurationByTurnId = candidate.highspeedModelDurationByTurnId;
    this.highspeedToolIntervalsByTurnId = candidate.highspeedToolIntervalsByTurnId;
    this.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
    this.currentTurnId = candidate.currentTurnId;
    this.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
    this.contextWindowState = candidate.contextWindowState;
    this.lastTurnModel = candidate.lastTurnModel;
    this.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
    this.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
    this.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
    this.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
    this.normalizationDiagnostics = candidate.normalizationDiagnostics;
  }

  /**
   * Atomically generate edit/retry actions from the prospective rows after reducing this event.
   * action=true must imply that the command layer can resolve a persistent message target at the
   * same revision. When the latest target changes, upsert both the old and new rows so clients do
   * not need to infer from array positions.
   */
  private materializeCommandRowActions(reduced: ConversationDelta[]): ConversationDelta[] {
    const prospective = applyConversationDeltas(this.snapshot, reduced);
    const rows = prospective.rows.window;
    const rowById = new Map(rows.map((row) => [row.rowId, row]));
    const latestAssistantRowIdByTurn = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== "assistantText") continue;
      const current = latestAssistantRowIdByTurn.get(row.turnId);
      if (current === undefined || row.rowId > current) {
        latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
      }
    }
    const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
    const completionBlockingActive = prospective.control.activeWorks.length > 0;
    let latestEditable: ConversationRow | undefined;
    let latestAssistant: AssistantTextRow | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (
        !latestEditable &&
        !compactActive &&
        row.kind === "userInput" &&
        row.origin === "realUser"
      ) {
        latestEditable = row;
      }
      if (!latestAssistant && row.kind === "assistantText") {
        latestAssistant = row;
      }
      if (latestEditable && latestAssistant) break;
    }
    // The old logic selected retry using only the "latest complete assistant," so a background
    // result's synthetic turn incorrectly gained the action. Filtering synthetic turns only in the
    // find predicate would instead skip the latest background assistant and revive retry on an
    // older real-user turn. First lock onto the latest assistant in the full timeline, then validate
    // its same-turn realUser canonical cause so ordinary retry never falls back across turns.
    const latestRetryable = (() => {
      if (
        completionBlockingActive ||
        !latestAssistant ||
        latestAssistant.state !== "complete" ||
        !this.messageIdByRowId.has(latestAssistant.rowId)
      ) {
        return undefined;
      }
      const headerId = this.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
      const canonicalUserRow = rows.find(
        (row) =>
          row.turnId === latestAssistant.turnId &&
          row.kind === "userInput" &&
          row.origin === "realUser",
      );
      const canonicalUserEntityId = canonicalUserRow
        ? this.entityIdByRowId.get(canonicalUserRow.rowId)
        : undefined;
      if (!canonicalUserEntityId || !this.editTargetByEntityId.has(canonicalUserEntityId)) {
        return undefined;
      }
      return latestAssistant;
    })();
    const latestEditableEntityId =
      latestEditable === undefined
        ? null
        : (this.entityIdByRowId.get(latestEditable.rowId) ?? null);
    // The edit action and command resolver must share canonical target authority. The old drain
    // branch registered only messageId, so the UI showed Edit while submission was rejected by the
    // resolver as actionUnavailable.
    const latestEditableRowId =
      latestEditable &&
      latestEditableEntityId &&
      this.messageIdByRowId.has(latestEditable.rowId) &&
      this.editTargetByEntityId.has(latestEditableEntityId)
        ? latestEditable.rowId
        : null;
    // The entity-target history table retains old records; revoking a row action alone cannot stop
    // direct entityId lookup from bypassing latest-only semantics. Update current edit authority and
    // actions in the same materialization; the resolver no longer scans rows or treats rowId as a
    // canonical key.
    this.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
    const latestRetryableRowId = latestRetryable?.rowId ?? null;
    const deltas: ConversationDelta[] = [];

    for (const row of rows) {
      if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
        continue;
      const nextActions = { ...row.actions };
      if (row.kind === "turnHeader") {
        const canRewindFiles =
          !completionBlockingActive &&
          prospective.pendingInteractions.length === 0 &&
          row.state !== "running" &&
          row.fileChanges?.state === "active";
        if (canRewindFiles) nextActions.canRewindFiles = true;
        else delete nextActions.canRewindFiles;
      } else if (row.kind === "userInput") {
        if (row.rowId === latestEditableRowId) {
          nextActions.canEdit = true;
          nextActions.editDisposition = "rewind";
        } else {
          delete nextActions.canEdit;
          delete nextActions.editDisposition;
        }
      } else {
        if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
        else delete nextActions.canRetry;
        const headerId = this.turnHeaderRowIdByTurnId.get(row.turnId);
        const header = headerId === undefined ? undefined : rowById.get(headerId);
        const canFork =
          !compactActive &&
          row.state === "complete" &&
          header?.kind === "turnHeader" &&
          header.state === "completedSuccess" &&
          latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
          this.messageIdByRowId.has(row.rowId);
        if (canFork) nextActions.canFork = true;
        else delete nextActions.canFork;
      }
      const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
      if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
      const nextRow: ConversationRow = { ...row, actions };
      if (!actions) delete nextRow.actions;
      deltas.push({ op: "row.upserted", row: nextRow });
    }
    return deltas;
  }

  // Revision advancement: if this event contains any structural delta, increment revision and
  // require state.updated.revision in the deltas.
  private attachRevision(deltas: ConversationDelta[]): ConversationDelta[] {
    if (!deltas.some(deltaBumpsRevision)) return deltas;
    const revision = this.snapshot.revision + 1;
    const last = deltas[deltas.length - 1];
    if (last?.op === "state.updated") {
      return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
    }
    return [...deltas, { op: "state.updated", patch: { revision } }];
  }

  private reduce(fact: CanonicalConversationFact): ConversationDelta[] {
    const event = fact.event;
    switch (event.type) {
      case SessionEventType.SessionCreated:
        return this.onSessionCreated(event);
      case SessionEventType.SessionResumed:
        return this.onSessionResumed(event);
      case SessionEventType.SessionTitleUpdated:
        return this.onSessionTitleUpdated(event);
      case SessionEventType.TurnStarted:
        if (fact.semanticKind !== "userIntent") return [];
        return [
          ...this.onTurnStarted(fact),
          // Model-only maintenance turns (manual /compact, goal continuation) cannot carry a
          // SessionStart summary; keep it pending until the next real user-visible turn.
          ...(this.currentTurnStartedModelOnly
            ? []
            : this.flushPendingSessionHookInvocations(fact.productTurnId)),
        ];
      case SessionEventType.ModelStreaming: {
        if (fact.semanticKind !== "assistantSegment") return [];
        const shouldClearApiRetry =
          this.acceptsActiveModelEvent(event) &&
          isZCodeModelRetryRecoveryProgressPayload(
            event.payload as unknown as Record<string, unknown>,
          );
        const streamingDeltas = this.onModelStreaming(fact);
        return shouldClearApiRetry
          ? [...streamingDeltas, ...this.setApiRetry(null)]
          : streamingDeltas;
      }
      case SessionEventType.ModelNetworkStatus:
        return this.onModelNetworkStatus(event);
      case SessionEventType.StreamRecoveryStarted:
        return this.onStreamRecoveryStarted(event);
      case SessionEventType.StreamRecoveryTailDiscarded:
        return this.onStreamRecoveryTailDiscarded(event);
      case SessionEventType.StreamRecoveryRetryStarted:
        return this.onStreamRecoveryRetryStarted(event);
      case SessionEventType.ModelSelected:
        return this.onModelSelected(event);
      case SessionEventType.ModelComplete:
        return this.onModelComplete(event);
      case SessionEventType.ToolCallScheduled:
        return this.onToolCallScheduled(event);
      case SessionEventType.ToolCallStarted:
        return this.onToolCallActivity(event);
      case SessionEventType.ToolCallProgress:
        return this.onToolCallProgress(event);
      case SessionEventType.ToolCallResult:
        return this.onToolCallResult(event);
      case SessionEventType.ToolCallError:
        return this.onToolCallError(event);
      case SessionEventType.PermissionRequested:
        return this.onPermissionRequested(event);
      case SessionEventType.PermissionResolved:
        return this.onPermissionResolved(event);
      case SessionEventType.PermissionDenied:
        return this.onPermissionDenied(event);
      case SessionEventType.PluginUiResourceUpdated: {
        // Live-only; does not change the snapshot. The renderer dispatches to sandbox instances by subscribers.
        const payload = event.payload as PluginUiResourceUpdatedPayload;
        return [
          {
            op: "pluginUi.resourceUpdated",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            uri: payload.uri,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiResourceListChanged: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [
          {
            op: "pluginUi.resourceListChanged",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiInstanceClosed: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [{ op: "pluginUi.instanceClosed", ...payload }];
      }
      case SessionEventType.PluginUiAppToolCallRequested: {
        // App-provided tools mailbox: live-only, delivered to the single instance among subscribers.
        const payload = event.payload as PluginUiAppToolCallRequestedPayload;
        return [
          {
            op: "pluginUi.appToolCall",
            activity: payload.activity,
            ...(payload.cancelled ? { cancelled: true } : {}),
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
            callId: payload.callId,
            toolName: payload.toolName,
            arguments: payload.arguments,
          },
        ];
      }
      case SessionEventType.UserInputAutoResolutionUpdated:
        return this.onUserInputAutoResolutionUpdated(event);
      case SessionEventType.WorkspaceHookReviewRequested:
        return this.onWorkspaceHookReviewRequested(event);
      case SessionEventType.WorkspaceHookReviewSettled:
        return this.onWorkspaceHookReviewSettled(event);
      case SessionEventType.WorkspaceHookReviewSuperseded:
        return this.onWorkspaceHookReviewSuperseded(event);
      case SessionEventType.WorkspaceHookAdmissionUpdated:
        return this.onWorkspaceHookAdmissionUpdated(event);
      case SessionEventType.HookRunStarted:
      case SessionEventType.HookRunProgress:
      case SessionEventType.HookRunCompleted:
      case SessionEventType.HookRunFailed:
      case SessionEventType.HookRunBlocked:
        return this.onHookRunLifecycle(event);
      case SessionEventType.TurnSteerQueued:
        return this.onTurnSteerQueued(event);
      case SessionEventType.TurnSteerDeliveryChanged:
        return this.onTurnSteerDeliveryChanged(event);
      case SessionEventType.TurnSteerDispatchChanged:
        return this.onTurnSteerDispatchChanged(event);
      case SessionEventType.TurnSteerDrained:
        return this.onTurnSteerDrained(event);
      case SessionEventType.TurnSteerDiscarded:
        return this.onTurnSteerDiscarded(event);
      case SessionEventType.SessionInputPromoted:
        return this.onSessionInputPromoted(event);
      case SessionEventType.TurnSteerReordered:
        return this.onTurnSteerReordered(event);
      case SessionEventType.QueueAutoDrainChanged:
        return this.onQueueAutoDrainChanged(event);
      case SessionEventType.FollowupModeChanged:
        return this.onFollowupModeChanged(event);
      case SessionEventType.SessionModeChanged:
        return this.onSessionModeChanged(event);
      case SessionEventType.TurnComplete:
        return this.onTurnComplete(event);
      case SessionEventType.TurnError:
        return this.onTurnError(event);
      case SessionEventType.CompactStarted:
      case SessionEventType.CompactCompleted:
      case SessionEventType.CompactFailed:
        return this.onCompactLifecycle(event);
      case SessionEventType.TargetChanged:
        return this.onTargetChanged(event);
      case SessionEventType.TargetCompletionVerification:
        return this.onTargetVerification(event);
      case SessionEventType.SessionForked:
        return this.onSessionForked(event);
      case SessionEventType.RewindTriggered:
        return this.onRewindTriggered(event);
      case SessionEventType.BackgroundTaskStarted:
      case SessionEventType.BackgroundTaskUpdated:
      case SessionEventType.BackgroundTaskCompleted:
        return this.onBackgroundTaskLifecycle(event);
      case SessionEventType.DynamicWorkflowRunProgress:
        return this.onDynamicWorkflowRunProgress(event);
      case SessionEventType.SubagentSpawned:
        return this.onSubagentSpawned(event);
      case SessionEventType.SubagentMessage:
        return this.onSubagentMessage(event);
      case SessionEventType.SubagentStopped:
        return this.onSubagentStopped(event);
      default:
        return [];
    }
  }

  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  private onSessionResumed(event: SessionEvent): ConversationDelta[] {
    const endedAt = this.ms(event);
    const deltas: ConversationDelta[] = [];
    // A session Hook not yet assigned before the Runtime epoch changes must not attach to the next
    // turn in the new epoch; the new Runtime emits its own resume SessionStart lifecycle.
    this.pendingSessionHookInvocations.clear();
    for (const row of this.snapshot.rows.window) {
      if (row.kind !== "hookInvocation" || row.state !== "running") continue;
      const executions = row.executions.map(
        (execution): HookExecutionProjection =>
          execution.state === "running"
            ? {
                ...execution,
                state: "failed",
                outcome: "cancelled",
                endedAt,
                durationMs: Math.max(0, endedAt - execution.startedAt),
              }
            : execution,
      );
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          state: "failed",
          executions,
          endedAt,
          durationMs: Math.max(0, endedAt - row.startedAt),
        },
      });
    }
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      // reviewFlowId/generation is monotonic only within one Runtime controller. After a Runtime
      // restart, old Requested events replay first while the new flow starts again at generation=1.
      // SessionResumed marks the new Runtime epoch, so discard reviews the old Runtime can no longer
      // resolve.
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    // Soft gate: activate reports admission state again after resume.
    // Set this to null during epoch cleanup so the old Runtime's banner does not remain until the
    // new Runtime takes over.
    if (this.snapshot.workspaceHookAdmission !== null) {
      deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
    }
    return deltas;
  }

  private onHookRunLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HookRunLifecyclePayload;
    const hookInvocationId = payload.hookInvocationId;
    const hookCount = payload.hookCount;
    if (
      !hookInvocationId ||
      !payload.hookRunId ||
      !Number.isInteger(hookCount) ||
      (hookCount ?? 0) <= 0 ||
      !Number.isInteger(payload.hookIndex) ||
      payload.hookIndex < 0
    ) {
      return [];
    }
    if (this.rewoundHookInvocationIds.has(hookInvocationId)) return [];

    const rowId = this.hookRowIdByInvocationId.get(hookInvocationId);
    const existing = rowId === undefined ? undefined : this.findRow(rowId);
    const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
    const pending = this.pendingSessionHookInvocations.get(hookInvocationId);
    const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
    const previousExecution = previousExecutions.find(
      (execution) => execution.hookRunId === payload.hookRunId,
    );
    const descriptor = payload.descriptor;
    if (
      !previousExecution &&
      (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
    ) {
      return [];
    }
    const state = this.hookExecutionState(event.type);
    const startedAt =
      typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
        ? payload.startedAt
        : (previousExecution?.startedAt ?? this.ms(event));
    const endedAt = state === "running" ? undefined : this.ms(event);
    const durationMs =
      typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
        ? Math.max(0, payload.durationMs)
        : endedAt === undefined
          ? undefined
          : Math.max(0, endedAt - startedAt);
    const outcome = this.hookExecutionOutcome(event.type, payload.outcome);
    const didExecute =
      previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
    const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
    if (sourceKind === undefined || sourceKind === "internal") return [];
    const blockReason = payload.blockReason ?? previousExecution?.blockReason;
    const execution: HookExecutionProjection = {
      hookRunId: String(payload.hookRunId),
      hookIndex: payload.hookIndex,
      didExecute,
      state,
      ...(outcome ? { outcome } : {}),
      ...(blockReason ? { blockReason } : {}),
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      displayName:
        previousExecution?.displayName ??
        (descriptor
          ? hookExecutionDisplayName(descriptor, payload.hookIndex)
          : `Hook #${payload.hookIndex + 1}`),
      sourceKind,
      ...(previousExecution?.pluginName || descriptor?.pluginName
        ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
        : {}),
      ...(payload.toolName || previousExecution?.toolName
        ? { toolName: payload.toolName ?? previousExecution?.toolName }
        : {}),
    };
    const byRunId = new Map(
      previousExecutions.map((candidate) => [candidate.hookRunId, candidate]),
    );
    byRunId.set(execution.hookRunId, execution);
    const executions = [...byRunId.values()].toSorted(
      (left, right) => left.hookIndex - right.hookIndex,
    );
    const rowState = this.hookInvocationState(executions, hookCount as number);
    const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
    const invocationEndedAt =
      rowState === "running"
        ? undefined
        : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

    const content: HookInvocationRowContent = {
      kind: "hookInvocation",
      hookInvocationId,
      hookEventName: payload.hookEventName,
      hookCount: hookCount as number,
      state: rowState,
      startedAt: invocationStartedAt,
      ...(invocationEndedAt !== undefined
        ? {
            endedAt: invocationEndedAt,
            durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
          }
        : {}),
      lane: this.hookInvocationLane(payload.hookEventName),
      ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
      executions,
    };

    if (existingRow) {
      const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
      return [
        {
          op: "row.upserted",
          row: {
            ...existingRow,
            ...content,
          },
        },
        ...(blockErrorDelta ? [blockErrorDelta] : []),
      ];
    }

    if (
      pending ||
      !event.turnId ||
      // Maintenance-turn exclusion applies only to SessionStart. If the first input is /compact,
      // the SessionStart Hook carries the compact turnId and cannot attach directly; keep it pending
      // until a real turn. Model-only does not mean maintenance: background_task, subagent_message,
      // and goal-continuation turns are also model-only, but are agent turns that run tools. Their
      // PreToolUse/PostToolUse/Stop events must attach directly using event.turnId (matching cold
      // merge ownership), or pending will absorb them and incorrectly move them to the next user turn.
      (payload.hookEventName === "SessionStart" &&
        (this.currentTurnId === null || this.currentTurnStartedModelOnly))
    ) {
      // Startup SessionStart may already carry a runtime turnId, but TurnStarted has not yet created
      // the runtimeTurnId -> productTurnId mapping. Appending early would split it into a separate
      // footer.
      this.pendingSessionHookInvocations.set(hookInvocationId, {
        firstEvent: pending?.firstEvent ?? event,
        content,
      });
      return [];
    }

    const turnId = this.turnIdOf(event);
    const rowBase = this.rowBase(event, turnId, hookInvocationId);
    const row: HookInvocationRow = {
      ...rowBase,
      ...content,
    };
    this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
    return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
  }

  /**
   * An executed block from UserPromptSubmit is a visible error for the current input, but does not
   * mean the task failed. Project it into transient lastError so ChatErrorBanner can show the cause;
   * the next TurnStarted clears it through the existing lifecycle. Admission-only and tool-boundary
   * blocks remain only in the Hook summary.
   */
  private hookBlockErrorDelta(
    event: SessionEvent,
    payload: HookRunLifecyclePayload,
    didExecute: boolean,
    blockReason: string | undefined,
  ): ConversationDelta | null {
    if (
      event.type !== SessionEventType.HookRunBlocked ||
      payload.hookEventName !== "UserPromptSubmit" ||
      !didExecute ||
      !blockReason
    ) {
      return null;
    }
    const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
      .map((value) => value?.trim())
      .find((value) => value && value !== blockReason);
    const displayReason = diagnosticMessage ?? blockReason;
    const message =
      displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
    const detail = [
      `Hook block reason: ${blockReason}`,
      ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
    ].join("\n");
    return {
      op: "state.updated",
      patch: this.controlPatch({
        lastError: {
          code: "fault.runtime.hookBlocked",
          message,
          recoverable: false,
          at: this.ms(event),
          source: "runtime",
          traceId: String(event.traceId),
          ...(detail ? { detail } : {}),
          attribution: {
            source: "runtime",
            reason: "hook_blocked",
          },
        },
      }),
    };
  }

  private flushPendingSessionHookInvocations(turnId: string): ConversationDelta[] {
    if (this.pendingSessionHookInvocations.size === 0) return [];
    const deltas: ConversationDelta[] = [];
    for (const [hookInvocationId, pending] of this.pendingSessionHookInvocations) {
      const row: HookInvocationRow = {
        ...this.rowBase(pending.firstEvent, turnId, hookInvocationId),
        ...pending.content,
      };
      this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }
    this.pendingSessionHookInvocations.clear();
    return deltas;
  }

  private hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"] {
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    if (
      eventType === SessionEventType.HookRunCompleted ||
      eventType === SessionEventType.HookRunBlocked
    ) {
      return "completed";
    }
    return "running";
  }

  private hookExecutionOutcome(
    eventType: SessionEvent["type"],
    outcome: HookRunLifecyclePayload["outcome"],
  ): HookExecutionProjection["outcome"] {
    if (outcome) return outcome;
    if (eventType === SessionEventType.HookRunCompleted) return "success";
    if (eventType === SessionEventType.HookRunBlocked) return "blocked";
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    return undefined;
  }

  private hookInvocationState(
    executions: readonly HookExecutionProjection[],
    hookCount: number,
  ): HookInvocationRow["state"] {
    if (
      executions.length < hookCount ||
      executions.some((execution) => execution.state === "running")
    ) {
      return "running";
    }
    return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
  }

  private hookInvocationLane(
    eventName: HookRunLifecyclePayload["hookEventName"],
  ): HookInvocationRow["lane"] {
    if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
    if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
    return "assistantWork";
  }

  /**
   * Live-projection truncation for rewind/edit/retry (editUserQuery/retryTurn's
   * `row.removed(target onward)`). RewindTriggered carries targetMessageId; reverse-resolve rowId,
   * then remove the full segment starting at that row's turn header so live subscribers see the
   * truncation immediately. A later editRerun appends a new turn through the existing event path.
   * For cold subscriptions/refreshes, transcript hydration reconstructs the truncated transcript
   * as a fallback. Return empty if messageId cannot be reverse-resolved (the user row has no
   * messageId yet, or the event is late), avoiding accidental deletion.
   */
  private onRewindTriggered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      targetMessageId?: string;
      scope?: string;
      branchCutAfterMessageId?: string;
      branchGeneration?: number;
      createdMessageId?: string;
      reason?: string;
    };
    if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
      const targetMessageId = payload.targetMessageId;
      if (!targetMessageId) return [];
      const targetRowId = this.rowIdForMessageId(targetMessageId);
      if (targetRowId === null) return [];
      const targetRow = this.findRow(targetRowId);
      if (!targetRow) return [];
      const headerRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId);
      const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
      if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
      return [
        {
          op: "row.upserted",
          row: {
            ...headerRow,
            fileChanges: {
              ...headerRow.fileChanges,
              state: "reverted",
            },
          },
        },
      ];
    }
    // The new semantics consume only committed conversation rewinds carrying branchGeneration/cut;
    // createdMessageId is only for legacy transcript compatibility. Failures/conflicts emit no
    // event, so they cannot create a false UI truncation.
    const applied =
      (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
      payload.createdMessageId !== undefined;
    if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this.findRow(targetRowId);
    if (!targetRow) return [];
    // Remove from the first row of this row's turn (the whole turn is replaced by rewind/edit/retry).
    const turnHeaderRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
    const fromRowId = Math.min(turnHeaderRowId, targetRowId);
    // Clear messageId/tool indexes for removed rows to avoid dangling mappings.
    for (const [rowId] of this.messageIdByRowId) {
      if (rowId >= fromRowId) this.messageIdByRowId.delete(rowId);
    }
    for (const [messageId, rowId] of this.outputContinuationRowIdByMessageId) {
      if (rowId >= fromRowId) this.outputContinuationRowIdByMessageId.delete(messageId);
    }
    for (const [rowId, entityId] of this.entityIdByRowId) {
      if (rowId >= fromRowId) {
        this.entityIdByRowId.delete(rowId);
        this.editTargetByEntityId.delete(entityId);
      }
    }
    for (const [hookInvocationId, rowId] of this.hookRowIdByInvocationId) {
      if (rowId >= fromRowId) {
        this.rewoundHookInvocationIds.add(hookInvocationId);
        this.hookRowIdByInvocationId.delete(hookInvocationId);
      }
    }
    return [{ op: "row.removed", fromRowId }];
  }

  /** Reverse lookup from messageId to rowId (linear scan of messageIdByRowId; row count is bounded, so no extra index is needed). */
  private rowIdForMessageId(messageId: string): number | null {
    const continuationRowId = this.outputContinuationRowIdByMessageId.get(messageId);
    if (continuationRowId !== undefined) return continuationRowId;
    for (const [rowId, mid] of this.messageIdByRowId) {
      if (mid === messageId) return rowId;
    }
    return null;
  }

  /**
   * Map any rowId to the rewind-anchor messageId for its turn. New live/cold user rows should carry
   * the persistent user messageId directly; a same-turn assistant is retained only as a fallback for
   * legacy events. `canEdit` must not rely on this fallback and must use the user row's exact target.
   */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.rewindAnchorForRows(this.snapshot.rows.window, rowId);
  }

  private rewindAnchorForRows(rows: readonly ConversationRow[], rowId: number): string | null {
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (!row) return null;
    const turnId = row.turnId;
    for (const [candidateRowId, messageId] of this.messageIdByRowId) {
      const candidate = rows.find((item) => item.rowId === candidateRowId);
      if (candidate && candidate.turnId === turnId) return messageId;
    }
    return null;
  }

  /**
   * Register the display identity and command identity of a real-user row atomically.
   * TurnSteerDrained previously wrote only messageId/entityId and omitted the edit target, causing
   * the UI action and editUserQuery resolver to reach opposite conclusions for the same row.
   */
  private registerCanonicalUserRowTarget(
    rowId: number,
    entityId: string,
    editTarget?: ConversationEditTarget,
  ): void {
    this.entityIdByRowId.set(rowId, entityId);
    if (!editTarget) return;
    this.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
    this.editTargetByEntityId.set(entityId, editTarget);
  }

  // ── Lifecycle ──

  private onSessionCreated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { contextWindow?: number };
    this.contextWindowState.maxTokens = payload.contextWindow ?? null;
    // Draft semantics: the session entity exists but has no rows; keep phase as draft with no visible delta.
    return [];
  }

  // renameSession / automatic title: SessionTitleUpdated(title, source) updates metadata.
  // custom (user rename) has the highest priority; once custom, it is not overwritten by generated,
  // matching core titleSource.
  private onSessionTitleUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      title?: string;
      source?: string;
    };
    const title = payload.title ?? "";
    // core titleSource has four values (default/first_input/generated/custom); normalize projection
    // metadata to default/generated/custom (first_input maps to generated because both are
    // "not explicitly set by the user").
    const source: "default" | "generated" | "custom" =
      payload.source === "custom"
        ? "custom"
        : payload.source === "default"
          ? "default"
          : "generated";
    const prev = this.snapshot.meta;
    if (prev.titleSource === "custom" && source === "generated") return [];
    if (prev.title === title && prev.titleSource === source) return [];
    return [
      {
        op: "state.updated",
        patch: { meta: { title, titleSource: source } },
      },
    ];
  }

  private onTurnStarted(fact: CanonicalUserIntentFact): ConversationDelta[] {
    const event = fact.event;
    const runtimeTurnId = fact.runtimeTurnId;
    const turnId = fact.productTurnId;
    this.currentTurnId = runtimeTurnId;
    this.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
    // New runtimeTurn: reset the product-turn mapping (1:1); the elapsed-time baseline is this turn's start.
    this.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
    if (turnId !== runtimeTurnId) this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
    this.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
    this.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    this.outputContinuationTextRowId = null;

    // A background Agent's ToolCallResult is only a launch ACK, so first settle the tool row as
    // success. The subagent's real terminal state later starts a new model-only task-notification
    // turn. V4 previously did not consume this authoritative fact by tool-use-id, leaving the card
    // stuck at completed forever after a 429.
    const deltas: ConversationDelta[] = this.applyBackgroundTaskNotification(fact);
    const sharedContextRef = fact.sharedContextRefs?.[0];
    if (
      sharedContextRef &&
      this.snapshot.sharedContextImport &&
      "contextId" in this.snapshot.sharedContextImport &&
      this.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
      (this.snapshot.sharedContextImport.status === "pending" ||
        this.snapshot.sharedContextImport.status === "reserved")
    ) {
      const sharedContextImport = {
        ...this.snapshot.sharedContextImport,
        status: "attached" as const,
      };
      this.snapshot = { ...this.snapshot, sharedContextImport };
      deltas.push({ op: "state.updated", patch: { sharedContextImport } });
    }
    // Marker timing: add a modelChange marker before turnHeader only when the provider/model
    // identity actually used this turn differs from the previous turn. The ordinary first turn with
    // silentInitial emits no marker; an explicit sourceLess boundary emits a "now using" marker.
    // A change in reasoning depth updates config.thought only; it is not a model-identity change.
    // Bug background: the old implementation added the marker in onModelSelected (at switch time),
    // so switching models in a prewarmed draft session put [modelChange] above the first message.
    const config = this.snapshot.config;
    const hasModel = config.provider !== "" && config.model !== "";
    if (hasModel && this.lastTurnModel.kind === "sourceLess") {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-initial:${turnId}:${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    } else if (
      hasModel &&
      this.lastTurnModel.kind === "known" &&
      (this.lastTurnModel.provider !== config.provider || this.lastTurnModel.model !== config.model)
    ) {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-change:${turnId}:${this.lastTurnModel.provider}/${this.lastTurnModel.model}->${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          // The projection determines the lane; the UI must not infer placement semantics from marker type.
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            fromProvider: this.lastTurnModel.provider,
            fromModel: this.lastTurnModel.model,
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    }
    if (hasModel) {
      this.lastTurnModel = {
        kind: "known",
        provider: config.provider,
        model: config.model,
        thought: config.thought,
      };
    }
    const headerBase = this.rowBase(event, turnId, turnId);
    const header: TurnHeaderRow = {
      ...headerBase,
      kind: "turnHeader",
      origin: fact.turnHeaderOrigin,
      executionKind: fact.executionKind,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      state: "running",
      startedAt: headerBase.createdAt,
    };
    this.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });

    // Model-only input (such as goal continuation) does not create a visible userInput row.
    if (fact.visibility === "visible") {
      const rowBase = this.rowBase(event, turnId, fact.entityId);
      const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
      const attachments = fact.attachments?.map((attachment, index) => ({
        ...attachment,
        ref: attachment.ref ?? `turn-attachment/${rowBase.rowId}/${index}`,
      }));
      const row: UserInputRow = {
        ...rowBase,
        kind: "userInput",
        text:
          fact.conversationQuotes || fact.botGroupSource
            ? (fact.intentText ?? fact.input)
            : fact.input,
        origin: fact.origin,
        ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
        ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
        ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
        ...(fact.clientId ? { clientId: fact.clientId } : {}),
        ...(fact.highspeed ? { highspeed: fact.highspeed } : {}),
        ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
        ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(fact.source ? { source: fact.source } : {}),
      };
      // A workspace checkpoint uses the user messageId as targetMessageId.
      // Ordinary TurnStarted must also register the userInput row's internal anchor; otherwise the
      // file-summary query can find only the assistant messageId and cannot find this turn's checkpoint.
      this.registerCanonicalUserRowTarget(
        row.rowId,
        fact.entityId,
        fact.transcriptMessageId
          ? {
              entityId: fact.entityId,
              productTurnId: fact.productTurnId,
              transcriptMessageId: fact.transcriptMessageId,
              coveredByStableCompact: false,
              intent: {
                kind: fact.intentKind,
                text: fact.intentText,
                ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
                ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
                ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
                ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
                ...(fact.clientId ? { clientId: fact.clientId } : {}),
                ...(fact.attachments ? { attachments: fact.attachments } : {}),
                ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
                ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
                ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
                ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
                ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
                ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
                ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
                ...(fact.mode ? { mode: fact.mode } : {}),
                ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
                ...(fact.provenance ? { provenance: fact.provenance } : {}),
              },
            }
          : undefined,
      );
      deltas.push({
        op: "row.appended",
        row,
      });
    }

    if (fact.executionKind === "agent") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [
            {
              kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
              ...(fact.foregroundExecutionId
                ? { foregroundExecutionId: fact.foregroundExecutionId }
                : {}),
              // An automatic interruption must be tied to the actual execution input; clients cannot
              // guess it from the last message.
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              startedAt: this.ms(event),
            },
          ],
          // Once a new turn is accepted, the old error is no longer current (same decision as the old reducer).
          lastError: null,
          apiRetry: null,
        }),
      });
    }
    // The visible /goal query uses a controlOnly turn to establish live timeline identity, but
    // actual execution belongs to the following goalContinuation. If the control turn also advances
    // to running, the continuous path briefly creates a second activeWorks entry and recovery
    // projection shows a fabricated work lifecycle.
    return deltas;
  }

  private applyBackgroundTaskNotification(fact: CanonicalUserIntentFact): ConversationDelta[] {
    const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
    if (!parsed) return [];
    const row = this.findToolRow(parsed.toolUseId);
    if (!row) return [];

    const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
      parsed.notification.status,
    );
    const status: ToolCallRow["status"] =
      notificationStatus === "failed"
        ? "error"
        : notificationStatus === "stopped"
          ? "cancelled"
          : "success";
    const content =
      parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
    const next: ToolCallRow = {
      ...row,
      status,
      ...(content
        ? {
            output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
          }
        : {}),
      endedAt: this.ms(fact.event),
    };
    if (status === "error") {
      next.error = {
        code: "fault.runtime.backgroundTaskFailed",
        message: parsed.notification.error ?? content ?? "Background task failed.",
      };
    } else {
      delete next.error;
    }
    return [{ op: "row.upserted", row: next }];
  }

  private onTurnComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnCompletePayload;
    this.outputContinuationTextRowId = null;
    const headerState = mapTurnResultToHeaderState(payload.resultType);
    const header = this.turnHeaderForEvent(event);
    if (header?.executionKind === "controlOnly") {
      // controlOnly has no Agent work duration. In particular, do not send duration=0 to the old
      // UI, which formats zero seconds as "worked for 1 second" for readability. Only settle the
      // visible turn here; do not change session control, except when leaving draft (see
      // leaveDraftAfterControlOnlyTurn).
      const deltas = [
        ...this.upsertTurnHeader(event, headerState, undefined, payload.historyRoundCount),
        ...this.leaveDraftAfterControlOnlyTurn(
          payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
        ),
      ];
      this.currentTurnId = null;
      // The model-only marker expires when the turn settles so it cannot affect the next ownership decision.
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    const phase: SessionControl["phase"] =
      payload.resultType === "success"
        ? "completedSuccess"
        : payload.resultType === "cancelled"
          ? "completedInterrupted"
          : "error";
    const streamClose = payload.resultType === "success" ? "complete" : "interrupted";
    const activeMs = this.activeMsForCompletion(event, payload.duration);

    // stopPausesActiveGoalTarget: when stop applies to any foreground work, force an active/verifying
    // goal into paused and wait for an explicit resumeGoal.
    const goal = this.snapshot.goal;
    const pausedGoal: GoalState | undefined =
      payload.resultType === "cancelled" &&
      (goal?.status === "active" || goal?.status === "verifying")
        ? { ...goal, status: "paused" }
        : undefined;

    // stopKeepsQueueAndDisablesAutoDrain (stop effect): preserve the queue after interruption and do
    // not consume it automatically, leaving it paused. pauseReason explains the cause to the UI and
    // does not participate in routing decisions.
    const heldQueue =
      payload.resultType === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0 &&
      (this.snapshot.queue.autoDrain || this.snapshot.queue.pauseReason !== "stopped")
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    const deltas: ConversationDelta[] = [
      ...this.closeStreamingRows(streamClose),
      // A terminal turn also settles any in-flight foreground tool row. Settlement invariant: an
      // inputText stream filtered by the profile must be implied by an unfiltered row.upserted (see
      // profiles.ts).
      ...this.closeOpenToolRows(event, payload.resultType === "cancelled" ? "cancelled" : "error"),
      ...this.upsertTurnHeader(
        event,
        headerState,
        activeMs,
        payload.historyRoundCount,
        this.highspeedTimingForTurn(this.turnIdOf(event), activeMs),
      ),
      ...(payload.resultType === "success" ? this.markStableForkAssistant(event) : []),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase,
            sessionEnded: phase !== "error",
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // The old V4 reducer did not consume ModelNetworkStatus. After adding projection, failing
            // to clear it when a turn goes directly to terminal would leave "reconnecting" visible
            // into the next turn.
            apiRetry: null,
          },
          pausedGoal,
          heldQueue,
        ),
      },
    ];
    this.currentTurnId = null;
    // The model-only marker expires when the turn settles so it cannot affect the next ownership decision.
    this.currentTurnStartedModelOnly = false;
    return deltas;
  }

  /**
   * A draft has one exit: settlement of its first turn. `draft` means "in-memory only, never had
   * real content, and disappears when the CLI restarts." Once a controlOnly turn settles, the
   * session has persisted visible history; continuing to call it a draft conflicts with cold
   * recovery, where the store seed assigns a terminal phase while the live projection remains in
   * draft. Sessions started directly by the hub have only a controlOnly startup turn, so the live
   * projection stays in draft and the task-index syncer discards the sessions-index summary as a
   * draft; it appears in the sidebar only after restart. Therefore, advance phase on controlOnly
   * settlement only while the session is still a draft (success → completedSuccess, cancellation →
   * completedInterrupted, failure → error). As before, control turns on non-draft sessions do not
   * change session control (the visible goal query turn must not fabricate running/work duration;
   * see onTurnStarted).
   */
  private leaveDraftAfterControlOnlyTurn(
    phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
  ): ConversationDelta[] {
    if (this.snapshot.control.phase !== "draft") return [];
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
        }),
      },
    ];
  }

  private onTurnError(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnErrorPayload;
    this.outputContinuationTextRowId = null;
    if (this.turnHeaderForEvent(event)?.executionKind === "controlOnly") {
      const deltas = [
        ...this.upsertTurnHeader(event, "failed"),
        ...this.leaveDraftAfterControlOnlyTurn("error"),
      ];
      this.currentTurnId = null;
      // The model-only marker expires when the turn settles so it cannot affect the next ownership decision.
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    // TurnError ends the current turn, not already-accepted future input. The old reducer had no
    // terminal queue patch, so core had to emit TurnSteerDiscarded to prevent a queue hanging after
    // an error, losing the user's message. Now preserve the existing queue as error-paused and wait
    // for explicit setAutoDrain(true) to resume FIFO.
    const heldQueue =
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "error" as const,
          }
        : undefined;
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "error"),
      ...this.upsertTurnHeader(
        event,
        "failed",
        undefined,
        undefined,
        this.highspeedTimingForTurn(this.turnIdOf(event)),
      ),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "error",
            sessionEnded: false,
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // Events do not yet carry fault.* classification; pass through the error type for now
            // and refine the mapping when classification is added.
            lastError: {
              code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
              message: payload.error.message,
              recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
              at: this.ms(event),
              // The old projection labeled every TurnError as runtime, losing provider/network facts
              // already identified by the adapter.
              source: payload.error.attribution?.source ?? "runtime",
              traceId: String(event.traceId),
              ...(payload.error.detail ? { detail: payload.error.detail } : {}),
              ...(payload.error.underlyingErrorMessage
                ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
                : {}),
              ...(payload.error.underlyingErrorDetail
                ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
                : {}),
              ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
            },
            // As with onTurnComplete, terminal state is the fallback cleanup boundary for the retry lifecycle.
            apiRetry: null,
          },
          undefined,
          heldQueue,
        ),
      },
    ];
  }

  // ── Streaming output ──

  private onModelNetworkStatus(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as ModelNetworkStatusPayload;
    if (
      (payload.querySource === undefined || payload.querySource === "main_turn") &&
      (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
      // Highspeed cards are split into several hidden providers by family (zai/bigmodel), so this can
      // no longer compare against a single constant; otherwise a BigModel account's accelerated turns
      // are treated as ordinary and the saved time is always 0.
      isHighspeedProviderId(payload.providerId) &&
      payload.durationMs !== undefined
    ) {
      // Cause: after a hybrid turn card expires, the session switches to the ordinary provider. The
      // old logic also accumulated ordinary-model retries/timeouts into Highspeed modelDurationMs,
      // inflating the saved time by the highspeed multiplier for hours.
      const turnId = this.turnIdOf(event);
      this.highspeedModelDurationByTurnId.set(
        turnId,
        (this.highspeedModelDurationByTurnId.get(turnId) ?? 0) + Math.max(0, payload.durationMs),
      );
    }
    switch (payload.type) {
      case "model_retry_scheduled": {
        const attempt = positiveInteger(payload.attempt, 1);
        const maxAttempts = Math.max(
          positiveInteger(payload.maxAttempts, attempt + 1),
          attempt + 1,
        );
        return this.setApiRetry({
          attempt,
          maxAttempts,
          nextRetryAt: this.ms(event) + nonNegativeInteger(payload.delayMs, 0),
          reasonCode: modelRetryReasonCode(payload.reason),
        });
      }
      case "model_request_started":
        if (payload.streamRecovery) {
          return this.setApiRetry(
            this.streamRecoveryApiRetry(
              payload.streamRecovery.retryNumber,
              payload.streamRecovery.maxRetries,
              this.ms(event),
              this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
            ),
          );
        }
        // adapter attempt=2+ means only that a retry request was sent, not that the connection
        // recovered. Keep the current state until the first valid text/reasoning/tool progress to
        // avoid the label disappearing briefly.
        return positiveInteger(payload.attempt, 1) <= 1 ? this.setApiRetry(null) : [];
      case "model_request_completed":
        return this.setApiRetry(null);
      case "model_request_failed":
        return payload.retryable ? [] : this.setApiRetry(null);
      case "model_stream_stalled":
      case "model_first_provider_event":
      case "model_first_content":
      case "model_first_text":
      // Both ends of admission waiting are runtime observations, not UI states; do not map them to
      // retry/waiting labels.
      case "model_request_queued":
      case "model_request_admitted":
      case "model_request_observation":
        return [];
    }
  }

  private onStreamRecoveryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        streamRecoveryReasonCode(payload.failureKind),
      ),
    );
  }

  private onStreamRecoveryTailDiscarded(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    // Cause: Core had already cut off the failed assistant attempt with tail_discarded, but the old
    // V4 projection ignored the event. The next reasoning/text event then incorrectly settled the
    // old row as complete. Mark it interrupted first so the recovery stream opens a new row with a
    // new assistant identity, rather than appearing as one continuous complete output.
    // Cause: tool rows opened by tool_input_start but not yet finalized by tool_call also belong to
    // the discarded tail. Core synthesizes terminal events only for committed tools, leaving these
    // rows unsettled; the recovery request opens another row with a new toolCallId, so the UI shows
    // two parallel "writing workflow" cards. Committed rows (running/pendingApproval) are excluded;
    // their terminal state is published by the executor.
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
    ];
  }

  private onStreamRecoveryRetryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryRetryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
      ),
    );
  }

  private streamRecoveryApiRetry(
    retryNumber: number,
    maxRetriesValue: number,
    nextRetryAt: number,
    reasonCode: string,
  ): ApiRetryState {
    const attempt = positiveInteger(retryNumber, 1);
    const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
    return {
      attempt,
      maxAttempts: maxRetries + 1,
      nextRetryAt,
      reasonCode,
    };
  }

  private setApiRetry(apiRetry: ApiRetryState | null): ConversationDelta[] {
    const current = this.snapshot.control.apiRetry;
    if (
      current === apiRetry ||
      (current !== null &&
        apiRetry !== null &&
        current.attempt === apiRetry.attempt &&
        current.maxAttempts === apiRetry.maxAttempts &&
        current.nextRetryAt === apiRetry.nextRetryAt &&
        current.reasonCode === apiRetry.reasonCode)
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({ apiRetry }),
      },
    ];
  }

  private acceptsActiveModelEvent(event: SessionEvent): boolean {
    if (!this.isRunning()) return false;
    // An old request may arrive after stop/a new turn; session-level state alone would let a retry/
    // progress event from the old turn overwrite the current input area. When the current runtime
    // turn is known, isolate by turnId.
    return (
      this.currentTurnId === null ||
      event.turnId === undefined ||
      String(event.turnId) === this.currentTurnId
    );
  }

  private onModelStreaming(fact: CanonicalAssistantSegmentFact): ConversationDelta[] {
    const event = fact.event;
    // Do not resurrect after a late terminal event: reject all streaming events received outside a
    // running state.
    // Assistant conservation: rejecting a body event is not a harmless drop. If the projection is
    // created after TurnStarted (a publisher is created mid-subscription), the entire reply silently
    // disappears until refresh (the live "whole reply vanished" failure mode). Expose the count to
    // the gateway, which marks the projection stale; the next subscription forces rehydration from
    // persisted facts.
    if (!this.isRunning()) {
      const dropped = fact.stream;
      if (
        dropped.kind === "text_start" ||
        dropped.kind === "text_delta" ||
        dropped.kind === "reasoning_start" ||
        dropped.kind === "reasoning_delta"
      ) {
        this.droppedContentStreamEventCount += 1;
      }
      return [];
    }
    const payload = fact.stream;
    switch (payload.kind) {
      case "text_start":
        return this.openTextRow(event, fact);
      case "text_delta": {
        const open = this.streamingTextRowId === null ? this.openTextRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingTextRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "text_end":
        return this.closeTextRow("complete");
      case "reasoning_start":
        return this.openReasoningRow(event, fact);
      case "reasoning_delta": {
        const open =
          this.streamingReasoningRowId === null ? this.openReasoningRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingReasoningRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "reasoning_end":
        return this.closeReasoningRow();
      case "tool_input_start":
        return this.openToolRow(event, payload, fact.entityId);
      case "tool_input_delta": {
        return this.appendStreamingToolInput(event, payload);
      }
      case "tool_input_end":
        return this.flushStreamingToolInput(String(payload.toolCallId ?? ""));
      case "tool_call":
        return this.finalizeStreamingToolInput(event, payload);
      default:
        return [];
    }
  }

  private openTextRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeTextRow("complete");
    const continuationRowId = this.outputContinuationTextRowId;
    this.outputContinuationTextRowId = null;
    const continuationRow =
      continuationRowId === null ? undefined : this.findRow(continuationRowId);
    const currentTurnId = this.turnIdOf(event);
    const lastVisibleRow = this.snapshot.rows.window.at(-1);
    if (
      continuationRow?.kind === "assistantText" &&
      continuationRow.turnId === currentTurnId &&
      lastVisibleRow?.rowId === continuationRow.rowId
    ) {
      // Runtime output-token Continue creates a new assistantMessageId for each provider request,
      // so the old projection split one answer into a history partial plus a turn-tail body.
      // ModelComplete already provides exact eligibility through length; reopen only the adjacent
      // same-turn text row so both continuous and replayable clients observe one steadily growing
      // assistant message.
      const {
        actions: _actions,
        assistantResponseId: _assistantResponseId,
        feedback: _feedback,
        ...continuedBase
      } = continuationRow;
      const row: AssistantTextRow = {
        ...continuedBase,
        entityId: fact.entityId,
        ...(fact.stream.assistantResponseId
          ? { assistantResponseId: fact.stream.assistantResponseId }
          : {}),
        state: "streaming",
      };
      this.streamingTextRowId = row.rowId;
      this.entityIdByRowId.set(row.rowId, fact.entityId);
      const previousMessageId = this.messageIdByRowId.get(row.rowId);
      if (previousMessageId) {
        this.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
      }
      if (fact.transcriptMessageId) {
        this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
      }
      return [...close, { op: "row.upserted", row }];
    }

    // Invariant: a new segment that is not output-token Continue always gets a new rowId; settle any
    // existing streaming row first.
    const row: AssistantTextRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "assistantText",
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingTextRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    // forkAssistant anchor: assistant row → authoritative messageId (provided in the first provider stream frame).
    if (fact.transcriptMessageId) {
      this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.appended", row }];
  }

  private closeTextRow(state: "complete" | "interrupted"): ConversationDelta[] {
    if (this.streamingTextRowId === null) return [];
    const row = this.findRow(this.streamingTextRowId);
    this.streamingTextRowId = null;
    if (row?.kind !== "assistantText") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  private onAssistantFeedbackUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as AssistantFeedbackUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is AssistantTextRow =>
        candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    if (payload.feedback === null) {
      if (row.feedback === undefined) return [];
      const { feedback: _removedFeedback, ...withoutFeedback } = row;
      return [{ op: "row.upserted", row: withoutFeedback }];
    }
    if (row.feedback === payload.feedback) return [];
    return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
  }

  private onRowPinnedUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as RowPinnedUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is AssistantTextRow | UserInputRow =>
        (candidate.kind === "assistantText" || candidate.kind === "userInput") &&
        candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    if (payload.pinnedAt === null) {
      if (row.pinnedAt === undefined) return [];
      const { pinnedAt: _removedPinnedAt, ...withoutPinnedAt } = row;
      return [{ op: "row.upserted", row: withoutPinnedAt }];
    }
    if (row.pinnedAt === payload.pinnedAt) return [];
    return [{ op: "row.upserted", row: { ...row, pinnedAt: payload.pinnedAt } }];
  }

  private onHighspeedMetricsUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HighspeedMetricsUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    // Cause: the terminal metrics update used to replace row.highspeed wholesale. The payload comes
    // from raw transcript metadata plus duration fields and lacks fallbackAt, which the live
    // projection had just written via TurnExecutionModelFallback; clearing it broke the downgrade
    // toast and made live and cold/replay disagree. Metrics updates are incremental supplements:
    // merge at field level, add-only (spec §5).
    return [
      {
        op: "row.upserted",
        row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
      },
    ];
  }

  private onTurnExecutionModelFallback(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnExecutionModelFallbackPayload;
    // Cause: a fallback discards the current assistant attempt, but the old projection updated only
    // the input row's metadata and left the old model's text/reasoning rows streaming. When the
    // original model resumed, that content was mislabeled complete, or even appended to the same row
    // when text_start was missing. Unfinalized tool input likewise never receives tool_call and must
    // be settled together with the discarded attempt. Committed tool executions are not handled
    // here; core's tool_abandoned event settles them.
    const discardedStreamDeltas = this.acceptsActiveModelEvent(event)
      ? [
          ...this.closeStreamingRows("interrupted"),
          ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
        ]
      : [];
    // Both card expiry and other accelerated-request failures project onto the same accelerated
    // input row: fallbackAt triggers the one-time notice, and fallbackReason lets the renderer
    // distinguish "card expired" from "acceleration service unavailable" copy.
    const turnId = this.turnIdOf(event);
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" &&
        // Cause: cold hydration rebuilds product turnIds, so the runtime turnId can no longer
        // associate persisted input; inputId/sourceCommandId are the recovery-stable identities.
        (candidate.turnId === turnId ||
          (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
        candidate.highspeed !== undefined,
    );
    if (!row?.highspeed) return discardedStreamDeltas;
    return [
      ...discardedStreamDeltas,
      {
        op: "row.upserted",
        row: {
          ...row,
          highspeed: {
            ...row.highspeed,
            fallbackAt: event.timestamp.getTime(),
            fallbackReason: payload.reason,
          },
        },
      },
    ];
  }

  private openReasoningRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeReasoningRow();
    const row: ReasoningRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "reasoning",
      // Cause: the canonical stream carried assistant response identity, but the old projection
      // stored it only on body and tool rows. The UI therefore could not reliably group reasoning
      // with the same response in a CUA Group.
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingReasoningRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    return [...close, { op: "row.appended", row }];
  }

  private closeReasoningRow(state: "complete" | "interrupted" = "complete"): ConversationDelta[] {
    if (this.streamingReasoningRowId === null) return [];
    const row = this.findRow(this.streamingReasoningRowId);
    this.streamingReasoningRowId = null;
    if (row?.kind !== "reasoning") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  private closeStreamingRows(state: "complete" | "interrupted"): ConversationDelta[] {
    return [...this.closeTextRow(state), ...this.closeReasoningRow(state)];
  }

  // A terminal turn settles every non-terminal foreground tool row (the isRunning gate prevents
  // late terminal events from resurrecting it); `only` lets stream recovery settle only the
  // unfinished subset.
  private closeOpenToolRows(
    event: SessionEvent,
    status: "cancelled" | "error",
    only?: (row: ToolCallRow) => boolean,
  ): ConversationDelta[] {
    if (this.openForegroundToolCallIds.size === 0) return [];
    const openRows: ToolCallRow[] = [];
    for (const toolCallId of this.openForegroundToolCallIds) {
      const row = this.findToolRow(toolCallId);
      // A derived index must not become a second source of truth; always recheck the current snapshot
      // row before settling it.
      if (!row || !this.isOpenForegroundToolRow(row)) continue;
      if (only && !only(row)) continue;
      openRows.push(row);
    }
    if (openRows.length === 0) return [];
    // A late reopen may change Set insertion order; rowId is monotonic, so sorting preserves the old
    // timeline delta order.
    if (openRows.length > 1) {
      openRows.sort((left, right) => left.rowId - right.rowId);
    }
    const deltas: ConversationDelta[] = [];
    const closedToolCallIds = new Set<string>();
    for (const row of openRows) {
      const next: ToolCallRow = {
        ...row,
        status,
        inputText: `${row.inputText ?? ""}${this.takePendingStreamingToolInput(row.toolCallId)}`,
        endedAt: this.ms(event),
      };
      delete next.approvalInteractionId;
      if (status === "error") {
        // If the executor exits early or an event is missing, the old projection settled tools only
        // on the stop path. Success/error turns left running rows, and the cold snapshot lacked a
        // header, causing the UI to misread the state as thinking.
        next.error = {
          code: "fault.runtime.toolLifecycleIncomplete",
          message: "Tool call ended without a terminal event.",
        };
      } else {
        delete next.error;
      }
      closedToolCallIds.add(row.toolCallId);
      deltas.push({ op: "row.upserted", row: next });
    }

    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) =>
        !(
          (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
          typeof interaction.payload.toolCallId === "string" &&
          closedToolCallIds.has(interaction.payload.toolCallId)
        ),
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    return deltas;
  }

  private isOpenForegroundToolRow(row: ToolCallRow): boolean {
    return (
      row.backgrounded !== true &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    );
  }

  private updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void {
    for (const delta of deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        if (delta.row.kind !== "toolCall") continue;
        if (this.isOpenForegroundToolRow(delta.row)) {
          this.openForegroundToolCallIds.add(delta.row.toolCallId);
        } else {
          this.openForegroundToolCallIds.delete(delta.row.toolCallId);
        }
        continue;
      }
      if (delta.op !== "row.removed") continue;
      for (const [toolCallId, rowId] of this.toolRowIdByCallId) {
        if (rowId < delta.fromRowId) continue;
        // Cause: rewind previously removed only rows/message indexes. An old toolCallId could still
        // prevent the new branch from reopening a streaming tool with the same ID, and the open
        // tracker could retain a row that no longer existed.
        this.toolRowIdByCallId.delete(toolCallId);
        this.openForegroundToolCallIds.delete(toolCallId);
        this.fileToolInputPreviewByCallId.delete(toolCallId);
      }
      this.pruneRemovedSubagentIndexes();
    }
  }

  private pruneRemovedSubagentIndexes(): void {
    for (const [agentId, rowId] of this.subagentRowIdByAgentId) {
      if (this.findRow(rowId)?.kind === "subagent") continue;
      // Cause: rewind rebuilt only rowIndex, so old agent aliases remained enumerable by every later
      // subagent materialization. Clean once from the authoritative snapshot after row.removed is
      // applied to prevent long sessions growing with deleted history; ordinary events do not scan
      // this index.
      this.subagentRowIdByAgentId.delete(agentId);
    }
  }

  // ── Tool-call state machine ──

  private openToolRow(
    event: SessionEvent,
    payload: CanonicalModelStream,
    entityId?: string,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (
      toolCallId === "" ||
      shouldHideInvalidToolCallFromProduct(payload.toolName) ||
      this.toolRowIdByCallId.has(toolCallId)
    ) {
      return [];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText: "",
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
      this.fileToolInputPreviewByCallId.set(toolCallId, {
        lastPublishedAt: null,
        pendingAppend: "",
      });
    }
    if (entityId) this.entityIdByRowId.set(row.rowId, entityId);
    return [{ op: "row.appended", row }];
  }

  private appendStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined) return [];
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    if (!state) {
      return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
    }

    state.pendingAppend += payload.delta;
    const now = this.ms(event);
    if (
      state.lastPublishedAt !== null &&
      now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    ) {
      return [];
    }

    const append = state.pendingAppend;
    state.pendingAppend = "";
    state.lastPublishedAt = now;
    return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  private flushStreamingToolInput(toolCallId: string): ConversationDelta[] {
    const append = this.takePendingStreamingToolInput(toolCallId);
    if (append === "") return [];
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  private takePendingStreamingToolInput(toolCallId: string): string {
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    return state?.pendingAppend ?? "";
  }

  private finalizeStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (toolCallId === "") return [];
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const existing = this.findToolRow(toolCallId);
    if (existing) {
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            ...(payload.assistantResponseId
              ? { assistantResponseId: payload.assistantResponseId }
              : {}),
            toolName: existing.toolName || payload.toolName || "",
            inputText,
            input: payload.input,
          },
        },
      ];
    }

    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText,
      input: payload.input,
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }];
  }

  private onToolCallScheduled(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallScheduledPayload;
    const toolCallId = String(payload.toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const cuaAction = readOfficialCuaAction(payload.toolName);
    const cuaApp =
      cuaAction && cuaAction !== "list_apps"
        ? resolveCuaAppIdentity(payload.input, this.latestListAppsSnapshot)
        : undefined;
    const existing = this.findToolRow(toolCallId);
    const planDeltas = this.todoPlanDeltas(
      event,
      extractPlanStepsFromToolInput({
        title: payload.toolName,
        kind: payload.toolName,
        input: payload.input,
      }),
    );
    if (existing) {
      // Replayable filters row.delta(inputText), so the final upsert must include the complete
      // inputText. Otherwise reconnect recovery sees only structured input and loses the v4 row's
      // final input text.
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            ...(payload.assistantMessageId
              ? { assistantResponseId: String(payload.assistantMessageId) }
              : {}),
            inputText,
            input: payload.input,
            ...(cuaApp ? { cuaApp } : {}),
            ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
          },
        },
        ...planDeltas,
      ];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantMessageId
        ? { assistantResponseId: String(payload.assistantMessageId) }
        : {}),
      toolCallId,
      toolName: payload.toolName,
      status: "inputStreaming",
      inputText,
      input: payload.input,
      ...(cuaApp ? { cuaApp } : {}),
      ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }, ...planDeltas];
  }

  private onToolCallActivity(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallStartedPayload;
    this.recordHighspeedToolStarted(
      this.turnIdOf(event),
      String(payload.toolCallId),
      this.ms(event),
    );
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    return projectToolActivity(event, row);
  }

  /**
   * MCP `notifications/progress` (A8) → progress on the row. Write only while running: a progress
   * notification arriving late after a terminal state must not relight a success/error row, and
   * bash stdout byte progress is not consumed here.
   */
  private onToolCallProgress(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallProgressPayload;
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row || row.status !== "running") return [];
    // Both branches share ToolCallProgress: the Bash tail window and MCP percentages must be
    // projected separately so merged results do not overwrite each other.
    if (row.toolName === "Bash") return projectToolActivity(event, row);
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
        ? payload.total
        : undefined;
    const fraction =
      total !== undefined &&
      typeof payload.progress === "number" &&
      Number.isFinite(payload.progress)
        ? Math.min(1, Math.max(0, payload.progress / total))
        : undefined;
    const message =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim().slice(0, 200)
        : undefined;
    if (fraction === undefined && message === undefined && total === undefined) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          progress: {
            ...(fraction !== undefined ? { fraction } : {}),
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
            updatedAt: this.ms(event),
          },
        },
      },
    ];
  }

  private onToolCallResult(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallResultPayload;
    const toolCallId = String(payload.toolCallId);
    this.recordHighspeedToolEnded(
      this.turnIdOf(event),
      toolCallId,
      this.ms(event),
      payload.duration,
    );
    const row = this.findToolRow(toolCallId);
    if (!row) return [];
    const success = payload.result.success;
    if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
      // Summary identity must come from a success fact observed by the Agent; a failed result must
      // not clear the old snapshot.
      const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
      if (snapshot) this.latestListAppsSnapshot = snapshot;
    }
    const display = toProtocolToolCallDisplay(payload.result.display);
    const next: ToolCallRow = {
      ...row,
      status: success ? "success" : "error",
      // Terminal state clears in-progress updates (R7).
      progress: undefined,
      output: buildToolOutput(payload.result, toolCallId),
      ...(display ? { display } : {}),
      endedAt: this.ms(event),
    };
    if (!success) {
      next.error = {
        code: payload.result.error?.type ?? "fault.runtime.toolFailed",
        message: payload.result.error?.message ?? "Tool execution failed.",
      };
    }
    const planDeltas = success
      ? this.todoPlanDeltas(
          event,
          extractPlanStepsFromToolOutput({
            title: row.toolName,
            kind: row.toolName,
            output: payload.result.content,
          }),
        )
      : [];
    return [{ op: "row.upserted", row: next }, ...planDeltas];
  }

  /**
   * TodoWrite projects both the live plan and the current goal iteration.
   * Before V4, only the tool row was retained, so the top-right summary could not rebuild each
   * iteration's action/status after live/cold recovery. Only the verifier boundary advances the
   * iteration; TodoWrite updates the currently open one and cannot start another.
   */
  private todoPlanDeltas(
    event: SessionEvent,
    steps: ReturnType<typeof extractPlanStepsFromToolInput>,
  ): ConversationDelta[] {
    if (!steps) return [];
    const items = steps.map((step, index) => ({
      id: step.id || `todo-${index + 1}`,
      content: step.title,
      status:
        step.status === "in_progress"
          ? ("inProgress" as const)
          : step.status === "completed"
            ? ("completed" as const)
            : ("pending" as const),
    }));
    const updatedAt = this.ms(event);
    const goal = this.snapshot.goal;
    if (!goal) {
      return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
    }

    const iteration =
      goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
        ? Math.max(1, goal.iteration)
        : Math.max(1, goal.iteration + 1);
    const iterations = [
      ...goal.iterations.filter((entry) => entry.iteration !== iteration),
      { iteration, items, updatedAt },
    ].sort((left, right) => left.iteration - right.iteration);
    return [
      {
        op: "state.updated",
        patch: {
          goal: { ...goal, iterations },
          plan: { items, updatedAt },
        },
      },
    ];
  }

  private onToolCallError(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallErrorPayload;
    this.recordHighspeedToolEnded(this.turnIdOf(event), String(payload.toolCallId), this.ms(event));
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    const cancelled =
      payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          // Stop emits tool_cancelled before the cancelled turn. If the tool terminal state is first
          // written as error, the later turn reducer, which settles only running rows, cannot
          // correct it to stopped.
          status: cancelled ? "cancelled" : "error",
          progress: undefined,
          ...(cancelled
            ? { error: undefined }
            : { error: { code: payload.error.type, message: payload.error.message } }),
          endedAt: this.ms(event),
        },
      },
    ];
  }

  // ── Permission interactions (blocking interaction → state) ──

  private onPermissionRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionRequestedPayload;
    const toolCallId = String(payload.toolCallId);
    const interactionId = payload.requestId ?? `perm-${toolCallId}`;
    const interaction = this.createPendingInteractionFromPermissionEvent(
      event,
      payload,
      toolCallId,
      interactionId,
    );
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          status: "pendingApproval",
          approvalInteractionId: interactionId,
        },
      });
    }
    deltas.push({
      op: "state.updated",
      patch: {
        pendingInteractions: [...this.snapshot.pendingInteractions, interaction],
      },
    });
    return deltas;
  }

  private createPendingInteractionFromPermissionEvent(
    event: SessionEvent,
    payload: PermissionRequestedPayload,
    toolCallId: string,
    interactionId: string,
  ): PendingInteraction {
    if (isAskUserQuestionToolName(payload.toolName)) {
      // AskUserQuestion's permission_requested is only a runtime waiting state. The v4 UI needs
      // structured questions to submit answers, not an Allow/Deny permission dialog.
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { toolName: payload.toolName },
          questions: readAskUserQuestionPayloadQuestions(payload.input),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
      // MCP elicitation: requestedSchema → structured questions,
      // using the same mapping as the broker; the v4 UI reuses ElicitationDialog.
      const elicitation = isPlainRecord(payload.input) ? payload.input : {};
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: {
            interaction: MCP_ELICITATION_INTERACTION,
            serverName: elicitation.serverName,
            requestedSchema: elicitation.requestedSchema,
          },
          questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (isExitPlanModeToolName(payload.toolName)) {
      // ExitPlanMode reuses the userInput/elicitation channel for plan-approval feedback; a regular
      // permission payload cannot express the business semantics of approve/custom feedback.
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { interaction: "plan_approval", toolName: payload.toolName },
          questions: [createExitPlanModeApprovalQuestion(payload.reason)],
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    const askDisplay = toProtocolToolCallDisplay(payload.display);
    return {
      interactionId,
      kind: "permission",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "permission",
        toolCallId,
        toolName: payload.toolName,
        summary: payload.reason,
        detail: payload.input,
        freeText: true,
        ...(payload.approvalMode !== "user-once" &&
        payload.fullAccessSupported === true &&
        !payload.origin &&
        !payload.optionsPolicy
          ? {
              fullAccessOption: {
                optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
                label: "Full access",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
              },
            }
          : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(askDisplay ? { display: askDisplay } : {}),
        options: [
          ...buildProtocolPermissionOptions({
            approvalMode: payload.approvalMode,
            input: payload.input,
            suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
            ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
            toolName: payload.toolName,
          }).map((option) => ({
            optionId:
              option.kind === "allow_once"
                ? "allowOnce"
                : option.kind === "allow_always"
                  ? "allowAlways"
                  : option.optionId,
            label: option.name,
            // Map the session-level no-confirmation kind to allowAlways in the closed set (same sort
            // position/style as always allow). Keep optionId as allowSession: the broker matches it
            // exactly, while the GUI localizes by name.
            kind:
              option.kind === "allow_once"
                ? ("allowOnce" as const)
                : option.kind === "allow_always" ||
                    option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                  ? ("allowAlways" as const)
                  : ("deny" as const),
            response: option.response,
          })),
          // Workflow Refine is available only in v4 (the legacy option list intentionally omits it;
          // see the session-mapper comment). A static response is an ordinary deny: consumers that
          // do not recognize this optionId (responses without freeText) fall back to rejection.
          // Feedback escalation happens only in interaction-broker's freeText special case.
          ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
          payload.toolName === AMEND_WORKFLOW_TOOL_NAME
            ? [
                {
                  optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                  label: "Refine",
                  kind: "custom" as const,
                  response: { decision: "deny" as const, reason: "Denied" },
                },
              ]
            : []),
        ],
      },
    };
  }

  private onPermissionResolved(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionResolvedPayload;
    return this.settlePermission(
      String(payload.toolCallId),
      payload.decision === "deny" ? "cancelled" : "running",
    );
  }

  private onPermissionDenied(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionDeniedPayload;
    return this.settlePermission(String(payload.toolCallId), "cancelled");
  }

  private onWorkspaceHookReviewRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewRequestedPayload;
    const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
    const current = this.snapshot.pendingInteractions.find(
      (item) => item.payload.kind === "workspaceHookReview",
    );
    if (current?.payload.kind === "workspaceHookReview") {
      const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
      // A different flow may take over only after onSessionResumed clears the old review (the epoch
      // policy is applied in onSessionResumed); other stale/replay/conflict cases must not overwrite
      // or extend current authority.
      if (verdict !== "same_flow_advance") {
        return [];
      }
    }
    const interaction: PendingInteraction = {
      interactionId: request.interactionId,
      kind: "workspaceHookReview",
      anchorRowId: null,
      createdAt: request.createdAt,
      payload: request,
    };
    // A higher generation in the same flow is the only valid replacement. Cross-flow takeover after
    // a Runtime restart must first clear old authority through SessionResumed. Replace atomically
    // here so historical anomalies cannot leave multiple reviews behind.
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) => item.payload.kind !== "workspaceHookReview",
    );
    pendingInteractions.push(interaction);
    return [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  private onWorkspaceHookReviewSettled(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSettledPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  private onWorkspaceHookReviewSuperseded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSupersededPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  private removeWorkspaceHookReview(interactionId: string): ConversationDelta[] {
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
    );
    return pendingInteractions.length === this.snapshot.pendingInteractions.length
      ? []
      : [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  /**
   * Soft gate: handle a WorkspaceHookAdmissionUpdated event.
   *
   * pendingCount > 0 → set snapshot.workspaceHookAdmission (show the banner);
   * pendingCount === 0 → set it to null (hide the banner).
   */
  private onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
    const workspaceHookAdmission =
      payload.pendingCount === 0
        ? null
        : {
            pendingCount: payload.pendingCount,
            bundleDigest: payload.bundleDigest,
            ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
          };
    return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
  }

  private onUserInputAutoResolutionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    let changed = false;
    const pendingInteractions = this.snapshot.pendingInteractions.map((interaction) => {
      if (
        interaction.interactionId !== payload.interactionId ||
        interaction.payload.kind !== "userInput"
      ) {
        return interaction;
      }
      changed = true;
      return {
        ...interaction,
        autoResolution: payload.autoResolution,
      };
    });
    return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
  }

  private settlePermission(toolCallId: string, status: ToolCallRow["status"]): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      const next: ToolCallRow = { ...row, status };
      delete next.approvalInteractionId;
      deltas.push({ op: "row.upserted", row: next });
    }
    const remaining = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(
          (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
          item.payload.toolCallId === toolCallId
        ),
    );
    if (remaining.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({
        op: "state.updated",
        patch: { pendingInteractions: remaining },
      });
    }
    return deltas;
  }

  // ── Turn-steer queue ──

  private onTurnSteerQueued(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerQueuedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    const existingIndex = this.snapshot.queue.items.findIndex(
      (item) => item.queueItemId === queueItemId,
    );
    const existing = existingIndex >= 0 ? this.snapshot.queue.items[existingIndex] : undefined;
    // A queued event's admittedDelivery can only be queue/guide. If an early or corrupted event
    // contains startNow, use the actual queue delivery so the projection does not claim the input
    // started immediately.
    const admittedDelivery: "queue" | "guide" =
      payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
        ? payload.intent.admittedDelivery
        : (payload.delivery ??
          (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
            ? existing.delivery.admitted
            : this.snapshot.config.followupMode === "guide"
              ? "guide"
              : "queue"));
    const requestedDelivery =
      payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
    const fallbackReasonCode =
      payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
    // Cause: the queue projection used to drop intent.highspeed, so both automatic and manual
    // promotion misjudged a valid card as absent.
    const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
    const nextItem: QueueItem = {
      queueItemId,
      kind:
        payload.intent?.kind === "compact" || payload.commandKind === "compact"
          ? ("compact" as const)
          : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
            ? ("sendGoalCommand" as const)
            : (existing?.kind ?? ("sendText" as const)),
      text: payload.input,
      sourceCommandId:
        payload.intent?.sourceCommandId ??
        existing?.sourceCommandId ??
        payload.inputId ??
        payload.pendingInputId,
      clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
      attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
      ...((payload.intent?.source ?? existing?.source)
        ? { source: payload.intent?.source ?? existing?.source }
        : {}),
      // QueueItem is also input to promoted execution, not just UI display; omitting fields makes a
      // new Turn inherit the old permissions/model. Older body-edit events may not have intent, so
      // preserve the existing item's facts instead of filling them from the current Session.
      modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
      mode: payload.intent?.mode ?? existing?.mode,
      planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
      sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
      provenance: payload.intent?.provenance ?? existing?.provenance,
      // Both queued events and in-place edits must retain the trusted ingress origin; the UI
      // projection must not drop the sender.
      ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
        ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
        : {}),
      ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
        ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
        : {}),
      ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
        ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
        : {}),
      delivery: {
        requested: requestedDelivery,
        admitted: admittedDelivery,
        ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
      },
      order: {
        admissionSeq:
          payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
        queuePosition:
          payload.intent?.queuePosition ??
          existing?.order.queuePosition ??
          Math.max(0, (payload.queueLength ?? 1) - 1),
      },
      steer:
        !payload.intent && !payload.delivery && existing
          ? existing.steer
          : fallbackReasonCode
            ? { state: "fellBack", reasonCode: fallbackReasonCode }
            : admittedDelivery === "guide"
              ? { state: "steering" }
              : { state: "notRequested" },
      dispatch: { state: "queued" },
      ...(highspeed ? { highspeed } : {}),
      ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
      admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? this.ms(event),
    };
    // Side table for delivery semantics: when the payload is absent (an old runtime event), fall
    // back to the current followupMode.
    this.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
    // Reentry with the same ID updates editQueueItem in place (preserving its position); a new ID is
    // appended. The old filter+append logic moved edited items to the tail, breaking the positional
    // semantics of queueContentIndependence.
    const items =
      existingIndex >= 0
        ? this.snapshot.queue.items.map((item, index) =>
            index === existingIndex ? nextItem : item,
          )
        : [...this.snapshot.queue.items, nextItem];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  private onTurnSteerDispatchChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDispatchChangedPayload;
    if (
      !this.snapshot.queue.items.some(
        (candidate) => candidate.queueItemId === payload.pendingInputId,
      )
    ) {
      return [];
    }
    const dispatch =
      payload.state === "queued"
        ? ({ state: "queued" } as const)
        : ({
            state: payload.state,
            reservationId: payload.reservationId,
          } as const);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((candidate) =>
            candidate.queueItemId === payload.pendingInputId
              ? { ...candidate, dispatch }
              : candidate,
          ),
        }),
      },
    ];
  }

  private onTurnSteerDeliveryChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDeliveryChangedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    if (!this.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
      return [];
    }
    this.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((item) =>
            item.queueItemId === queueItemId
              ? {
                  ...item,
                  delivery: {
                    requested: payload.requestedDelivery,
                    admitted: payload.admittedDelivery,
                    fallbackReasonCode: payload.fallbackReasonCode,
                  },
                  steer: {
                    state: "fellBack",
                    reasonCode: payload.fallbackReasonCode,
                  },
                }
              : item,
          ),
        }),
      },
    ];
  }

  private onTurnSteerDrained(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDrainedPayload;
    const runtimeTurnId = String(
      payload.targetTurnId ?? event.turnId ?? this.currentTurnId ?? "turn-unknown",
    );
    // Drain facts carry text/messageId directly (drainedInputs). The projection no longer relies on
    // in-memory queue state to get text; the old implementation silently continued when it could
    // not find a queue item, so the user's input disappeared from the queue and never entered
    // history. Fall back to lookup for old events without drainedInputs.
    const items =
      payload.drainedInputs ??
      payload.pendingInputIds.flatMap((pendingInputId, index) => {
        const queueItem = this.snapshot.queue.items.find(
          (candidate) => candidate.queueItemId === pendingInputId,
        );
        if (!queueItem) return [];
        const intent: TurnInputIntentMetadata = {
          sourceCommandId: queueItem.sourceCommandId,
          queueItemId: queueItem.queueItemId,
          clientId: queueItem.clientId,
          kind: queueItem.kind,
          text: queueItem.text,
          ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
          ...(queueItem.mode ? { mode: queueItem.mode } : {}),
          ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
          admissionSeq: queueItem.order.admissionSeq,
          admittedAt: queueItem.admittedAt,
          requestedDelivery: queueItem.delivery.requested,
          admittedDelivery: queueItem.delivery.admitted,
          queuePosition: queueItem.order.queuePosition,
          ...(queueItem.delivery.fallbackReasonCode
            ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
            : {}),
          attachmentRefs: queueItem.attachments,
        };
        return [
          {
            pendingInputId,
            messageId: payload.injectedMessageIds?.[index],
            text: queueItem.text,
            delivery: this.deliveryByPendingInputId.get(pendingInputId),
            intent,
          },
        ];
      });

    const deltas: ConversationDelta[] = [];
    for (const item of items) {
      const delivery =
        item.delivery ?? this.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
      // Queue consumption is a product-turn boundary (one turn per item: settle the previous
      // segment's header, open a new turnHeader, and assign later assistant events to the new turn);
      // guide steer stays inline in the current turn.
      if (delivery === "queue") {
        deltas.push(
          ...this.splitProductTurn(
            event,
            runtimeTurnId,
            item.messageId ? String(item.messageId) : undefined,
          ),
        );
      }
      const messageId = item.messageId ? String(item.messageId) : null;
      const entityId = messageId ?? item.pendingInputId;
      const productTurnId = this.turnIdOf(event);
      const rootSourceCommandId =
        item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
      const row = {
        ...this.rowBase(event, productTurnId, entityId),
        kind: "userInput" as const,
        text:
          item.intent?.conversationQuotes || item.intent?.botGroupSource
            ? (item.intent.text ?? item.text)
            : item.text,
        origin: "realUser" as const,
        ...(delivery === "guide" ? { guided: true as const } : {}),
        ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
        ...(item.intent?.conversationQuotes
          ? { conversationQuotes: item.intent.conversationQuotes }
          : {}),
        ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
        ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
        ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
        ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
        ...(item.intent?.source ? { source: item.intent.source } : {}),
      };
      // A real-user row consumed from queue/guide uses the same complete canonical target as an
      // ordinary TurnStarted. Legacy events without messageId remain display-only and do not expose
      // an unexecutable edit action.
      this.registerCanonicalUserRowTarget(
        row.rowId,
        entityId,
        messageId && item.intent?.kind !== "compact"
          ? {
              entityId,
              productTurnId,
              transcriptMessageId: messageId,
              coveredByStableCompact: false,
              intent: {
                kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
                text: item.intent?.text ?? item.text,
                ...(item.intent?.sourceCommandId
                  ? { sourceCommandId: item.intent.sourceCommandId }
                  : {}),
                ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
                ...(item.intent?.conversationQuotes
                  ? { conversationQuotes: item.intent.conversationQuotes }
                  : {}),
                ...(item.intent?.botGroupSource
                  ? { botGroupSource: item.intent.botGroupSource }
                  : {}),
                ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
                ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
                ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
                ...(item.intent?.admissionSeq !== undefined
                  ? { admissionSeq: item.intent.admissionSeq }
                  : {}),
                ...(item.intent?.admittedAt !== undefined
                  ? { admittedAt: item.intent.admittedAt }
                  : {}),
                ...(item.intent?.requestedDelivery
                  ? { requestedDelivery: item.intent.requestedDelivery }
                  : {}),
                ...(item.intent?.admittedDelivery
                  ? { admittedDelivery: item.intent.admittedDelivery }
                  : {}),
                ...(item.intent?.fallbackReasonCode
                  ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                  : {}),
                ...(item.intent?.modelSelection
                  ? { modelSelection: item.intent.modelSelection }
                  : {}),
                ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
                ...(item.intent?.planEnabled !== undefined
                  ? { planEnabled: item.intent.planEnabled }
                  : {}),
                ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
              },
            }
          : undefined,
      );
      if (delivery === "guide") {
        deltas.push(...this.openGuidedWorkSegment(event, row.entityId ?? item.pendingInputId));
      }
      deltas.push({ op: "row.appended", row });
      this.deliveryByPendingInputId.delete(item.pendingInputId);
    }
    return [...deltas, ...this.removeQueueItems(payload.pendingInputIds)];
  }

  /**
   * A queue-drain boundary is a product-turn boundary (within the same runtimeTurn).
   * Settle the previous productTurn's header (split work duration at the boundary so the sum equals
   * the total), map runtimeTurnId → the new productTurnId, and open a new turnHeader.
   */
  private splitProductTurn(
    event: SessionEvent,
    runtimeTurnId: string,
    promotedUserMessageId?: string,
  ): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const previousProductTurnId =
      this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(previousProductTurnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const endedAt = this.ms(event);
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          state: "completedSuccess",
          endedAt,
          activeMs: Math.max(
            0,
            endedAt - (this.currentProductTurnStartedAtMs ?? headerRow.startedAt),
          ),
          ...(headerRow.workSegments
            ? {
                workSegments: this.completeWorkSegments(headerRow.workSegments, endedAt),
              }
            : {}),
        },
      });
    }
    const ordinal = (this.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
    this.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
    // The old implementation built productTurnId from runtimeTurnId plus a process-local ordinal;
    // cold hydration instead used hydrate-turn-N, so the same queue input had a different identity
    // before and after recovery. Promotion already produces a persistent user messageId, so the
    // new product turn must use that authoritative identity directly. Keep the ordinal fallback only
    // for legacy drains without messageId.
    const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
    this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
    this.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    const header = buildTurnHeaderRow(this.rowBase(event, productTurnId, productTurnId), {
      turnNumber: 0,
      input: "",
    });
    this.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });
    return deltas;
  }

  // Split work duration at boundaries: for a runtimeTurn split by drain, the final productTurn's
  // duration is from the last boundary to completion, not the full runtime duration (otherwise the
  // segments sum to more than the real elapsed time).
  private activeMsForCompletion(event: SessionEvent, runtimeDuration?: number): number | undefined {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // A stable user messageId mapping does not imply that queue drain split the turn. Calculate the
    // final segment's duration from boundary timestamps only when a split ordinal exists. Otherwise,
    // the display timestamps on synthetic cold events span only a short interval and would
    // incorrectly overwrite the full-turn duration calculated from the transcript.
    if (!this.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
    if (this.currentProductTurnStartedAtMs === null) return runtimeDuration;
    return Math.max(0, this.ms(event) - this.currentProductTurnStartedAtMs);
  }

  private onTurnSteerDiscarded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDiscardedPayload;
    return this.removeQueueItems(payload.pendingInputIds);
  }

  private onSessionInputPromoted(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionInputPromotedPayload;
    // After sendQueuedNow starts successfully, TurnSteerDiscarded(promoted) can be lost at a
    // process/link boundary, leaving a promoting ghost item in the UI forever.
    // SessionInputPromoted is emitted only after the user message and session_input are committed
    // in the same transaction, so it is the durable commit signal that safely removes the queue projection.
    return this.removeQueueItems([payload.pendingInputId]);
  }

  /** Reorder v4 queue rows by orderedPendingInputIds (append unlisted items in their existing relative order). */
  private onTurnSteerReordered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { orderedPendingInputIds?: string[] };
    const order = payload.orderedPendingInputIds ?? [];
    const byId = new Map(this.snapshot.queue.items.map((item) => [item.queueItemId, item]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((item): item is (typeof this.snapshot.queue.items)[number] => item !== undefined);
    // Append items omitted from order (to avoid loss), preserving their original relative order.
    const orderedIds = new Set(order);
    const rest = this.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
    const reordered = [...ordered, ...rest];
    const items = reordered.map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
    // Emit no delta when the order is unchanged (idempotent).
    if (
      items.length === this.snapshot.queue.items.length &&
      items.every((item, index) => item === this.snapshot.queue.items[index])
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  // setAutoDrain: flip the queue.autoDrain authorization bit. autoDrain affects the held derivation
  // (heldQueueInputRequiresChoice) and Area A availability, so use queuePatch for a unified recompute.
  private onQueueAutoDrainChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { autoDrain?: boolean };
    const autoDrain = payload.autoDrain ?? true;
    if (
      this.snapshot.queue.autoDrain === autoDrain &&
      (autoDrain || this.snapshot.queue.pauseReason === "manual")
    ) {
      return [];
    }
    const queue = { ...this.snapshot.queue, autoDrain };
    if (autoDrain) {
      delete queue.pauseReason;
    } else {
      queue.pauseReason = "manual";
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch(queue),
      },
    ];
  }

  // setFollowupMode: flip config.followupMode. While running, followupMode authorizes enqueue vs
  // guide routing (computeInputRouting), so recompute Area A after changing config.
  private onFollowupModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { mode?: "queue" | "guide" };
    const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
    if (this.snapshot.config.followupMode === mode) return [];
    const nextConfig: ConversationSnapshot["config"] = {
      ...this.snapshot.config,
      followupMode: mode,
    };
    const context = this.deriveContext({});
    return [
      {
        op: "state.updated",
        patch: {
          config: nextConfig,
          availability: computeAvailability(context),
          inputRouting: computeInputRouting(context, mode),
        },
      },
    ];
  }

  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * Event sources include the command surface (source=command) and plan-tool path
   * (enterPlanMode/exitPlanMode, source=tool). Both paths share this projection, so the UI mode
   * selector also follows tool-driven mode changes.
   */
  private onSessionModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      mode?: string;
      planEnabled?: boolean;
      source?: string;
      toolCallId?: string;
      permissionGrant?: { interactionId: string; queueItemIds: string[] };
    };
    const mode = typeof payload.mode === "string" ? payload.mode : "";
    // Once a log event touches mode, a seed cannot overwrite it (even a same-value return counts as
    // a touch because the log has an authoritative value).
    if (mode) this.configModeTouchedByEvent = true;
    if (!mode) return [];
    const planEnabled = payload.planEnabled ?? mode === "plan";
    const planTransition =
      payload.source === "tool" && payload.toolCallId
        ? { toolCallId: payload.toolCallId, planEnabled }
        : this.snapshot.config.planTransition;
    if (
      this.snapshot.config.mode === mode &&
      this.snapshot.config.planEnabled === planEnabled &&
      planTransition === this.snapshot.config.planTransition &&
      !payload.permissionGrant
    )
      return [];
    return [
      {
        op: "state.updated",
        patch: {
          ...(payload.permissionGrant
            ? this.queuePatch({
                ...this.snapshot.queue,
                items: this.snapshot.queue.items.map((item) =>
                  payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                    ? { ...item, mode: "yolo" as const }
                    : item,
                ),
              })
            : {}),
          config: {
            ...this.snapshot.config,
            mode,
            planEnabled,
            planTransition,
            ...(payload.permissionGrant
              ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
              : {}),
          },
        },
      },
    ];
  }

  /**
   * Materialize the subagent row and summary projection in the same event transaction.
   * The old UI queried session/subagents separately after spawn. With seven concurrent children, if
   * the query happened before the last session was persisted, it cached six permanently until the
   * user switched sessions. The renderer now consumes the complete state committed with the row,
   * eliminating the separate event/query clocks.
   */
  private shouldMaterializeSubagentProjection(reduced: readonly ConversationDelta[]): boolean {
    // Performance cause: cold hydration previously scanned all historical rows even for unrelated
    // events such as checkpoints. Apply the materializer's actual input gate only in the unpublished
    // batch accumulator; live and strict fallback keep the original path, and store seeds that write
    // directly to the authoritative manifest after batching are unaffected.
    if (!this.hydrationAccumulator) return true;

    for (const delta of reduced) {
      switch (delta.op) {
        case "row.appended":
        case "row.upserted":
          if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
            return true;
          }
          break;
        case "row.delta":
          if (this.findRow(delta.rowId)?.kind === "subagent") return true;
          break;
        case "row.removed":
          // Suffix removal may also remove a subagent row; do not scan rows again just to determine that.
          return true;
        case "state.updated":
          if (
            delta.patch.pendingInteractions !== undefined ||
            delta.patch.backgroundWorks !== undefined
          ) {
            return true;
          }
          break;
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // Non-row op: it changes only workflowRuns state keys, which do not intersect the input to
        // subagent row projection.
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return false;
  }

  private materializeSubagentProjection(
    reduced: readonly ConversationDelta[],
  ): ConversationDelta[] {
    const previous: SubagentProjectionState = this.snapshot.subagents ?? {
      revision: 0,
      childSessionIds: [],
      running: [],
      endedTotal: 0,
    };
    const previousRunningById = new Map(
      previous.running.map((item) => [item.childSessionId, item]),
    );
    const latestRowByChildId = new Map<string, SubagentRow>();
    const collectSubagentRow = (row: SubagentRow | null): void => {
      if (row?.childSessionId && !this.invalidSubagentChildSessionIds.has(row.childSessionId)) {
        latestRowByChildId.set(row.childSessionId, row);
      }
    };
    // Performance cause: the old implementation copied the full rows array and scanned every
    // ordinary conversation row. subagentRowIdByAgentId is already the reducer's derived lookup
    // index; deduplicate by rowId here and restore timeline order through rowIndexById. Applying
    // row.removed clears invalid aliases.
    const currentRowIds = new Set(this.subagentRowIdByAgentId.values());
    for (const delta of reduced) {
      if (delta.op === "row.upserted") {
        if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
          currentRowIds.add(delta.row.rowId);
        }
      } else if (delta.op === "row.delta" && this.findRow(delta.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.rowId);
      }
    }
    const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
    for (const rowId of currentRowIds) {
      const rowIndex = this.rowIndexById.get(rowId);
      const row = rowIndex === undefined ? undefined : this.snapshot.rows.window[rowIndex];
      if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
    }
    currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
    for (const { row } of currentRows) {
      collectSubagentRow(this.prospectiveSubagentRow(row, reduced, 0));
    }
    for (let index = 0; index < reduced.length; index += 1) {
      const delta = reduced[index]!;
      if (delta.op !== "row.appended") continue;
      collectSubagentRow(this.prospectiveSubagentRow(delta.row, reduced, index + 1));
    }

    let pendingInteractions = this.snapshot.pendingInteractions;
    let backgroundWorks = this.snapshot.backgroundWorks;
    for (const delta of reduced) {
      if (delta.op !== "state.updated") continue;
      if (delta.patch.pendingInteractions !== undefined) {
        pendingInteractions = delta.patch.pendingInteractions;
      }
      if (delta.patch.backgroundWorks !== undefined) {
        backgroundWorks = delta.patch.backgroundWorks;
      }
    }
    const waitingChildIds = new Set<string>();
    // Hook-review interaction payloads added by workspace-hook-trust have no origin field; skip the
    // guard to avoid misreading them.
    for (const interaction of pendingInteractions) {
      if (!("origin" in interaction.payload)) continue;
      const origin = interaction.payload.origin;
      if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
    }
    const blockedChildIds = new Set(
      backgroundWorks.flatMap((work) =>
        work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
          ? [work.childSessionId]
          : [],
      ),
    );

    const childSessionIds = [...latestRowByChildId.keys()];
    const running: RunningSubagentSummary[] = [];
    for (const [childSessionId, row] of latestRowByChildId) {
      if (row.status !== "running") continue;
      const previousItem = previousRunningById.get(childSessionId);
      const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
      running.push({
        childSessionId,
        agentId: row.entityId,
        ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
        subagentType: row.subagentType,
        title,
        status: waitingChildIds.has(childSessionId)
          ? "waiting"
          : blockedChildIds.has(childSessionId)
            ? "blocked"
            : "running",
        ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      });
    }
    running.sort(
      (left, right) =>
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        right.childSessionId.localeCompare(left.childSessionId),
    );
    const endedTotal = childSessionIds.length - running.length;
    const semanticState = { childSessionIds, running, endedTotal };
    if (
      JSON.stringify(semanticState) ===
      JSON.stringify({
        childSessionIds: previous.childSessionIds,
        running: previous.running,
        endedTotal: previous.endedTotal,
      })
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          subagents: {
            revision: previous.revision + 1,
            ...semanticState,
          },
        },
      },
    ];
  }

  private prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null {
    let prospective: ConversationRow | null = row;
    for (let index = startIndex; index < reduced.length && prospective; index += 1) {
      const delta = reduced[index]!;
      switch (delta.op) {
        case "row.appended":
        case "state.updated":
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // Non-row op: it cannot change this row's prospective shape.
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        case "row.upserted":
          if (delta.row.rowId === prospective.rowId) prospective = delta.row;
          break;
        case "row.delta":
          if (
            delta.rowId === prospective.rowId &&
            delta.path === "summaryText" &&
            prospective.kind === "subagent"
          ) {
            prospective = {
              ...prospective,
              summaryText: prospective.summaryText + delta.append,
            };
          }
          break;
        case "row.removed":
          if (prospective.rowId >= delta.fromRowId) prospective = null;
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return prospective?.kind === "subagent" ? prospective : null;
  }

  // ── Subagent row mirroring ──
  // The schema/UI already support subagent rows, but the old reducer did not consume Subagent*
  // events; cold hydration could not restore drill-down rows even with synthetic events. Use the
  // same state machine for live and cold paths here.

  private onSubagentSpawned(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    if (existing) this.subagentRowIdByAgentId.set(agentId, existing.rowId);
    const childSessionId = this.stringPayload(payload, "childSessionId");
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const resumedBackgroundWork = this.resumedSubagentBackgroundWorkDelta(
      event,
      payload,
      agentId,
      childSessionId,
    );
    if (
      existing?.status === "running" &&
      (!childSessionId || childSessionId === existing.childSessionId) &&
      (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
      (payload.background !== true || existing.backgrounded === true)
    ) {
      return resumedBackgroundWork ? [resumedBackgroundWork] : [];
    }
    if (existing) {
      const row: SubagentRow = {
        ...existing,
        status: "running",
        summaryText:
          this.stringPayload(payload, "description") ??
          this.stringPayload(payload, "prompt") ??
          existing.summaryText,
        // The resume event carries the SendMessage call ID, but parentToolCallId is the row's
        // creation anchor. Do not overwrite an existing anchor as a lifecycle field, or the UI can
        // no longer associate the original Agent row.
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        startedAt: this.ms(event),
      };
      delete row.endedAt;
      return [
        { op: "row.upserted", row },
        ...(resumedBackgroundWork ? [resumedBackgroundWork] : []),
      ];
    }
    const row: SubagentRow = {
      ...this.rowBase(event, this.turnIdOf(event), agentId),
      kind: "subagent",
      ...(this.stringPayload(payload, "parentToolCallId")
        ? { parentToolCallId: this.stringPayload(payload, "parentToolCallId") }
        : {}),
      subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
      status: "running",
      summaryText:
        this.stringPayload(payload, "description") ??
        this.stringPayload(payload, "summaryText") ??
        this.stringPayload(payload, "prompt") ??
        "",
      ...(this.stringPayload(payload, "childSessionId")
        ? { childSessionId: this.stringPayload(payload, "childSessionId") }
        : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: this.ms(event),
    };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }

  private resumedSubagentBackgroundWorkDelta(
    event: SessionEvent,
    payload: Record<string, unknown>,
    agentId: string,
    childSessionId: string | undefined,
  ): ConversationDelta | undefined {
    if (payload.background !== true || payload.resumed !== true || !childSessionId) {
      return undefined;
    }

    // SendMessage resume enters the subagent port directly and bypasses the Agent tool executor, so
    // it does not emit the tracker's BackgroundTaskStarted. SubagentSpawned is already the single
    // start fact; add cancellable work in the same V4 transaction to avoid introducing another
    // fallible event.
    const previous = this.snapshot.backgroundWorks;
    const existing = previous.find((work) => work.workId === agentId);
    const title =
      this.stringPayload(payload, "description") ??
      this.stringPayload(payload, "prompt") ??
      existing?.title ??
      agentId;
    if (
      existing?.status === "running" &&
      existing.kind === "subagent" &&
      existing.title === title &&
      existing.childSessionId === childSessionId &&
      existing.cancellable === true
    ) {
      return undefined;
    }
    const next: BackgroundWorkSummary = {
      workId: agentId,
      kind: "subagent",
      title,
      status: "running",
      startedAt: this.ms(event),
      cancellable: true,
      anchorRowId: existing?.anchorRowId ?? null,
      childSessionId,
    };
    const backgroundWorks = existing
      ? previous.map((work) => (work.workId === agentId ? next : work))
      : [...previous, next];
    return { op: "state.updated", patch: { backgroundWorks } };
  }

  private onSubagentMessage(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const row = this.findSubagentRow(this.subagentAgentId(payload, event));
    const append =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "text") ??
      this.stringPayload(payload, "message");
    if (!row || !append) return [];
    return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
  }

  private onSubagentStopped(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const status = this.mapSubagentStatus(this.stringPayload(payload, "status"));
    const summaryText =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "result") ??
      this.stringPayload(payload, "error") ??
      this.stringPayload(payload, "description") ??
      existing?.summaryText ??
      "";
    const row: SubagentRow = existing
      ? {
          ...existing,
          status,
          summaryText,
          endedAt: this.ms(event),
          // A resumed child's terminal state still belongs to the original Agent row; fill the
          // anchor only if the old row is missing it.
          ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
        }
      : {
          ...this.rowBase(event, this.turnIdOf(event), agentId),
          kind: "subagent",
          ...(this.stringPayload(payload, "parentToolCallId")
            ? {
                parentToolCallId: this.stringPayload(payload, "parentToolCallId"),
              }
            : {}),
          subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
          status,
          summaryText,
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
          ...(payload.background === true ? { backgrounded: true as const } : {}),
          ...(payload.background === true ? { workId: agentId } : {}),
          endedAt: this.ms(event),
        };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: existing ? "row.upserted" : "row.appended", row }];
  }

  // cancelBackgroundWork: project the background-task lifecycle
  // (BackgroundTaskStarted/Updated/Completed) into snapshot.backgroundWorks, which the background
  // work surface reads for rendering and the cancel action. taskId equals workId; normalize status
  // to the summary's closed four-value enum.
  private onBackgroundTaskLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      taskId?: string;
      toolName?: string;
      taskKind?: string;
      command?: string;
      description?: string;
      status?: string;
      cancellable?: boolean;
      blocked?: boolean;
      childSessionId?: string;
    };
    const workId = payload.taskId;
    if (!workId) return [];
    const prev = this.snapshot.backgroundWorks;
    const existing = prev.find((work) => work.workId === workId);
    const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
    // New events use the explicit taskKind from runtime; older events all use the shared resolver.
    // Do not scatter Agent/Task/subagent string branches throughout the reducer.
    // "workflow" is a workflow run (previously mislabeled as bash). The legacy resolver has no
    // equivalent because the legacy `Workflow` tool intentionally remains bash; they are different
    // things, and sharing a category would mix them in the panel.
    const kind: BackgroundWorkSummary["kind"] =
      payload.taskKind === "subagent"
        ? "subagent"
        : payload.taskKind === "bash"
          ? "bash"
          : payload.taskKind === "workflow"
            ? "workflow"
            : legacyKind === "agent"
              ? "subagent"
              : legacyKind === "bash"
                ? "bash"
                : (existing?.kind ?? "bash");
    // Event statuses (running/completed/failed/timed_out/cancelled/spawn_error/lost)
    // → summary status（running/resultPending/failed/cancelled）。
    const rawStatus = payload.status ?? "running";
    const status: "running" | "resultPending" | "failed" | "cancelled" =
      rawStatus === "running"
        ? "running"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "completed"
            ? "resultPending"
            : "failed";
    const title =
      payload.description?.trim() ||
      payload.command?.trim() ||
      existing?.title ||
      payload.toolName ||
      workId;
    const next: BackgroundWorkSummary = {
      workId,
      kind,
      title,
      status,
      startedAt: existing?.startedAt ?? this.ms(event),
      ...(status === "running" ? {} : { endedAt: this.ms(event) }),
      ...(typeof payload.cancellable === "boolean"
        ? { cancellable: payload.cancellable }
        : existing?.cancellable !== undefined
          ? { cancellable: existing.cancellable }
          : {}),
      ...(typeof payload.blocked === "boolean"
        ? { blocked: payload.blocked }
        : existing?.blocked !== undefined
          ? { blocked: existing.blocked }
          : {}),
      anchorRowId: existing?.anchorRowId ?? null,
      ...(payload.childSessionId
        ? { childSessionId: payload.childSessionId }
        : existing?.childSessionId
          ? { childSessionId: existing.childSessionId }
          : {}),
    };
    // Idempotent: emit no delta when content is unchanged.
    if (
      existing &&
      existing.status === next.status &&
      existing.title === next.title &&
      existing.kind === next.kind &&
      existing.cancellable === next.cancellable &&
      existing.blocked === next.blocked &&
      existing.childSessionId === next.childSessionId
    ) {
      return [];
    }
    const backgroundWorks = existing
      ? prev.map((work) => (work.workId === workId ? next : work))
      : [...prev, next];
    return [{ op: "state.updated", patch: { backgroundWorks } }];
  }

  // ── DWF live run state: DynamicWorkflowRunProgress → workflowRuns state key ──
  // Each engine RunEvent becomes one session event and reduces to authoritative state replaced at
  // the key level. Using the reducer instead of a side channel makes it persistent and replayable,
  // with cold recovery included (precedent: the subagents key).
  //
  // The reducer lives in @zcode/shared's workflow-runs-reducer beside the state schema. The TUI
  // mirror must use the same reducer; separate implementations would create two clocks
  // (docs/dynamic-workflow/launch.md "The inline card").
  // Only impure projection work remains here: extract the payload from the event envelope and emit
  // the difference between old/new state as a key-level delta.
  private onDynamicWorkflowRunProgress(event: SessionEvent): ConversationDelta[] {
    // Convert the bounded contracts payload, then assign it to the structured shared input. This
    // assignment is the compile-time guard that the two shapes do not drift (shared cannot depend
    // on contracts in reverse, so its input type must be defined structurally).
    const envelope: WorkflowRunProgressEnvelope =
      event.payload as DynamicWorkflowRunProgressPayload;
    const prior = this.snapshot.workflowRuns;
    const workflowRuns = reduceWorkflowRunsState(prior, envelope);
    // null means no semantic change (invalid event or replay of the same event): emit no delta and
    // do not advance revision.
    if (workflowRuns === null) return [];
    // Emit the **difference**, not the whole key: one engine event changes one node, while resending
    // the whole key costs O(N) bytes per event and O(N²) over a run (the workflow-runs-delta.ts
    // header explains how that becomes a per-node limit and a frozen UI).
    // The contract that `applyAll(prior, diff(prior, next))` equals next **byte for byte** is pinned
    // by property tests, so after applyEventInternal applies these deltas,
    // this.snapshot.workflowRuns remains next.
    return diffWorkflowRunsState(prior, workflowRuns);
  }

  private removeQueueItems(ids: readonly string[]): ConversationDelta[] {
    const idSet = new Set(ids);
    for (const id of ids) this.deliveryByPendingInputId.delete(id);
    const items = this.snapshot.queue.items
      .filter((item) => !idSet.has(item.queueItemId))
      .map((item, index) =>
        item.order.queuePosition === index
          ? item
          : { ...item, order: { ...item.order, queuePosition: index } },
      );
    if (items.length === this.snapshot.queue.items.length) return [];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  // ── config / usage ──

  private onModelSelected(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelSelectedPayload;
    // Cause: storing fresh-child identity in pending side state meant atomic projection clone/adopt
    // forgot to copy the field, making the live marker disappear. Use explicit null in the model
    // baseline to express ∅→X directly. The shared projection no longer recognizes Subagent identity;
    // later selections update config without overwriting the model actually used in the prior turn.
    if (payload.previousModelSelection === null) {
      this.lastTurnModel = { kind: "sourceLess" };
    }
    const prev = this.snapshot.config;
    const provider = payload.modelSelection.providerId;
    const model = payload.modelSelection.modelId;
    const thought =
      payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
    const modelSelection = cloneSparseModelSelection(payload.modelSelection);
    const thoughtLevels = payload.supportedThoughtLevels
      ? [...payload.supportedThoughtLevels]
      : prev.thoughtLevels;
    const contextWindow =
      payload.contextWindow === null
        ? null
        : payload.contextWindow !== undefined
          ? positiveInteger(payload.contextWindow, 0) || undefined
          : undefined;
    // Cause: old events updated only config. Although runtime had switched models, historical usage
    // maxTokens stayed at the source model until the next ModelComplete happened to correct it. The
    // window belongs to the applied model capability and must be committed in the same
    // ModelSelected; usedTokens still preserves historical context facts.
    if (contextWindow !== undefined) {
      this.contextWindowState.touchedByEvent = true;
      this.contextWindowState.maxTokens =
        contextWindow !== null && contextWindow > 0 ? contextWindow : null;
    }
    const previousContextWindow = this.snapshot.usage.contextWindow;
    if (previousContextWindow) {
      this.contextWindowState.usedTokens = previousContextWindow.usedTokens;
    }
    const contextWindowChanged =
      contextWindow !== undefined &&
      (contextWindow === null
        ? previousContextWindow !== null
        : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
    const modelIdentityChanged = prev.provider !== provider || prev.model !== model;
    const contextBudgetChanged = contextWindowChanged || modelIdentityChanged;
    // Once a log event touches model selection, a seed cannot overwrite it (even a same-value return
    // counts as a touch).
    // Exception: ModelSelected synthesized during cold recovery (HYDRATION_TRACE_ID) only rebuilds
    // historical selection from message facts for the modelChange marker; it is not an authoritative
    // selection action. After replay, seedConfig still settles on runtime truth (the previous/draft
    // selection restored by resume).
    if (String(event.traceId) !== HYDRATION_TRACE_ID) {
      this.configModelTouchedByEvent = true;
      if (payload.supportedThoughtLevels !== undefined) {
        this.configThoughtLevelsTouchedByEvent = true;
      }
    }
    // A selection event updates config only; do not add a modelChange marker at selection time.
    // Switching is an intent, and onTurnStarted decides whether to mark based on a difference from
    // the model actually used in the previous turn (see the comment and bug background there).
    const configChanged = !(
      prev.provider === provider &&
      prev.model === model &&
      sameSparseModelSelection(prev.modelSelection, modelSelection) &&
      prev.thought === thought &&
      prev.thoughtLevels.length === thoughtLevels.length &&
      prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
    );
    const modelTransition =
      payload.origin === "registryFallback" &&
      payload.previousModelSelection != null &&
      (payload.previousModelSelection.providerId !== provider ||
        payload.previousModelSelection.modelId !== model)
        ? {
            eventId: String(event.id),
            origin: payload.origin,
            from: {
              provider: payload.previousModelSelection.providerId,
              model: payload.previousModelSelection.modelId,
            },
            to: { provider, model },
          }
        : undefined;
    if (!configChanged && !contextBudgetChanged && modelTransition === undefined) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          ...(configChanged
            ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
            : {}),
          // Cause: projecting only config loses the fact that a registry fallback triggered this,
          // so the renderer cannot safely distinguish automatic recovery from an explicit/historical
          // switch. Preserve the event ID and source/destination identities; the client still shows
          // the toast only at the live online-delivery boundary.
          ...(modelTransition ? { modelTransition } : {}),
          ...(contextBudgetChanged
            ? {
                usage: {
                  ...this.snapshot.usage,
                  // Cause: null is the registry's authoritative event clearing the explicit window,
                  // so clear the entire usage.contextWindow. Only a missing field preserves legacy
                  // event compatibility semantics.
                  contextWindow:
                    contextWindow === null
                      ? null
                      : previousContextWindow
                        ? {
                            ...invalidateResolvedContextBudgetThresholds(previousContextWindow),
                            ...(contextWindow !== undefined ? { maxTokens: contextWindow } : {}),
                          }
                        : contextWindow === undefined
                          ? null
                          : {
                              usedTokens: this.contextWindowState.usedTokens,
                              maxTokens: contextWindow,
                              autoCompactThresholdTokens: null,
                            },
                },
              }
            : {}),
        },
      },
    ];
  }

  private onModelComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelCompletePayload;
    const retryClearDeltas = this.acceptsActiveModelEvent(event) ? this.setApiRetry(null) : [];
    // Same decision as the old reducer: only a main-session round trip can overwrite the context watermark.
    const isMainTurn =
      payload.querySource !== undefined
        ? payload.querySource === "main_turn"
        : payload.stopReason !== "tool_internal";
    if (isMainTurn) this.outputContinuationTextRowId = null;
    if (
      isMainTurn &&
      payload.stopReason?.trim().toLowerCase() === "length" &&
      payload.toolCallCount === 0
    ) {
      const lastVisibleRow = this.snapshot.rows.window.at(-1);
      if (
        lastVisibleRow?.kind === "assistantText" &&
        lastVisibleRow.turnId === this.turnIdOf(event) &&
        lastVisibleRow.state === "complete"
      ) {
        this.outputContinuationTextRowId = lastVisibleRow.rowId;
      }
    }
    // Usage from a subagent ModelComplete is still not the main-session watermark, but its
    // fileChanges belong to the child session's workspace and must be projected independently into
    // the child turn header.
    const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
    const usage = payload.usage as ModelUsage;
    const deltas: ConversationDelta[] = [];
    const turnId = this.turnIdOf(event);
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const fileChanges =
        supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
          ? {
              fileChanges: {
                additions: payload.fileChanges.additions,
                deletions: payload.fileChanges.deletions,
                files: payload.fileChanges.files,
                // Cause: this conditional object is later spread-merged with headerRow, and TS widens
                // the literal to string, breaking the TurnFileChangeSummary contract in the
                // pre-CLI-start build.
                state: "active" as const,
              },
            }
          : {};
      if (isMainTurn || "fileChanges" in fileChanges) {
        deltas.push({
          op: "row.upserted",
          row: {
            ...headerRow,
            ...fileChanges,
            // Cause: when the renderer observes the running snapshot is unreliable; continuous
            // clients may receive merged updates, and replayable clients may first recover with a
            // terminal state already present. Per-turn tokens must accumulate in the authoritative
            // event projection.
            ...(isMainTurn
              ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
              : {}),
          },
        });
      }
    }
    if (!isMainTurn) return [...deltas, ...retryClearDeltas];
    const usedTokens = getModelUsageContextTokens(usage) ?? 0;
    this.contextWindowState.usedTokens = usedTokens;
    const maxTokens = payload.contextWindow ?? this.contextWindowState.maxTokens;
    const cumulative = this.snapshot.usage.cumulative;
    const previousContextWindow = this.snapshot.usage.contextWindow;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          // Cause: after the registry explicitly cleared the window, a ModelComplete without
          // contextWindow previously rebuilt the object with zero, breaking unknown-capacity
          // semantics. Continue updating tokens in side state and accumulated values.
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens,
                  maxTokens,
                  autoCompactThresholdTokens:
                    payload.autoCompactThresholdTokens !== undefined
                      ? payload.autoCompactThresholdTokens
                      : (previousContextWindow?.autoCompactThresholdTokens ?? null),
                  ...(payload.autoCompactThresholdTokens !== undefined ||
                  previousContextWindow?.autoCompactThresholdAuthoritative === true
                    ? { autoCompactThresholdAuthoritative: true }
                    : {}),
                  ...(payload.microcompactThresholdTokens !== undefined
                    ? { microcompactThresholdTokens: payload.microcompactThresholdTokens }
                    : previousContextWindow?.microcompactThresholdTokens !== undefined
                      ? {
                          microcompactThresholdTokens:
                            previousContextWindow.microcompactThresholdTokens,
                        }
                      : {}),
                  ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                  ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                    ? { breakdown: payload.contextUsageBreakdown }
                    : {}),
                },
          cumulative: {
            inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
            cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
          },
        },
      },
    });
    // ModelComplete is the success fallback when a network completed event is missing; do not leave
    // the retry notice hanging.
    deltas.push(...retryClearDeltas);
    return deltas;
  }

  // ── Compact marker (effect of the compact command) ──
  // One operationId uses the same marker row for its entire lifecycle: running →
  // success/failed/noop/cancelled. The marker is placed at the end of the rows when the event
  // arrives; clients need no ownership logic.

  private onCompactLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as CompactLifecyclePayload & {
      anchorMessageId?: string;
      tailStartMessageId?: string;
    };
    const existingRowId = this.compactMarkerRowIdByOperationId.get(payload.operationId);
    const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
    const prev =
      existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
        ? existingRow.marker
        : undefined;

    const status = mapCompactMarkerStatus(payload.status);
    if (status === "success") {
      const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
      const coverageRowId = coverageMessageId ? this.rowIdForMessageId(coverageMessageId) : null;
      if (coverageRowId !== null) {
        this.stableCompactCoverageBoundaryRowId = Math.max(
          this.stableCompactCoverageBoundaryRowId ?? 0,
          coverageRowId,
        );
        for (const [rowId, entityId] of this.entityIdByRowId) {
          if (rowId > this.stableCompactCoverageBoundaryRowId) continue;
          const target = this.editTargetByEntityId.get(entityId);
          if (target && !target.coveredByStableCompact) {
            this.editTargetByEntityId.set(entityId, {
              ...target,
              coveredByStableCompact: true,
            });
          }
        }
      }
    }
    const tokensAfter =
      payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
    const marker: TimelineMarkerPayload = {
      type: "compact",
      origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
      status,
      // Only terminal events include token counts; preserve known values on upsert (retry does not reset them).
      ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
        ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
        : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      // Fetch the full summary by ref (same as toolOutput/get); use summaryMessageId as the placeholder.
      ...(payload.summaryMessageId !== undefined || prev?.summaryRef
        ? {
            summaryRef:
              payload.summaryMessageId !== undefined
                ? String(payload.summaryMessageId)
                : prev?.summaryRef,
          }
        : {}),
    };

    const deltas: ConversationDelta[] = [];
    if (existingRow?.kind === "timelineMarker") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...existingRow,
          marker,
          ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
        },
      });
    } else {
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.turnIdOf(event), String(payload.operationId)),
        kind: "timelineMarker",
        lane: "assistantWork",
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      };
      this.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }

    // Enter/leave activeWorks while compacting. The guard is derived from the same source:
    // compactOperationLock/compactingAcceptsFutureInput are driven here, matching the formal-proof
    // evaluateCompacting rule.
    const otherWorks = this.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
    if (status === "running") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: [...otherWorks, { kind: "compact", startedAt: this.ms(event) }],
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
        }),
      });
    } else {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: otherWorks,
          ...(otherWorks.length === 0
            ? {
                canStop: false,
                stopState: "idle" as const,
                stopTargetKind: "unknown" as const,
              }
            : {}),
        }),
      });
    }

    // Successful compact → immediately lower the context watermark (update usage.contextWindow).
    if (status === "success" && tokensAfter !== undefined) {
      this.contextWindowState.usedTokens = tokensAfter;
      const maxTokens =
        this.snapshot.usage.contextWindow?.maxTokens ?? this.contextWindowState.maxTokens;
      deltas.push({
        op: "state.updated",
        patch: {
          usage: {
            ...this.snapshot.usage,
            contextWindow:
              maxTokens === null
                ? null
                : {
                    usedTokens: tokensAfter,
                    maxTokens,
                    ...(this.snapshot.usage.contextWindow?.autoCompactThresholdTokens !== undefined
                      ? {
                          autoCompactThresholdTokens:
                            this.snapshot.usage.contextWindow.autoCompactThresholdTokens,
                        }
                      : { autoCompactThresholdTokens: null }),
                    ...(this.snapshot.usage.contextWindow?.autoCompactThresholdAuthoritative ===
                    true
                      ? { autoCompactThresholdAuthoritative: true }
                      : {}),
                    ...(this.snapshot.usage.contextWindow?.microcompactThresholdTokens !== undefined
                      ? {
                          microcompactThresholdTokens:
                            this.snapshot.usage.contextWindow.microcompactThresholdTokens,
                        }
                      : {}),
                  },
          },
        },
      });
    }
    return deltas;
  }

  // ── Goal state machine ──

  private onTargetChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetChangedPayload;
    switch (payload.action) {
      case "set": {
        if (!payload.target) return [];
        // New target: reset iteration/verifications.
        // goalSet is stateOnly and emits no timeline row (the old goalSet marker was an invisible
        // row rendered as null inside the window, polluting turn grouping). The goal panel/status
        // area owns target display.
        const goal: GoalState = {
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
          iteration: 0,
          verifications: [],
          iterations: [],
        };
        return [{ op: "state.updated", patch: this.goalPatch(goal) }];
      }
      case "cleared": {
        if (!this.snapshot.goal) return [];
        return [{ op: "state.updated", patch: this.goalPatch(null) }];
      }
      default: {
        // status_updated / run_started / run_finished / usage_accounted / summary_updated：
        // Refresh elapsed time and summary title together. The old implementation compared only
        // status, dropping run-accounting changes over one second and summaryTitle updates, which
        // made the UI differ before and after refresh.
        const goal = this.snapshot.goal;
        if (!goal || !payload.target) return [];
        const nextGoal: GoalState = {
          ...goal,
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
        };
        if (
          nextGoal.targetId === goal.targetId &&
          nextGoal.objective === goal.objective &&
          nextGoal.summaryTitle === goal.summaryTitle &&
          nextGoal.timeUsedSeconds === goal.timeUsedSeconds &&
          nextGoal.activeRunStartedAtMs === goal.activeRunStartedAtMs &&
          nextGoal.status === goal.status
        ) {
          return [];
        }
        return [{ op: "state.updated", patch: this.goalPatch(nextGoal) }];
      }
    }
  }

  private onTargetVerification(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetCompletionVerificationPayload;
    const goal = this.snapshot.goal;
    // The goal verification boundary does not depend on goal state being present.
    // A cold-recovery synthetic event stream has no TargetChanged, so goal is null; the old
    // implementation discarded the verification fact here and the goalVerify marker disappeared
    // after refresh. Always create/update the marker now; apply the goal-state patch only when a goal
    // is present.

    if (payload.status === "started") {
      const iteration = payload.goalIteration ?? (goal ? goal.iteration + 1 : 1);
      const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
      const verifyingGoal = goal ? { ...goal, status: "verifying" as const, iteration } : undefined;
      const otherWorks = this.snapshot.control.activeWorks.filter(
        (work) => work.kind !== "goalVerifier",
      );
      const controlDelta: ConversationDelta = {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "running",
            sessionEnded: false,
            activeWorks: [
              ...otherWorks,
              {
                kind: "goalVerifier",
                ...(payload.foregroundExecutionId
                  ? { foregroundExecutionId: payload.foregroundExecutionId }
                  : {}),
                startedAt: this.ms(event),
              },
            ],
            canStop: true,
            stopState: "stoppable",
            stopTargetKind: otherWorks.length > 0 ? ("mixed" as const) : ("goalVerifier" as const),
            lastError: null,
            apiRetry: null,
          },
          verifyingGoal,
        ),
      };
      // GV identity: retrying the same targetId+iteration with a new verificationId reuses the same
      // marker row and returns it to running instead of creating a second marker.
      const existingRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
      const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
      if (existingRow?.kind === "timelineMarker") {
        return [
          {
            op: "row.upserted",
            row: {
              ...existingRow,
              marker: { type: "goalVerify", iteration, outcome: "running" },
            },
          },
          controlDelta,
        ];
      }
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: { type: "goalVerify", iteration, outcome: "running" },
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      return [{ op: "row.appended", row }, controlDelta];
    }

    // Terminal states: completed (pass/notSatisfied are valid conclusions), failed_closed
    // (verification process failed), or cancelled (stopped before producing a conclusion →
    // marker=failed(detail=cancelled), goal returns to paused).
    const iteration = payload.goalIteration ?? goal?.iteration ?? 1;
    const outcome: "pass" | "notSatisfied" | "failed" =
      payload.status === "completed"
        ? payload.verification?.passed
          ? "pass"
          : "notSatisfied"
        : "failed";
    const goalStatus: GoalState["status"] =
      payload.status === "cancelled"
        ? "paused"
        : payload.status === "failed_closed"
          ? "failed"
          : outcome === "pass"
            ? "verified"
            : "notSatisfied";

    const deltas: ConversationDelta[] = [];
    const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
    const markerRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
    let anchorRowId: number | null = null;
    const markerRow = markerRowId !== undefined ? this.findRow(markerRowId) : undefined;
    const terminalMarker: TimelineMarkerPayload = {
      type: "goalVerify",
      iteration,
      outcome,
      ...(payload.status === "cancelled"
        ? { detail: "cancelled" }
        : payload.verification?.reason
          ? { detail: payload.verification.reason }
          : {}),
    };
    if (markerRow?.kind === "timelineMarker") {
      anchorRowId = markerRow.rowId;
      deltas.push({
        op: "row.upserted",
        row: { ...markerRow, marker: terminalMarker },
      });
    } else {
      // GV terminal-only: upsert the boundary by lifecycleKey so any lifecycle event can create the
      // entity, regardless of arrival order. The old implementation discarded terminal events if
      // no started marker existed (for example, a terminal event arriving after cold recovery or a
      // dropped started event).
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: terminalMarker,
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      anchorRowId = row.rowId;
      deltas.push({ op: "row.appended", row });
    }

    const hadGoalVerifierWork = this.snapshot.control.activeWorks.some(
      (work) => work.kind === "goalVerifier",
    );
    const shouldPatchControl = hadGoalVerifierWork || this.snapshot.goal?.status === "verifying";
    const otherWorks = this.snapshot.control.activeWorks.filter(
      (work) => work.kind !== "goalVerifier",
    );
    const terminalPhase: SessionControl["phase"] =
      payload.status === "cancelled"
        ? "completedInterrupted"
        : payload.status === "failed_closed"
          ? "error"
          : "completedSuccess";
    const heldQueue =
      payload.status === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    // If goal is absent (cold-recovery synthetic stream), retain the marker row. Settle control only
    // when the current live control is actually verifier work, preventing a terminal-only historical
    // fact from incorrectly advancing a cold-recovery draft snapshot to completed.
    if (!goal) {
      if (!shouldPatchControl) return deltas;
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: terminalPhase,
            sessionEnded: terminalPhase !== "error",
            activeWorks: otherWorks,
            ...(otherWorks.length === 0
              ? {
                  canStop: false,
                  stopState: "idle" as const,
                  stopTargetKind: "unknown" as const,
                }
              : {
                  stopTargetKind: "mixed" as const,
                }),
          },
          undefined,
          heldQueue,
        ),
      });
      return deltas;
    }

    // Keep only conclusions in verifications (cancelled is not a conclusion and is omitted); retain
    // the most recent N entries.
    const verifications =
      payload.status === "cancelled"
        ? goal.verifications
        : [
            ...goal.verifications,
            {
              iteration,
              outcome,
              at: this.ms(event),
              anchorRowId,
              ...(payload.verification?.reason ? { reason: payload.verification.reason } : {}),
              ...(payload.verification?.nextAction
                ? { nextAction: payload.verification.nextAction }
                : {}),
            },
          ].slice(-PROTOCOL_V4_LIMITS.goalVerificationsRetained);

    const nextGoal = {
      ...goal,
      status: goalStatus,
      iteration,
      verifications,
    };
    deltas.push({
      op: "state.updated",
      patch: shouldPatchControl
        ? this.controlPatch(
            {
              phase: terminalPhase,
              sessionEnded: terminalPhase !== "error",
              activeWorks: otherWorks,
              ...(otherWorks.length === 0
                ? {
                    canStop: false,
                    stopState: "idle" as const,
                    stopTargetKind: "unknown" as const,
                  }
                : {
                    stopTargetKind: "mixed" as const,
                  }),
            },
            nextGoal,
            heldQueue,
          )
        : this.goalPatch(nextGoal),
    });
    return deltas;
  }

  /** Goal verification boundary identity: targetId_goalIteration. */
  private goalVerifyLifecycleKey(
    payload: TargetCompletionVerificationPayload,
    iteration: number,
  ): string {
    return payload.targetId ? `${payload.targetId}_${iteration}` : payload.verificationId;
  }

  // Placement: prefer anchorAssistantMessageId (resolve to the turn containing the rendered row;
  // after a fork copy, this is the remapped child-local ID); next use anchorTurnId (it must be a
  // known turn, since an unknown ID must not be treated as turnId or it creates ghost turn groups,
  // as with a parent runtime turnId from before the fork); finally use event ownership.
  private goalVerifyTurnId(
    payload: TargetCompletionVerificationPayload,
    event: SessionEvent,
  ): string {
    const anchorMessageId = payload.anchorAssistantMessageId
      ? String(payload.anchorAssistantMessageId)
      : null;
    if (anchorMessageId) {
      const rowId = this.rowIdForMessageId(anchorMessageId);
      const row = rowId !== null ? this.findRow(rowId) : undefined;
      if (row) return row.turnId;
    }
    const anchorTurnId = payload.anchorTurnId ? String(payload.anchorTurnId) : null;
    if (anchorTurnId) {
      const mapped = this.productTurnIdByRuntimeTurnId.get(anchorTurnId) ?? anchorTurnId;
      if (this.turnHeaderRowIdByTurnId.has(mapped)) return mapped;
    }
    return this.turnIdOf(event);
  }

  // ── Fork marker (effect of the forkAssistant command) ──

  private onSessionForked(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionForkedPayload;
    const isParent = String(payload.originalSessionId) === this.snapshot.sessionId;
    if (isParent) {
      // Do not show forkCreated on the parent timeline; the fork relationship appears only in the
      // sessions tree/list. The old implementation created a row anchored approximately at
      // nextRowId-1, and the UI rendered it as null (an invisible row that polluted turn grouping).
      // Keep the forkNotice at the start of the child unchanged.
      return [];
    }
    // forkNotice at the start of the child (forkTimelineIsBoundary): the event payload has no
    // parent-side rowId, so use 0 as a placeholder. The transport wrapper fills the transcript
    // anchor → rowId mapping.
    const row: TimelineMarkerRow = {
      ...this.rowBase(
        event,
        this.turnIdOf(event),
        `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
      ),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: {
        type: "forkNotice",
        parentSessionId: String(payload.originalSessionId),
        parentRowId: 0,
      },
    };
    return [{ op: "row.appended", row }];
  }

  // ── Internal helpers ──

  // goal=undefined means leave goal unchanged; null/object replaces it with this patch (availability
  // is derived from the same source).
  // queue=undefined means leave the queue unchanged. The held derivation
  // (heldQueueInputRequiresChoice) depends on queue.items.length + autoDrain, so any control/goal/
  // queue change recomputes Area A from this one place.
  private controlPatch(
    control: Partial<SessionControl>,
    goal?: GoalState | null,
    queue?: ConversationSnapshot["queue"],
  ): StatePatch {
    const next: SessionControl = { ...this.snapshot.control, ...control };
    const nextGoal = goal === undefined ? this.snapshot.goal : goal;
    const nextQueue = queue ?? this.snapshot.queue;
    const context = {
      phase: next.phase,
      goalStatus: nextGoal?.status ?? null,
      // compacting is not a separate phase (the enum is closed); derive it from activeWorks.
      compacting: next.activeWorks.some((work) => work.kind === "compact"),
      goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
      queueLength: nextQueue.items.length,
      autoDrain: nextQueue.autoDrain,
    };
    return {
      control: next,
      ...(goal === undefined ? {} : { goal }),
      ...(queue === undefined ? {} : { queue }),
      availability: computeAvailability(context),
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  // Patch for a goal-only change (availability shares the goal source; phase/activeWorks stay unchanged).
  private goalPatch(goal: GoalState | null): StatePatch {
    return {
      goal,
      availability: computeAvailability(this.deriveContext({ goal })),
    };
  }

  // Patch for a queue-only change: queue length/autoDrain affect the held derivation, so recompute
  // Area A at the same time.
  private queuePatch(queue: ConversationSnapshot["queue"]): StatePatch {
    const context = this.deriveContext({ queue });
    return {
      queue,
      availability: computeAvailability(context),
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  private deriveContext(overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  }) {
    const goal = overrides.goal === undefined ? this.snapshot.goal : overrides.goal;
    const queue = overrides.queue ?? this.snapshot.queue;
    return {
      phase: this.snapshot.control.phase,
      goalStatus: goal?.status ?? null,
      compacting: this.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
      goalVerifying: this.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
      queueLength: queue.items.length,
      autoDrain: queue.autoDrain,
    };
  }

  private upsertTurnHeader(
    event: SessionEvent,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    activeMs?: number,
    historyRoundCount?: number,
    highspeedTiming?: {
      modelDurationMs: number;
      toolDurationMs: number;
      otherDurationMs: number;
    },
  ): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row) return [];
    const endedAt = this.ms(event);
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state,
          endedAt,
          ...(activeMs !== undefined ? { activeMs } : {}),
          ...highspeedTiming,
          ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
          ...(row.workSegments
            ? {
                workSegments: this.completeWorkSegments(row.workSegments, endedAt),
              }
            : {}),
        },
      },
    ];
  }

  private recordHighspeedToolStarted(turnId: string, toolCallId: string, startedAt: number): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    intervals.set(toolCallId, { startedAt });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private recordHighspeedToolEnded(
    turnId: string,
    toolCallId: string,
    endedAt: number,
    durationMs?: number,
  ): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    const existing = intervals.get(toolCallId);
    const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
    intervals.set(toolCallId, {
      startedAt,
      endedAt: Math.max(
        startedAt,
        existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
      ),
    });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private highspeedTimingForTurn(
    turnId: string,
    activeMs?: number,
  ): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
    const modelDurationMs = this.highspeedModelDurationByTurnId.get(turnId);
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId);
    if (modelDurationMs === undefined && intervals === undefined) return undefined;
    const sorted = [...(intervals?.values() ?? [])]
      .filter((interval) => interval.endedAt !== undefined)
      .sort((left, right) => left.startedAt - right.startedAt);
    let toolDurationMs = 0;
    let unionEnd = -1;
    for (const interval of sorted) {
      const start = Math.max(0, interval.startedAt);
      const end = Math.max(start, interval.endedAt ?? start);
      if (start > unionEnd) toolDurationMs += end - start;
      else if (end > unionEnd) toolDurationMs += end - unionEnd;
      unionEnd = Math.max(unionEnd, end);
    }
    const model = Math.max(0, modelDurationMs ?? 0);
    const otherDurationMs = Math.max(
      0,
      (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
    );
    this.highspeedModelDurationByTurnId.delete(turnId);
    this.highspeedToolIntervalsByTurnId.delete(turnId);
    return { modelDurationMs: model, toolDurationMs, otherDurationMs };
  }

  private openGuidedWorkSegment(event: SessionEvent, triggerEntityId: string): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row || row.executionKind === "controlOnly") return [];
    const startedAt = this.ms(event);
    const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
      {
        segmentId: `${row.turnId}:initial`,
        startedAt: row.startedAt,
      },
    ];
    // The old UI kept only one collapsed state for the whole product turn, so an accepted guide
    // could be inserted only as an ordinary row and could not restore an independent work area.
    // The CLI must record segment boundaries; React cannot infer them from adjacent rows.
    const workSegments = [
      ...this.completeWorkSegments(existingSegments, startedAt),
      {
        segmentId: triggerEntityId,
        triggerEntityId,
        startedAt,
      },
    ];
    return [{ op: "row.upserted", row: { ...row, workSegments } }];
  }

  private completeWorkSegments(
    segments: readonly TurnWorkSegment[],
    endedAt: number,
  ): TurnWorkSegment[] {
    return segments.map((segment, index) =>
      index === segments.length - 1 && segment.endedAt === undefined
        ? {
            ...segment,
            endedAt,
            activeMs: Math.max(0, endedAt - segment.startedAt),
          }
        : segment,
    );
  }

  private turnHeaderForEvent(event: SessionEvent): TurnHeaderRow | undefined {
    const rowId = this.turnHeaderRowIdByTurnId.get(this.turnIdOf(event));
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "turnHeader" ? row : undefined;
  }

  private markStableForkAssistant(event: SessionEvent): ConversationDelta[] {
    const turnId = this.turnIdOf(event);
    const rows = this.snapshot.rows.window;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerIndex = headerRowId === undefined ? undefined : this.rowIndexById.get(headerRowId);
    const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
    let row: AssistantTextRow | undefined;
    // Performance cause: the old implementation copied and reversed all historical rows for every
    // successful turn, causing cold recovery to accumulate approximately O(turns * rows) allocations
    // and scans. Rows for the current turn can appear only after its own header.
    for (let index = rows.length - 1; index >= startIndex; index -= 1) {
      const candidate = rows[index];
      if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
      row = candidate;
      break;
    }
    if (!row || !this.messageIdByRowId.has(row.rowId)) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state: "complete",
          actions: { ...row.actions, canFork: true },
        },
      },
    ];
  }

  private isRunning(): boolean {
    const phase = this.snapshot.control.phase;
    return phase === "running" || phase === "prewarming";
  }

  private isMirroredSubagentToolEvent(event: SessionEvent): boolean {
    const payload = event.payload as unknown as Record<string, unknown>;
    // Cause: child tool lifecycle is mirrored to the parent runtime, but it is not a tool fact for
    // the parent session. V4 previously treated the mirror as an ordinary ToolCallRow, showing the
    // child's Read/Bash on the main timeline and including the dirty row in replayable snapshots.
    // The complete tool history should be materialized only by the child topic.
    return payload.source === "subagent";
  }

  private openAssistantSegments(): Partial<
    Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>
  > {
    const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
    const text = this.openSegmentIdentity(this.streamingTextRowId);
    const reasoning = this.openSegmentIdentity(this.streamingReasoningRowId);
    if (text) segments.text = text;
    if (reasoning) segments.reasoning = reasoning;
    return segments;
  }

  private openSegmentIdentity(rowId: number | null): CanonicalOpenSegmentIdentity | null {
    if (rowId === null) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    if (!entityId) return null;
    return {
      entityId,
      transcriptMessageId: this.messageIdByRowId.get(rowId) ?? null,
    };
  }

  private rowBase(event: SessionEvent, turnId: string, entityId = String(event.id)) {
    const rowId = this.nextRowId++;
    this.entityIdByRowId.set(rowId, entityId);
    return {
      rowId,
      turnId,
      entityId,
      productTurnId: turnId,
      visibility: "visible" as const,
      createdAt: this.ms(event),
      createdAtSeq: event.sequenceNumber,
    };
  }

  private turnIdOf(event: SessionEvent): string {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // After queue drain splits a turn, subsequent event rows in the same runtimeTurn belong to the
    // latest productTurn.
    return this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  }

  private ms(event: SessionEvent): number {
    return event.timestamp.getTime();
  }

  private findRow(rowId: number): ConversationRow | undefined {
    const index = this.rowIndexById.get(rowId);
    return index === undefined ? undefined : this.snapshot.rows.window[index];
  }

  private updateRowIndexAfterImmutableApply(
    previousRowsLength: number,
    deltas: readonly ConversationDelta[],
  ): void {
    if (deltas.some((delta) => delta.op === "row.removed")) {
      this.rowIndexById = new Map(
        this.snapshot.rows.window.map((row, index) => [row.rowId, index]),
      );
      return;
    }
    let nextIndex = previousRowsLength;
    for (const delta of deltas) {
      if (delta.op !== "row.appended") continue;
      this.rowIndexById.set(delta.row.rowId, nextIndex);
      nextIndex += 1;
    }
  }

  private findToolRow(toolCallId: string): ToolCallRow | undefined {
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "toolCall" ? row : undefined;
  }

  private findSubagentRow(agentId: string): SubagentRow | undefined {
    const rowId = this.subagentRowIdByAgentId.get(agentId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "subagent" ? row : undefined;
  }

  private findSubagentLifecycleRow(
    agentId: string,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ): SubagentRow | undefined {
    const exact = this.findSubagentRow(agentId);
    if (exact) return exact;

    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    if (!parentToolCallId) return undefined;
    const turnId = this.turnIdOf(event);
    // Late-subscription hydration cannot recover the real agentId from a background Agent's text
    // tool output, so it first synthesizes a SubagentRow using toolCallId. A later live lifecycle
    // carries the real agentId, and the old logic appended a second row; the UI then let the
    // synthetic row without childSessionId take precedence in pairing. The parent tool call is a
    // stable unique identity within the turn, so merge the real event into the synthetic row and fill
    // in childSessionId.
    return this.snapshot.rows.window.find(
      (row): row is SubagentRow =>
        row.kind === "subagent" &&
        row.turnId === turnId &&
        row.parentToolCallId === parentToolCallId,
    );
  }

  private subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string {
    return (
      this.stringPayload(payload, "agentId") ??
      this.stringPayload(payload, "childSessionId") ??
      this.stringPayload(payload, "parentToolCallId") ??
      `subagent-${event.sequenceNumber}`
    );
  }

  private stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private mapSubagentStatus(status: string | undefined): SubagentRow["status"] {
    switch (status) {
      case "completed":
      case "success":
        return "success";
      case "cancelled":
      case "stopped":
        return "cancelled";
      default:
        return "failed";
    }
  }
}

function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

/**
 * Narrow core tool display to the kinds that the v4 protocol can carry.
 *
 * This allowlist used to be duplicated as inline checks at each projection site. When create_workflow
 * display was introduced, one check was missed: live projection dropped the entire graph, while
 * hydration did not filter it, so Desktop showed it only after reload. Consolidate the checks into
 * one predicate so every projection site shares the same allowlist.
 */
function toProtocolToolCallDisplay(
  display: ToolResultDisplayPayload | undefined,
): ToolCallDisplay | undefined {
  if (!display) return undefined;
  switch (display.kind) {
    case "node_repl_images":
    case "task_output":
    case "respond_to_coordinator":
    case "mcp_tool":
    case "create_workflow":
    // The five display kinds for workflow observation tools. The shared toolCallDisplaySchema has
    // added these members too; allowing them here lets the UI receive structured payloads on
    // row.display.
    case "get_workflow_run":
    case "list_workflow_runs":
    case "eval_workflow_snippet":
    case "saved_workflow_list":
    case "list_models":
    // ResumeWorkflowRun recovery card.
    case "resume_workflow_run":
      return display;
    default:
      return undefined;
  }
}

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function normalizeAskUserQuestionPayloadQuestion(value: unknown): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
