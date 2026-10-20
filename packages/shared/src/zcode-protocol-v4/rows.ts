import { conversationQuotesSchema } from "../conversationSelection.js";
import { botGroupInputSourceSchema } from "../bots.js";
// ConversationRow: self-contained row types.
// Three structural rules: each row is self-contained (rendering a row requires no other row);
// structural changes replace the whole row (row.upserted), text growth uses append (row.delta), and turn is a row label, not a container.
import { z } from "zod";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { timestampSchema } from "./core.js";
import { conversationInputSourceSchema } from "./input-intent.js";
import { backgroundResultOriginMetaSchema, workflowLaunchMetaSchema } from "./workflow-row-meta.js";
import { attachmentRefSchema } from "./attachment-ref.js";

// RowBase. rowId is monotonic and never reused within a session; deterministic pure function of the event log.
const rowBaseFields = {
  rowId: z.number(),
  turnId: z.string(),
  // Canonical identity: required on every row from new CLIs; optional only for older-frame compatibility.
  // entityId identifies the persisted entity; productTurnId is the product turn and must not be re-inferred by the UI.
  entityId: z.string().min(1).optional(),
  productTurnId: z.string().min(1).optional(),
  visibility: z.literal("visible").optional(),
  createdAt: timestampSchema,
  createdAtSeq: z.number(),
  // Defaults to all false; send only keys set to true. canRewind is not in the payload (rewind is the UI entry point for editUserQuery).
  actions: z
    .object({
      canFork: z.literal(true).optional(),
      canEdit: z.literal(true).optional(),
      canRetry: z.literal(true).optional(),
      canRewindFiles: z.literal(true).optional(),
      editDisposition: z.enum(["rewind", "fork"]).optional(),
    })
    .optional(),
} as const;

export const rowActionsSchema = rowBaseFields.actions;
export type RowActions = NonNullable<z.infer<typeof rowActionsSchema>>;

// Row-level metadata for workflow turns moved to workflow-row-meta.ts (max-lines); re-export names unchanged here.
export {
  backgroundResultOriginMetaSchema,
  workflowBlockedMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  workflowSettingsAmendMetaSchema,
  type BackgroundResultOriginMeta,
  type WorkflowBlockedMeta,
  type WorkflowLaunchMeta,
  type WorkflowNotificationMeta,
  type WorkflowSettingsAmendMeta,
} from "./workflow-row-meta.js";

export const turnWorkSegmentSchema = z.object({
  segmentId: z.string().min(1),
  triggerEntityId: z.string().min(1).optional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  activeMs: z.number().nonnegative().optional(),
});
export type TurnWorkSegment = z.infer<typeof turnWorkSegmentSchema>;

