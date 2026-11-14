import {
  createSessionPayloadSchema,
  worktreeCreationRecordSchema,
  type WorktreeCreationRecord,
} from "./create-session-command.js";
import { genUiModelContextSchema } from "../gen-ui/contract.js";
import { createSessionRequestedConfigSchema } from "./create-session-config.js";
import { localTtftContextSchema, localTtftClockSchema } from "../local-ttft/contract.js";
import { conversationQuotesSchema } from "../conversationSelection.js";
// Command layer: envelope / ACK / complete command payload set.
// Conversation rewind has no separate command (decision: it is the UI entry point for editUserQuery);
// workspace-only file rollback uses applyFileRewind and does not truncate chat history.
import { z } from "zod";
import * as worktreePreparationCommand from "./worktree-preparation-command.js";
import {
  conversationRowTargetSchema,
  timestampSchema,
  v4ColdResumeWorkspaceSchema,
} from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { turnHeaderRowSchema } from "./rows.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { botGroupInputSourceSchema, zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import {
  amendWorkflowRunSettingsPayloadSchema,
  amendWorkflowRunSettingsResultSchema,
} from "./workflow-run-settings-command.js";
import {
  workspaceHookReviewCommandTargetSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookTrustRevokeTargetSchema,
  requestWorkspaceHookReviewTargetSchema,
} from "./workspace-hook-review.js";
import { zcodeBrowserAmbientContextSchema } from "../zcode-protocol/index.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";
import { conversationInputSourceSchema } from "./input-intent.js";
export type { SharedContextRef } from "./shared-context-ref.js";
export * from "./workflow-command-rejections.js";

// Defined next to createSessionPayloadSchema, which also uses it.
export { worktreeCreationRecordSchema, type WorktreeCreationRecord };

/**
 * forkAssistant places the child session in another cwd under the same workspace (managed worktree, §8.2).
 * childSessionId is pre-allocated by the Host. strict: undeclared fields are rejected, never silently dropped.
 */
export const forkTargetCwdSchema = z
  .object({
    cwd: z.string().trim().min(1),
    childSessionId: z.string().trim().min(1),
    worktreeCreation: worktreeCreationRecordSchema,
  })
  .strict();
export type ForkTargetCwd = z.infer<typeof forkTargetCwdSchema>;

// Execution-material invariant shared by sendText / editUserQuery / sendQueuedNow: modelExecution may only accompany
// this request's modelSelection; never provide credentials without a Selection (do not reuse credentials after rewinding a historical message).
function requireModelSelectionForExecution(
  payload: { modelSelection?: unknown; modelExecution?: unknown },
  context: z.RefinementCtx,
): void {
  if (payload.modelExecution && !payload.modelSelection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modelExecution requires modelSelection",
      path: ["modelExecution"],
    });
  }
}

