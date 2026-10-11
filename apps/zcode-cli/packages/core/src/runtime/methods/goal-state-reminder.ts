import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";

export async function recordGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  input: {
    text: string;
    traceContext?: TraceContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const activeTurn = this.activeTurn;
  if (
    activeTurn?.kind === "regular" &&
    activeTurn.goalStateChangeReminderDeferralOpen
  ) {
    // Stop pauses the goal before aborting the running tool. Writing to history immediately here
    // would put the reminder between tool_use and cancelled tool_result, violating provider grammar on the next request.
    activeTurn.pendingGoalStateChangeReminder = { text: input.text };
    return;
  }
  await materializeGoalStateChangeReminder.call(this, input.text, traceContext);
}

export function openGoalStateChangeReminderDeferral(
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn?.kind === "regular") {
    activeTurn.goalStateChangeReminderDeferralOpen = true;
  }
}

export async function closeGoalStateChangeReminderDeferral(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
  traceContext: TraceContext,
): Promise<void> {
  if (activeTurn?.kind !== "regular") return;

  // activeTurn remains alive until terminal/accounting work is complete, so its existence no longer indicates
  // pending ownership. Close it synchronously first; reminders arriving afterward are materialized directly.
  activeTurn.goalStateChangeReminderDeferralOpen = false;
  const pending = activeTurn.pendingGoalStateChangeReminder;
  if (!pending) return;

  activeTurn.pendingGoalStateChangeReminder = undefined;
  try {
    await materializeGoalStateChangeReminder.call(this, pending.text, traceContext);
  } catch (error) {
    // The authoritative target is already persisted; reminder persistence failure must not prevent the Stop turn from emitting its terminal event.
    // Materialize once without adding retry, cursor, or another persistence state machine to turn finalization.
    this.logger?.warn("Failed to materialize pending goal state reminder", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.reminder.materialize.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

async function materializeGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.ensureContextInitialized(traceContext);
  this.messageHistory.addAttachment("goal_state_change", text);
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: this.sessionId,
    source: "goal_state_change",
    text,
    traceContext,
    visibility: "model-only",
  });
}
