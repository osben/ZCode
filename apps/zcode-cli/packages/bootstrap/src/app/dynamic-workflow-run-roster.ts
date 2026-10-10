// ============================================================
// **Situation snapshot** for a Dynamic Workflow Run: phase / subagents / health.
// ============================================================
// `getRunDetail` originally returned only counts and a short log tail; it could not answer the three questions a model actually needs: how far the run has progressed, what each subagent is doing now, and whether it is still active.
// This module derives exactly those three facts—and **only derives** them. It is a pure function with no journal, registry, or clock access:
// the caller passes events, node rows, actor rows, reduced state, parked questions, and `now`.
//
// Keep it pure because the rules for these fields (status precedence, how to interpret absence, and the sole source of time) are dense and easy to get wrong,
// while their data sources (SQLite journal + engine registry) are expensive to use in tests. Separating rules from data access lets unit tests pin behavior
// with hand-built events and rows; one integration test can then prove the wiring works.
//
// Split across files: event scanning is in -roster-events.ts, phase mapping in -roster-phases.ts, and the roster in
// -roster-subagents.ts (each file header documents its data-access rules). This file keeps the public contract, health surface, and orchestration.

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord, StoredEvent } from "@zcode/dynamic-workflow";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import {
  indexRosterEvents,
  instanceKey,
  type RosterEventIndex,
} from "./dynamic-workflow-run-roster-events.js";
import { buildPhaseViews } from "./dynamic-workflow-run-roster-phases.js";
import { buildSubagentViews, NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

/** `kind` for ask node rows. Consecutive failures count only ask settlements: a world-read failure does not mean the subagent keeps failing. */
const ASK_NODE_KIND = "ask";

/** Inputs used to derive a situation snapshot. */
interface WorkflowRunRosterInput {
  /**
   * Reduced state for this run (the same reducer used by the run panel after replaying journal events).
   * Pass `undefined` for a run with no events (a registry gap); the phase map is then absent and the roster is empty.
   */
  run: WorkflowRunState | undefined;
  /** All journal events for this run, sorted by sequence ascending. The **only** source of time. */
  events: readonly StoredEvent[];
  /** `journal.listNodes(runId)`. Supplies only status and `stats`; rows have no time columns. */
  nodes: readonly NodeRecord[];
  /** `journal.listActors(runId)`. The roster's source rows. */
  actors: readonly ActorRecord[];
  /** Run lifecycle state, equal to the value shown in the detail view (whether it is terminal determines half of the status wording). */
  status: DynamicWorkflowRunLifecycleStatus;
  /**
   * Questions currently parked on this run. **`undefined` means the parking table was unavailable to this read** (the run belongs to another process);
   * then `health.pendingQuestionsKnown` is false and no subagent is reported as `parked`.
   * An empty array is different: it definitively means nobody is waiting.
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /** Time of this read, used only to **clamp** event times (see `timeOf` in -roster-events.ts). */
  now: number;
}

/** Situation snapshot; the detail view expands these three keys directly. */
interface WorkflowRunRoster {
  phases?: DynamicWorkflowRunPhaseView[];
  subagents: DynamicWorkflowRunSubagentView[];
  health: DynamicWorkflowRunHealth;
}

/** Derive a situation snapshot from the facts already read by one getRunDetail call. */
export function buildWorkflowRunRoster(input: WorkflowRunRosterInput): WorkflowRunRoster {
  const { run, events, nodes, actors, status, pendingQuestions, now } = input;
  const terminal = TERMINAL_RUN_STATUSES.has(status);
  const index = indexRosterEvents(events, now);
  const phases = buildPhaseViews({ run, index, terminal });
  return {
    ...(phases === undefined ? {} : { phases }),
    subagents: buildSubagentViews({
      actors,
      nodes,
      run,
      index,
      terminal,
      ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
    }),
    health: buildHealth({ run, nodes, index, terminal, pendingQuestions }),
  };
}

/** Whether the run as a whole is still active (see `DynamicWorkflowRunHealth`). */
function buildHealth(input: {
  run: WorkflowRunState | undefined;
  nodes: readonly NodeRecord[];
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunHealth {
  const { run, nodes, index, terminal, pendingQuestions } = input;
  // Count orphaned running rows only for terminal runs: while a run is active, a row marked running means it is working normally.
  const leftoverRunning = terminal
    ? nodes.filter((node) => node.status === NODE_ROW_RUNNING).length
    : 0;
  return {
    ...(index.lastProgressAt === undefined ? {} : { lastProgressAt: index.lastProgressAt }),
    ...(index.stalledSince === undefined ? {} : { stalledSince: index.stalledSince }),
    ...concurrencyField(run, index),
    consecutiveFailures: countTrailingFailures(nodes, index),
    cachedSteps: index.settlements.filter((settlement) => settlement.cached).length,
    ...(leftoverRunning === 0 ? {} : { leftoverRunning }),
    pendingQuestionsKnown: pendingQuestions !== undefined,
  };
}

/**
 * and find the current state.
 *
 * `cap` is **this run's own** limit: the user-specified value, or the machine ceiling if none was set.
 * `effective` is the number the governor currently admits, further bounded by the shared gate.
 *
 * **Present only when `effective < cap`**, following the same absence rule as detail's `maxConcurrency`: a run at its own limit has nothing extra to report.
 * Reporting the machine ceiling as `cap` would be wrong—a run started with `max_concurrency: 3` on a six-core machine would always show "3/6",
 * suggesting throttling even though it is running at the limit the user chose.
 */
function concurrencyField(
  run: WorkflowRunState | undefined,
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunHealth, "concurrency"> {
  const concurrency = run?.concurrency;
  if (concurrency === undefined) return {};
  const cap = concurrency.limit ?? concurrency.ceiling;
  const effective = Math.min(concurrency.cap, cap);
  if (effective >= cap) return {};
  return {
    concurrency: {
      effective,
      cap,
      ...(index.concurrencyReason === undefined ? {} : { reason: index.concurrencyReason }),
      ...(index.concurrencySince === undefined ? {} : { since: index.concurrencySince }),
    },
  };
}

/**
 * Number of **consecutive trailing** failed asks in settlement order: three failures in a row differs from three scattered failures,
 * because the former suggests the next ask will likely fail too. Count asks only—a world-read failure is a script issue, not a subagent failure.
 * `cancelled`, like success, breaks the consecutive-failure run: cancellation is not failure.
 */
function countTrailingFailures(nodes: readonly NodeRecord[], index: RosterEventIndex): number {
  const askKeys = new Set(
    nodes
      .filter((node) => node.kind === ASK_NODE_KIND)
      .map((node) => instanceKey(node.siteId, node.ordinal)),
  );
  let failures = 0;
  for (let position = index.settlements.length - 1; position >= 0; position -= 1) {
    const settlement = index.settlements[position]!;
    if (!askKeys.has(settlement.key)) continue;
    if (settlement.outcome !== "failed") break;
    failures += 1;
  }
  return failures;
}
