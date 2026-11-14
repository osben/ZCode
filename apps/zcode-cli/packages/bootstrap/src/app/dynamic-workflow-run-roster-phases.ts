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
import type { NodeRecord } from "@zcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { instanceKey, type RosterEventIndex } from "./dynamic-workflow-run-roster-events.js";
import { NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

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
  /** 节点行。停止事件把归约状态里的节点都结算了，终态上「没做完」只有行还记得。 */
  rows: readonly NodeRecord[];
}): DynamicWorkflowRunPhaseView[] | undefined {
  const { run, index, terminal, rows } = input;
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
  // 这里曾只看归约状态：花名册说子代理 unfinished、`nodes_running=1`，它所在的阶段却写 done。
  const leftoverRows = new Set(
    terminal
      ? rows
          .filter((row) => row.status === NODE_ROW_RUNNING)
          .map((row) => instanceKey(row.siteId, row.ordinal))
      : [],
  );
  const isOpen = (node: WorkflowRunNode) =>
    node.phase !== "settled" || leftoverRows.has(instanceKey(node.siteId, node.ordinal));
  return names.map((name) => {
    const rounds = entered.find((phase) => phase.name === name)?.rounds ?? 0;
    const owned = nodes.filter((node) => node.phaseName === name);
    const running = owned.filter(isOpen).length;
    const settled = owned.length - running;
    const trace = index.phases.get(name);
    return {
      name,
      state: phaseStateOf({
        rounds,
        terminal,
        open: owned.filter(isOpen),
        isCurrent: run?.currentPhase === name,
      }),
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
  /** 这个阶段里还没结算的节点。 */
  open: readonly WorkflowRunNode[];
  isCurrent: boolean;
}): DynamicWorkflowRunPhaseView["state"] {
  const { rounds, terminal, open, isCurrent } = input;
  if (rounds === 0) return "ahead";
  if (terminal) {
    return open.some((node) => node.kind !== WORLD_NODE_KIND) ? "unfinished" : "done";
  }
  return isCurrent ? "current" : "done";
}
