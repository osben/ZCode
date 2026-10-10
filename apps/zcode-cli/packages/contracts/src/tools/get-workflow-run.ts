// ============================================================
// GetWorkflowRun Tool - adaptive details for one workflow run (progress summary / artifacts / failure)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentSchema,
} from "./get-workflow-run-roster.js";
import { WorkflowRunSummarySchema } from "./list-workflow-runs.js";

// The schema for the roster view (phases / subagents / health) lives in get-workflow-run-roster.ts and
// is re-exported here unchanged to preserve `@zcode/contracts` import paths.
export * from "./get-workflow-run-roster.js";

export const GET_WORKFLOW_RUN_TOOL_NAME = "GetWorkflowRun";

export const GetWorkflowRunInputSchema = z
  .object({
    // Uses snake_case like TaskOutput's `task_id`: to the model, these keys belong to the same family
    // of run / task identifiers, and a naming-style split would make it guess between the two tools.
    run_id: z
      .string()
      .min(1)
      .describe("The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)"),
  })
  .strict();

export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunInputSchema>;

export const GetWorkflowRunInputJsonSchema = toToolJsonSchema(GetWorkflowRunInputSchema);

/**
 * Run progress and usage (observation surface, with no total limit). `nodesObserved` is the **number of
 * persisted node rows** (sum of the three states), never a "total step count": dynamic workflows have
 * no static total, and `queued` exists only in the event phase, not in storage.
 */
export const GetWorkflowRunUsageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

/** One actor-site instance. `persona` is intentionally omitted: the full system prompt is inherently unbounded. */
export const GetWorkflowRunActorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

/**
 * One `log()` narrative entry. `at` is when the event was written to the journal (`dwf_event.time_created`),
 * used by the model-facing surface to render "how long ago." Omitted on older journals without this
 * column, so those rows have no age prefix—**never** fall back to read-time `Date.now()`, which would
 * label a week of history as "just now."
 */
export const GetWorkflowRunLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string(),
    at: z.number().optional(),
  })
  .strict();

/**
 * An escalation question currently parked while waiting for the main agent's answer.
 *
 * This is the **query fallback** when escalation notifications are dropped, and the model's only
 * discovery surface: `ResolveWorkflowQuestion` accepts only `qid`, and notifications have two known
 * drop paths (stale branch generation / shutdown). `askedAt` lets the model see how long the question
 * has been waiting—there is no timeout fallback.
 */
export const GetWorkflowRunPendingQuestionSchema = z
  .object({
    qid: z.string(),
    /** Actor that asked, in `site@ordinal` form. */
    actor: z.string(),
    /** Human-readable actor name; omitted for anonymous actors (the reader decides how to render "unnamed"). */
    actorName: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
    /** Question time (epoch ms, on the same scale as createdAt / updatedAt). */
    askedAt: z.number(),
  })
  .strict();

/**
 * One **user-facing artifact**: output published to the user by the script through `artifact.*`,
 * already displayed as a card.
 *
 * ⚠ Terminology: this is **different from** `result` in this tool's output (the script's top-level
 * return value, also called artifact inside the engine). The model uses them differently: `result` is
 * content to relay; an artifact is something to **reference** by title.
 *
 * Intentionally **omits `uri`**: the model cannot read the tool-artifact store. Fields use the
 * **latest version's** values (`version` is the version number; historical version metadata is in the
 * UI side panel).
 */
export const GetWorkflowRunArtifactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
    /** Card title; omitted if the script did not provide one (the facade's default title is the id). */
    title: z.string().optional(),
    /** Latest version number. */
    version: z.number(),
    /** MIME type for content artifacts; omitted for built-in boards. */
    contentType: z.string().optional(),
    /** Byte count for the latest content-artifact version; omitted for built-in boards. */
    bytes: z.number().optional(),
    /** Workspace origin for a content artifact (the bytes were copied into the store; this is only where they came from). */
    sourcePath: z.string().optional(),
    /** Number of tagged `report` items received by a built-in board; always 0 for content artifacts. */
    itemCount: z.number(),
    /** Run deliverable (at most one), listed first. */
    primary: z.literal(true).optional(),
  })
  .strict();

