/* oxlint-disable max-lines -- v4 snapshot schema is a frozen cross-process contract; additions stay grouped here. */
// ConversationSnapshot section A.
// Section A updates replace whole fields (state.updated); never deep-merge them, which causes inconsistent state.
import { z } from "zod";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
export { sharedContextImportStateSchema } from "./shared-context-import.js";
import { conversationInputDispatchSchema, conversationInputIntentSchema } from "./input-intent.js";
import {
  zcodeContextUsageBreakdownSchema,
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  zcodeSessionContextCacheUsageSchema,
} from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { toolCallDisplaySchema } from "./toolDisplay.js";

import { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review.js";
import { workflowRunsStateSchema } from "./workflow-runs.js";
import { sessionConfigStateSchema, sessionModelTransitionSchema } from "./session-config.js";
export {
  sessionConfigStateSchema,
  sessionModelTransitionSchema,
  type SessionConfigState,
  type SessionModelTransition,
} from "./session-config.js";
// ── SessionControl ──
export const sessionPhaseSchema = z.enum([
  // Preserve draft adjudication as in-memory state visible in sessions-index, with no row.
  // It is not persisted and disappears when the CLI restarts; firstInput arrival moves it to prewarming/running.
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const stopTargetKindSchema = z.enum([
  "assistant",
  "tool",
  "subagent",
  "compact",
  "goalVerifier",
  "goalContinuation",
  "turnSteer",
  "mixed",
  "unknown",
]);
export type StopTargetKind = z.infer<typeof stopTargetKindSchema>;

export const activeWorkSummarySchema = z.object({
  kind: z.enum([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: z.string().min(1).optional(),
  sourceCommandId: z.string().min(1).optional(),
  startedAt: timestampSchema,
});
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

// Error codes are grouped into fault.*, proto.*, and guard.*.
export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;

export const sessionErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  at: timestampSchema,
  source: z.enum(["provider", "runtime", "tool", "network"]),
  traceId: z.string().optional(),
  detail: z.string().optional(),
  underlyingErrorMessage: z.string().optional(),
  underlyingErrorDetail: z.string().optional(),
  attribution: errorAttributionSchema.optional(),
});
export type SessionErrorInfo = z.infer<typeof sessionErrorInfoSchema>;

export const apiRetryStateSchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number(),
  nextRetryAt: timestampSchema,
  reasonCode: z.string(),
});
export type ApiRetryState = z.infer<typeof apiRetryStateSchema>;

export const sessionControlSchema = z.object({
  phase: sessionPhaseSchema,
  // Derived value (= phase ∈ completed*), retained for UI convenience.
  sessionEnded: z.boolean(),
  canStop: z.boolean(),
  stopState: z.enum(["idle", "stoppable", "stopping"]),
  stopTargetKind: stopTargetKindSchema,
  // For lightweight evidence/hover hints; the UI must not infer flags from this.
  // hasBackgroundWork is not in the payload: clients derive it with backgroundWorks.some(w => w.status === "running").
  activeWorks: z.array(activeWorkSummarySchema),
  lastError: sessionErrorInfoSchema.nullable(),
  apiRetry: apiRetryStateSchema.nullable(),
});
export type SessionControl = z.infer<typeof sessionControlSchema>;

// ── availability and inputRouting ──
export const actionAvailabilitySchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  // reasonCode is the product-protocol guard ID used by the disabled-state tooltip.
  z.object({ allowed: z.literal(false), reasonCode: z.string() }),
]);
export type ActionAvailability = z.infer<typeof actionAvailabilitySchema>;

export const sessionActionAvailabilitySchema = z.object({
  fork: actionAvailabilitySchema,
  compact: actionAvailabilitySchema,
  switchModelConfig: actionAvailabilitySchema,
  setFollowupMode: actionAvailabilitySchema,
  queueEdit: actionAvailabilitySchema,
  sendQueuedNow: actionAvailabilitySchema,
  pauseGoal: actionAvailabilitySchema,
  resumeGoal: actionAvailabilitySchema,
});
export type SessionActionAvailability = z.infer<typeof sessionActionAvailabilitySchema>;

