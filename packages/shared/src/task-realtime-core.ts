/* oxlint-disable eslint(max-lines) -- Re-homed artifact: task realtime runtime schemas were migrated here so types and validation stay together. */
// Re-homed migration artifact (prepares for removal of the legacy protocol tree).
// This file contains runtime schemas and resolveWorkspaceKey still used by the live stack
// for the task realtime transport surface (external relay payload validation in validation.ts).
// task-realtime.ts retains legacy protocol compatibility interfaces; this file centralizes their runtime schemas.

import { z } from "zod";
import type { ZCodeTaskMigrationSource, ZCodeTaskMode } from "./zcode-task-types-core.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { zcodePermissionResponseSchema } from "./zcode-protocol-legacy-types.js";
// Merge-conflict resolution: both sides added separate imports on adjacent lines (this branch's hook trust review
// decision schema and staging telemetry error-attribution schema); they do not overlap semantically, so keep both.
import { workspaceHookReviewDecisionSchema } from "./zcode-protocol-v4/workspace-hook-review.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";

const nonEmptyString = z.string().trim().min(1);
const zcodeTaskModeRealtimeValues = [
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
] as const satisfies readonly ZCodeTaskMode[];
const zcodeTaskMigrationSourceRealtimeValues = [
  "claudeCode",
] as const satisfies readonly ZCodeTaskMigrationSource[];
const zcodeTaskChangeSummaryRealtimeSchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const taskMetaRealtimeSchema = z.object({
  taskId: nonEmptyString,
  traceId: nonEmptyString,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  titleUpdatedAt: z.number().int().nonnegative().optional(),
  workspacePath: nonEmptyString,
  workspaceIdentity: nonEmptyString.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  // The runtime schema for realtime delivery previously widened mode to string,
  // so the inferred schema type no longer narrowed back to ZCodeTaskMeta and host typechecking could not cover this path.
  mode: z.enum(zcodeTaskModeRealtimeValues),
  model: z.string().optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // Relay payloads may be projected by older desktop versions; normalize historical provider values to glm here.
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: z.enum(zcodeTaskMigrationSourceRealtimeValues).optional(),
  forkedFromTaskId: nonEmptyString.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: z.enum(["running", "completed", "error"]).optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyString.optional(),
      taskId: nonEmptyString.optional(),
      // The legacy realtime schema silently stripped lastError.attribution, causing mobile replayable
      // task metadata attribution to differ from the desktop snapshot; reuse the shared schema here to keep wire constraints consistent.
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  changeSummary: zcodeTaskChangeSummaryRealtimeSchema.optional(),
});
export function resolveWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath;
}
export const taskRealtimeReasonSchema = z.enum([
  "task_created",
  "user_message_saved",
  "assistant_message_saved",
  "task_status_changed",
  "task_meta_changed",
  // Keep pure configuration changes such as model switches as a separate reason so they are not treated as ownership-related metadata changes that refresh the whole list.
  "task_model_changed",
  // Title updates (first message/automatic title) are frequent and unrelated to ownership; a separate reason avoids reloading global membership.
  "task_title_changed",
  "task_pinned",
  "task_unpinned",
  "task_archived",
  "task_unarchived",
  "task_deleted",
  "stream_mirror_gap",
  "stream_mirror_owner_lost",
]);
export const taskRealtimeDeliveryPurposeSchema = z.enum(["observer", "relay_owner"]);
export const taskRealtimeHostDeliveryKindSchema = z.enum(["desktop_window", "relay_bridge"]);
const taskRealtimeEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    traceId: nonEmptyString,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
const taskStreamWatermarkSchema = z
  .object({
    runId: nonEmptyString,
    opSeq: z.number().int().nonnegative(),
  })
  .strict();
const taskRealtimeInvalidationBaseEventSchema = taskRealtimeEnvelopeSchema
  .extend({
    reason: taskRealtimeReasonSchema,
    streamWatermark: taskStreamWatermarkSchema.optional(),
  })
  .strict();
const addWorkspaceKeyIssue = (
  ctx: z.RefinementCtx,
  event: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
) => {
  const expectedWorkspaceKey = resolveWorkspaceKey(event);
  if (event.workspaceKey !== expectedWorkspaceKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workspaceKey"],
      message: "workspaceKey must match workspaceIdentity fallback rule",
    });
  }
};
const addRunIdTraceIdIssue = (ctx: z.RefinementCtx, target: { runId: string; traceId: string }) => {
  if (target.runId !== target.traceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "runId must match traceId",
    });
  }
};
export const taskSnapshotInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("task_snapshot_invalidated"),
    taskId: nonEmptyString,
  })
  .strict();
export const workspaceTaskListInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("workspace_task_list_invalidated"),
    taskId: nonEmptyString.optional(),
    taskMeta: taskMetaRealtimeSchema.optional(),
  })
  .strict();
