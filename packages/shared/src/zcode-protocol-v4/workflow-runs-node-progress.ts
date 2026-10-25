// ============================================================
// **Task and progress data** for one ask: instructionsHead from node-queued and three counters from node-progress
// ============================================================
// Kept outside the main reducer for the same reason as workflow-runs-phases.ts: the main file's max-lines limit.
//
// These fields answer questions phase alone cannot: an ask may remain `executing` for ten minutes, and phase cannot distinguish
// long-running work from a stalled task. `turn` / `toolCalls` / `lastTool` provide that signal;
// `instructionsHead` says what the subagent was asked to do.
//
// Two structural facts are easy to miss:
//   1. The reducer **rebuilds the entire node object** for each `node-*` event (only kind / actor ref / phaseName carry forward from
//      previousNode). These four fields must therefore be carried explicitly, or the next lifecycle event after `node-progress`
//      will erase the values just recorded.
//   2. An ask has two **birth** events: `node-queued` and `node-settled { cached: true }` emitted directly on a replay hit
//      (that node has no queued event; this is its birth, following the same phaseName precedent in the main file). Requeueing the same site instance on resume
//      creates a new ask and starts the turn count at 1; a cache-hit settlement did not execute at all. Therefore **birth events clear** the three counters from the prior run
//      rather than carrying them forward. Inheriting them would make a node with no work this run display “turn 9, 40 tool calls,” the false reading these fields prevent.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunNodeLastTool,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** Task and progress data for one ask: the four fields handled by this module. */
type NodeProgressFields = Pick<
  WorkflowRunNode,
  "instructionsHead" | "turn" | "toolCalls" | "lastTool"
>;

/**
 * Values for these four fields on lifecycle events (`node-queued` … `node-settled`).
 *
 * Carry the three counters forward (written by {@link reduceNodeProgress}), and **clear them on either birth event** — see item 2 in the file header.
 * `instructionsHead` arrives only in the `node-queued` payload (instructions are still the author's original text at that point;
 * the driver appends the engine suffix later); carry it forward on other events.
 *
 * The task summary and three counters are **intentionally handled differently** on a cache-hit settlement: the completed cache is keyed by input hash,
 * so the ask's instructions are identical to the prior run and carrying the summary still describes the same task. The counters describe execution that
 * **did not happen this run**. On requeue, use the new payload for the summary too, because the instructions may have changed.
 */
export function carryNodeProgress(
  eventType: string,
  payload: Record<string, unknown>,
  previousNode: WorkflowRunNode | undefined,
): Partial<NodeProgressFields> {
  const requeued = eventType === "node-queued";
  const born = requeued || (eventType === "node-settled" && payload.cached === true);
  const carried = born ? undefined : previousNode;
  const head = boundedText(
    payload.instructionsHead,
    WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength,
  );
  const instructionsHead = requeued ? head : (head ?? previousNode?.instructionsHead);
  return {
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(carried?.turn === undefined ? {} : { turn: carried.turn }),
    ...(carried?.toolCalls === undefined ? {} : { toolCalls: carried.toolCalls }),
    ...(carried?.lastTool === undefined ? {} : { lastTool: carried.lastTool }),
  };
}

/**
 * Reduce `node-progress`: apply the resolved turn data to the node **already in the table**.
 *
 * **Change only these three fields** — do not change phase, step counts, or actor state. Resolving a turn is not a lifecycle transition;
 * phase remains governed by `node-executing` / `node-waiting` events. Ignore events for instances missing from the table (rejected at the limit
 * or progress arriving before `node-queued`) without creating an entry, matching other node events for unknown instances.
 *
 * **Preserve known values** for individual fields that cannot be read; an event reporting only toolCalls must not erase the turn count.
 * Writes use **last writer wins**, not max (unlike `phases[].rounds`); see item 2 in the file header.
 */
export function reduceNodeProgress(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  payload: Record<string, unknown>,
): WorkflowRunState {
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  const turn = readPositiveInt(payload.turn) ?? node.turn;
  const toolCalls = readNonNegativeInt(payload.toolCalls) ?? node.toolCalls;
  const lastTool = readLastTool(payload.lastTool) ?? node.lastTool;
  const nodes = [...run.nodes];
  nodes[index] = {
    ...node,
    ...(turn === undefined ? {} : { turn }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
  return { ...run, nodes };
}

/** Turns are positive integers starting at 1; there is no turn 0. Treat 0, fractions, and NaN as unreadable. */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Tool call count may be 0: “no tools called” is a value, not an absent field. */
function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The tool name is what makes this record useful; if unreadable, omit the whole record (a lastTool containing only target says nothing). */
function readLastTool(value: unknown): WorkflowRunNodeLastTool | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = boundedText(record.name, WORKFLOW_RUNS_LIMITS.maxLastToolNameLength);
  if (name === undefined) return undefined;
  const target = boundedText(record.target, WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength);
  return { name, ...(target === undefined ? {} : { target }) };
}

/**
 * Truncate to protocol limits and treat an empty string as absent.
 *
 * The producer already truncates these values (`INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS` in the engine).
 * This is a second guard, for the same reason as `boundedActorName` / `boundedPhaseName`: an overlong string would cause the renderer to reject every
 * subsequent frame for the parent session. **Truncate directly without an ellipsis**; this summary is already a head, and continuation markers belong to rendering. The protocol only guarantees valid lengths.
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, limit);
  return text.length > 0 ? text : undefined;
}