// ── §6.4 Complete command payload set ──
export const commandPayloadSchemas = {
  // Without firstInput → empty session at phase=draft; with it → create turnHeader + userInput rows directly.
  createSession: createSessionPayloadSchema,
  updateWorktreePreparation: worktreePreparationCommand.updateWorktreePreparationPayloadSchema,
  // Parent session is specified by envelope.sessionId; the server derives the full runtime config from the parent record.
  // If firstInput exists, start the first normal input as soon as the child is created; otherwise leave an empty side panel.
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // Applying a recommendation overrides only the new child's full selection; when absent, retain the parent's runtime selection.
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // Decision follows inputRouting: startNow / enqueue / guide / choice.
  // heldQueueDisposition is required in held state (inputRouting.mode=choice):
  // clear → clear the queue then startNow; keep → retain the queue and startNow immediately.
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter overrides only this busy input and does not change session followupMode.
      // CLI atomically takes over the current turn for startNow without queue admission.
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      genUiContext: genUiModelContextSchema.optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover allows only one imported context for the current session; runtime resolves the full body from
      // persisted provenance, which must not be passed by the renderer in the command.
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      // Structured source (plugin UI, interactive view, session, extension); persisted with the intent and projected onto the userInput row.
      source: conversationInputSourceSchema.optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // Set of queueItemIds shown when the pause-queue confirmation dialog opened. CLI validates before applying clear/keep
      // to prevent concurrent additions/removals on Desktop/mobile from causing an unconfirmed queue item to be discarded.
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // Older senders may omit these during migration; CLI admission fixes the current Session Selection into
      // the canonical intent. After the renderer migration, first-party user submissions always include both explicitly.
      modelSelection: modelSelectionSchema.optional(),
      // Bot 异步解析的读取依据；接纳时若已变化，固定最新 Session Selection。
      modelSelectionBasis: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // This execution still uses the standard Selection above; this carries only non-persistent semantics, dynamic auth, and child policy.
      // Accepted only for idle startNow, preventing Secret/Ticket from entering the ordinary CommandInbox.
      modelExecution: modelExecutionSchema.optional(),
      // The Highspeed card snapshot is stored in message.data with the input facts; runtime credentials and headers are excluded.
      // The model and credentials used to accelerate this turn go through modelSelection + modelExecution above; see
      // docs/highspeed/highspeed-access-mode-migration.md.
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // Bot source is injected only by Host, so CronCreate can read and persist the reply address during this turn.
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      inputOrigin: z.enum(["desktop", "mobile"]).optional(),
      botGroupSource: botGroupInputSourceSchema.optional(),
      conversationQuotes: conversationQuotesSchema.optional(),
      // Later user inputs in a scheduled-task session must also retain turn-scoped tool-surface isolation; do not reuse
      // automationId, which would incorrectly mark ordinary user input as an automation dispatch.
      toolDisallowlist: z.array(z.string().min(1)).optional(),
      // Submission id of the frozen first sendText of a reserved plain submission (set by the renderer on
      // the first attempt and every retry). Only this sendText may complete its durable preparation; a
      // sendText without it, or with another id, never does (specs/first-submission-instant-ux.md).
      firstSubmissionId: z.string().min(1).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.automationId && payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "automationId and offPeakTaskId are mutually exclusive",
        });
      }
      if (payload.offPeakRunType && !payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offPeakRunType requires offPeakTaskId",
          path: ["offPeakRunType"],
        });
      }
      requireModelSelectionForExecution(payload, context);
    }),
  sendGoalCommand: z.object({
    text: z.string(),
    displayText: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
    expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
  }),
  stop: z.object({
    // From activeWorks; CLI uses it to reject a late Stop that could otherwise kill an unrelated later execution.
    expectedForegroundExecutionId: z.string().min(1).optional(),
  }),
  stopSubagent: z
    .object({
      taskId: z.string().min(1),
      executionId: z.string().min(1),
    })
    .strict(),
  // compact is an input-style maintenance command: execute immediately when idle, enqueue FIFO when busy/held.
  // Admission is unrelated to the current revision, so it does not use CAS; sourceCommandId provides the idempotency boundary.
  compact: z.object({ modelSelection: modelSelectionSchema.optional() }),
  // Available for the stable assistant row while running.
  forkAssistant: z.object({
    target: conversationRowTargetSchema,
    // The child session stays in the same workspace with its cwd moved to a new managed worktree (docs/git/worktree.md §8.2).
    // Default = parent session cwd, behavior unchanged. An older CLI silently drops this field and forks into the parent directory,
    // so the Host must confirm runtime/capabilities.worktreeCwd before sending.
    // Additional directories are not sent here: the Host sends them uniformly on child create/resume/subscribe (I16).
    targetCwd: forkTargetCwdSchema.optional(),
  }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z
    .object({
      target: conversationRowTargetSchema,
      newText: z.string(),
      conversationQuotes: conversationQuotesSchema.optional(),
      attachments: z.array(attachmentRefSchema).optional(),
      // An edit-and-resend is handled as a new active send: it accepts only the card and execution material from this fresh prepare,
      // and never reuses old credentials from the rewound history message.
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      // The default is preserve: it only switches the conversation branch; rewind first restores that turn's files safely.
      workspaceMode: z.enum(["preserve", "rewind"]).optional(),
      // Composer edit mode reuses the send toolbar: same semantics as sendText; defaults to the original intent.
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  // (2026-09-12): the former setToolWidgetState / setSessionPluginUiState commands were removed—plugin UI widgetState
  // is now kept in host renderer memory and no longer written to CLI session storage; model-visible information uses ui/update-model-context.
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  // Display-only pin bookmark on the final assistant text segment or a real user input; persisted in the
  // session transcript, never injected into agent context. Toggle semantics: pinned=false unpins.
  setRowPinned: z.object({
    target: conversationRowTargetSchema,
    pinned: z.boolean(),
  }),
  setHighspeedMetrics: z.object({
    target: conversationRowTargetSchema,
    regularTps: z.number().positive(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    highspeedTps: z.number().positive(),
    savedDurationMs: z.number().nonnegative(),
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
  }),
  sendQueuedNow: z
    .object({
      queueItemId: z.string(),
      // Manual promotion lets the Renderer add execution materials for the same card to the original queued item; credentials are not persisted in the queue.
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  // Frozen edit (docs/ui/composer-edit-mode.md): lock succeeds only for a queued item without a lock;
  // editQueueItem carrying editorId must hold the lock; after the in-place replacement the same command releases it.
  // attachments/modelSelection/mode/planEnabled default to keeping the original values; attachments=[] clears them.
  lockQueueItemEdit: z.object({ queueItemId: z.string(), editorId: z.string().min(1) }),
  releaseQueueItemEdit: z.object({ queueItemId: z.string() }),
  editQueueItem: z.object({
    queueItemId: z.string(),
    newText: z.string(),
    editorId: z.string().min(1).optional(),
    attachments: z.array(attachmentRefSchema).optional(),
    conversationQuotes: conversationQuotesSchema.optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
  }),
  // After an edit is submitted, apply the new model/mode to other queued items (docs/ui/composer-edit-mode.md): body and Plan unchanged;
  // items that do not exist, are not queued, are compact, or hold an edit lock are skipped; skipping all = noop. No CAS, for the same reason as editQueueItem.
  applyQueueItemsConfig: z
    .object({
      queueItemIds: z.array(z.string()).min(1),
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
    })
    .refine((value) => value.modelSelection !== undefined || value.mode !== undefined, {
      message: "applyQueueItemsConfig requires modelSelection or mode",
    }),
  // beforeQueueItemId = null → move to the end of the queue.
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // First to arrive wins; later requests are no-ops (reasonCode=proto.alreadyResolved).
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // Elicitation response convergence: carry AskUserQuestion/plan-approval multi-question answers and annotations without loss.
      // When action is present, CLI broker maps accept/decline/cancel precisely (content passes through with legacy userInput response semantics); when absent, use the
      // compatible optionId/freeText path and preserve old-client behavior.
      action: z.enum(["accept", "decline", "cancel"]).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  respondWorkspaceHookReview: workspaceHookReviewCommandTargetSchema.extend({
    decision: workspaceHookReviewDecisionSchema,
  }),
  toggleWorkspaceHookReviewItem: workspaceHookReviewCommandTargetSchema.extend({
    reviewItemId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  revokeWorkspaceHookTrust: z.union([
    workspaceHookReviewCommandTargetSchema.extend({
      reviewItemIds: z.array(z.string().trim().min(1)).min(1),
    }),
    workspaceHookTrustRevokeTargetSchema,
  ]),
  // Soft gate: open the review flow when needed; clone revokes the non-flow target but does not include hookDeclarationDigests.
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // First valid AskUserQuestion action permanently pauses this auto-finish; duplicate/late calls are idempotent no-ops.
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // Additive (evolution of the frozen surface is backed by golden tests): switch agent collaboration mode.
  // Values = the switchable subset of core CollaborationMode (auto is not user-switchable and is excluded from the UI command surface).
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]),
  }),
  // Additive (specs/acp-agent-runtime.md "S6"): the user's choice for one select of the session's
  // ACP agent. The worker stores it and applies it before the next prompt; a running turn is never
  // touched. `sessionId` repeats the envelope's session and must equal it. No baseRevision: the choice
  // does not depend on the conversation revision, and a same value is a no-op (config.unchanged).
  setExternalAgentConfigOption: z
    .object({
      sessionId: z.string().min(1),
      configId: z.string().min(1),
      value: z.string().min(1),
    })
    .strict(),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // Cancel & resume: resume a dwf run cancelled by the user or interrupted by process death. workId ≡ runId
  // (same identity as cancelBackgroundWork); optional `name` supplies the completion-notification subject after resume (the original CreateWorkflow tool input is unavailable after restart).
  // Intentionally omits baseRevision, like cancelBackgroundWork (workflowRuns is revision-free; false CAS failures would only hurt).
  // The CLI gates it (resumable set = cancelled ∪ failed+Interrupted); rejection returns ACK with
  // fault.command.workflowRunResumeRejected.<reason>.
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow: the hub’s “Run” action no longer synthesizes
  // dialogue text; it directly asks the agent to start the saved workflow in a new session. Like cancelBackgroundWork / resumeWorkflowRun,
  // it does not carry baseRevision (workflowRuns are revision-free, and a false CAS failure would be harmful). The agent fills in name from the
  // parsed result (invariant 6); the command does not accept a name override.
  // Rejections return an ACK with fault.command.savedWorkflowStartRejected.<reason> (the allowed values are defined below in
  // workflow-command-rejections.ts in savedWorkflowStartRejectionReasonSchema); missing capability (no DWF port) → V4CapabilityUnsupportedError
  // (the same error used by resumeWorkflowRun).
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings: “Configure” on a run card/details page asks the agent to revise the run with new settings directly, without a model turn. Payload, result, and rejection
  // vocabulary are in workflow-run-settings-command.ts; missing capability → V4CapabilityUnsupportedError.
  amendWorkflowRunSettings: amendWorkflowRunSettingsPayloadSchema,
  renameSession: z.object({ title: z.string() }),
  deleteSession: z.object({}),
  discardSharedContext: z.object({ contextId: z.string().trim().min(1) }).strict(),
} as const;

export type CommandType = keyof typeof commandPayloadSchemas;
export type CommandPayloadMap = {
  [T in CommandType]: T extends "sendText"
    ? z.infer<(typeof commandPayloadSchemas)[T]> &
        import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution
    : z.infer<(typeof commandPayloadSchemas)[T]>;
};

export const commandTypeSchema = z.enum(
  Object.keys(commandPayloadSchemas) as [CommandType, ...CommandType[]],
);

// cancelBackgroundWork rejection: when core explicitly reports “nothing was cancelled” (task missing / already terminal / unsupported type),
// return prefix + reason instead of a falsely successful accepted response — the details page can tell users the run is not running.
// reason is core's stopBackgroundTask reason with `background_task_` removed: not_found / not_running / cancel_not_supported.
export const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX =
  "fault.command.backgroundWorkCancelRejected." as const;

// Commands with CAS: envelope must include baseRevision.
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "setRowPinned",
  "sendQueuedNow",
  // editQueueItem 不走 CAS：运行中 revision 随 control/queue 投影频繁递增，用户编辑排队消息的提交
  // 会被 proto.staleRevision 误拒。冻结编辑的并发保护是 CLI 编辑锁（editorId 必须仍持锁）。
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "setRowPinned",
  "setHighspeedMetrics",
]);

// ── Envelope ──
export const commandEnvelopeSchema = z.object({
  workspace: v4ColdResumeWorkspaceSchema,
  /** Injected by the Host only, based on the current attachment handshake; unknown CLIs do not receive it. */
  pluginDiscoveryUi: z.literal(true).optional(),
  /** Trusted attachment injection by the Host; the CLI keeps it through to the original input intent. */
  inputOrigin: z.enum(["desktop", "mobile"]).optional(),
  ttft: localTtftContextSchema.optional(),
  // UUID v7, generated by the client and stable across retries.
  commandId: z.string(),
  clientId: z.string(),
  // Null for createSession.
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // Client clock for telemetry only; server does not use it for decisions.
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Validate the envelope and payload by type (the envelope schema cannot statically associate payload, so validation is centralized here). */
export function parseCommandEnvelope(
  value: unknown,
): { ok: true; envelope: CommandEnvelope } | { ok: false; error: z.ZodError } {
  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false, error: envelope.error };
  const payload = commandPayloadSchemas[envelope.data.type].safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error };
  if (
    (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.data.type) &&
      envelope.data.baseRevision === undefined) ||
    (ROW_TARGETING_COMMANDS.has(envelope.data.type) && envelope.data.baseLogEpoch === undefined)
  ) {
    return {
      ok: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: [envelope.data.baseRevision === undefined ? "baseRevision" : "baseLogEpoch"],
          message: "CAS commands require baseRevision and baseLogEpoch",
        },
      ]),
    };
  }
  return {
    ok: true,
    envelope: { ...envelope.data, payload: payload.data },
  };
}

