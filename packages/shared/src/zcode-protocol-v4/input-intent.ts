import { genUiModelContextSchema } from "../gen-ui/contract.js";
import { conversationQuotesSchema } from "../conversationSelection.js";
import { botGroupInputSourceSchema } from "../bots.js";
// Self-contained input facts after CLI admission.
// Queue / guide / runtime / transcript must carry this same intent; individual layers must not rebuild its fields.
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";

/**
 * Structured origin of user input: attached when a plugin UI, interactive view, session, or extension sends on the user's behalf;
 * the stored card then shows the source. Absent means the user typed the input directly. Session and extension origins are injected
 * by the Host and never inferred from the body text; models and tools cannot set them.
 * Contract: apps/zcode-cli/docs/design/v2/conversation-input-source.md.
 */
const pluginUiInputSourceSchema = z
  .object({
    kind: z.literal("pluginUi"),
    pluginId: z.string().min(1),
    toolCallId: z.string().min(1),
  })
  .strict();
/**
 * Sent by an extension through ctx.sessions.* (docs/plugins/extension-host.md §17.8). Injected only by
 * the Window Host extension gateway. Older CLIs do not know it (sendText rejects the whole input,
 * createSession.firstInput silently strips it), so the Host must check
 * runtime/capabilities.extensionInputSource before sending. pluginId is self-reported by the extension
 * process and is used only for display and attribution.
 */
const extensionInputSourceSchema = z
  .object({
    kind: z.literal("extension"),
    pluginId: z.string().min(1),
  })
  .strict();
export const conversationInputSourceSchema = z.discriminatedUnion("kind", [
  pluginUiInputSourceSchema,
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.string().min(1),
      /**
       * 只读字段，仅服务改动前已持久化的数据（规格 0.13）。新数据不再写入它。
       *
       * 它曾是发送那一刻发起方的标题快照，而会话标题分三档（default / generated / custom）：
       * 跨会话发送多半发生在发起方第一轮进行中，此时还是 default 档——「标题」就是首条提示词
       * 原文。生成标题随后落定，快照却不回写，于是气泡永远显示一整段提示词。身份是 sessionId，
       * 标题是会变的派生展示字段，不该进持久化载荷。
       */
      title: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("genUi"),
      path: z.string().min(1).max(4096),
      title: z.string().max(250).optional(),
    })
    .strict(),
  extensionInputSourceSchema,
]);
export type ConversationInputSource = z.infer<typeof conversationInputSourceSchema>;

export const conversationInputDeliverySchema = z
  .object({
    requested: z.enum(["auto", "startNow", "queue", "guide"]),
    admitted: z.enum(["startNow", "queue", "guide"]),
    fallbackReasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputOrderSchema = z
  .object({
    admissionSeq: z.number().int().nonnegative(),
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

export const conversationInputSteerSchema = z
  .object({
    state: z.enum(["notRequested", "submitting", "steering", "guided", "fellBack"]),
    reasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputDispatchSchema = z
  .object({
    state: z.enum(["admitted", "queued", "reserved", "promoting", "drained"]),
    reservationId: z.string().optional(),
  })
  .strict();

export const conversationInputIntentSchema = z
  .object({
    inputOrigin: z.enum(["desktop", "mobile"]).optional(),
    botGroupSource: botGroupInputSourceSchema.optional(),
    conversationQuotes: conversationQuotesSchema.optional(),
    sourceCommandId: z.string().min(1),
    queueItemId: z.string().min(1),
    clientId: z.string().min(1),
    // compact is a queueable maintenance intent; when consumed, it follows the compact lifecycle and is not projected as a user row.
    kind: z.enum(["sendText", "sendGoalCommand", "compact"]),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).default([]),
    // optional exists only for hydrating old snapshots; new admissions must include a complete Submission.
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    genUiContext: genUiModelContextSchema.optional(),
    sharedContextRefs: z.array(sharedContextRefSchema).max(1).optional(),
    delivery: conversationInputDeliverySchema,
    order: conversationInputOrderSchema,
    steer: conversationInputSteerSchema,
    dispatch: conversationInputDispatchSchema,
    admittedAt: timestampSchema,
    highspeed: highspeedMessageMetaSchema.optional(),
    provenance: z
      .object({
        sourceCommandId: z.string().min(1),
        queueItemId: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    source: conversationInputSourceSchema.optional(),
  })
  .strict();

export type ConversationInputIntent = z.infer<typeof conversationInputIntentSchema>;
