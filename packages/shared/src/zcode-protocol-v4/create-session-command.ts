import { z } from "zod";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { incognitoProfileSchema } from "../incognito-profile.js";
import { modelSelectionSchema } from "../model-selection.js";
import { zcodeProtocolMcpServerSchema } from "../zcode-protocol/index.js";
import { zcodeExecutionWorktreeSchema } from "./execution-worktree.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { createSessionRequestedConfigSchema } from "./create-session-config.js";
import { submissionModeSchema } from "./submission.js";
import { conversationInputSourceSchema } from "./input-intent.js";
import * as worktreePreparationCommand from "./worktree-preparation-command.js";

/**
 * Result of managed worktree creation (docs/git/worktree.md §6.6.4). The CLI writes it as a
 * timeline part in session history (timelineType = "worktree_creation"); V4 projects it as a worktreeCreated marker.
 */
export const worktreeCreationRecordSchema = z
  .object({
    /** Worktree root directory. */
    path: z.string().trim().min(1),
    /** Checked-out commit. */
    sha: z.string().trim().min(1),
    /** Start point chosen by the user; null = current HEAD of the source directory. */
    ref: z.string().min(1).nullable(),
    /** Tail of the git and copy output. */
    output: z.string().max(64 * 1024),
  })
  .strict();
export type WorktreeCreationRecord = z.infer<typeof worktreeCreationRecordSchema>;

/** `createSession` command payload (§6.4), split out of command.ts. */
export const createSessionPayloadSchema = z
  .object({
    // Host-reserved stable session id; the CLI still rejects overwriting an existing session.
    sessionId: z.string().min(1).optional(),
    additionalDirectories: z.array(z.string().min(1)).max(256).optional(),
    workspaceId: z.string(),
    // Session cwd differs from the workspace (managed worktree, docs/git/worktree.md §1.1). Local
    // workspaces only; only the Host worktree service may set it, and the Host rejects a renderer
    // createSession that carries it. Older CLI z.object schemas silently drop it, so the Host must
    // check capabilities.worktreeCwd first.
    cwd: z.string().trim().min(1).optional(),
    // Sent together with cwd: the CLI writes it as the first turn's "worktree created" timeline part.
    worktreeCreation: worktreeCreationRecordSchema.optional(),
    /** Reserve a submitted conversation before runtime startup or attachment upload. */
    submissionPreparation: z.object({ submissionId: z.string().min(1) }).optional(),
    /** Frozen submission identity required when materializing a generic reservation. */
    expectedSubmissionId: z.string().min(1).optional(),
    /**
     * Command id of the frozen first sendText an earlier attempt of this reserved submission already
     * created. The CLI admits-or-not by that identity (a session_input row with this sourceCommandId),
     * so a Retry after a rejected or lost attempt is never judged by another input's admission.
     */
    expectedFirstInputCommandId: z.string().min(1).optional(),
    ...worktreePreparationCommand.worktreePreparationCreateSessionFields,
    permissionScope: z.literal("session").optional(),
    firstInput: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentRefSchema).optional(),
        modelSelection: modelSelectionSchema.optional(),
        mode: submissionModeSchema.optional(),
        planEnabled: z.boolean().optional(),
        // Same contract as sendText.source (the first message of a session an extension creates).
        // Older CLI z.object schemas silently strip it and the message is created without a source,
        // so with an extension source the Host must check runtime/capabilities.extensionInputSource.
        source: conversationInputSourceSchema.optional(),
      })
      .optional(),
    config: createSessionRequestedConfigSchema.optional(),
    // Execution worktree: the agent runs in this linked worktree directory while the session stays
    // listed under workspaceId. Additive: older CLI z.object schemas silently drop this key
    // (fail-closed) and the session then executes in the parent workspace as before.
    executionWorktree: zcodeExecutionWorktreeSchema.optional(),
    // MCP is runtime startup configuration; include it in the record during create, not as a later write after first send.
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak tool-surface flag, equivalent to legacy session/create — V4 createSession is Desktop's
    // actual new-session path; without forwarding this, OffPeakCreate/OffPeakList are never registered. Additive:
    // older CLI z.object schemas silently drop this key (fail-closed).
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic workflow rollout flag, following the same pattern as offPeakToolEnabled.
    dynamicWorkflowEnabled: z.boolean().optional(),
    // Gray-release mode is sent alongside the boolean (launch.md “On demand: activation”); older CLIs silently discard it via z.object.
    dynamicWorkflowMode: z.enum(DYNAMIC_WORKFLOW_MODES).optional(),
    // Incognito profile (specs/incognito-session.md), frozen at creation. Unlike the additive flags
    // above, dropping it is not fail-closed: senders must gate on the incognitoSession capability.
    incognito: incognitoProfileSchema.optional(),
  })
  .superRefine((payload, context) => {
    if (
      payload.submissionPreparation &&
      (payload.worktreePreparation ||
        payload.preparedSessionId ||
        payload.expectedSubmissionId ||
        payload.firstInput ||
        payload.config ||
        payload.executionWorktree ||
        payload.permissionScope)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "submission reservation cannot include runtime or input settings",
        path: ["submissionPreparation"],
      });
    }
    if (
      payload.expectedSubmissionId &&
      (!payload.preparedSessionId || payload.expectedAttemptId || payload.worktreePreparation)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "submission activation requires only a prepared session and submission identity",
        path: ["expectedSubmissionId"],
      });
    }
    if (
      payload.expectedFirstInputCommandId &&
      (!payload.expectedSubmissionId || payload.executionWorktree || payload.firstInput)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "expectedFirstInputCommandId is valid only for a reserved submission activation (no worktree, no firstInput)",
        path: ["expectedFirstInputCommandId"],
      });
    }
    // The prepare step reserves the session row before any profile exists, and that reservation
    // write carries no profile — accepting both would silently persist a normal session that the
    // caller believes is incognito. The profile must arrive on the activation create instead
    // (`preparedSessionId`); rejecting is the only fail-closed option (specs/incognito-session.md).
    if (payload.worktreePreparation && payload.incognito) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "worktree preparation cannot include an incognito profile",
        path: ["incognito"],
      });
    }
  });
