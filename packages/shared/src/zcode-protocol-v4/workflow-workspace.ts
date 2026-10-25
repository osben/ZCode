// ============================================================
// Protocol vocabulary for the workspace transcript.
// ============================================================
// A run's `files.*` / `git.*` / `world.run` calls are replayed as tool cards in the side panel.
// The journal's `dwf_node` row is authoritative (`kind ∈ {world-read, world-run}`): `input_json`
// (migration 0030) contains the op and arguments; `result_json` contains the body.
//
// Two v4 queries, following the user-facing artifact split into ①/③:
//   Workspace  lightweight row list (op / args / status / summary / timestamp), **without the body**;
//              re-query when the live projection's `lastEventSequence` advances
//   NodeResult the body of one node, shape-preserving and bounded by maxBytes; fetched only when expanded and cached by tab
//
// Layering: bodies never enter the list; the storage layer uses SQLite JSON functions to compute list summaries such as size / exit code / item count
// inside the database. Like workflowRunEvents, this is read-only, stateless, and safe to retry after a timeout; intentionally not a v4 command,
// with no atSeq / atLogEpoch (it reads the journal, so there is no staleness to guard against). The new method is naturally safe under version skew.

import { z } from "zod";

/** Display limits for the workspace transcript. The numbers are the contract. */
export const WORKFLOW_WORKSPACE_LIMITS = {
  /** Maximum rows per list; the gateway truncates beyond the limit and sets `truncated`. */
  maxNodes: 2000,
  /** Maximum length of an `op` name (`git-changed-files` is the longest). */
  maxOpLength: 32,
  /** Number of arguments (≤ 8 after engine-side truncation; original untruncated values are ≤ 3 by the facade signature). */
  maxArgs: 16,
  /** Display length for failure messages; the host truncates longer messages. */
  maxErrorMessageLength: 2000,
  /** Maximum body size read back at once in bytes (truncate rather than reject — this is an audit surface, not the script's data retrieval surface). */
  resultMaxBytes: 32 * 1024,
} as const;

export const workflowRunWorkspaceNodeKindSchema = z.enum(["world-read", "world-run"]);
export type WorkflowRunWorkspaceNodeKind = z.infer<typeof workflowRunWorkspaceNodeKindSchema>;

/** Journal row status (wire mirror of `NodeRecordStatus`). */
export const workflowRunWorkspaceNodeStatusSchema = z.enum(["running", "completed", "failed"]);
export type WorkflowRunWorkspaceNodeStatus = z.infer<typeof workflowRunWorkspaceNodeStatusSchema>;

/** Structured failure: code + message from journal `error_json` (other fields are not sent over the protocol). */
export const workflowRunWorkspaceNodeErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength),
  })
  .strict();
export type WorkflowRunWorkspaceNodeError = z.infer<typeof workflowRunWorkspaceNodeErrorSchema>;

/**
 * Summary for one list row: a few values available without decoding the body. Which values are present depends on op — array bodies (glob / grep /
 * changedFiles) have `resultCount`; `world.run` has `exitCode` and the byte sizes of both output streams; string bodies
 * have only `resultBytes`.
 */
export const workflowRunWorkspaceNodeSummarySchema = z
  .object({
    resultBytes: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkflowRunWorkspaceNodeSummary = z.infer<typeof workflowRunWorkspaceNodeSummarySchema>;

/**
 * A row in the workspace transcript. `op` / `args` come from `input_json`; historical rows from before the upgrade omit both
 * (the UI falls back to the static graph's step label); `inputTruncated` means args are per-item string previews rather than original values.
 */
export const workflowRunWorkspaceNodeSchema = z
  .object({
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    kind: workflowRunWorkspaceNodeKindSchema,
    op: z.string().min(1).max(WORKFLOW_WORKSPACE_LIMITS.maxOpLength).optional(),
    args: z.array(z.unknown()).max(WORKFLOW_WORKSPACE_LIMITS.maxArgs).optional(),
    inputTruncated: z.literal(true).optional(),
    status: workflowRunWorkspaceNodeStatusSchema,
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    summary: workflowRunWorkspaceNodeSummarySchema.optional(),
    /** Journal row creation/most recent update time (epoch milliseconds); their difference is this step's duration. */
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRunWorkspaceNode = z.infer<typeof workflowRunWorkspaceNodeSchema>;

// ── v4 query ①: workflowRunWorkspace (lightweight row list) ──
export const v4ConversationWorkflowRunWorkspaceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceParams = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceParamsSchema
>;

export const v4ConversationWorkflowRunWorkspaceResultSchema = z
  .object({
    /** In persistence order (ascending journal row id = engine admission order). */
    nodes: z.array(workflowRunWorkspaceNodeSchema).max(WORKFLOW_WORKSPACE_LIMITS.maxNodes),
    /** The list was truncated because it exceeded maxNodes. */
    truncated: z.boolean().optional(),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceResult = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceResultSchema
>;

// ── v4 query ②: workflowRunNodeResult (one node's body) ──
// Authorization happens on the CLI side (port implementation): sessionId must be this run's parentSessionId; otherwise return the same response as "no such node"
// so callers cannot distinguish the cases. Bound the body by maxBytes while **preserving its shape**: truncate strings, drop array tails, and truncate run stdout/stderr
// independently — a card needs "what ran and what the first few hundred lines were," not the script's all-or-nothing data retrieval.
export const v4ConversationWorkflowRunNodeResultParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    /** Both the default and maximum are resultMaxBytes; the gateway clamps the value. */
    maxBytes: z.number().int().positive().max(WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultParams = z.infer<
  typeof v4ConversationWorkflowRunNodeResultParamsSchema
>;

export const v4ConversationWorkflowRunNodeResultResultSchema = z
  .object({
    status: workflowRunWorkspaceNodeStatusSchema,
    /** Bounded body; absent for running and failed rows. */
    result: z.unknown().optional(),
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    truncated: z.boolean(),
    /** Serialized byte count before truncation. */
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultResult = z.infer<
  typeof v4ConversationWorkflowRunNodeResultResultSchema
>;
