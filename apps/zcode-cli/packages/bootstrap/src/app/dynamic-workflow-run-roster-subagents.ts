// ============================================================
// **Subagent roster** for the situation snapshot: what each subagent is doing now.
// ============================================================
// One subagent = one actor instance. Its
// asks run in `actorSeq` order, so "what it is doing now" means where its ask chain has reached.
//
// Three data sources have separate roles and must not be substituted for one another:
//   - **Actor / node rows** (journal): which actors exist, whether each ask succeeded, and token use. Rows are durable facts,
//     unbounded and unaffected by projection eviction.
//   - **Reduced state**: task summary and progress for the current ask (`instructionsHead` / `turn` / `toolCalls` /
//     `lastTool`), plus node phase coordinates. These exist only in events; rows have no such columns.
//   - **Event index**: all timestamps. See the -roster-events.ts file header.

import type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentState,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord } from "@zcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  instanceKey,
  laterOf,
  type RosterEventIndex,
  type RosterNodeTrace,
} from "./dynamic-workflow-run-roster-events.js";

/** "Not yet settled" status for a node row; also the criterion for `unfinished` / `leftoverRunning`. */
export const NODE_ROW_RUNNING = "running";

/** Ask rows owned by one subagent, sorted by `actorSeq` ascending (legacy rows missing this column sort first, stably). */
function asksOf(
  nodes: readonly NodeRecord[],
  actor: Pick<ActorRecord, "siteId" | "ordinal">,
): NodeRecord[] {
  return nodes
    .filter((node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal)
    .sort((left, right) => (left.actorSeq ?? 0) - (right.actorSeq ?? 0));
}

/**
 * Build the roster in actor-row order (= creation order). **Always return an array**; if there are no actors, return an empty array:
 * "How many subagents does this run have?" always has an answer, and that answer may be 0.
 *
 * `pendingQuestions` being `undefined` means the parking table was unavailable to this read (the run belongs to another process). Then
 * **no subagent is reported as `parked`**, because we cannot distinguish "nobody is waiting" from "unknown".
 */
export function buildSubagentViews(input: {
  actors: readonly ActorRecord[];
  nodes: readonly NodeRecord[];
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunSubagentView[] {
  const { actors, nodes, run, index, terminal, pendingQuestions } = input;
  const reduced = new Map<string, WorkflowRunNode>();
  for (const node of run?.nodes ?? []) reduced.set(instanceKey(node.siteId, node.ordinal), node);

  return actors.map((actor) => {
    const asks = asksOf(nodes, actor);
    const settled = asks.filter((ask) => ask.status !== NODE_ROW_RUNNING);
    // Asks for one subagent are serial, so there should be at most one running row; if there are several, choose the one with the highest actorSeq—
    // it was dispatched most recently.
    const runningAsk = asks.filter((ask) => ask.status === NODE_ROW_RUNNING).at(-1);
    const trace =
      runningAsk === undefined
        ? undefined
        : index.nodes.get(instanceKey(runningAsk.siteId, runningAsk.ordinal));
    const parkedOn = pendingQuestions?.find(
      (question) => question.actor === instanceKey(actor.siteId, actor.ordinal),
    )?.qid;
    const lastAskFailed = settled.at(-1)?.status === "failed";

    return {
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      state: subagentStateOf({
        terminal,
        running: runningAsk !== undefined,
        waiting: trace?.lastLifecycleType === "node-waiting",
        parked: parkedOn !== undefined,
        lastAskFailed,
      }),
      ...phaseNameField({ actor, runningAsk, settled, reduced, run }),
      ...(runningAsk === undefined ? {} : { currentAsk: currentAskOf(runningAsk, reduced, trace) }),
      ...(trace?.wait === undefined ? {} : { wait: trace.wait }),
      ...(parkedOn === undefined ? {} : { parkedOn }),
      stepsSettled: settled.length,
      stepsFailed: settled.filter((ask) => ask.status === "failed").length,
      // Count tokens only from settled asks: the in-flight ask has no stats yet (the driver fills them in on settlement).
      tokens: settled.reduce((total, ask) => total + (ask.stats?.tokens ?? 0), 0),
      ...lastProgressField(asks, index),
    };
  });
}

/**
 * Subagent status. **The check order is the order in this code**, and the first match decides—the order is part of the contract:
 * a subagent parked while waiting for an answer also has a running ask; reporting `executing` would hide the fact that it is blocked.
 */
function subagentStateOf(input: {
  terminal: boolean;
  running: boolean;
  waiting: boolean;
  parked: boolean;
  lastAskFailed: boolean;
}): DynamicWorkflowRunSubagentState {
  const { terminal, running, waiting, parked, lastAskFailed } = input;
  if (terminal) {
    // On a terminal run, all three live statuses are retired: a row still marked running only means the process died while it was active.
    if (running) return "unfinished";
    return lastAskFailed ? "failed" : "done";
  }
  if (parked) return "parked";
  if (running) return waiting ? "waiting" : "executing";
  return lastAskFailed ? "failed" : "idle";
}

/** Current ask snapshot: identity from rows, task and progress from reduced state, timestamps from the event index. */
function currentAskOf(
  ask: NodeRecord,
  reduced: ReadonlyMap<string, WorkflowRunNode>,
  trace: RosterNodeTrace | undefined,
): DynamicWorkflowRunSubagentAsk {
  const node = reduced.get(instanceKey(ask.siteId, ask.ordinal));
  const lastTool = node?.lastTool;
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(node?.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    ...(trace?.dispatchedAt === undefined ? {} : { startedAt: trace.dispatchedAt }),
    ...(node?.turn === undefined ? {} : { turn: node.turn }),
    ...(node?.toolCalls === undefined ? {} : { toolCalls: node.toolCalls }),
    ...(lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: lastTool.name,
            ...(lastTool.target === undefined ? {} : { target: lastTool.target }),
            ...(trace?.lastToolAt === undefined ? {} : { at: trace.lastToolAt }),
          },
        }),
  };
}

/**
 * Phase where its current (or most recent) ask began; if neither ask can be read, fall back to the actor's own initial phase.
 * Phase coordinates exist only in reduced state, so look them up on the reduced node, not in the row.
 */
function phaseNameField(input: {
  actor: Pick<ActorRecord, "siteId" | "ordinal">;
  runningAsk: NodeRecord | undefined;
  settled: readonly NodeRecord[];
  reduced: ReadonlyMap<string, WorkflowRunNode>;
  run: WorkflowRunState | undefined;
}): Pick<DynamicWorkflowRunSubagentView, "phaseName"> {
  const { actor, runningAsk, settled, reduced, run } = input;
  const candidates = [runningAsk, settled.at(-1)];
  for (const ask of candidates) {
    if (ask === undefined) continue;
    const phaseName = reduced.get(instanceKey(ask.siteId, ask.ordinal))?.phaseName;
    if (phaseName !== undefined) return { phaseName };
  }
  const born = run?.actors.find(
    (entry) => entry.siteId === actor.siteId && entry.ordinal === actor.ordinal,
  )?.phaseName;
  return born === undefined ? {} : { phaseName: born };
}

/** Last time it was observed doing work: the latest progress event from any ask it owns. */
function lastProgressField(
  asks: readonly NodeRecord[],
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunSubagentView, "lastProgressAt"> {
  let latest: number | undefined;
  for (const ask of asks) {
    latest = laterOf(latest, index.nodes.get(instanceKey(ask.siteId, ask.ordinal))?.lastActivityAt);
  }
  return latest === undefined ? {} : { lastProgressAt: latest };
}
