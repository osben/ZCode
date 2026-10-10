// ============================================================
// Row-level metadata for workflow turns (turnHeader / userInput members in rows.ts)
// ============================================================
// Extract the notification manifest, background-result origin, and direct-launch schemas from rows.ts
// so it stays under the max-lines limit (following create-workflow-display.ts, where feature-level
// schemas have their own module). Public names remain unchanged: rows.ts re-exports them as-is, so both
// the @zcode/shared barrel and relative imports continue to work.

import { z } from "zod";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

// Structured payload for workflow notifications.
// Created and bounded by the emitter; never parse it back from model-facing notification text. The
// payload travels with the turnHeader row through the protocol and snapshots, so truncation is explicit
// (resultTruncated / count != shown means the preview is partial; the full result is available by run
// ID). Batch turns intentionally omit it because one manifest per turn does not apply to a batch.
export const workflowNotificationMetaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    status: z.enum(["completed", "errored", "stopped"]),
    // Present only when `status === "stopped"`.
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    summary: z.string().min(1).max(500),
    result: z.string().max(4000).optional(),
    resultForm: z.enum(["prose", "json"]).optional(),
    resultTruncated: z.literal(true).optional(),
    error: z.string().max(2000).optional(),
    reports: z
      .object({
        count: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        preview: z.array(z.string().max(500)).max(8),
      })
      .optional(),
    // User-facing artifact chips payload.
    // Terminology: this artifact is an output published to users by the script through `artifact.*`;
    // it is unrelated to `result` in the same payload (the script's top-level return value, also called
    // an artifact internally by the engine).
    // Include only fields that fit on a chip. Byte and item counts are available in the side panel and
    // do not fit on the chip. The limit is 8; set artifactsTruncated when exceeded, including entries
    // filtered by kind. The title limit of 120 matches ARTIFACT_CAPS.maxTitleLength and is truncated by
    // the emitter.
    // The primary deliverable is an exception: it also includes `description` (up to 500, matching
    // ARTIFACT_CAPS), because the completion card renders it as a text-bearing deliverable and this is
    // the only readable payload in a cold transcript. Put primary first in the list.
    artifacts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
          title: z.string().max(120).optional(),
          version: z.number().int().positive(),
          contentType: z.string().max(255).optional(),
          primary: z.literal(true).optional(),
          description: z.string().max(500).optional(),
        }),
      )
      .max(8)
      .optional(),
    artifactsTruncated: z.literal(true).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("escalation"),
    qid: z.string().min(1),
    actor: z.string().min(1),
    question: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    askedAt: z.number().optional(),
  }),
  // Run-level stall: one entry per stalled interval; this is not a terminal state.
  z.object({
    kind: z.literal("stall"),
    sinceMs: z.number().int().nonnegative(),
    reason: z.string().max(64).optional(),
    cap: z.number().int().nonnegative().optional(),
  }),
]);
export type WorkflowNotificationMeta = z.infer<typeof workflowNotificationMetaSchema>;

export const backgroundResultOriginMetaSchema = z.object({
  // Keep these three values in sync with BackgroundResultOriginMeta in contracts.
  // "workflow" is a dynamic-workflow run (workId equals runId) and reuses the full background-notification pipeline.
  backgroundSource: z.enum(["bash", "subagent", "workflow"]),
  workId: z.string().min(1),
  title: z.string().min(1),
  // Present only on a single notification turn with backgroundSource === "workflow". Zod strips
  // unknown keys, so omitting it here would silently drop the value throughout the pipeline; this is
  // the only data source for rendering the manifest.
  workflowNotification: workflowNotificationMetaSchema.optional(),
});
export type BackgroundResultOriginMeta = z.infer<typeof backgroundResultOriginMetaSchema>;

// Metadata for a direct-launch turn.
// When the user runs a saved workflow from the GUI hub in a new session, the agent creates a controlOnly
// turn. Both its turnHeader and userInput are projected with origin: "workflowLaunch" and carry this
// metadata. Cold recovery (message metadata) and the live projection (TurnStarted payload) use the same
// shape.
// Bounds follow workflowNotificationMetaSchema: the emitter creates a bounded payload and reports
// truncation honestly. The full script and diagnostics are available in the details side panel by runId;
// the card displays only this fixed-size summary.
// Do not reuse backgroundResultOriginMeta's backgroundSource shape: that represents background
// notification ownership, while this represents a user-initiated launch from the hub. Keep the shapes
// separate so the two concepts can evolve independently.
const workflowSubagentModelTextSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);