// ── ACK ──
/** 同一审批已提交后的重试原因码。只有原权限可继续发布，不得据失败回执更新偏好。 */
export const permissionGrantCommittedReasons = {
  guarded: "fault.permissionGrant.committed.guarded",
  yolo: "fault.permissionGrant.committed.yolo",
} as const;
export function committedPermissionGrantMode(reasonCode: string | undefined) {
  if (reasonCode === permissionGrantCommittedReasons.guarded) return "guarded";
  if (reasonCode === permissionGrantCommittedReasons.yolo) return "yolo";
  return undefined;
}

export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    // Prepared-worktree activation outcome (createSession with preparedSessionId only). Closed
    // enum: an unknown value fails the ACK parse instead of being stripped into a guess.
    //  - materialized / input-pending: the frozen input is not admitted yet; the sender dispatches it.
    //  - input-admitted: the frozen input is durably admitted under the command id the sender named
    //    (expectedFirstInputCommandId); the sender must not resend it.
    //  - already-active: the preparation is active, which another input can cause. It does not prove the
    //    frozen input was admitted; the sender dispatches it unless input-admitted was returned.
    preparedActivation: z
      .enum(["materialized", "input-pending", "input-admitted", "already-active"])
      .optional(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK does not wait for TurnStarted; messageId may be filled in by a later event.
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  worktreePreparationCommand.worktreePreparationUpdatedResultSchema,
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // Retain fork only for legacy ACK decoding compatibility; new editUserQuery no longer creates a child session.
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK:
    // runId joins the launch turn's run-card state / notification / sidebar; toolCallId = launch-<uuid>, joining the synthetic CreateWorkflow turn.
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId is filled as side-channel attribution only after TurnStarted; Core admission ACK does not wait for
    // projection commit, so messageId cannot be required for input acceptance.
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // Previously, restart discarded returned an undifferentiated fault, so the renderer could not distinguish
    // a runtime-local queue from a startNow that still needed user confirmation. Delivery comes from the persisted session_input
    // fact and cannot be guessed by the client from the current UI phase.
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** App Memory setting used when creating the session; absent from older senders means unknown. */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted does not promise survival across CLI processes; final reconciliation uses the authoritative sourceCommandId.
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // Required for rejected/stale/noop/failed; guard ID or fault code (namespace).
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // Cached result for duplicate replay; accepted may also be returned immediately (fork).
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
/**
 * commands/query 读取命令记录失败时的 reasonCode（status 为 failed）。它表示"无法确认命令是否执行"，
 * 不表示命令执行失败；调用方不能据此做破坏性清理（docs/git/worktree.md §3.5）。
 */
export const COMMAND_QUERY_UNAVAILABLE_REASON = "fault.command.queryUnavailable" as const;
export const commandKeySchema = z
  .object({
    // null belongs only to the global/createSession idempotency bucket; session commands must include sessionId.
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

// 命令对应回合的当前状态：owner 全量投影中 sourceCommandId 匹配的第一个 turnHeader。
// 修复原因：快照只下发 60 行尾窗，长回合的 header 会滚出窗口，客户端据此判定 wait 结果会得到
// unknown，审批也匹配不到回合。由 owner 直接给出，不受尾窗限制；只出现在 session bucket。
export const commandQueryTurnSchema = z
  .object({
    turnId: turnHeaderRowSchema.shape.turnId,
    state: turnHeaderRowSchema.shape.state,
  })
  .strict();
export type CommandQueryTurn = z.infer<typeof commandQueryTurnSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
    turn: commandQueryTurnSchema.optional(),
  })
  .strict()
  .refine((item) => !item.turn || item.key.sessionId !== null, "global commands carry no turn");
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
