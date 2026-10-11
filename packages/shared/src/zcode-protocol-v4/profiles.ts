// Pure function for filtering by delivery profile.
// First step in the channel flush pipeline: filter → coalesce → frame. Recovery replay uses the same
// function (apply the subscriber's profile filter before coalescing) to ensure deterministic redelivery
// after reconnect.
//
// Terminal invariant (covered by golden tests): every event filtered by profile must eventually be
// closed out by an unfilterable event. If row.delta(inputText) is filtered, row.upserted at tool-input
// finalization must carry the complete inputText; otherwise replayable subscribers end without it. Any
// reducer change that breaks this invariant fails the test requiring byte-identical terminal state for
// both profiles.
import type { DeliveryProfile } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow } from "./rows.js";

export function filterConversationRowsForProfile(
  rows: readonly ConversationRow[],
  _profile: DeliveryProfile,
): ConversationRow[] {
  // HookInvocationRow is now a client-safe summary shared by desktop and mobile. There is currently no
  // profile-specific full row; keep the pure-function boundary for future controlled row types.
  return [...rows];
}

/**
 * Filter delta events according to the profile's streamPaths setting.
 * Filter row.delta by streaming capability; structurally complete rows represent the same product facts
 * in both profiles. This is a pure function that does not mutate its input and preserves authoritative
 * log order.
 */
export function filterConversationDeltasForProfile(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
): ConversationDelta[] {
  return deltas.filter((delta) => {
    if (delta.op === "row.delta") return profile.streamPaths[delta.path];
    return true;
  });
}