// turnHeader: product turn boundary + authoritative elapsed time + per-turn file summary.
// Internal collapsed boundaries created by guide are expressed through workSegments; CLI still determines row ownership, with no ownership logic in clients.
export const turnHeaderRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("turnHeader"),
  // workflowLaunch: controlOnly turn started directly by the hub.
  // Known skew behavior: adding a closed-enum value means an older Desktop with a newer CLI drops the row on parse failure (same tier as adding
  // backgroundSource: "workflow" below); acceptable when CLI and Desktop ship together.
  origin: z.enum([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  // CLI projection decides execution semantics; UI must not infer them from input text or duration.
  // Optional only for old snapshot compatibility; new turnHeader rows always set it explicitly.
  executionKind: z.enum(["agent", "controlOnly"]).optional(),
  // Command attribution and historical turn count for the current query; optional for old transcript/snapshot compatibility.
  sourceCommandId: z.string().optional(),
  historyRoundCount: z.number().int().nonnegative().optional(),
  state: z.enum(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  // Authoritative elapsed time: excludes permission / user-input / verifier waits.
  activeMs: z.number().optional(),
  // Cumulative output usage from main-chain ModelComplete events within the current product turn; optional for old snapshot compatibility.
  outputTokens: z.number().int().nonnegative().optional(),
  // Real durations aggregated by the CLI from runtime events; optional for old snapshots and ordinary turns.
  modelDurationMs: z.number().nonnegative().optional(),
  toolDurationMs: z.number().nonnegative().optional(),
  otherDurationMs: z.number().nonnegative().optional(),
  // guide does not split a product turn, but each accepted guide starts a separate visual work segment.
  // Defaults to absent to preserve old snapshot compatibility; once guide is present, CLI projects the first and subsequent segments fully.
  workSegments: z.array(turnWorkSegmentSchema).optional(),
  originMeta: backgroundResultOriginMetaSchema.optional(),
  // Present on turns where origin === "workflowLaunch" (live projection source); alongside originMeta, without reusing its shape.
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  fileChanges: z
    .object({
      additions: z.number(),
      deletions: z.number(),
      files: z.number(),
      state: z.enum(["active", "reverted"]).optional(),
    })
    .optional(),
});
export type TurnHeaderRow = z.infer<typeof turnHeaderRowSchema>;

// userInput. originMeta eliminates text sniffing.
export const userInputRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("userInput"),
  inputOrigin: z.enum(["desktop", "mobile"]).optional(),
  botGroupSource: botGroupInputSourceSchema.optional(),
  conversationQuotes: conversationQuotesSchema.optional(),
  text: z.string(),
  // Text from this index onward is appended by the engine (dwf ask suffix /
  // nudge); GUI folds it into a disclosure collapsed by default. 0 = entire text; absent = none (old transcript or non-workflow session).
  epilogueStart: z.number().int().nonnegative().optional(),
  // workflowLaunch: user-visible row for a turn started directly by the hub.
  // Message text remains in text (older clients / TUI fall back to that canonical English sentence); newer clients use the
  // workflowLaunch metadata below to render a run card at turn end instead of a bubble. Closed-enum skew matches the turnHeader.origin comment.
  origin: z.enum([
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ]),
  originMeta: z
    .object({
      // Same value set as backgroundResultOriginMetaSchema (including "workflow" for workflow runs and "dream" for /dream consolidation).
      backgroundSource: z.enum(["bash", "subagent", "workflow", "dream"]).optional(),
      workId: z.string().optional(),
      senderSessionId: z.string().optional(),
      senderLabel: z.string().optional(),
    })
    .optional(),
  // Present on rows with origin === "workflowLaunch”; alongside originMeta, matching turnHeader.
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  // Injected through turn-steer (guideModeTurnSteer).
  guided: z.literal(true).optional(),
  // Required for realUser/guided; absent for system sources. Overlay finalization anchor.
  sourceCommandId: z.string().optional(),
  // edit/retry creates a new sourceCommandId; this field stays pointed at the canonical input root,
  // for lineage checks across retries such as one-time recovery budgets. May be absent in old transcripts.
  rootSourceCommandId: z.string().optional(),
  // Submitting client identity is written by CLI admission; may be absent in old transcripts.
  clientId: z.string().optional(),
  // Persistent facts for accelerated history display; absent for ordinary messages and old snapshots.
  highspeed: highspeedMessageMetaSchema.optional(),
  // A previous duplicate definition had its source stripped by post-dequeue row validation, making history attachments lose their preview entry; shares the schema with the inbound reference.
  attachments: z.array(attachmentRefSchema).optional(),
  // Messages sent on behalf of plugin UI carry a source; the card shows "from plugin X". May be absent in old transcripts.
  source: conversationInputSourceSchema.optional(),
  // Display-only pin bookmark (unix ms, CLI clock); presence means pinned. Not injected into agent context.
  pinnedAt: z.number().optional(),
});
export type UserInputRow = z.infer<typeof userInputRowSchema>;

// assistantText / reasoning.
// Invariant: append only to rows in state="streaming"; a normal new response always gets a new rowId. The only exception is
// output-token Continue, confirmed by ProductProjection using length/zero-tool facts, which reopens the visually adjacent assistantText row in the same turn;
// clients still observe only standard row.upserted + row.delta.
export const assistantTextRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("assistantText"),
  // Body and tools from the same model response share this ID; optional for old snapshot compatibility.
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted", "failed"]),
  model: z.string().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  // Display-only pin bookmark (unix ms, CLI clock); presence means pinned. Not injected into agent context.
  pinnedAt: z.number().optional(),
});
export type AssistantTextRow = z.infer<typeof assistantTextRowSchema>;

