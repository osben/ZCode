import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/**
 * Join tool cards to DWF runs.
 *
 * The authoritative source is each run's `toolCallId` in the `workflowRuns` projection (the schema comment calls it
 * the “tool card → details page join key”). In v4, the tool row's own output contains only
 * the prose selected by `formatCreateWorkflowModelContent`; structured fields such as `status` and `backgroundTaskId`
 * are not on the row at all.
 *
 * Keep this as a pure function instead of a component `useMemo`: count semantics (settled vs observed) are the only
 * rule here that warrants exhaustive cases, and a Map can be exhaustively checked without rendering anything.
 */
export function buildWorkflowRunByToolCallId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byToolCallId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    // A run without a toolCallId has no clickable card, so omit it from the table.
    if (!run.toolCallId) continue;
    const { settled, total } = workflowRunStepCounts(run);
    byToolCallId.set(run.toolCallId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      // Count scheduled (observed) nodes, not the eventual total: scripts determine dynamic workflow size at runtime.
      nodesTotal: total,
      agents: run.actors.length,
      // Include the full live projection: the card's inline timeline needs its lights, pills, and ink.
      run,
      // Resumability is a state flag (the CLI decides it using the resume gate in the run-settled payload, and the reducer carries it); the UI does not infer it.
      ...(run.resumable === true ? { resumable: true as const } : {}),
    });
  }
  return byToolCallId;
}

/**
 * Build a runId-keyed join table for compact clickable run cards.
 *
 * A ResumeWorkflowRun tool row can **never** find a run by toolCallId: in the projection, `run.toolCallId` continues
 * to refer to the original CreateWorkflow row across resume (“keep the details-page join intact” is intentional; do not change it).
 * The resume row's display payload carries runId (≡ backgroundTaskId ≡ workId), so joining the same projection by runId works.
 * The sidebar run tab is also keyed by runId, so opening it from either the resume row or original create row reaches the same tab.
 */
export function buildWorkflowRunByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byRunId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    const { settled, total } = workflowRunStepCounts(run);
    byRunId.set(run.runId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      nodesTotal: total,
      agents: run.actors.length,
      run,
      ...(run.resumable === true ? { resumable: true as const } : {}),
      // Join key for the open request: WorkflowRunSidePane uses it to find the originating CreateWorkflow row (the graph and script
      // are on that row). The resume row's own ID cannot be used because its display has no graph.
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
    });
  }
  return byRunId;
}

/**
 * Which `toolCallId` to put in the request when opening the sidebar run view. It is not “the clicked row,” but the
 * **CreateWorkflow row that started the run**. `WorkflowRunSidePane` searches the row window for it (the causalityGraph and
 * original script are attached to that row's display/arguments; the resume row has no graph, so using its ID would show
 * “this workflow graph is not in visible history”). Prefer the projection's `toolCallId` when present; otherwise
 * fall back to the clicked row's ID, which is already the same for a CreateWorkflow row.
 *
 * This also prevents stale overwrites: `openWorkflowRunSidePane` merges an existing tab with `{...existing, ...nextTab}`;
 * a wrong ID in the request could corrupt an otherwise valid tab.
 */
export function resolveWorkflowRunOpenToolCallId(
  rowToolCallId: string,
  workflowRun: WorkflowRunCardSummary | undefined,
): string {
  return workflowRun?.toolCallId ?? rowToolCallId;
}

/**
 * Map runId to the set of qids currently waiting on that run. This is the sole source for flipping a workflow notification manifest from Waiting to Answered.
 *
 * A present key means the run is in the projection (after cold replay, run-settled has cleared pendingQuestions for terminal runs).
 * Its value is a Set, possibly empty when the last question was answered. A missing key means the run is absent
 * (evicted by the eight-run limit, so the question remains neutral).
 *
 * When pendingQuestions is empty, the key is absent (the existing workflow-runs schema convention); normalize it to an empty Set.
 */
export function buildWorkflowRunPendingQuestionsByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byRunId = new Map<string, ReadonlySet<string>>();
  for (const run of runs ?? []) {
    byRunId.set(run.runId, new Set((run.pendingQuestions ?? []).map((question) => question.qid)));
  }
  return byRunId;
}

/**
 * Find the “launch graph” attached to a row. The graph belongs to the **run** and is found by the run's originating toolCallId,
 * regardless of the row type:
 * - CreateWorkflow tool row: `causalityGraph` on `display.kind === "create_workflow"`;
 * - Direct hub launch without a tool row: graph is in the launch turn's `workflowLaunch` metadata on the turnHeader/userInput row
 *   (same toolCallId and display schema).
 *
 * An empty graph (the script has no ask or files.* calls) does not warrant an empty track; treat it as “no graph,” matching the tool card rule.
 */
function workflowGraphOfRow(
  row: ConversationRow,
): { toolCallId: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind === "toolCall") {
    const display = row.display;
    if (display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: row.toolCallId, graph }
      : undefined;
  }
  if (row.kind === "turnHeader" || row.kind === "userInput") {
    const launch = row.workflowLaunch;
    const display = launch?.display;
    if (launch === undefined || display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: launch.toolCallId, graph }
      : undefined;
  }
  return undefined;
}

/**
 * Build the originating toolCallId → graph join table in one pass over the row window. End-of-turn run cards
 * (from CreateWorkflow rows, ResumeWorkflowRun rows, or direct launch turns) and run details/script transcript side panes all use this table.
 * “Find graph by originating toolCallId” is implemented only here. The row window is bounded, so an old conversation may no longer
 * contain its launch row; that is expected, not an error. In that case there is no graph, the card falls back to a single-line header,
 * and the side pane says “graph unavailable.”
 */
export function buildWorkflowGraphByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowCausalityGraphData> {
  const byToolCallId = new Map<string, WorkflowCausalityGraphData>();
  for (const row of rows ?? []) {
    const found = workflowGraphOfRow(row);
    // The launch turn's turnHeader and userInput each carry the same metadata; use the first one found.
    if (found !== undefined && !byToolCallId.has(found.toolCallId)) {
      byToolCallId.set(found.toolCallId, found.graph);
    }
  }
  return byToolCallId;
}

/** Prefix for the originating toolCallId of a run created by a “configure” revision (the agent generates `settings-<uuid>`). */
const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

/**
 * Find the graph by originating toolCallId, with one graph-borrowing exception:
 * A run created by a “configure” revision (`settings-…`) has no graph in the row window until its settings turn lands—the primary
 * agent may still be in a turn, and the settings turn must wait for it to finish. In that case, borrow the predecessor's graph via
 * `resumedFrom`; its script is identical by construction.
 * Other runs never borrow a graph because a changed script produces a different graph. A predecessor may itself be a “configure” run,
 * so follow the chain with cycle protection.
 */
export function resolveWorkflowRunGraph(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  toolCallId: string,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const visited = new Set<string>();
  let current: string | undefined = toolCallId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const graph = graphs.get(current);
    if (graph !== undefined) return graph;
    if (!current.startsWith(WORKFLOW_SETTINGS_TOOL_CALL_PREFIX)) return undefined;
    const settingsToolCallId: string = current;
    const run: WorkflowRunState | undefined = runs?.find(
      (candidate) => candidate.toolCallId === settingsToolCallId,
    );
    const predecessorId: string | undefined = run?.resumedFrom;
    current =
      predecessorId === undefined
        ? undefined
        : runs?.find((candidate) => candidate.runId === predecessorId)?.toolCallId;
  }
  return undefined;
}
