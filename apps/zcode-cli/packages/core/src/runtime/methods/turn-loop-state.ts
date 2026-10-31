import { OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  ModelSelection,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { ToolLoopHistory } from "../helpers/tool-loop-patterns.js";
import type { ModelToolContract, ModelUsage, SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics, ModelExecutionContext } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
/** Execution-run self-pause tool; visible only when the loop carries a Host-admission-injected automationId, not part of the mutation list. */
export const AUTOMATION_SELF_PAUSE_TOOL_NAME = "CronPauseSelf";
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
 * Tools hidden on off-peak dispatch rounds; OffPeakList stays as read-only.
 * - OffPeakCreate: prevents off-peak tasks from recursively self-dispatching and scheduling forever.
 * - Workflow and dynamic-execution entries: the standalone workflow runner has not yet joined the off-peak ticket lifecycle.
 *
 * A separate constant — never merge into AUTOMATION_MUTATION_TOOL_NAMES: a cron automation turn
 * explicitly allows OffPeakCreate (scheduled spawning of off-peak tasks), and mixing it in would
 * make automation turns deny it by mistake.
 */
export const OFF_PEAK_MUTATION_TOOL_NAMES = OFF_PEAK_EXECUTION_TOOL_DENYLIST;
// The off-peak dispatch init segment's traceId has no fixed prefix; only the resume segment is
// `${offPeakTaskId}:resume:*` (offpeak- prefixed). The prefix is only a resume fallback signal;
// the primary signal must be an explicit offPeakTaskId.
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
  getAgentListingTools?: () => readonly { name: string }[];
  compactReason: CompactReason;
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
  getContinuationTools?: () => readonly ModelToolContract[];
}

export interface ReactiveCompactLoopContext {
  agentListingTools?: readonly { name: string }[];
  activeEntries?: readonly RuntimeMessageEntry[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
  getContinuationTools?: () => readonly ModelToolContract[];
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  offPeakExecutionId?: string;
  activeTurn?: ActiveTurnSteeringState;
  /** Automation identity for this turn passed explicitly by Host admission; must not be inferred from persisted task metadata. */
  automationId?: string;
  /** Off-peak task identity for this turn passed explicitly by Host admission; mutually exclusive with automationId, not inferred from persisted meta. */
  offPeakTaskId?: string;
  /** Usage reported by an external agent for this turn; absent for provider-backed turns. */
  externalAgentUsage?: ModelUsage;
  /** After CronCreate hits the global limit, this user turn permanently switches to plain-text replies; the model may not recover on its own. */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** Whether this turn already consumed the subagent-sourced background result notification. */
  backgroundSubagentResultConsumed: boolean;
  /** Whether this turn already consumed the workflow-sourced (dynamic-workflow run) background notification. */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  inputId?: string;
  modelResponse: string;
  /** The callable model pinned for this turn; config changes affect only Loops created afterwards. */
  model: Model;
  /** "execution" means the current Active Model cannot be rewritten by the guide in the same loop. */
  modelSelectionScope?: "execution";
  /** Fallback declaration of this turn's execution Selection; cleared after one hit, and the fallen-back model does not fall back again. */
  selectionFallback?: ModelExecutionContext["selectionFallback"];
  /** A request-phase failure matched the fallback declaration but no fallback target is available; TurnError attribution is published from this and the renderer invalidates the matching card. */
  highspeedFallbackUnavailable?: boolean;
  /** Startup snapshot used only for expired-accelerated-card fallback; not used for off-peak ticket swaps. */
  highspeedFallbackSelection?: ModelSelection;
  /** Foreground child Selection override from the Core Server; takes precedence over profile and parent-model inheritance. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** Number of assistant/compact artifacts of the current query already written into the provider-visible persistent history. */
  historyRoundCount: number;
  completedRealToolResultBatch: boolean;
  /** Input attachments to collect on the next loop iteration: set at round start, after a full tool batch, and when a text reply is followed by a guide. */
  inputAttachmentCollectionPending: boolean;
  /** The turn was already stopped when the tool batch settled; decides that the interruption marker uses the tool-phase wording. */
  interruptedDuringToolBatch?: boolean;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  /** Non-polling loop history for rotation detection; reset with the repeated-call streak. */
  toolLoopHistory?: ToolLoopHistory;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** Raw transcript start of the final successful product turn; assigned only once it is confirmed there is no further continue. */
  stableProductStartMessageId?: MessageId;
  /** Final successful assistant boundary; always paired with stableProductStartMessageId. */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** Provider-local history of the current turn; released as soon as the turn ends. */
  turnRequestState: TurnRequestState;
  /** Tool names not exposed to the provider this turn; the registry keeps them so the execution boundary can do defense-in-depth checks. */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** Provider-visible output style captured for the current turn; does not imply an explicit subagent model override. */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // An active/busy automation input merges the turn-scoped denylist into the current loop; even
  // when the original automationId is no longer the loop's first input, the same fact must keep
  // reaching the handler execution boundary.
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * Whether this turn is an off-peak auto-dispatched turn (OffPeakCreate must be denied). The
 * triple signal mirrors isAutomationMutationRestrictedTurn: an explicit offPeakTaskId is the
 * primary signal; the resume-segment traceId prefix and the turn denylist are defense-in-depth
 * fallbacks.
 */
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakTaskId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;

  // The fallback recognizes only the OffPeakCreate sentinel: a denylist dispatched by an older host may not yet carry newly added tools.
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
  state.inputAttachmentCollectionPending = true;
  // The old guard lived for the whole user turn and stayed "used" after a full tool batch, so a later real overflow could not reactive-compact again.
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount expands parallel tools by count and cannot express the rounds the model actually
  // wrote to history. Call sites reuse modelStepCount's existing commit boundary and additionally
  // accumulate history rounds without changing loop control semantics.
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // A compact summary is its own provider-visible persistent history entry, but not a normal model step; count it once separately.
  state.historyRoundCount += 1;
}
