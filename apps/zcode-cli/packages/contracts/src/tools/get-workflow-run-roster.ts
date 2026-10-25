// ============================================================
// **Roster view** schema for GetWorkflowRun: phases / subagents / health
// ============================================================
// Split from get-workflow-run.ts for the same reason as the port-side
// dynamic-workflow-run-roster.port.ts: that file was approaching oxlint's max-lines limit, and these
// three schema groups form a cohesive unit. The public surface is unchanged—get-workflow-run.ts
// re-exports every name from here, keeping `@zcode/contracts` import paths exactly the same.
//
// These are **field-by-field mirrors** of the port types (DynamicWorkflowRunPhaseView /
// …SubagentView / …Health), with Zod bounds added. Keep both sides in sync: the port is the read-side
// fact, and this is the model-facing contract; a missing field prevents a discovered fact from
// reaching the model.

import { z } from "zod";

/**
 * Bounds for the roster view. Each matches an existing bound rather than defining a new one:
 * phase count and name length follow reducer `WORKFLOW_RUNS_LIMITS.maxPhases` /
 * `maxPhaseNameLength`; instruction heads and tool name / target follow engine-side
 * `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`.
 */
export const GET_WORKFLOW_RUN_ROSTER_LIMITS = {
  /** Maximum number of phase rows (same value as reducer maxPhases). */
  maxPhases: 32,
  maxPhaseNameLength: 128,
  /**
   * Maximum number of roster rows. Intentionally higher than the phase-list limit: a fan-out of 50 is
   * routine, and readers specifically ask "who is doing what?" When this limit is exceeded, the whole
   * section is truncated and `subagentsTruncated` indicates that it happened—a roster silently missing
   * 18 rows would read as "there are only 64 subagents."
   */
  maxSubagents: 64,
  maxActorNameLength: 128,
  /** Task summary for one ask (`instructionsHead` from `node-queued`). */
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
  /** Free-text reason from `node-waiting` (for example, a brief provider error during backoff). */
  maxWaitReasonLength: 240,
} as const;

/** Phase state in the roster view (mirror of port `DynamicWorkflowRunPhaseView`). */
export const GetWorkflowRunPhaseSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength),
    /** `ahead` = declared by the script but not yet reached by control flow; also the only state with `rounds: 0`. */
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    /** Most recent entry / exit times (epoch ms). Omitted when events lack timestamps; never use 0. */
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

/** Most recently observed tool call in an ask. `target` is a hint (path / command prefix), not the full input. */
export const GetWorkflowRunSubagentLastToolSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolNameLength),
    target: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolTargetLength).optional(),
    at: z.number().optional(),
  })
  .strict();

/**
 * Ask currently running for a subagent. **Omission of `turn` / `toolCalls` means "unknown"**; `0`
 * means "no tools have been called." Older journals lack `node-progress`, so these must be distinguishable.
 */
export const GetWorkflowRunSubagentAskSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    actorSeq: z.number().int().nonnegative().optional(),
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
  })
  .strict();

/** What the current ask is waiting for. `slot` = waiting for the process-level admission gate; `backoff` = runner is retrying after a delay. */
export const GetWorkflowRunSubagentWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    since: z.number().optional(),
  })
  .strict();

/**
 * One subagent in the roster (mirror of port `DynamicWorkflowRunSubagentView`).
 *
 * The seven `state` values are closed, and their evaluation order is their declaration order (the port
 * comment has the full decision chain): for a live run, `parked` → `waiting` → `executing` → `failed`
 * → `idle`; for a terminal run, only `unfinished` → `failed` → `done` remain.
 */
export const GetWorkflowRunSubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    currentAsk: GetWorkflowRunSubagentAskSchema.optional(),
    wait: GetWorkflowRunSubagentWaitSchema.optional(),
    /** Question it is parked on; never present when `health.pendingQuestionsKnown` is false. */
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

/**
 * Run-level concurrency state. **The whole object is present only when constrained below its own
 * limit**: a run operating at its own limit has nothing to report, and presence means "currently constrained."
 */
export const GetWorkflowRunConcurrencyHealthSchema = z
  .object({
    effective: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    since: z.number().optional(),
  })
  .strict();

/** Whether the run as a whole is active (mirror of port `DynamicWorkflowRunHealth`). */
export const GetWorkflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: GetWorkflowRunConcurrencyHealthSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    /** Terminal runs only: node rows still marked `running` (the process died during them). Omitted when 0. */
    leftoverRunning: z.number().int().positive().optional(),
    /**
     * Whether this read can answer "is any question waiting for an answer?" When false, the whole
     * `pendingQuestions` field is omitted and no subagent is reported as `parked`—"nobody is waiting"
     * and "unknown" are different facts.
     */
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

export type GetWorkflowRunPhase = z.infer<typeof GetWorkflowRunPhaseSchema>;
export type GetWorkflowRunSubagent = z.infer<typeof GetWorkflowRunSubagentSchema>;
export type GetWorkflowRunSubagentAsk = z.infer<typeof GetWorkflowRunSubagentAskSchema>;
export type GetWorkflowRunHealth = z.infer<typeof GetWorkflowRunHealthSchema>;
