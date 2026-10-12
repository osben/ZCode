import type { ZCodeContextCompactionTimelineMeta } from "@zcode/shared";

const RUNNING_CONTEXT_COMPACTION_STATUSES = new Set(["started", "retrying"]);

export function isRunningContextCompactionTimeline(
  timeline: ZCodeContextCompactionTimelineMeta,
): boolean {
  return RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status);
}

export function shouldContextCompactionTimelineCompleteTask(
  timeline: ZCodeContextCompactionTimelineMeta,
): boolean {
  if (isRunningContextCompactionTimeline(timeline)) {
    return false;
  }

  if (timeline.phase === "standalone_turn") {
    return true;
  }

  // Fix reason: the local `/compact` failure fallback event may arrive before the agent backfills
  // the phase. Such a manual command is its own standalone turn, so its terminal state should
  // still settle the task.
  return timeline.trigger === "manual" && timeline.phase === undefined;
}