/** Structured failure. `code` is a stable discriminator—the model must distinguish process death from a real script failure. */
export const GetWorkflowRunErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** Present only when `code === "ProviderStop"`. */
    providerStop: z
      .object({
        kind: z.enum([
          "auth",
          "not_configured",
          "model_unavailable",
          "invalid_request",
          "quota",
          "other",
        ]),
        reason: z.string(),
        providerId: z.string().optional(),
        providerLabel: z.string().optional(),
        modelId: z.string().optional(),
        providerCode: z.string().optional(),
        subagent: z.string().optional(),
        subagentName: z.string().optional(),
        phase: z.string().optional(),
        rawMessage: z.string().optional(),
        resetAt: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Character limit for `summary`. Budget for one sentence: beyond this, it is another report, not a summary. */
export const GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS = 400;

export const GetWorkflowRunOutputSchema = WorkflowRunSummarySchema.extend({
  /**
   * One-sentence roster summary: status + elapsed / completed time + phase position + step and
   * in-flight breakdown + unanswered questions + latest progress. The handler **deterministically**
   * assembles it from the structured fields below (no model involved), so the same snapshot always
   * produces the same sentence. Bounded by {@link GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS}; if exceeded,
   * drop whole trailing clauses.
   */
  summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS),
  /**
   * Time this snapshot was read (epoch ms). Every model-facing "how long ago" is calculated against
   * this value—one clock per output makes two ages comparable. `formatModelContent` accepts one
   * argument (the core ToolEntry contract), so the handler must read the clock and include the result
   * in the output; the formatter remains a pure `(output) => text` function that can be tested exactly.
   */
  generatedAt: z.number(),
  usage: GetWorkflowRunUsageSchema,
  /**
   * This run's own concurrency limit (number of subagents in flight), **present only when below the
   * current ceiling**: a run at the ceiling has nothing to report (same omission rule as
   * pendingQuestions). When AmendWorkflow omits `max_concurrency`, this is the value it will reuse, so
   * the model knows what an amendment inherits.
   */
  maxConcurrency: z.number().int().positive().optional(),
  /**
   * Model used by this run's subagents, canonical form `providerId/modelId[$reasoningLevel]`,
   * **present only when explicitly set**: a run using the session model has nothing to report (same
   * omission rule as `maxConcurrency`). When AmendWorkflow omits `subagent_model`, it reuses this value.
   */
  subagentModel: z.string().optional(),
  /**
   * Script file for this run, **already formatted for the model-facing surface** (workspace-relative
   * when inside the session working directory; absolute otherwise). **Present only when this run
   * recorded a file** (same omission rule as `subagentModel`): drafts that could not be written and
   * runs started before this feature have nothing to report. When present, this is the `path` to pass
   * to the next AmendWorkflow call.
   */
  scriptPath: z.string().optional(),
  actors: z.array(GetWorkflowRunActorSchema),
  /** Tail of `log()` events, in chronological order (ascending sequence). Empty when there are no log events. */
  logTail: z.array(GetWorkflowRunLogEntrySchema),
  /**
   * Phase list: declared phases in declaration order, followed by phases that were entered but not
   * declared. **Omit the whole field when the script declared no phases and none were entered**—that
   * run has no phases at all, while an empty array reads as "the phase list is empty."
   */
  phases: z.array(GetWorkflowRunPhaseSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).optional(),
  /**
   * Subagent roster, in creation order. **Always present**; a run with no actors has an empty array.
   * Unlike `phases`, "how many subagents does this run have?" always has an answer, and 0 is that answer.
   *
   * Intentionally separate from the adjacent `actors`: that is a stable identity table, while each
   * item here is a read-time snapshot.
   */
  subagents: z.array(GetWorkflowRunSubagentSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents),
  /** Roster was truncated by its limit. Omitted otherwise (same convention as `truncated`: no explicit `false`). */
  subagentsTruncated: z.literal(true).optional(),
  /** Whether the run as a whole is active. Always present. */
  health: GetWorkflowRunHealthSchema,
  /**
   * The script's top-level return value, **serialized as text** (strings unchanged, everything else
   * as pretty JSON). Present only for completed runs; an `undefined` result omits the whole field.
   *
   * Why it accepts a string rather than the original value: model-facing serialization has one
   * implementation in core (`serializeWorkflowArtifact`, shared by completion notifications and
   * TaskOutput). Passing through the original value could make the same run's result look different in
   * its notification and this tool.
   */
  result: z.string().optional(),
  /** Always present for errored; present for stopped only with provider / interrupted. The code is passed through unchanged. */
  error: GetWorkflowRunErrorSchema.optional(),
  /**
   * Escalation questions still awaiting answers, in question order. **Omit the whole field when empty**
   * (same as the port projection; do not send an empty array), so the reader hides the entire pending
   * section instead of rendering an empty section.
   */
  pendingQuestions: z.array(GetWorkflowRunPendingQuestionSchema).optional(),
  /**
   * User-facing artifacts published by this run, in first-publication order, **included in any state**
   * (a running run may already have delivered its first chart). **Omit the whole field when empty**, as
   * with pendingQuestions. Bounded to 32 (= `ARTIFACT_CAPS.maxArtifactsPerRun`, the maximum number of
   * artifact ids per run).
   */
  artifacts: z.array(GetWorkflowRunArtifactSchema).optional(),
}).strict();

export type GetWorkflowRunOutput = z.infer<typeof GetWorkflowRunOutputSchema>;

export const GetWorkflowRunOutputJsonSchema = toToolJsonSchema(GetWorkflowRunOutputSchema);
