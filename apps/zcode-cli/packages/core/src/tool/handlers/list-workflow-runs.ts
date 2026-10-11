// ============================================================
// ListWorkflowRuns Tool Handler
// ============================================================
// List workflow runs by project (the session working directory), including cross-session history.
//
// Keep the handler **very thin**: the run service supplies ready-to-use labels, ownership, status, and timestamps (the port's
// `DynamicWorkflowRunListItem` comment explains why raw data does not cross the boundary). This handler only gets the port, fixes cwd
// to this session's working directory, and projects results to the contract shape.

import {
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsInputJsonSchema,
  ListWorkflowRunsInputSchema,
  ListWorkflowRunsOutputJsonSchema,
  ListWorkflowRunsOutputSchema,
  type ListWorkflowRunsInput,
  type ListWorkflowRunsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  formatWorkflowRunTimestamp,
  workflowIntrospectionUnavailableFailure,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

const LIST_WORKFLOW_RUNS_TIMEOUT_MS = 10_000;
/** As with CreateWorkflow, keep the list lightweight (answerable by one SQL row); 24k leaves room beyond 50 entries. */
const LIST_WORKFLOW_RUNS_MODEL_BYTES = 24_000;

const LIST_WORKFLOW_RUNS_DESCRIPTION = [
  "Lists this project's dynamic-workflow runs (the session's working directory is the project key), most recently updated first. Includes runs started by other sessions — the run journal is per-project, not per-session.",
  "",
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  "",
  "- Each row gives the run ID, its label, lifecycle status, whether this session started it, tokens spent, and timestamps.",
  '- `possibly_interrupted="true"` means this session cannot confirm the run is still alive: it may be a leftover from a process that exited, or a sibling session\'s run still in flight. It is an annotation, not a verdict — do not report it as a failure.',
  "- Pass a run ID to GetWorkflowRun for progress detail, the log tail, the final result, or the failure.",
  "- Three terminal states: `completed`; `errored` (the script itself failed); `stopped` with `stop_reason` — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error stopped it: read GetWorkflowRun for the cause, resolve it with the user, then resume), `interrupted` (the owning process exited: continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `superseded_by` names the live successor — never resume a superseded run).",
  "- Any stopped run other than a superseded one can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script. An errored run cannot.",
  "- ANY run here — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script; the new run imports the old one's finished work as a warm cache (and stops it first if it is still running). A run whose script errored is the case to reach for it — fix the script instead of rewriting the workflow from scratch. `resumed_from` on a row names the run it was amended from.",
].join("\n");

const listWorkflowRunsHandler: ToolHandler = async (input, context) => {
  const parsed = ListWorkflowRunsInputSchema.parse(input) as ListWorkflowRunsInput;

  const port = context.dynamicWorkflowRunPort;
  // Port absent and method absent on a present port produce the same business failure; they mean the same thing to the model.
  // Detect optional members with typeof (the `cancel` port contract set this precedent).
  if (port === undefined || typeof port.listRuns !== "function") {
    return workflowIntrospectionUnavailableFailure();
  }

  const result = await port.listRuns({
    // Always use this session's working directory: the model cannot scan other projects, which is also required by `sideEffectScope: "none"`.
    // Match paths literally without normalization; submit stores them as-is and reads query them as-is, so normalizing would make the two sides disagree.
    cwd: context.workingDirectory,
    // Input schema preprocessing clamps the limit to [1, 50], so the port never sees an unbounded enumeration.
    limit: parsed.limit,
    ...(parsed.statuses === undefined ? {} : { statuses: parsed.statuses }),
  });

  return {
    runs: result.runs.map((item) => ({
      runId: item.runId,
      label: item.label,
      labelSource: item.labelSource,
      status: item.status,
      ...(item.stopReason === undefined ? {} : { stopReason: item.stopReason }),
      ...(item.resumedFrom === undefined ? {} : { resumedFrom: item.resumedFrom }),
      ...(item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }),
      ownedByThisSession: item.ownedByThisSession,
      // Present only when true; `false` would add a noisy field to every row.
      ...(item.possiblyInterrupted ? { possiblyInterrupted: true } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      spentTokens: item.spentTokens,
    })),
    ...(result.truncated ? { truncated: true } : {}),
  } satisfies ListWorkflowRunsOutput;
};

/**
 * Model-facing format: one XML-ish container with **one row per run**.
 *
 * Why not split each field into a separate element as TaskOutput does? That format is for one-object details; 50 rows × 8 elements
 * would turn one list into hundreds of lines, approaching the 24k budget without increasing information density. A single line of
 * attributes retains the same XML-ish tag convention (which the model parses reliably) while keeping 50 runs to 50 lines.
 */
function formatListWorkflowRunsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListWorkflowRuns returned an invalid result.";

  const { runs, truncated } = parsed.data;
  const header = [
    workflowRunAttribute("count", runs.length),
    ...(truncated ? [workflowRunAttribute("truncated", true)] : []),
  ].join(" ");

  if (runs.length === 0) {
    // Explicitly say when the project has no workflow runs; an empty container can look like the tool failed to answer.
    return `<workflow_runs ${header}>\nNo workflow runs recorded for this project.\n</workflow_runs>`;
  }

  const rows = runs.map((run) =>
    [
      "<run",
      workflowRunAttribute("id", run.runId),
      workflowRunAttribute("status", run.status),
      ...(run.stopReason === undefined
        ? []
        : [workflowRunAttribute("stop_reason", run.stopReason)]),
      ...(run.resumedFrom === undefined
        ? []
        : [workflowRunAttribute("resumed_from", run.resumedFrom)]),
      ...(run.supersededBy === undefined
        ? []
        : [workflowRunAttribute("superseded_by", run.supersededBy)]),
      workflowRunAttribute("label", run.label),
      workflowRunAttribute("label_source", run.labelSource),
      workflowRunAttribute("owned_by_this_session", run.ownedByThisSession),
      ...(run.possiblyInterrupted ? [workflowRunAttribute("possibly_interrupted", true)] : []),
      workflowRunAttribute("spent_tokens", run.spentTokens),
      workflowRunAttribute("created_at", formatWorkflowRunTimestamp(run.createdAt)),
      workflowRunAttribute("updated_at", formatWorkflowRunTimestamp(run.updatedAt)),
      "/>",
    ].join(" "),
  );

  return [`<workflow_runs ${header}>`, ...rows, "</workflow_runs>"].join("\n");
}

export const listWorkflowRunsToolEntry: ToolEntry = {
  capability: "List this project's dynamic-workflow runs, including runs from other sessions",
  metadata: {
    name: LIST_WORKFLOW_RUNS_TOOL_NAME,
    description: LIST_WORKFLOW_RUNS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxOutputBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listWorkflowRunsHandler,
  inputSchema: ListWorkflowRunsInputJsonSchema,
  outputSchema: ListWorkflowRunsOutputJsonSchema,
  runtimeInputSchema: ListWorkflowRunsInputSchema,
  runtimeOutputSchema: ListWorkflowRunsOutputSchema,
  formatModelContent: formatListWorkflowRunsModelContent,
  permission: {
    permission: "listWorkflowRuns",
    reason: "ListWorkflowRuns reads the run journal for the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // Input has no path subject (cwd comes from session context), so match only by tool name.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Intentionally **do not** inherit CreateWorkflow's alwaysAsk: that gate exists because it executes a full code block, which does
    // not apply to reading status.
  },
  resultBudget: {
    maxInlineBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    maxModelBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
      // Head: most recently updated runs come first; trimming the tail discards the oldest.
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ListWorkflowRuns reads the run journal synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
