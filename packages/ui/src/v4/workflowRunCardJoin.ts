import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow, ConversationRowsPartition } from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES,
  type ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { memoizeByRows } from "@/v4/conversationProjectionStore.js";
import {
  isFillWorkflowHoleToolCall,
  isCreateWorkflowToolCall,
  isAmendWorkflowToolCall,
} from "@/lib/workflowToolNames.js";

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

/**
 * runId → most recent successful fill display (docs/dynamic-workflow/presentation.md, “The model”
 * under “Holes on the timeline”): a `FillWorkflowHole` row outputs `CreateWorkflowOutput`, whose
 * `causalityGraph` is the graph of the **effective script**—the filled hole now occupies its place.
 * The card and side pane use the latest display whose run id matches: after filling, this is the
 * fill row; before filling, it is the launch row. Scan the row window once in order, letting later
 * entries replace earlier ones. Only accept successful, compiled rows (a failed fill never joined
 * the run, so its graph does not belong to it). The name comes from the display's `fill` block
 * (the filled hole has no position in the resulting graph, and the row input has no name—the
 * transcript stores only the model's input). Do not expose the type in the UI.
 */
export interface WorkflowFillGraph {
  graph: WorkflowCausalityGraphData;
  holeLabels: ReadonlyMap<string, { name: string }>;
}

function readFillRow(
  row: ConversationRow,
): { runId: string; holeId: string; name?: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind !== "toolCall" || row.status !== "success") return undefined;
  if (!isFillWorkflowHoleToolCall(row)) return undefined;
  const display = row.display;
  if (display?.kind !== "create_workflow" || display.ok !== true) return undefined;
  const graph = display.causalityGraph;
  if (graph === undefined || graph.steps.length === 0) return undefined;
  const target = readWorkflowHoleTarget(row.input, display.fill);
  if (target?.runId === undefined || target.holeId === undefined) return undefined;
  return {
    runId: target.runId,
    holeId: target.holeId,
    ...(target.name === undefined ? {} : { name: target.name }),
    graph,
  };
}

export function buildWorkflowFillGraphByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowFillGraph> {
  const byRunId = new Map<string, WorkflowFillGraph>();
  for (const row of rows ?? []) {
    const fill = readFillRow(row);
    if (fill === undefined) continue;
    // Names accumulate across fills: the graph for the second fill still contains the first hole, whose name appears only in the first row's input.
    const labels = new Map(byRunId.get(fill.runId)?.holeLabels ?? []);
    if (fill.name !== undefined) labels.set(fill.holeId, { name: fill.name });
    byRunId.set(fill.runId, { graph: fill.graph, holeLabels: labels });
  }
  return byRunId;
}

/** Single entry point for the card and side pane to get a graph: use the fill row's graph after a fill; otherwise use the launch toolCallId (including the “Configure” graph-reuse rule). */
export function resolveWorkflowRunGraphForRun(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  fills: ReadonlyMap<string, WorkflowFillGraph> | undefined,
  toolCallId: string | undefined,
  runId: string | undefined,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const fill = runId === undefined ? undefined : fills?.get(runId);
  if (fill !== undefined) return fill.graph;
  return toolCallId === undefined ? undefined : resolveWorkflowRunGraph(graphs, toolCallId, runs);
}

/** Launch toolCallId prefix for runs retuned through “Configure” (agent-generated `settings-<uuid>`, docs/dynamic-workflow/launch.md). */
export const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

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

/**
 * Transcript of which workflow the model saved this run as (docs/dynamic-workflow/transcript-and-notifications.md,
 * “Which workflow a run is saved as”): successful `SaveWorkflow` rows in the row window are
 * assigned to the run claimed by their input `run_id`.
 *
 * These are **candidates**, not final results: the row only says “the model saved this name at the
 * time.” Whether the file still exists and whether it is the same file is resolved again by the
 * agent-side `workflows/forRun`. So do not read output or infer anything beyond success here;
 * rows without `status === "success"` (compile failures, rejections, or still streaming) were never written to a file.
 *
 * Follow the same rules as other joins: pure function, one pass over the row window, identity comes
 * only from the input channel (display does not contain this information).
 */
