import { z } from "zod";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS,
  GetWorkflowRunActorSchema,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentLastToolSchema,
  GetWorkflowRunUsageSchema,
} from "./get-workflow-run.js";
import {
  ListWorkflowRunsRunSchema,
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

/**
 * Result-card display payloads for workflow inspection tools (GetWorkflowRun /
 * ListWorkflowRuns / EvalWorkflowSnippet / ListSavedWorkflows / ListModels).
 *
 * Length limits correspond one-to-one with the builder (core's
 * workflow-observation-display.ts): display does not pass through the result budget, so text
 * fields and array lengths must be bounded independently before entering live events and
 * persisted metadata. The builder sets the truncated marker when a limit is exceeded.
 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES = 40;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS = 1_024;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS = 32;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS = 4_000;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS = 2_048;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS = 50;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS = 32;
/** Maximum model rows shown on one catalog card (the builder slices and marks truncated when exceeded). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS = 100;
/** Card limits for the run snapshot; same values as the tool surface ({@link GET_WORKFLOW_RUN_ROSTER_LIMITS}). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES = GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS =
  GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents;

/**
 * One subagent on the card. Deliberately a **flat row**, rather than the nested shape of the
 * tool output: the card renders one row, and the facts in `currentAsk` (assigned task, round
 * number, last tool used) are simply the rest of that row. Another nesting level would only
 * make the renderer destructure and reassemble it.
 *
 * The enum set is **identical and closed** with the tool surface: the consumer bundle rejects
 * unknown enum values (which once invalidated an entire subscription), so always update both
 * definitions together.
 */
export const getWorkflowRunToolResultDisplaySubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    /** Current ask's task summary and progress values (omitted means unknown, never 0). */
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
    /** What it is waiting for (the reason text is not shown; the card needs only whether it is waiting for a slot or backing off, and for how long). */
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

export const getWorkflowRunToolResultDisplayLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS),
    // Time when the event was written to the journal (epoch ms), from the same source as the
    // tool output's `logTail[].at`; card age is calculated relative to `generatedAt`. Optional:
    // payloads from before the run snapshot was introduced do not have it, matching shared.
    at: z.number().optional(),
  })
  .strict();

/**
 * Structured failure for the tool card: **only code and message**. Deliberately do not reuse
 * the tool output's `GetWorkflowRunErrorSchema`.
 *
 * The two channels have different readers: the model reads output and needs `providerStop` to
 * know what to fix; the renderer reads display and strictly validates every frame against its
 * mirrored schema in packages/shared. Reuse would make display inherit output's larger fields;
 * if the mirror lagged, the entire row would be rejected and session recovery would fail closed.
 * This definition mirrors that schema; keep both synchronized field by field.
 */
export const getWorkflowRunToolResultDisplayErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

/**
 * Result-card payload for GetWorkflowRun. Budget / actor reuse the tool output schema (small
 * numeric values or already-bounded structures); errors use the display-specific schema
 * above. Bound logTail and result separately on the display side: the output-side 2,048
 * characters per item and artifact serialization limit belong to the model channel and do not
 * replace these limits.
 */
export const getWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    /** Present only when `status === "stopped"`. */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    /**
     * Run snapshot: the summary, snapshot time, phase table, roster, and health.
     *
     * All five fields are **optional**, even though the builder always supplies them. Reason:
     * **transcripts already stored in the database**. Persisted `get_workflow_run` payloads
     * from before snapshots were introduced do not have these keys, and the display schema is
     * strict. Making them required would cause the entire card in every historical session
     * opened after an upgrade to fail validation and fall back to plain text. The text fallback
     * is only for old rows with **no payload at all**, not rows with a payload.
     *
     * `generatedAt` is the reference for every "how long ago" value on the card: calculate
     * against the snapshot time, not `Date.now()` at render time. When a three-day-old
     * transcript is reopened, the card should still show the age from that snapshot.
     */
    summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS).optional(),
    generatedAt: z.number().optional(),
    usage: GetWorkflowRunUsageSchema,
    phases: z
      .array(GetWorkflowRunPhaseSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES)
      .optional(),
    subagents: z
      .array(getWorkflowRunToolResultDisplaySubagentSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS)
      .optional(),
    health: GetWorkflowRunHealthSchema.optional(),
    actors: z.array(GetWorkflowRunActorSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS),
    logTail: z
      .array(getWorkflowRunToolResultDisplayLogEntrySchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    result: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS).optional(),
    error: getWorkflowRunToolResultDisplayErrorSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/** Result-card payload for ListWorkflowRuns: run rows reuse the output schema directly (limit is capped at 50). */
export const listWorkflowRunsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(ListWorkflowRunsRunSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * Result-card payload for EvalWorkflowSnippet. Diagnostics reuse create_workflow's display
 * diagnostic schema (same TypeScript diagnostic shape and length limit); logs use their tail,
 * and response is bounded separately.
 */
export const evalWorkflowSnippetToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    logs: z
      .array(z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS))
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    response: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * Result-card payload for ListSavedWorkflows. Root cause: on the v4 wire, output.text is
 * formatModelContent's XML-style projection, so the UI's JSON probe never matches and falls
 * back to the raw JSON card. Structured lists must use this display channel. Bound description /
 * whenToUse independently; keep only arg names here (declaration details belong in the
 * confirmation dialog).
 */
export const savedWorkflowListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            whenToUse: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * Result-card payload for ListModels. Same root cause as saved_workflow_list: on the v4 wire,
 * output.text is formatModelContent's `<models>` projection, so the UI's JSON probe never
 * matches. Structured catalogs must use this channel.
 *
 * Fields are the tool output itself (the reader needs to render three facts: what is available,
 * where it comes from, and which one is current), plus `truncated`. providerLabel /
 * disabledReason are free text from the registry. Display does not pass through the result
 * budget, so bound them separately here; pass through the remaining short ids and small numbers.
 */
export const listModelsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_models"),
    /** Session's current model (canonical form); omitted if it does not match any catalog entry. */
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS),
    truncated: z.boolean().optional(),
  })
  .strict();

export type GetWorkflowRunToolResultDisplayPayload = z.infer<
  typeof getWorkflowRunToolResultDisplayPayloadSchema
>;
export type ListWorkflowRunsToolResultDisplayPayload = z.infer<
  typeof listWorkflowRunsToolResultDisplayPayloadSchema
>;
export type EvalWorkflowSnippetToolResultDisplayPayload = z.infer<
  typeof evalWorkflowSnippetToolResultDisplayPayloadSchema
>;
export type SavedWorkflowListToolResultDisplayPayload = z.infer<
  typeof savedWorkflowListToolResultDisplayPayloadSchema
>;
export type ListModelsToolResultDisplayPayload = z.infer<
  typeof listModelsToolResultDisplayPayloadSchema
>;

/**
 * Result-card payload for ResumeWorkflowRun.
 *
 * Deliberately minimal `{runId}`: the recovery card only needs to say which run continues in
 * the background. The response prompt is for the model channel, while the UI has its own
 * localization vocabulary; extra fields would add wire bytes with no consumer. The builder
 * returns undefined if safeParse fails on the output schema (falling back to text), matching
 * the structure of the four builders above.
 */
export const resumeWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ResumeWorkflowRunToolResultDisplayPayload = z.infer<
  typeof resumeWorkflowRunToolResultDisplayPayloadSchema
>;
