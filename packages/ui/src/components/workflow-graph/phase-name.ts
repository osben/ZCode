import { IMPLICIT_PHASE_ID, UNPHASED_PHASE_ID } from "./types.js";
import type { LaneNameFormatter } from "./lane-name.js";

/**
 * The single policy point for phase display names, matching lane-name.ts rule for rule (one policy per concern):
 * author's original wording > localized fallback.
 *
 * Apply the fallback at render time: the projection is a memoized pure function, independent of language, and copy baked into it
 * would become stale if the user switched languages. `unphased` is the only phase without a `name`: it is not authored text but
 * represents the steps before the first marker, so its name is always localized.
 */

/** All inputs needed to form a phase display name, excluding identity information beyond id. */
export interface PhaseNaming {
  id: string;
  /** Name supplied by `phase("preflight")` in the script; absent for `unphased`. */
  name?: string;
}

export function phaseDisplayName(phase: PhaseNaming, formatMessage: LaneNameFormatter): string {
  if (phase.name !== undefined) return phase.name;
  if (phase.id === UNPHASED_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.unphased" });
  }
  // The implicit sole module for an unmarked script (participant-model.ts): the entire script is one phase.
  if (phase.id === IMPLICIT_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
  }
  // This should be unreachable: phases other than `unphased` have authored names. If it occurs, show the ID (identity), not "Ungrouped"—
  // calling a named phase a fallback phase would be false; exposing its ID at least makes the issue diagnosable.
  return phase.id;
}

/**
 * Display phase names are truncated to this many characters by `boundGraphText` (the contracts limit
 * `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS`); runtime names (entry records and instance birth stamps) retain the full
 * name (the reducer truncates them to the same limit itself).
 */
export const DISPLAY_PHASE_NAME_BOUND = 128;

/**
 * Exact match is the only default rule for associating display phase names with runtime phase names.
 * Use prefix matching only when the display name **exactly reaches the limit**—otherwise "Plan" could incorrectly match "Plan Fix".
 * Shared by timeline entry records, `currentPhase`, and instance binding.
 *
 * If either side is absent, return false: association requires two names, and "unnamed" is not a matchable name.
 * Pairing an unnamed display phase (`unphased` / implicit `workflow`) with an unstamped instance is a separate rule handled explicitly by `phasesOf`.
 */
export function phaseNameMatches(
  displayName: string | undefined,
  runtimeName: string | undefined,
): boolean {
  if (displayName === undefined || runtimeName === undefined) return false;
  if (displayName === runtimeName) return true;
  return displayName.length >= DISPLAY_PHASE_NAME_BOUND && runtimeName.startsWith(displayName);
}