export const inputRoutingSchema = z.object({
  // choice: while held (completed+queue>0+autoDrain=false),
  // input is not silently queued; the client offers “clear queue and send / keep queue and send now.”
  mode: z.enum(["startNow", "enqueue", "guide", "reject", "choice"]),
  // Required for mode=reject; optional for enqueue/guide/choice (for example, why guide fell back).
  reasonCode: z.string().optional(),
});
export type InputRouting = z.infer<typeof inputRoutingSchema>;

// ── meta (session-level metadata: title). renameSession/automatic titles are stored here. ──
export const sessionMetaStateSchema = z.object({
  title: z.string(),
  // default = unnamed; generated = generated by the model; custom = explicitly renamed by the user (no longer overwritten by automatic titles).
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

/**
 * Read-only source marker for imported shared context.
 *
 * The shared_context body is for model use only and must not be faked into a conversation bubble through a userInput row.
 * This additive metadata lets Desktop tell users where the context came from in a new session.
 */
export type { SharedContextImportState } from "./shared-context-import.js";

// ── usage. Conflation: unchanged values are not sent. ──
export const sessionUsageStateSchema = z.object({
  contextWindow: z
    .object({
      usedTokens: z.number(),
      maxTokens: z.number(),
      autoCompactThresholdTokens: z.number().nullable(),
      cache: zcodeSessionContextCacheUsageSchema.optional(),
      breakdown: zcodeContextUsageBreakdownSchema.optional(),
    })
    .nullable(),
  cumulative: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
});
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

// ── queue (not persisted; discarded when the CLI process exits, and the client lets the user decide whether to resend after reconciliation). ──
export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),
  }),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueStateSchema = z.object({
  items: z.array(queueItemSchema),
  // false after stop (queue paused); setAutoDrain resumes it.
  autoDrain: z.boolean(),
  // Additive: when absent from an older snapshot, the UI uses generic pause text; Stop/TurnError can show a reason.
  pauseReason: z.enum(["stopped", "manual", "error"]).optional(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

// ── pendingInteractions (blocking interactions → state) ──
export const MAX_PERMISSION_FEEDBACK_CHARS = 4_096;

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";
const permissionOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  kind: z.enum(["allowOnce", "allowAlways", "deny", "custom"]),
  response: zcodePermissionResponseSchema.optional(),
});

export const permissionRequestPayloadSchema = z.object({
  kind: z.literal("permission"),
  toolCallId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  detail: z.unknown(),
  // Additive: when absent from an older snapshot, the UI hides feedback input; the new V4 projection can enable it explicitly.
  freeText: z.boolean().optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
  // Tool-reported confirmation preview reuses the row display projection (the same bounded shape). Defaults to a plain-text ask.
  // This is also non-gating: if preview parsing fails, fall back to a plain-text ask instead of rejecting the snapshot (see toolDisplay.ts comments).
  display: toolCallDisplaySchema.optional().catch(undefined),
  // Independent additive capability: older UIs ignore this field and continue to show the original options, without exposing a partially implemented authorization entry point.
  fullAccessOption: permissionOptionSchema
    .extend({
      optionId: z.literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      kind: z.literal("custom"),
    })
    .optional(),
  options: z.array(permissionOptionSchema),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

export const userInputOptionPayloadSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type UserInputOptionPayload = z.infer<typeof userInputOptionPayloadSchema>;

export const userInputQuestionPayloadSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(userInputOptionPayloadSchema),
  multiSelect: z.boolean().optional(),
});
export type UserInputQuestionPayload = z.infer<typeof userInputQuestionPayloadSchema>;

export const userInputRequestPayloadSchema = z.object({
  kind: z.literal("userInput"),
  prompt: z.string(),
  freeText: z.boolean(),
  options: z.array(z.object({ optionId: z.string(), label: z.string() })).optional(),
  // true → treat the input as a password; clients must not add it to drafts/history.
  sensitive: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  traceId: z.string().optional(),
  input: z.unknown().optional(),
  schema: z.unknown().optional(),
  questions: z.array(userInputQuestionPayloadSchema).optional(),
  currentQuestionIndex: z.number().optional(),
  answerDrafts: z.record(z.string(), z.array(z.string())).optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
});
export type UserInputRequestPayload = z.infer<typeof userInputRequestPayloadSchema>;

export const interactionAutoResolutionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["hiddenGrace", "visibleCountdown"]),
    startedAt: timestampSchema,
    visibleAt: timestampSchema,
    deadlineAt: timestampSchema,
  }),
  z.object({
    state: z.literal("snoozed"),
    startedAt: timestampSchema,
    snoozedAt: timestampSchema,
  }),
]);
export type InteractionAutoResolution = z.infer<typeof interactionAutoResolutionSchema>;

