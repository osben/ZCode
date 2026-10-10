/**
 * Single decision function for Review monotonicity.
 *
 * Background: the rule that `reviewFlowId/generation is monotonic only within a single Runtime controller` was independently reimplemented
 * in product projection (event replay), prompt-turn observer (live monitor), and renderer review store (binding display), and had already diverged mechanically. Relying on identical comments for synchronization is fragile.
 * This module centralizes the "decision" as a pure function; the "application policy" (drop/defer/accept a new flow) remains with each
 * consumer. New mirrored consumers must use this function rather than writing their own comparisons.
 */

/** Review triple identity: compare only these three fields; other payload fields do not affect monotonicity. */
export interface WorkspaceHookReviewIdentity {
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

/**
 * - no_current: no current authority; candidate takes over;
 * - same_flow_advance: higher generation in the same flow; accept (supersede);
 * - same_flow_replay: same flow, generation, and interactionId; idempotent replay, ignore;
 * - same_flow_conflict: same flow and generation but different interactionId; violates controller
 *   monotonicity, so ignore;
 * - same_flow_stale: lower generation in the same flow; late event, ignore;
 * - cross_flow: different flow (Runtime generation changed); generations across flows are incomparable, so the caller decides based on its own
 *   epoch evidence (projection drops / prompt-turn defers / store accepts the new authority).
 */
export type WorkspaceHookReviewMonotonicityVerdict =
  | "no_current"
  | "same_flow_advance"
  | "same_flow_replay"
  | "same_flow_conflict"
  | "same_flow_stale"
  | "cross_flow";

export function verdictWorkspaceHookReviewRequest(
  current: WorkspaceHookReviewIdentity | undefined,
  candidate: WorkspaceHookReviewIdentity,
): WorkspaceHookReviewMonotonicityVerdict {
  if (!current) return "no_current";
  if (candidate.reviewFlowId !== current.reviewFlowId) return "cross_flow";
  if (candidate.generation > current.generation) return "same_flow_advance";
  if (candidate.generation < current.generation) return "same_flow_stale";
  return candidate.interactionId === current.interactionId
    ? "same_flow_replay"
    : "same_flow_conflict";
}