// Settings turn: the user changes settings through Configure on a run card or in the details page.
// The agent revises the run using the same script and records the change in a controlOnly turn with the
// same shape as a direct launch.
// This section describes what changed. Only modified settings are present; a missing from/to endpoint
// means that endpoint uses the default (model = session model, limit = machine limit). `ceiling` is the
// machine limit, used to express changes such as 13 → 4.
export const workflowSettingsAmendMetaSchema = z.object({
  // Run this revision was based on. **Absent means applied in place**: when only the concurrency limit
  // changes while a run is active, Configure neither stops nor starts a run, so there is no predecessor
  // to reference; runId identifies the adjusted run. The renderer then shows only this row, not another
  // card (two cards for one run would look like two runs).
  // This field is optional; producers and consumers must use matching schemas to parse in-place settings changes.
  predecessorRunId: z.string().min(1).max(128).optional(),
  subagentModel: z
    .object({
      from: workflowSubagentModelTextSchema.optional(),
      to: workflowSubagentModelTextSchema.optional(),
    })
    .optional(),
  maxConcurrency: z
    .object({
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
  ceiling: z.number().int().positive().optional(),
});
export type WorkflowSettingsAmendMeta = z.infer<typeof workflowSettingsAmendMetaSchema>;

export const workflowLaunchMetaSchema = z.object({
  // runId equals workId: drives the launch card's live status and steps, and links cancel, resume, and
  // details-side-panel actions.
  runId: z.string().min(1).max(128),
  // Uses the launch-<uuid> prefix to distinguish it from model tool-call IDs; matches the synthetic
  // CreateWorkflow toolCall ID.
  toolCallId: z.string().min(1).max(128),
  // Workflow name from the parsed result, supplied by the agent; neither the user nor the model can
  // override it. Hub launches always include it. A settings turn uses the adjusted run's own name and
  // omits it if that run is unnamed. The card and side panel then use the standard fallback label for
  // unnamed runs instead of showing a run ID as the title.
  name: z.string().min(1).max(200).optional(),
  // scope/path belong only to hub launches. A settings turn (`amend` below) changes an existing run and
  // has no saved file to reference.
  // Known version skew: older desktop clients require these fields, so they reject a settings turn from
  // a newer CLI and drop the whole row (the same behavior as adding a value to the closed origin enum).
  // Hub-launch turns always include both fields and are unaffected.
  scope: z.enum(["project", "global"]).optional(),
  // Resolved script path on disk; used only for details and diagnostics, not shown on the card. 1024
  // characters covers deeply nested global and project paths.
  path: z.string().min(1).max(1024).optional(),
  // Argument key/value table and card-rendering source. Bounded to 4 KB serialized, matching the
  // contracts-side TurnStartedPayload limit and preventing a large object from being copied into every
  // persisted message and live event.
  args: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 4096, {
      message: "workflowLaunch.args JSON must be ≤ 4096 bytes",
    })
    .optional(),
  // Optional description line; shared by the argument panel and hub card. The 500-character limit
  // matches the notification summary limit.
  description: z.string().max(500).optional(),
  // create_workflow display compiled before launch (bounded causal graph and diagnostics). The run
  // details side panel finds the graph through toolCallId on the initiating row; direct launches have
  // no tool row, so they use this field. It shares the tool-row display schema.
  // This is also non-gating: a graph parse failure leaves this row without a graph and does not reject
  // the frame (see the toolDisplay.ts comment).
  display: toolCallCreateWorkflowDisplaySchema.optional().catch(undefined),
  // Original script executed by this run, shown in the side panel's Script section and corresponding
  // to input.script on the tool row. Its limit matches contracts WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS.
  script: z.string().max(256_000).optional(),
  // Present only on settings turns: which run Configure revised and what changed.
  amend: workflowSettingsAmendMetaSchema.optional(),
});
export type WorkflowLaunchMeta = z.infer<typeof workflowLaunchMetaSchema>;
