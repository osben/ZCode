import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
 * Tools hidden during an off-peak dispatch turn; OffPeakList remains available as read-only.
 * - OffPeakCreate: prevents off-peak tasks from recursively spawning themselves and scheduling without limit.
 * - SendMessage / Workflow: these can start child Agents outside the off-peak turn's modelExecution (SendMessage resumes
 *   a completed subagent; Workflow creates a script sub-session), using the model selected persistently by the parent session.
 *
 * Keep this as a separate constant; never add it to AUTOMATION_MUTATION_TOOL_NAMES. Cron automation turns explicitly allow
 * OffPeakCreate to schedule off-peak tasks, and merging the constants would incorrectly deny it.
 */
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate", "SendMessage", "Workflow"] as const;
// The init phase of an off-peak dispatch has no fixed traceId prefix; only the resume phase uses `${offPeakTaskId}:resume:*`
// (starting with offpeak-). The prefix is only a fallback signal for resume; the primary signal must be explicit offPeakTaskId.
const OFF_PEAK_QUERY_ID_PREFIX = "offpeak-";

export interface CompactLoopTracking {
  consecutiveRapidRefills: number;
  toolTurnsSinceCompact: number;
}

export interface RapidRefillDecision {
  consecutiveRapidRefills: number;
  shouldBlock: boolean;
  toolTurnsSinceCompact: number;
}

export type CompactAttemptOutcome = "skipped" | "compacted" | "failed";

export type AutoCompactOutcome = CompactAttemptOutcome | "rapid_refill_blocked";

export interface AutoCompactLoopContext {
  compactReason: CompactReason;
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
}

export interface ReactiveCompactLoopContext {
  activeEntries?: readonly RuntimeMessageEntry[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  activeTurn?: ActiveTurnSteeringState;
  /** Identity of this automation turn, explicitly passed by Host admission; do not infer it from persisted task metadata. */
  automationId?: string;
  /** Identity of this off-peak task turn, explicitly passed by Host admission; mutually exclusive with automationId and not inferred from persisted metadata. */
  offPeakTaskId?: string;
  /** After CronCreate reaches the global limit, this user turn is permanently text-only; the model cannot resume tool use. */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** Whether this turn has consumed a background result notification from a subagent. */
  backgroundSubagentResultConsumed: boolean;
  /** Whether this turn has consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  modelResponse: string;
  /** The callable model fixed for this turn; configuration changes affect only Loops created later. */
  model: Model;
  /** execution means the current Active Model cannot be changed by a guide in the same loop. */
  modelSelectionScope?: "execution";
  /** Foreground child Selection override from Core Server; takes precedence over profile and parent-model inheritance. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** Number of assistant/compact outputs for the current query successfully written to provider-visible persistent history. */
  historyRoundCount: number;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** Raw transcript start for the final successful product turn; assigned only after confirming there will be no continuation. */
  stableProductStartMessageId?: MessageId;
  /** Final successful assistant boundary; paired with stableProductStartMessageId. */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** Provider-local history for the current Turn; released when the Turn ends. */
  turnRequestState: TurnRequestState;
  /** Tool names hidden from the provider for the current turn; the registry retains them for defense-in-depth checks at execution boundaries. */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** Provider-visible output style captured for the current Turn; this does not indicate an explicit subagent model override. */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // Active/busy automation input merges the turn-scoped denylist into the current loop. Even if the original
  // automationId is no longer the loop's first input, propagate the same fact to handler execution boundaries.
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * Whether this is an automatically dispatched off-peak turn (OffPeakCreate must be denied). The three signals mirror
 * isAutomationMutationRestrictedTurn: explicit offPeakTaskId is primary; the resume-phase traceId prefix and turn denylist are defense-in-depth fallbacks.
 */
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakTaskId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;

  // The fallback checks only the OffPeakCreate sentinel; older Host dispatches may not yet include the newly added tool in the denylist.
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(OFF_PEAK_MUTATION_TOOL_NAMES[0]);
}

export function evaluateRapidRefill(
  tracking: CompactLoopTracking | undefined,
): RapidRefillDecision {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  const consecutiveRapidRefills =
    tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD
      ? tracking.consecutiveRapidRefills + 1
      : 0;

  return {
    consecutiveRapidRefills,
    shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    toolTurnsSinceCompact,
  };
}

export function recordCompactSuccess(
  state: RegularTurnLoopState,
  decision: RapidRefillDecision,
): void {
  state.compactTracking = {
    consecutiveRapidRefills: decision.consecutiveRapidRefills,
    toolTurnsSinceCompact: 0,
  };
}

export function recordCompletedToolBatch(state: RegularTurnLoopState): void {
  // The old guard remained used for the entire user turn after a complete tool batch, preventing a later real overflow from triggering reactive compaction again.
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount expands parallel tools by count and cannot represent the turns the model actually wrote to history.
  // Reuse the existing modelStepCount commit boundary and additionally count history turns without changing loop-control semantics.
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // A compact summary is a separate provider-visible persistent history entry, not an ordinary model step, so count it separately.
  state.historyRoundCount += 1;
}
