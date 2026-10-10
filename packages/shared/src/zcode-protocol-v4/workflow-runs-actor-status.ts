// ============================================================
// **Derived** actor tri-state (one rule in workflowRuns reduction).
// ============================================================
// Pure function derived only from node and run status; reads no clock and performs no I/O.
//
// Why this must be derived: outside `actor-created`, the engine's Boundary C **emits no actor lifecycle events**,
// so there are no events to transport for "is this subagent active, waiting, or done?"; derive that from the phases of its nodes and the run's
// terminal status. Re-run this function after every event that changes nodes or run.status.

import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/**
 * Join the key with `\0` instead of a printable character: siteId is a string supplied by the engine, and a separator such as `-` would make
 * ("a-1", 2) collide with ("a", "1-2"). (The source uses the escaped `\0` rather than a raw NUL byte — the runtime string is the same,
 * but grep no longer treats the file as binary.)
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

/**
 * Three-state derivation:
 *   running   at least one node is executing / repairing / nudged (a model request has been sent and is running)
 *   waiting   a live node exists (queued / dispatched / waiting), or there are no nodes yet and the run is non-terminal
 *   completed otherwise: all nodes have settled or the run is terminal (terminal state takes precedence; nobody in a terminal run
 *             is still running or waiting, even if a node's settled event has not arrived yet)
 * `dispatched` maps to waiting rather than running: it is the brief phase where the session is ready but the first request has not
 * been admitted yet. `node-executing` marks actual execution.
 *
 * Keep actors whose state has not changed **referentially stable**. Key-level deltas first check by reference whether an entry changed;
 * creating a new object every time would cause each node event to resend the entire actors table.
 */
export function withDerivedWorkflowActorStatuses(run: WorkflowRunState): WorkflowRunState {
  const executing = new Set<string>();
  const live = new Set<string>();
  const owned = new Set<string>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    owned.add(key);
    switch (node.phase) {
      case "executing":
      case "repairing":
      case "nudged":
        executing.add(key);
        break;
      case "queued":
      case "dispatched":
      case "waiting":
        live.add(key);
        break;
      default:
        break;
    }
  }
  const runLive = run.status === "pending" || run.status === "running";
  return {
    ...run,
    actors: run.actors.map((actor) => {
      const key = actorKey(actor.siteId, actor.ordinal);
      const status: WorkflowRunActor["status"] = !runLive
        ? "completed"
        : executing.has(key)
          ? "running"
          : live.has(key) || !owned.has(key)
            ? "waiting"
            : "completed";
      return actor.status === status ? actor : { ...actor, status };
    }),
  };
}
