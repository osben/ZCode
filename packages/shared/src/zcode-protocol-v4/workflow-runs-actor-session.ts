// ============================================================
// The actor's `sessionId`: the session holding this subagent's transcript (one rule of the workflowRuns reduction)
// ============================================================
// Lives outside the main reduction file for the same reason as workflow-runs-actor-status.ts
// (the main file's max-lines gate), and under the same discipline: pure functions, no clock, no I/O.
//
// Why sessionId moves at all (docs/dynamic-workflow/presentation.md, "Subagent transcripts"):
// `actor-created` carries the session the run service minted for this run, but in an amended run a
// subagent whose answers all come from import hits never created that session — a hit does not
// create sessions, and those exchanges live only in the predecessor's session. The transcript panel
// subscribes by `sessionId`; pointing at a nonexistent session leaves only error + retry. So this
// field must follow "where the transcript is now" instead of sticking to the minted id.

import type { WorkflowRunActor } from "./workflow-runs.js";
import { boundedSessionId } from "./workflow-runs-entries.js";

interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * The actor table entry for the subagent named by a node event, after that event
 * (unchanged actors keep the original reference).
 *
 * Only two ask events say "which session holds this subagent's transcript":
 *   - **Cached-hit settlement**: if the payload carries `sourceSessionId`, the answer was read from
 *     the predecessor's session (an import hit, or a replay of an imported row when an amended run
 *     resumes); without it, the answer was produced in this run and the envelope's `actorSessionId`
 *     (this run's session) is the one;
 *   - **Dispatch**: the subagent starts running live, and this run's session exists by now —
 *     imported prefixes were already seeded into it.
 *
 * The latest entry wins. Asks for the same subagent settle in order, and import divergence is
 * monotonic: import hits come first and point at the predecessor's session; from the first live
 * dispatch on, this run's session holds everything, including the imported prefix. All other
 * events, events without an actor ref (world-read), old payloads where neither id can be read,
 * and subagents not in the table: left untouched.
 */
export function actorsWithTranscriptSession(
  actors: WorkflowRunActor[],
  eventType: string,
  payload: Record<string, unknown>,
  actorRef: ActorRef | null,
  envelopeSessionId: string | undefined,
): WorkflowRunActor[] {
  if (actorRef === null) return actors;
  const sessionId =
    eventType === "node-settled" && payload.cached === true
      ? (boundedSessionId(payload.sourceSessionId) ?? boundedSessionId(envelopeSessionId))
      : eventType === "node-dispatched"
        ? boundedSessionId(envelopeSessionId)
        : undefined;
  if (sessionId === undefined) return actors;
  const index = actors.findIndex(
    (actor) => actor.siteId === actorRef.siteId && actor.ordinal === actorRef.ordinal,
  );
  // Keep the reference when unchanged: key-level deltas first decide "did this change" by
  // reference (workflow-runs-delta.ts).
  if (index < 0 || actors[index]!.sessionId === sessionId) return actors;
  const next = actors.slice();
  next[index] = { ...actors[index]!, sessionId };
  return next;
}
