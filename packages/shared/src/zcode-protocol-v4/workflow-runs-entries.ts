// Read birth facts and create actor entries within protocol capacity limits.
// Pure function; does not read the clock or perform I/O.
//
// Names and phase names are script-generated and may exceed protocol length limits. The renderer
// strictly validates every frame, so oversized values could reject both deltas and recovery snapshots.
// Producers truncate to schema limits while retaining the full values in the journal.

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * Create one actor entry. Both call sites must be **identical**: `actor-created` and the `node-dispatched`
 * activation with birth facts in workflow-runs-eviction.ts. The same subagent can arrive through either
 * path; different entries would not match during cold replay.
 *
 * `status` is a placeholder; the following `withDerivedWorkflowActorStatuses` recalculates it from node
 * and run terminal states.
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    status: "waiting",
  };
}

/** Wire limit for subagent display names (see the subscription failure described at the file top). */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * Wire limit for an instance's birth phase name. It follows {@link boundedActorName} for the same
 * reason, but **truncates directly without an ellipsis**: this is a correlation key, not user-facing
 * text, and the UI's `phaseNameMatches` matches the truncated name to a display phase by prefix.
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/** Treat an empty string as absent; on the wire, the protocol has only two states: key present or key absent. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