export const reasoningRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("reasoning"),
  // Reasoning, body, and tools from the same model response share this ID; optional for old snapshot compatibility.
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted"]),
  durationMs: z.number().optional(),
});
export type ReasoningRow = z.infer<typeof reasoningRowSchema>;

// Tool-call display schemas moved to ./toolDisplay.ts (rows.ts is subject to max-lines).
import { toolCallDisplaySchema, toolOutputSchema, toolProgressSchema } from "./toolDisplay.js";

export const cuaAppIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().trim().min(1).max(256),
    bundleId: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type CuaAppIdentity = z.infer<typeof cuaAppIdentitySchema>;

export const toolCallRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("toolCall"),
  // Body and tools from the same model response share this ID; optional for old snapshot compatibility.
  assistantResponseId: z.string().min(1).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"]),
  inputText: z.string(),
  input: z.unknown().optional(),
  cuaApp: cuaAppIdentitySchema.optional(),
  output: toolOutputSchema.optional(),
  // If display parsing fails, discard only this card's payload, not the whole row (see the toolOutputSchema
  // comment in toolDisplay.ts: decorative payload must not determine the fate of a row/frame/subscription).
  display: toolCallDisplaySchema.optional().catch(undefined),
  // (2026-09-12): the former widgetState / widgetStateVisibility fields were removed; plugin UI view state no longer goes into rows.
  // Required when status=error.
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // Present while running (ToolCallProgress events); cleared on terminal state.
  progress: toolProgressSchema.optional(),
  // Bounded Bash content shared by continuous/replayable; cleared on terminal state or background handoff.
  outputPreview: executionOutputPreviewSchema.optional(),
  // Points to a pendingInteractions entry when status=pendingApproval.
  approvalInteractionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type ToolCallRow = z.infer<typeof toolCallRowSchema>;

// Share artifacts are part of the official conversation projection; ref is a Host-authorized read reference in local projection.
// Public share projections must replace it with zcode-artifact://share/:id and must not expose local paths.
export const conversationArtifactTypeSchema = z.enum([
  "pdf",
  "pptx",
  "docx",
  "xlsx",
  "image",
  "html",
  "md",
  "text",
]);
export type ConversationArtifactType = z.infer<typeof conversationArtifactTypeSchema>;

export const artifactRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("artifact"),
  artifactVersionId: z.string().trim().min(1),
  logicalArtifactKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  artifactType: conversationArtifactTypeSchema,
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  ref: z.string().trim().min(1),
  state: z.literal("current"),
});
export type ArtifactRow = z.infer<typeof artifactRowSchema>;

// subagent. Prerequisite: subagent mirror events must be included in the event log.
export const subagentRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("subagent"),
  // Agent/Task tool call that triggered this subagent; concurrent spawn order cannot be used for correlation.
  parentToolCallId: z.string().optional(),
  subagentType: z.string(),
  status: z.enum(["running", "success", "failed", "cancelled"]),
  summaryText: z.string(),
  // Present → UI can drill down by subscribing to conversation/<childSessionId> (child rows are not embedded).
  childSessionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type SubagentRow = z.infer<typeof subagentRowSchema>;

