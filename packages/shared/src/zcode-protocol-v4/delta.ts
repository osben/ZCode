// ConversationDelta: a closed set of seven operations.
// There is no row.inserted (mid-stream insertion), row.moved, or field-level JSON patch —
// For any structural change this model cannot express, the server sends a snapshot resync, deliberately reducing the client's error surface.
//
// The only exception is the final two `workflowRun.*` operations: `workflowRuns` is a high-frequency state key, and replacing the whole key would make
// every engine event resend the entire table (O(N) bytes per event, O(N²) per run). These operations open an incremental path **only** for this key,
// keyed by (runId, siteId, ordinal); semantics remain "replace the whole value within the key, just two levels deeper":
// Replace header keys in full and entries as whole rows, with no field-level deep merge. Rules live in workflow-runs-delta.ts.
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
import {
  backgroundWorkSummarySchema,
  commandStateSummarySchema,
  goalStateSchema,
  inputRoutingSchema,
  pendingInteractionSchema,
  planStateSchema,
  queueStateSchema,
  sessionActionAvailabilitySchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionMetaStateSchema,
  sessionModelTransitionSchema,
  sessionUsageStateSchema,
  subagentProjectionStateSchema,
  workspaceHookAdmissionStateSchema,
} from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
} from "./workflow-runs.js";

// StatePatch: replace whole values at the key level (Object.assign); the set of keys is closed. Never deep-merge within a key.
export const statePatchSchema = z.object({
  revision: z.number().optional(),
  control: sessionControlSchema.optional(),
  sharedContextImport: sharedContextImportStateSchema.optional(),
  availability: sessionActionAvailabilitySchema.optional(),
  inputRouting: inputRoutingSchema.optional(),
  meta: sessionMetaStateSchema.optional(),
  config: sessionConfigStateSchema.optional(),
  modelTransition: sessionModelTransitionSchema.nullable().optional(),
  usage: sessionUsageStateSchema.optional(),
  queue: queueStateSchema.optional(),
  pendingInteractions: z.array(pendingInteractionSchema).optional(),
  pendingCommands: z.array(commandStateSummarySchema).optional(),
  backgroundWorks: z.array(backgroundWorkSummarySchema).optional(),
  subagents: subagentProjectionStateSchema.optional(),
  // Live runtime state for workflow runs. The container itself is not strict, so an old desktop receiving this new key simply **strips one key**,
  // preserving every other key in the patch — which is why no version-skew defenses are needed.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // Soft gate: null clears pending state (the banner disappears); an object updates the pending review state.
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

/**
 * A run's **header** is `workflowRunSchema` without the actors/nodes tables, which are synchronized incrementally by instance.
 *
 * Derive it from the same schema using `.omit` to avoid subscription parsing failures caused by independently maintained field lists drifting apart. Small collections (reports / artifacts / phases / pendingQuestions…) remain in the header and are replaced as whole keys —
 * their bounds are only a few dozen entries, so another incremental syntax would only add another place to make mistakes.
 */
export const workflowRunHeaderSchema = workflowRunSchema.omit({ actors: true, nodes: true });
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;

/** Partial header update: replace each present key as a whole; leave absent keys unchanged (never deep-merge). */
export const workflowRunHeaderPatchSchema = workflowRunHeaderSchema.partial();
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;

/** Header keys that become **absent**. "Zero entries ⇒ key absent" is the protocol contract for keys such as reports/pendingQuestions, so deltas must be able to express it. */
export const workflowRunHeaderKeySchema = workflowRunHeaderSchema.keyof();
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;

/**
 * **Identity** of one evicted entry (the deduplication key shared by both tables). Use `.pick` from the actor schema instead of manually writing
 * the two fields: their bounds should have one definition, for the same reason as the `.omit` in `workflowRunHeaderSchema`.
 *
 * Intentionally contains **identity only**: eviction means only "this entry is gone"; including the entry itself would make consumers think this is an
 * upsert.
 */
export const workflowRunEntryRefSchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunEntryRef = z.infer<typeof workflowRunEntryRefSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // Append to the end (99% of cases).
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // Replace the entire row by rowId (state-machine transition).
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // Delete this row and all following rows (edit/retry branch). Applies to all loaded client rows with rowId >= fromRowId.
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // Append streaming text. Allowed only on streaming rows (guaranteed by the server; the client may assert it).
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  /**
   * Key-level delta for one DWF run. `revision` is the absolute `workflowRuns.revision` **after this change**;
   * one engine event produces at most one of these operations (node phase, derived actor state, usage, and watermarks commit atomically).
   *
   * The six payloads each have their own semantics: `run` replaces whole keys; `cleared` lists keys that became absent;
   * `removedActors` / `removedNodes` remove entries by (siteId, ordinal); `actors` / `nodes` upsert whole rows by the same key.
   * The bounds of all four tables match the state key, so a delta cannot assemble an invalid state.
   *
   * **Application order is header → removals → upserts**, reflected both here and in field order: if the same key is removed and re-added in one operation
   * (a previously overflowed run is reopened with cleared tables on resume, or an evicted entry returns), it must end up at the table's tail so the result matches
   * applying the two operations in sequence.
   */
  z.object({
    op: z.literal("workflowRun.updated"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
    run: workflowRunHeaderPatchSchema.optional(),
    cleared: z
      .array(workflowRunHeaderKeySchema)
      .max(workflowRunHeaderKeySchema.options.length)
      .optional(),
    removedActors: z
      .array(workflowRunEntryRefSchema)
      .max(WORKFLOW_RUNS_LIMITS.maxActors)
      .optional(),
    removedNodes: z.array(workflowRunEntryRefSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
    actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
    nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  }),
  /** The producer evicted this run (only the producer evicts, and it must say so; clients never enforce bounds themselves). */
  z.object({
    op: z.literal("workflowRun.removed"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export type WorkflowRunRemovedDelta = Extract<ConversationDelta, { op: "workflowRun.removed" }>;