const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("audio"),
      filename: z.string(),
      mimeType: z.string(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  // When video was added as an attachment type, the replayable schema was not updated and mobile remote control rejected valid attachments.
  z
    .object({
      kind: z.literal("video"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      dataBase64: z.string().optional(),
      textContent: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
]);
const taskStreamMirrorableEventSchema = z
  .object({
    type: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
  })
  .passthrough();
const taskStreamMirrorUserMessagePublishOpSchema = z
  .object({
    kind: z.literal("user_message"),
    messageId: nonEmptyString,
    content: z.string(),
    attachments: z.array(zcodePromptAttachmentSchema).optional(),
    timestamp: z.number().finite(),
  })
  .strict();
const taskStreamMirrorStreamEventPublishOpSchema = z
  .object({
    kind: z.literal("stream_event"),
    event: taskStreamMirrorableEventSchema,
  })
  .strict();
export const taskStreamMirrorPublishOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema,
  taskStreamMirrorStreamEventPublishOpSchema,
]);
export const taskStreamMirrorOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
  taskStreamMirrorStreamEventPublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
]);
const taskStreamMirrorTargetRawSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
    traceId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
  })
  .strict();
export const taskStreamMirrorTargetSchema = taskStreamMirrorTargetRawSchema.superRefine(
  (target, ctx) => {
    addWorkspaceKeyIssue(ctx, target);
    addRunIdTraceIdIssue(ctx, target);
  },
);
const taskStreamMirrorBatchEventRawSchema = taskRealtimeEnvelopeSchema
  .extend({
    type: z.literal("task_stream_mirror_batch"),
    taskId: nonEmptyString,
    runId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
    batchSeq: z.number().int().positive(),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    ops: z.array(taskStreamMirrorOpSchema),
    terminal: z.boolean(),
  })
  .strict();
export const taskRunLeaseTargetSchema = taskStreamMirrorTargetSchema;
export const taskRunLeaseAcquireRequestSchema = taskStreamMirrorTargetRawSchema
  .extend({
    leaseRequestId: nonEmptyString,
  })
  .strict()
  .superRefine((request, ctx) => {
    addWorkspaceKeyIssue(ctx, request);
    addRunIdTraceIdIssue(ctx, request);
  });
export const taskRunLeaseResultSchema = z.discriminatedUnion("acquired", [
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(true),
      ownerHostId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(false),
      ownerHostId: nonEmptyString,
      reason: z.literal("owned_by_other_host"),
    })
    .strict(),
]);
const taskOwnerCommandBaseSchema = z
  .object({
    commandRequestId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
  })
  .strict();
const taskStopGenerationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("stop_generation"),
  })
  .strict();
const taskRespondPermissionOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_permission"),
    permissionRequestId: nonEmptyString,
    optionId: nonEmptyString,
    response: zcodePermissionResponseSchema,
  })
  .strict();
const taskRespondElicitationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_elicitation"),
    elicitationRequestId: nonEmptyString,
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const taskRespondWorkspaceHookReviewOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_workspace_hook_review"),
    remoteSessionId: nonEmptyString.optional(),
    sessionId: nonEmptyString,
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewFlowId: nonEmptyString,
    generation: z.number().int().positive(),
    interactionId: nonEmptyString,
    decision: workspaceHookReviewDecisionSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.remoteSessionId && !command.workspaceIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceIdentity"],
        message: "remote workspace Hook review response requires workspaceIdentity",
      });
    }
  });
const zcodeTaskRuntimeCommandBaseSchema = z
  .object({
    commandId: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    status: z.enum(["accepted", "running", "failed"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    clientId: nonEmptyString.optional(),
    clientLabel: nonEmptyString.optional(),
    error: z.string().optional(),
  })
  .strict();
const zcodeTaskRuntimeCommandSchema = z.discriminatedUnion("type", [
  zcodeTaskRuntimeCommandBaseSchema
    .extend({
      type: z.literal("send_prompt"),
      content: z.string(),
      attachments: z.array(zcodePromptAttachmentSchema).optional(),
      automationId: nonEmptyString.optional(),
    })
    .strict(),
]);
const taskEnqueueCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("enqueue_task_command"),
    taskCommand: zcodeTaskRuntimeCommandSchema,
  })
  .strict();
const taskPromoteCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("promote_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
const taskCancelCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("cancel_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
export const taskOwnerCommandRequestSchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema,
    taskRespondPermissionOwnerCommandRequestSchema,
    taskRespondElicitationOwnerCommandRequestSchema,
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema,
    taskEnqueueCommandOwnerCommandRequestSchema,
    taskPromoteCommandOwnerCommandRequestSchema,
    taskCancelCommandOwnerCommandRequestSchema,
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
export const taskOwnerCommandDeliverySchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondPermissionOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondElicitationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskEnqueueCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskPromoteCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskCancelCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
export const taskOwnerCommandErrorCodeSchema = z.enum([
  "NO_ACTIVE_TASK_OWNER",
  "STALE_TASK_OWNER_COMMAND",
  "OWNER_COMMAND_FAILED",
]);
export const taskOwnerCommandResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(true),
      taskCommand: zcodeTaskRuntimeCommandSchema.optional(),
    })
    .strict(),
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(false),
      error: z.string(),
      code: taskOwnerCommandErrorCodeSchema.optional(),
    })
    .strict(),
]);
export const taskRealtimeEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema,
    workspaceTaskListInvalidatedEventSchema,
    taskStreamMirrorBatchEventRawSchema,
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
export const taskRealtimeDeliveredEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    workspaceTaskListInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    taskStreamMirrorBatchEventRawSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
