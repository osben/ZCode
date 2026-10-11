// ============================================================
// Two pure rules for the publisher's `workflowRun.*` key-level deltas: encoding for old consumers and the fast path's growth bound.
// ============================================================
// Keeping these outside the publisher matters as much as their being pure functions: both rules
// need independent tests, while the publisher is a runtime shell with a subscription registry and
// retained log. Testing them there would require building half a transport layer first.
//
// ── 1. Encoding for old consumers ──
// The retained log always stores native ops (one fact, one log); encoding is per subscriber. A
// connection that advertises `workflowRunDeltas` during the handshake receives deltas directly.
// Older clients do not recognize this op's discriminator: `conversationDeltaSchema` is a
// discriminatedUnion, so an unknown `op` makes the whole union parse fail and the assembler drops the
// entire logical frame. The resent snapshot also lacks this op, leaving that subscription silent
// forever. This is therefore the boundary between older clients being able to see a run or not, not an optimization.
//
// There is one rewrite rule: drop all `workflowRun.*` ops in the batch and insert one
// `state.updated{workflowRuns: current projection}` at the position of the **last** dropped op. Why
// the last position rather than the first? The whole-key replacement includes the effects of every
// delta in the batch; placing it at the last one's position preserves its ordering relative to other
// ops as if they had been delivered individually (row ops and state keys are independent and commute).
// Why use the **current** projection rather than a historical intermediate state? During replay, the
// logged delta is no longer the latest fact, and the client needs the final state. Skipping
// intermediate states here is the same thing coalescing does routinely.
//
// `clampWorkflowRunsForLegacy` handles limiting to the old boundary (256); see its file header for the rationale.

import type { ConversationDelta, WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { clampWorkflowRunsForLegacy, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";

function isWorkflowRunDelta(delta: ConversationDelta): boolean {
  return delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed";
}

/**
 * Encode a delta batch for old consumers. If the batch has no `workflowRun.*`, return the same array
 * unchanged (this path runs for every subscriber on every ingest, so unrelated batches should not allocate an array).
 *
 * If `workflowRuns` is absent, drop without inserting a replacement: the projection has no key to replace.
 * The producer should never reach this case (a delta implies state); this prevents emitting `{workflowRuns: undefined}`.
 */
export function encodeConversationDeltasForLegacy(
  deltas: readonly ConversationDelta[],
  workflowRuns: WorkflowRunsState | undefined,
): readonly ConversationDelta[] {
  let lastIndex = -1;
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    if (isWorkflowRunDelta(deltas[index]!)) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return deltas;

  const replacement: ConversationDelta | null =
    workflowRuns === undefined
      ? null
      : { op: "state.updated", patch: { workflowRuns: clampWorkflowRunsForLegacy(workflowRuns) } };
  const encoded: ConversationDelta[] = [];
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]!;
    if (!isWorkflowRunDelta(delta)) {
      encoded.push(delta);
      continue;
    }
    if (index === lastIndex && replacement !== null) encoded.push(replacement);
  }
  return encoded;
}

// ── 2. Growth bound for the ingest fast path ──
//
// Today every DWF engine event takes the exact path: clone the projection and JSON.stringify the
// entire wire snapshot to check the 16 MiB gate. A run can emit thousands of events, making this a
// megabytes-scale repeated cost; whole-key retransmission is the other half of the same cost. Key-level
// deltas provide a cheap but **reliable** upper bound on how much this step grew, so most events need not measure the whole snapshot.

/** Headroom for the JSON wrapper (`{"kind":"deltas","deltas":[…]}` and frame envelope), matching the streaming append fast path. */
const WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES = 64;

/**
 * Byte upper bound for snapshot growth when a delta batch contains **only** key-level deltas; return null
 * if it contains any other op (an exact measurement is required).
 *
 * Why the bound holds: all content written to the snapshot by `workflowRun.updated` is in that op's
 * payload (the header key is replaced as a whole and an entry is upserted as a whole), so the snapshot
 * can grow by at most the op's size. `workflowRun.removed` can only shrink the snapshot.
 *
 * An **empty batch** also satisfies this criterion (there is no non-key-level delta), and its growth
 * argument is even stronger: an event that emits no delta changes only the `seq` number in the
 * snapshot, well within the headroom. This is not a special case; it follows directly from the
 * criterion and lets replay events whose reduction is idempotent and emits no deltas avoid serializing the whole snapshot.
 *
 * The null case is also part of the contract: when diff cannot recognize a structural change, it falls
 * back to a whole-key `state.updated`. That op's byte size is **not** an upper bound on growth (it
 * replaces the entire key, whose old bytes are not included), so use the exact path. The criterion is
 * therefore "every delta is key-level", not "there is a key-level delta".
 *
 * Headroom is allocated **per batch**, not per delta: it covers both the JSON wrapper and growth in the decimal width of `seq`.
 */
export function workflowRunDeltaGrowthUpperBound(
  deltas: readonly ConversationDelta[],
): number | null {
  for (const delta of deltas) {
    if (delta.op !== "workflowRun.updated" && delta.op !== "workflowRun.removed") return null;
  }
  return utf8JsonByteLength(deltas) + WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES;
}