export const pendingInteractionSchema = z
  .object({
    interactionId: z.string(),
    kind: z.enum(["permission", "userInput", "workspaceHookReview"]),
    // null = session-level (for example, provider interactions and workspace Hook review).
    anchorRowId: z.number().nullable(),
    createdAt: timestampSchema,
    autoResolution: interactionAutoResolutionSchema.optional(),
    payload: z.discriminatedUnion("kind", [
      permissionRequestPayloadSchema,
      userInputRequestPayloadSchema,
      workspaceHookReviewRequestPayloadSchema,
    ]),
  })
  .superRefine((interaction, context) => {
    if (interaction.kind !== interaction.payload.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "pending interaction kind must match payload kind",
      });
    }
    if (interaction.kind === "workspaceHookReview" && interaction.autoResolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoResolution"],
        message: "workspaceHookReview cannot use AskUserQuestion auto-resolution",
      });
    }
    if (
      interaction.payload.kind === "workspaceHookReview" &&
      interaction.interactionId !== interaction.payload.interactionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactionId"],
        message: "workspaceHookReview interaction id must match its immutable payload",
      });
    }
  });
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

// ── pendingCommands / backgroundWorks ──
export const commandStateSummarySchema = z.object({
  commandId: z.string(),
  clientId: z.string(),
  type: z.string(),
  state: z.enum(["accepted", "executing"]),
  at: timestampSchema,
});
export type CommandStateSummary = z.infer<typeof commandStateSummarySchema>;

export const backgroundWorkSummarySchema = z.object({
  workId: z.string(),
  // workflow = workflow run (CreateWorkflow). **Skew cost of adding a closed-set value**:
  // when an older Desktop receives an unknown value, the entire state.updated patch fails to parse (an invalid value for a known key is an error, not stripped),
  // so the assembler rejects the whole frame. The resync snapshot carries the same value and fails too; there is no graceful fallback.
  // This is acceptable only when CLI and Desktop ship together.
  kind: z.enum(["bash", "subagent", "workflow"]),
  title: z.string(),
  // resultPending = completed, with the result waiting for foreground availability in the continuation inbox;
  // the entry disappears after delivery (the result becomes a userInput row with origin=backgroundResult).
  status: z.enum(["running", "resultPending", "failed", "cancelled"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  cancellable: z.boolean().optional(),
  blocked: z.boolean().optional(),
  anchorRowId: z.number().nullable(),
  childSessionId: z.string().optional(),
});
export type BackgroundWorkSummary = z.infer<typeof backgroundWorkSummarySchema>;

// Subagent runtime state belongs to the authoritative conversation projection, not the renderer query cache.
// Keep ended details in cursor queries; the snapshot carries only the directory total so live counts do not depend on query timing.
export const runningSubagentSummarySchema = z.object({
  childSessionId: z.string(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  subagentType: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["running", "waiting", "blocked"]),
  startedAt: timestampSchema.optional(),
});
export type RunningSubagentSummary = z.infer<typeof runningSubagentSummarySchema>;

export const subagentProjectionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  childSessionIds: z.array(z.string()),
  running: z.array(runningSubagentSummarySchema),
  endedTotal: z.number().int().nonnegative(),
});
export type SubagentProjectionState = z.infer<typeof subagentProjectionStateSchema>;

