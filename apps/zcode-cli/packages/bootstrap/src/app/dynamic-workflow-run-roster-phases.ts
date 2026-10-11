// ============================================================
// **Phase table** for the run's situation snapshot: declared sites plus visited sites.
// ============================================================
// Names and phases come from the same reduced run state as the run panel
// (`run.phaseNames` / `run.phases` / `run.currentPhase` / `run.nodes`); timestamps come from the
// event index. This division is also described in the header of -roster-events.ts.
//
// Why count nodes from the **reduced state** rather than journal rows? Phase coordinates (`phaseName`)
// exist only in reduced state (the engine stamps them only on creation events, and rows have no such
// column). Joining against rows would drop nodes that reduced state can represent. Reduced state also
// includes queued nodes that have not yet produced rows, which must count toward nodes running in the current phase.

import type { DynamicWorkflowRunPhaseView } from "@zcode/contracts";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { RosterEventIndex } from "./dynamic-workflow-run-roster-events.js";

/** Treat nodes other than world-read / world-run as ask: `kind` appears only on creation events, so absence means unknown. */
const WORLD_NODE_KIND = "world-read";

/**
 * Phase table: declared phases in declaration order, followed by visited-but-undeclared phases in order of first entry.
 *
 * Return undefined when the script declared no phases and none were visited: such a run has no
 * phase table at all. Returning an empty array would instead say that it has an empty phase table.
 */
export function buildPhaseViews(input: {
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
}): DynamicWorkflowRunPhaseView[] | undefined {
  const { run, index, terminal } = input;
  const declared = run?.phaseNames ?? [];
  const entered = run?.phases ?? [];
  if (declared.length === 0 && entered.length === 0) return undefined;

  const names = [...declared];
  const seen = new Set(declared);
  for (const phase of entered) {
    if (seen.has(phase.name)) continue;
    seen.add(phase.name);
    names.push(phase.name);
  }

  const nodes = run?.nodes ?? [];
  return names.map((name) => {
    const rounds = entered.find((phase) => phase.name === name)?.rounds ?? 0;
    const owned = nodes.filter((node) => node.phaseName === name);
    const settled = owned.filter((node) => node.phase === "settled").length;
    const running = owned.length - settled;
    const trace = index.phases.get(name);
    return {
      name,
      state: phaseStateOf({ rounds, terminal, owned, isCurrent: run?.currentPhase === name }),
      rounds,
      nodesSettled: settled,
      nodesRunning: running,
      ...(trace?.enteredAt === undefined ? {} : { enteredAt: trace.enteredAt }),
      ...(trace?.exitedAt === undefined ? {} : { exitedAt: trace.exitedAt }),
    };
  });
}

/**
 * Situation for one phase (see the four states in `DynamicWorkflowRunPhaseState`).
 *
 * `unfinished` applies **only to terminal runs**: while a run is alive, in-flight asks in a non-current
 * phase are normal parallel branches, not abandoned work. `nodesRunning` already reports their count.
 */
function phaseStateOf(input: {
  rounds: number;
  terminal: boolean;
  owned: readonly WorkflowRunNode[];
  isCurrent: boolean;
}): DynamicWorkflowRunPhaseView["state"] {
  const { rounds, terminal, owned, isCurrent } = input;
  if (rounds === 0) return "ahead";
  if (terminal) {
    const leftover = owned.some(
      (node) => node.phase !== "settled" && node.kind !== WORLD_NODE_KIND,
    );
    return leftover ? "unfinished" : "done";
  }
  return isCurrent ? "current" : "done";
}