export type WorkflowSaveCandidate = ZCodeWorkflowsForRunCandidate;

function readWorkflowSaveCandidate(
  row: ConversationRow,
): { runId: string; candidate: WorkflowSaveCandidate } | undefined {
  if (row.kind !== "toolCall" || row.toolName !== "SaveWorkflow" || row.status !== "success") {
    return undefined;
  }
  const input = row.input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const runId = typeof record.run_id === "string" ? record.run_id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (runId.length === 0 || name.length === 0) return undefined;
  const scope = record.scope === "global" || record.scope === "project" ? record.scope : undefined;
  return { runId, candidate: { name, ...(scope === undefined ? {} : { scope }) } };
}

export function buildWorkflowSaveCandidatesByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, readonly WorkflowSaveCandidate[]> {
  const byRunId = new Map<string, WorkflowSaveCandidate[]>();
  for (const row of rows ?? []) {
    const found = readWorkflowSaveCandidate(row);
    if (found === undefined) continue;
    const list = byRunId.get(found.runId) ?? [];
    // Keep only one candidate for a save under the same name (for example, after metadata changes): resolving once gives the same answer as resolving three times.
    if (list.some((entry) => entry.name === found.candidate.name)) continue;
    // Enforce the protocol candidate limit here; keep the earliest entries if there are too many (the first saved copy is more likely to still exist).
    if (list.length >= ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES) continue;
    list.push(found.candidate);
    byRunId.set(found.runId, list);
  }
  return byRunId;
}

/**
 * Bug root cause: SessionPane calls selectWorkflowJoinRows on every snapshot change (every frame while streaming).
 * Name-based detection ran several regex normalizations per tool row, costing ~1ms per frame on an ~8000-row session
 * and growing with history length. Protocol rows are immutable — a content change always yields a new object — so
 * caching verdicts per row object needs no invalidation; a WeakMap also does not extend row lifetime.
 * After partitioning, the tail is re-filtered every frame; this cache keeps unchanged tail tool rows from repeating the regex normalization.
 */
const workflowJoinToolRowVerdicts = new WeakMap<ConversationRow, boolean>();

function isWorkflowJoinToolRow(row: Extract<ConversationRow, { kind: "toolCall" }>): boolean {
  const cached = workflowJoinToolRowVerdicts.get(row);
  if (cached !== undefined) return cached;
  const verdict =
    row.display?.kind === "create_workflow" ||
    isCreateWorkflowToolCall(row) ||
    isAmendWorkflowToolCall(row) ||
    isFillWorkflowHoleToolCall(row) ||
    row.toolName === "SaveWorkflow";
  workflowJoinToolRowVerdicts.set(row, verdict);
  return verdict;
}

/** Ordinary message frames do not affect the Workflow join; keep relevant raw rows and let callers reuse deps after a shallow compare. */
export function selectWorkflowJoinRows(
  rows: readonly ConversationRow[] | undefined,
): ConversationRow[] {
  return (rows ?? []).filter((row) => {
    if (row.kind === "turnHeader" || row.kind === "userInput")
      return row.workflowLaunch !== undefined;
    return row.kind === "toolCall" && isWorkflowJoinToolRow(row);
  });
}

const workflowJoinRowsByRows = memoizeByRows(selectWorkflowJoinRows);

/**
 * Same result as selectWorkflowJoinRows(history ++ tail); the history segment is cached by reference and only the tail turn is filtered each frame.
 * When the tail turn has no relevant rows, return the history array directly so the caller's shallow compare skips item-by-item comparison.
 */
export function selectWorkflowJoinRowsInPartition(
  partition: ConversationRowsPartition | null,
): ConversationRow[] {
  if (!partition) return [];
  const history = workflowJoinRowsByRows(partition.history);
  const tail = workflowJoinRowsByRows(partition.tail);
  return tail.length === 0 ? history : [...history, ...tail];
}