// ── goal / plan ──
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const goalIterationStateSchema = z.object({
  iteration: z.number().int().positive(),
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type GoalIterationState = z.infer<typeof goalIterationStateSchema>;

export const goalStateSchema = z.object({
  // default is only for compatibility with older snapshots; new projections always include the current target identity and timing facts.
  targetId: z.string().default(""),
  objective: z.string(),
  summaryTitle: z.string().nullable().default(null),
  timeUsedSeconds: z.number().int().nonnegative().default(0),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().default(null),
  // paused: target is forced into this state when stop applies to any foreground work (stopPausesActiveGoalTarget).
  // notSatisfied is distinct from failed: the former is a valid conclusion, the latter means verification failed.
  status: z.enum(["active", "paused", "verifying", "verified", "notSatisfied", "failed"]),
  iteration: z.number(),
  verifications: z.array(
    z.object({
      iteration: z.number(),
      outcome: z.enum(["pass", "notSatisfied", "failed"]),
      at: timestampSchema,
      anchorRowId: z.number().nullable(),
      reason: z.string().optional(),
      nextAction: z.string().optional(),
    }),
  ),
  iterations: z.array(goalIterationStateSchema).default([]),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type PlanState = z.infer<typeof planStateSchema>;

// ── Snapshot overview ──
export const rowsWindowSchema = z.object({
  // Tail window, ordered by rowId ascending.
  window: z.array(conversationRowSchema),
  // Current total ordered row count (decreases after truncation; used only to estimate the scrollbar).
  totalCount: z.number(),
  // First rowId in the total order; if it equals the window's first row, the beginning has been reached (cursor pagination check).
  firstRowId: z.number().nullable(),
});
export type RowsWindow = z.infer<typeof rowsWindowSchema>;

// Soft Gate: session-level admission status for hooks awaiting review.
// Shared by snapshot and StatePatch (delta.ts) so projection patches and snapshot fields have the same shape.
export const workspaceHookAdmissionStateSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  bundleDigest: z.string(),
  workspaceIdentity: z.string().optional(),
});
export type WorkspaceHookAdmissionSnapshotState = z.infer<typeof workspaceHookAdmissionStateSchema>;

export const conversationSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: z.string(),
  logEpoch: z.string(),
  // Snapshot alignment watermark (= the containing frame's toSeq; read atomically from the in-memory projection).
  seq: z.number(),
  revision: z.number(),
  // Section A
  control: sessionControlSchema,
  availability: sessionActionAvailabilitySchema,
  inputRouting: inputRoutingSchema,
  // meta was added after the schema was frozen, so it must have a default to preserve parsing of old snapshots/senders.
  // A backup branch once made it required, leaving the shared round-trip test failing there (missed because root vitest was not run).
  meta: sessionMetaStateSchema.default({ title: "", titleSource: "default" }),
  // Additive: when older CLIs/snapshots omit this field, treat it as a regular session.
  sharedContextImport: sharedContextImportStateSchema.optional(),
  config: sessionConfigStateSchema,
  // Persisted stable fact for live clients to recognize a one-time hint; absent fields in older snapshots do not trigger it.
  modelTransition: sessionModelTransitionSchema.nullable().default(null),
  usage: sessionUsageStateSchema,
  queue: queueStateSchema,
  pendingInteractions: z.array(pendingInteractionSchema),
  pendingCommands: z.array(commandStateSummarySchema),
  backgroundWorks: z.array(backgroundWorkSummarySchema),
  // Optional only for wire compatibility with older snapshots; new CLI initial state and every projection always include this field.
  subagents: subagentProjectionStateSchema.optional(),
  // Cold snapshots must include workflowRuns. If omitted, active runs silently disappear after refresh/reconnect
  // (leaving the details page blank while the run continues). Optional is only for wire compatibility with older snapshots.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable(),
  plan: planStateSchema.nullable(),
  // Soft Gate: this additive field must have default(null).
  // Older snapshots/senders omit it, so it parses as null and remains compatible (per the frozen-schema rule).
  // The projection sets it to null when pendingCount === 0, hiding the banner.
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().default(null),
  // (2026-09-12): the former additive field pluginUiSurfaces was removed; plugin panel widgetState now
  // lives only in the host renderer's memory.
  // Section B
  rows: rowsWindowSchema,
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
