import type {
  V4ConversationWorkflowRunSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Pure model for the run directory, with the journal as its single source of truth.
 *
 * The "Ended · N" row in the task-list footer and the rows on the directory page **must use the same filtering and bucketing**.
 * If implemented separately, the footer might show 5 items while the opened directory contains only 4.
 * Therefore this module exports only two entry points, and the count is defined to equal the ended-list length (see `countEndedWorkflowRuns` at the end).
 */

/**
 * Number of rows fetched for one directory query.
 *
 * **Both callers must use the same value**: the directory page and task-list count each own a hook instance, and different depths mean
 * different results (the CLI default is 16 and the maximum is 64; see `DEFAULT_LIST_RUNS_LIMIT` in `dynamic-workflow-run-service.ts`).
 * Use the maximum rather than the default: this page is the full history users can see, and reading 64 journal summaries is bounded and inexpensive.
 */
export const WORKFLOW_RUN_DIRECTORY_LIMIT = 64;

/**
 * A row in the directory. It is the discovery-query summary with `toolCallId` tightened to required. **Filtering happens when building the table**,
 * so downstream consumers (page and count) never receive a row that cannot open a detail page and do not need to check it again.
 */
export type WorkflowRunDirectoryRow = V4ConversationWorkflowRunSummary & { toolCallId: string };

interface WorkflowRunDirectory {
  /** `pending` / `running`: still in progress. */
  running: WorkflowRunDirectoryRow[];
  /** `completed` / `errored` / `stopped`: one bucket; the status word on each row explains the outcome. */
  ended: WorkflowRunDirectoryRow[];
  /**
   * Whether this page is full (more may follow). Check the **number of rows returned by the query**, not the filtered row count:
   * if a page contains only old runs missing `toolCallId`, the screen may show zero rows, but claiming "that's all" would be false.
   */
  truncated: boolean;
}

/**
 * A run without `toolCallId` cannot open its detail page (`workflow-run` tab needs it to find the row with the static graph in the parent conversation projection).
 * These rows are removed entirely rather than shown disabled. The tradeoff is that older runs created before `tool_call_id` was persisted
 * are unreachable in the GUI.
 */
function hasDetailAnchor(
  summary: V4ConversationWorkflowRunSummary,
): summary is WorkflowRunDirectoryRow {
  return summary.toolCallId !== undefined;
}

function isEnded(summary: V4ConversationWorkflowRunSummary): boolean {
  return summary.status !== "pending" && summary.status !== "running";
}

/**
 * Missing summaries (not queried yet / capability unavailable) produce the same empty directory as zero results. Callers use the hook's `null` vs `[]`
 * to distinguish those cases; the model does not, it only groups rows.
 *
 * **Do not sort**: query order is display order, with most recently updated first (sorting happens in CLI storage). Reordering here would compete
 * with the storage layer's decision; if the two disagree, rows jump around on every refetch.
 */
export function buildWorkflowRunDirectory(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): WorkflowRunDirectory {
  const rows = (summaries ?? []).filter(hasDetailAnchor);
  return {
    running: rows.filter((row) => !isEnded(row)),
    ended: rows.filter(isEnded),
    truncated: (summaries?.length ?? 0) >= WORKFLOW_RUN_DIRECTORY_LIMIT,
  };
}

/**
 * Count for the task-list footer row. Uses the same table-building function, so it **always equals** the number of rows in the directory's ended section.
 * This invariant is the reason this module exists; do not copy it with `summaries.filter(...)` at the call site.
 */
export function countEndedWorkflowRuns(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): number {
  return buildWorkflowRunDirectory(summaries).ended.length;
}

/**
 * Trigger key, derived from the **live projection**, for deciding whether to refetch these journal summaries.
 *
 * Its shape is "run count + settled count" because the directory expresses only two facts: whether a row exists and which section it belongs to.
 * - A new run changes the first value (it must appear under "Running").
 * - A run finishing changes the second (it must move to "Ended").
 * - Node-level progress changes neither.
 *
 * The last case is the key point. Projection `revision` increments on every engine event; using it as a trigger would turn
 * one paginated read into an event-driven stream, without any visible difference for directory readers.
 *
 * **Both interfaces share this derivation** (task-list count and directory page), as with `countEndedWorkflowRuns`:
 * matching criteria are not enough; freshness must match too. The observed failure was "the island updated, but the page it opened did not."
 */
export function workflowRunDirectoryRefreshKey(
  runs: readonly WorkflowRunState[] | null | undefined,
): string {
  const all = runs ?? [];
  const settled = all.filter((run) => run.status !== "pending" && run.status !== "running").length;
  return `${all.length}:${settled}`;
}
