// ProductProjection state factory and derivation rules.
// This file contains only pure functions: initial snapshots, availability/inputRouting derivation, and revision advancement.
import type {
  ActionAvailability,
  ConversationDelta,
  ConversationSnapshot,
  GoalState,
  InputRouting,
  SessionActionAvailability,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Sentinel traceId for synthetic events during cold recovery.
 * Synthetic events rebuild a view; they are not authoritative user actions. Config events such as
 * ModelSelected update the projected config but must not claim seed authority
 * (`configModelTouchedByEvent`), or the model from the last historical turn will override the
 * runtime truth written during resume, including a draft selection.
 */
export const HYDRATION_TRACE_ID = "hydrate-trace";

export function createInitialConversationSnapshot(
  sessionId: string,
  logEpoch: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch,
    seq: 0,
    revision: 0,
    control: {
      // Draft decision: the session entity exists, but has no input yet.
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: computeAvailability({
      phase: "draft",
      goalStatus: null,
      compacting: false,
      goalVerifying: false,
      queueLength: 0,
      autoDrain: true,
    }),
    inputRouting: computeInputRouting(
      {
        phase: "draft",
        goalStatus: null,
        compacting: false,
        goalVerifying: false,
        queueLength: 0,
        autoDrain: true,
      },
      "queue",
    ),
    meta: { title: "", titleSource: "default" },
    // Initial mode = the core default collaboration mode (the "build" fallback from session-mode-port getMode).
    // Although SessionCreated carries a mode, draft semantics require no visible delta (no revision bump).
    // If the persisted preference is not build, the first SessionModeChanged takes precedence (TODO: add a seed channel that avoids a draft-time revision bump).
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    // Soft gate: no pending review state initially; the projection writes it after activate() reports.
    workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const ALLOWED: ActionAvailability = { allowed: true };

function denied(reasonCode: string): ActionAvailability {
  return { allowed: false, reasonCode };
}

// Guard-derived input surface (from the same source as the projection). compacting/goalVerifying
// are not independent phases (phase is a closed enum); derive them from activeWorks / goal.status and pass them in.
// queueLength/autoDrain are used to derive held state.
interface AvailabilityContext {
  phase: SessionControl["phase"];
  goalStatus: GoalState["status"] | null;
  compacting: boolean;
  goalVerifying: boolean;
  queueLength: number;
  autoDrain: boolean;
}

// This decision table matches evaluate in packages/formal-proof/src/model.ts entry by entry
// (backed by the formal-proof-consistency golden test); reasonCode = the product-protocol guard id.
export function computeAvailability(context: AvailabilityContext): SessionActionAvailability {
  const { phase, goalStatus, compacting } = context;
  const running = phase === "running" || phase === "prewarming";
  const compact = compacting
      ? // formal-proof: duplicateCompactRejected — deduplicate running/queued compact-operation locks.
      denied("compactOperationLock")
    : phase === "draft"
      ? // formal-proof: idleCannotCompact — there is no context to compact.
        denied("idleCannotCompact")
      : // While running or verifying a goal, commands enter the typed FIFO; when completed, they execute immediately or enter the held queue.
        ALLOWED;
  return {
    fork: compacting
      ? denied("compactOperationLock")
      : phase === "draft"
        ? denied("forkTargetNotStable")
        : ALLOWED,
    compact,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: compacting
      ? denied("compactOperationLock")
      : running
        ? ALLOWED
        : denied("sendQueuedNowRequiresRunning"),
    // The separate pauseGoal changes the target's product state. During verifier/notSatisfied, the
    // underlying target remains active, so pausing is allowed without requiring a provider abort controller.
    pauseGoal:
      goalStatus === "active" || goalStatus === "verifying" || goalStatus === "notSatisfied"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToPause" : "goalNotActive"),
    // resumeGoal reverses stopPausesActiveGoalTarget: only a paused goal can be resumed.
    resumeGoal:
      goalStatus === "paused"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToResume" : "goalNotPaused"),
  };
}

export function computeInputRouting(
  context: AvailabilityContext,
  followupMode: "queue" | "guide",
): InputRouting {
  // formal-proof: compactingAcceptsFutureInput
  // Compact is a maintenance step; input expresses future intent, so enqueue it without interrupting compact.
  if (context.compacting) {
    return { mode: "enqueue", reasonCode: "compactingAcceptsFutureInput" };
  }
  // A goal verifier is completion-blocking active work, but it is not a regular assistant active turn.
  // Checking only phase=running would attempt to steer in guide mode, where core has no steerable
  // activeTurn; user input would then appear in neither the queue nor history.
  if (context.goalVerifying) {
    return { mode: "enqueue", reasonCode: "goalVerifierAcceptsFutureInput" };
  }
  if (context.phase === "running" || context.phase === "prewarming") {
    return { mode: followupMode === "guide" ? "guide" : "enqueue" };
  }
  // When completed + queue>0 + autoDrain=false, do not silently enqueue input.
  // The client presents a clear/keep choice, and disposition travels with the command.
  const completed =
    context.phase === "completedSuccess" || context.phase === "completedInterrupted";
  if (completed && context.queueLength > 0 && !context.autoDrain) {
    return { mode: "choice", reasonCode: "heldQueueInputRequiresChoice" };
  }
  return { mode: "startNow" };
}

// Revision advancement rule (closed definition): row structure changes and section A changes
// (except usage/pendingCommands) each add 1.
// `workflowRuns` is intentionally excluded and belongs to the usage/pendingCommands exemption:
// it is high-frequency derived data (about five transitions per node), has its own monotonic
// revision field, and no command reads it in a baseRevision CAS. Including it would bump the
// conversation revision on every node transition while a run is in flight, adding spurious CAS failures.
const REVISION_BEARING_PATCH_KEYS: ReadonlyArray<keyof StatePatch> = [
  "control",
  "availability",
  "inputRouting",
  "meta",
  "config",
  "queue",
  "pendingInteractions",
  "backgroundWorks",
  "subagents",
  "goal",
  "plan",
];

export function deltaBumpsRevision(delta: ConversationDelta): boolean {
  switch (delta.op) {
    case "row.appended":
    case "row.upserted":
    case "row.removed":
      return true;
    case "row.delta":
      return false;
    case "state.updated":
      return REVISION_BEARING_PATCH_KEYS.some((key) => delta.patch[key] !== undefined);
    // Key-level deltas have the same exemption as a whole-key `workflowRuns` patch (see above): they
    // express changes to that key, and a different encoding should not change the accounting rule.
    // Including them would bump the conversation revision on every node transition of an in-flight run.
    case "workflowRun.updated":
    case "workflowRun.removed":
      return false;
  }
}