// Hook runtime descriptor is used only for CLI event/projection input compatibility. Conversation wire rows use the client-safe summary below;
// it carries no commands, absolute paths, stdin/stdout/stderr, tool input, or environment variables.
export const hookExecutionDescriptorSchema = z
  .object({
    clientVisible: z.literal(true),
    sourceKind: z.enum(["user", "plugin", "project", "internal"]),
    sourcePath: z.string().optional(),
    pluginId: z.string().optional(),
    pluginName: z.string().optional(),
    statusMessage: z.string().optional(),
    executionType: z.enum(["process", "command"]),
    executionMode: z.enum(["foreground", "background"]),
    commandDisplay: z.string(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type HookExecutionDescriptor = z.infer<typeof hookExecutionDescriptorSchema>;

export const hookExecutionProjectionSchema = z
  .object({
    hookRunId: z.string().min(1),
    hookIndex: z.number().int().nonnegative(),
    // True only after HookRunStarted has been observed for this runId; admission-only blocked is false.
    didExecute: z.boolean(),
    state: z.enum(["running", "completed", "failed"]),
    outcome: z.enum(["success", "blocked", "failed", "cancelled", "timed_out"]).optional(),
    blockReason: z.string().trim().min(1).optional(),
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
    displayName: z.string().trim().min(1),
    sourceKind: z.enum(["user", "plugin", "project"]),
    pluginName: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export type HookExecutionProjection = z.infer<typeof hookExecutionProjectionSchema>;

export const hookInvocationRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("hookInvocation"),
  hookInvocationId: z.string().min(1),
  hookEventName: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]),
  hookCount: z.number().int().positive(),
  state: z.enum(["running", "completed", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  lane: z.enum(["assistantWork", "toolBefore", "toolAfter"]),
  anchorToolCallId: z.string().optional(),
  executions: z.array(hookExecutionProjectionSchema),
});
export type HookInvocationRow = z.infer<typeof hookInvocationRowSchema>;

// timelineMarker.
// compact.status=cancelled means auto compact was stopped; failed is a failure terminal state.
export const timelineMarkerPayloadSchema = z.union([
  z.object({
    type: z.literal("compact"),
    origin: z.enum(["manual", "auto"]),
    status: z.enum(["running", "success", "failed", "noop", "cancelled"]),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    summaryRef: z.string().optional(),
  }),
  // Appears at the beginning of a child session (forkTimelineIsBoundary).
  z.object({
    type: z.literal("forkNotice"),
    parentSessionId: z.string(),
    parentRowId: z.number(),
  }),
  // Appears in the parent (optional display).
  z.object({
    type: z.literal("forkCreated"),
    childSessionId: z.string(),
    atRowId: z.number(),
  }),
  z.object({
    type: z.literal("modelChange"),
    fromProvider: z.string(),
    fromModel: z.string(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("modelChange"),
    // An explicit ∅→X model boundary has no source; never ensures the two source fields cannot appear alone,
    // preventing the renderer from receiving a partial provider/model tuple.
    fromProvider: z.never().optional(),
    fromModel: z.never().optional(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("goalSet"),
    objective: z.string(),
    previousObjective: z.string().optional(),
  }),
  z.object({
    type: z.literal("goalVerify"),
    iteration: z.number(),
    outcome: z.enum(["running", "pass", "notSatisfied", "failed"]),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("retryNotice"),
    attempt: z.number(),
    reasonCode: z.string(),
  }),
  // Receipt in the timeline for a workspace-scoped action.
  z.object({
    type: z.literal("checkpointRestored"),
    checkpointId: z.string(),
  }),
]);
export type TimelineMarkerPayload = z.infer<typeof timelineMarkerPayloadSchema>;

/**
 * Marker lane:
 * CLI projection decides placement semantics; UI assembles by lane and must not infer by marker type.
 * - assistantWork: assistant work activity (compact), placed in the “worked” collapsed group;
 * - turnTailBoundary: turn-tail boundary (goalVerify/forkNotice), remains at the end of the turn and is not collapsed;
 * - lightBoundary: light boundary at the start of a turn (modelChange), rendered before user input.
 * Optional for old snapshot compatibility (when absent, UI falls back to mapping by marker type).
 */
export const timelineMarkerLaneSchema = z.enum([
  "assistantWork",
  "turnTailBoundary",
  "lightBoundary",
]);
export type TimelineMarkerLane = z.infer<typeof timelineMarkerLaneSchema>;

export const timelineMarkerRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("timelineMarker"),
  // Required for user-triggered markers.
  sourceCommandId: z.string().optional(),
  lane: timelineMarkerLaneSchema.optional(),
  marker: timelineMarkerPayloadSchema,
});
export type TimelineMarkerRow = z.infer<typeof timelineMarkerRowSchema>;

export const conversationRowSchema = z.discriminatedUnion("kind", [
  turnHeaderRowSchema,
  userInputRowSchema,
  assistantTextRowSchema,
  reasoningRowSchema,
  toolCallRowSchema,
  artifactRowSchema,
  subagentRowSchema,
  hookInvocationRowSchema,
  timelineMarkerRowSchema,
]);
export type ConversationRow = z.infer<typeof conversationRowSchema>;
export type ConversationRowKind = ConversationRow["kind"];
