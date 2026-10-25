import type { ZCodeTimelineMeta } from "@zcode/shared";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";

const RUNNING_CONTEXT_COMPACTION_STATUSES = new Set(["started", "retrying"]);
const RUNNING_GOAL_VERIFICATION_STATUSES = new Set(["started"]);

export function isRunningGoalVerificationTimeline(
  timeline: ZCodeTimelineMeta | undefined,
): boolean {
  return (
    timeline?.type === "goal_verification" &&
    RUNNING_GOAL_VERIFICATION_STATUSES.has(timeline.status) &&
    // Fix reason: CI/snapshot restore can produce an inconsistent banner whose status is still
    // started while verification already carries passed/reason. The verification result is the
    // authoritative signal that the verifier has finished; the session must not stay judged
    // running, or a new `/goal` under a completed goal would be wrongly queued.
    timeline.verification === undefined
  );
}

export function isRunningZCodeTimeline(timeline: ZCodeTimelineMeta | undefined): boolean {
  if (!timeline) {
    return false;
  }
  if (timeline.type === "context_compaction") {
    return RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status);
  }
  if (timeline.type === "goal_verification") {
    return isRunningGoalVerificationTimeline(timeline);
  }
  return false;
}

export function hasRunningZCodeTimeline(messages: readonly TaskChatMessage[]): boolean {
  return messages.some((message) => isRunningZCodeTimeline(message.syntheticTimeline));
}

export function hasRunningContextCompactionTimeline(messages: readonly TaskChatMessage[]): boolean {
  return messages.some((message) => {
    const timeline = message.syntheticTimeline;
    return (
      timeline?.type === "context_compaction" &&
      RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status)
    );
  });
}

export function hasRunningGoalVerificationTimeline(messages: readonly TaskChatMessage[]): boolean {
  return messages.some((message) => isRunningGoalVerificationTimeline(message.syntheticTimeline));
}

export function hasRunningGoalContinuationMessage(messages: readonly TaskChatMessage[]): boolean {
  // Bugfix: the model-only input of a goal's normal continuation produces no visible user bubble
  // and does not advance goalIteration; the UI only keeps a streaming assistant with a
  // streamGroupId. The queue's "send now" interception must recognize this running state, or a
  // briefly missing target's meta would wrongly allow preempting the active goal.
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.streaming === true &&
      !message.syntheticTimeline &&
      !message.uiTimeline &&
      typeof message.streamGroupId === "string" &&
      message.streamGroupId.length > 0,
  );
}

export function hasRunningGoalRuntimeSignal(messages: readonly TaskChatMessage[]): boolean {
  return (
    hasRunningGoalVerificationTimeline(messages) || hasRunningGoalContinuationMessage(messages)
  );
}
