import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type TraceContext,
} from "../deps.js";
import {
  formatWorkflowEscalationNotification,
  formatWorkflowStallNotification,
} from "../../runtime-task/notification.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Appends a workflow run progress event to the **parent session** (the run has no session of its own).
 *
 * This is an **out-of-turn append**: the run executes in the background, so the parent session may be in a turn or idle when the event arrives.
 * Both cases must be persisted, and this path already supports both—BackgroundTask* uses it (through the core tool executor's emitEvent).
 * The dwf event source is in the bootstrap run service, which cannot access AgentRuntimeInternal, so this public method is needed;
 * {@link recordTargetChanged} is a similar precedent.
 *
 * Deliberately use `rootTraceContext` rather than the current turn's trace, leaving turnId empty so the event is not attributed to any turn.
 * Cold-recovery merge inserts in-memory events with a turnId at the end of their "owning unfinished turn." A run event
 * belongs to the run, not to any turn; attributing it would make it appear after a completed conversation during cold recovery.
 */
export async function recordDynamicWorkflowRunProgress(
  this: AgentRuntimeInternal,
  input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
): Promise<void> {
  const { traceContext: provided, ...payload } = input;
  const traceContext = provided ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.DynamicWorkflowRunProgress,
      payload satisfies DynamicWorkflowRunProgressPayload,
      traceContext,
    ),
    traceContext,
  );
  notifyEscalationRaised.call(this, payload, traceContext);
  notifyRunStalled.call(this, payload, traceContext);
}

/** Event type for run-level stalls (the engine's `RunEvent.type`). */
const RUN_STALLED_EVENT_TYPE = "run-stalled";

/**
 * `run-stalled` → one model-visible notification inside the run. It follows the same layer and three
 * rules as {@link notifyEscalationRaised}: exactly one notification per event (the driver emits once per stalled interval, and rearms after success);
 * no reminders; never throw—skip and log malformed payloads.
 */
function notifyRunStalled(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== RUN_STALLED_EVENT_TYPE) return;
  const sinceMs = payload.payload.sinceMs;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0) {
    this.logger?.warn?.("Dynamic workflow stall notification skipped: malformed payload", {
      event: "dynamic_workflow.stall.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const reason = stringField(payload.payload, "reason");
  const capValue = payload.payload.cap;
  const cap =
    typeof capValue === "number" && Number.isFinite(capValue) && capValue >= 0
      ? Math.floor(capValue)
      : undefined;
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      workId: payload.runId,
      workflowNotification: {
        kind: "stall",
        sinceMs: Math.floor(sinceMs),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 64) }),
        ...(cap === undefined ? {} : { cap }),
      },
    },
    taskId: payload.runId,
    text: formatWorkflowStallNotification({
      runLabel,
      runId: payload.runId,
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    }),
    traceContext,
  });
}

/** Event type for escalation questions (the engine's `RunEvent.type`, received as `eventType` in the progress payload). */
const ESCALATION_RAISED_EVENT_TYPE = "escalation-raised";

/**
 * `escalation-raised` → one model-visible notification inside the run.
 *
 * Why handle this here instead of adding another port: the progress sink already sends every RunEvent here, making it the **only** place
 * that can see both run events and AgentRuntime. Adding another port would route the same fact along two paths.
 *
 * Three rules:
 *   - **Exactly one notification per raised event**, with no resend or reminder. If a notification is dropped (stale branch / shutdown),
 *     the fallback is a query—GetWorkflowRun's pendingQuestions—not a retry.
 *   - **Do not notify on `escalation-resolved`**: the main agent answers the question, and the acknowledgement is already the result of that tool call.
 *   - **Never throw**: this is an observation surface; the journal is authoritative for the run. Skip and log malformed payloads—
 *     it crosses a port boundary and has been bounded, so defensive reads are appropriate.
 */
function notifyEscalationRaised(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== ESCALATION_RAISED_EVENT_TYPE) return;

  const qid = stringField(payload.payload, "qid");
  const question = stringField(payload.payload, "question");
  if (qid === undefined || question === undefined) {
    this.logger?.warn?.("Dynamic workflow escalation notification skipped: malformed payload", {
      event: "dynamic_workflow.escalation.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  // The display-name fallback chain matches terminal notifications: registry entry description (CreateWorkflow name /
  // derived from the script's first line) → runId. Do not query a port; notifications are produced synchronously and this path does no I/O.
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const context = stringField(payload.payload, "context");
  // Anonymous actors have no actorName (the engine deliberately does not synthesize a fallback label; see the RunEvent comment).
  // Use the structured ref `site@ordinal`, which uniquely identifies the actor within the run and remains readable in prose. Notification text and manifest
  // payload share the same fallback chain; separate fallbacks could display different names for the same actor.
  const actor = stringField(payload.payload, "actorName") ?? actorRefLabel(payload.payload);
  // askedAt is epoch milliseconds and may be absent (stringField cannot read numbers, so access it defensively).
  const askedAt = payload.payload.askedAt;

  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId: use the same display anchor as this run's terminal notification so both notifications appear under the same background work.
      workId: payload.runId,
      // Manifest payload (the escalation discriminator branch): the GUI collapses this to "Subagent X has a question"
      // and expands to show the full question. The emitter constructs and bounds it (question / context ≤4000, matching the shared schema).
      workflowNotification: {
        kind: "escalation",
        qid,
        actor,
        question: question.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS),
        ...(context === undefined
          ? {}
          : { context: context.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS) }),
        ...(typeof askedAt === "number" && Number.isFinite(askedAt) ? { askedAt } : {}),
      },
    },
    // taskId lets the notification inherit the run's branchGeneration (fencing late notifications); the fallback is a snapshot query.
    taskId: payload.runId,
    text: formatWorkflowEscalationNotification({
      runLabel,
      runId: payload.runId,
      qid,
      actor,
      question,
      ...(context === undefined ? {} : { context }),
    }),
    traceContext,
  });
}

/** Length limit for question / context in the manifest payload (shared schema: ≤4000 characters). */
const WORKFLOW_ESCALATION_TEXT_MAX_CHARS = 4_000;

/** `{siteId, ordinal}` → `site@ordinal` (the engine's `refToString` format); say "unknown actor" if it cannot be read. */
function actorRefLabel(payload: Record<string, unknown>): string {
  const actor = payload.actor;
  if (typeof actor === "string") return actor;
  if (typeof actor !== "object" || actor === null) return "unknown actor";
  const siteId = stringField(actor as Record<string, unknown>, "siteId");
  const ordinal = (actor as Record<string, unknown>).ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return "unknown actor";
  return `${siteId}@${ordinal}`;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
