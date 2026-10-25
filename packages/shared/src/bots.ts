import { zcodeProtocolTraceSchema, type ZCodeProtocolTrace } from "./zcode-protocol/trace.js";
import { channelContentPartsSchema, type ChannelContentPart } from "./channel-mention.js";
/* oxlint-disable eslint(max-lines) -- Keep shared Bot contracts, providers, states, and schemas together so types stay close to validation. */
import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import { conversationQuotesSchema } from "./conversationSelection.js";
import { ZCODE_AGENT_PROVIDER, ZCODE_AGENT_PROVIDER_LABEL } from "./zcode-agent-policy.js";
import type {
  ZCodeConfigOption,
  ZCodeElicitationRequest,
  ZCodeElicitationQuestion,
  ZCodePermissionRequest,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeStatus,
} from "./zcode-task-types-core.js";
import {
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionResponse,
} from "./zcode-protocol-legacy-types.js";
import type { Locale } from "./protocol.js";

export const botProviders = [
  "telegram",
  "webhook",
  "feishu",
  "lark",
  "weixin",
  "discord",
  "wecom",
] as const;

export type BotProvider = (typeof botProviders)[number];
export type FeishuBotProvider = Extract<BotProvider, "feishu" | "lark">;

/**
 * Bot callback target after a scheduled task completes. Keep only session addresses that remain stable for future use; the current message id/context token
 * belongs to one inbound interaction and must not be persisted and reused. The Host injects this field; it is not exposed directly as a model tool parameter.
 */
export const zcodeAutomationBotDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().min(1).optional(),
  })
  .strict();

export type ZCodeAutomationBotDeliveryTarget = z.infer<
  typeof zcodeAutomationBotDeliveryTargetSchema
>;

export function isFeishuBotProvider(provider: BotProvider): provider is FeishuBotProvider {
  return provider === "feishu" || provider === "lark";
}
export type BotContextMode = "draft" | "task";
export type BotReplyGranularity =
  | "assistant_changes"
  | "assistant_toolcalls_changes"
  | "summary_changes"
  | "streaming_card";

export const BOT_REPLY_GRANULARITIES = [
  "assistant_changes",
  "assistant_toolcalls_changes",
  "summary_changes",
  "streaming_card",
] as const satisfies readonly BotReplyGranularity[];

export const ALL_BOT_WORKSPACES = "*";
export const BOT_BIND_CODE_TTL_MS = 30_000;

export interface BotWorkspaceRef {
  id: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 新版选择虚拟项目；旧协议字段名保留。空 roots 在提交时才分配 cwd。 */
  projectId?: string;
  hostId?: string;
  rootPaths?: string[];
}

export interface BotAllowedCommands {
  status: boolean;
  new: boolean;
  workspace: boolean;
  model: boolean;
  mode?: boolean;
  thoughtLevel: boolean;
  sandboxMode?: boolean;
  approvalPolicy?: boolean;
  remote?: boolean;
  reply: boolean;
}

export type BotCommandPolicy = BotAllowedCommands;

export interface BotCurrentOptions {
  modelSelection?: ModelSelection;
  mode?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
}

export type BotReplyMode = BotReplyGranularity;

export interface BotConfig {
  id: string;
  name: string;
  provider: BotProvider;
  enabled: boolean;
  credentialRef?: string;
  webhookSecretRef?: string;
  webhookUrl?: string;
  webhookAuthHeaderName?: string;
  feishuAppId?: string;
  providerUserId?: string;
  displayName?: string;
  allowedWorkspaces: string[];
  allowedCommands: BotAllowedCommands;
  currentOptions: BotCurrentOptions;
  replyMode: BotReplyMode;
}

export interface BotPendingPermissionOption {
  requestId: string;
  optionId: string;
  command: "approve" | "deny";
  label: string;
  response: ZCodePermissionResponse;
  handledAt?: number;
}

export interface BotPendingElicitation {
  taskId: string;
  requestId: string;
  runId: string;
  origin?: ZCodeInteractionRequestOrigin;
  actorKey?: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers: Record<string, string[]>;
  renderContext?: {
    kind: "plan_approval";
    plan: string;
  };
  expandedCustomAnswerQuestionIndexes?: number[];
  handledAt?: number;
}

export interface BotStructuredElicitationResponse {
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface BotOutboundElicitationRequest {
  requestId: string;
  taskId: string;
  runId: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers?: Record<string, string[]>;
  status?: "pending" | "completed" | "cancelled";
  expandedCustomAnswerQuestionIndexes?: number[];
  schema?: unknown;
}

export interface BotDraftOptions {
  provider: ZCodeProvider;
  modelSelection?: ModelSelection;
  mode?: string;
}

export interface BotsConfigFile {
  version: 3;
  bots: BotConfig[];
}

export interface BotState {
  botId: string;
  group?: BotGroupSession;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceId?: string;
  /** hostId 缺席表示旧状态待交接；明确 NULL 项目不会再次按目录归入。 */
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
  mode: BotContextMode;
  activeTaskId: string | null;
  draftOptions?: BotDraftOptions;
  pendingPermissionOptions?: BotPendingPermissionOption[];
  pendingElicitation?: BotPendingElicitation;
  telegramOffset?: number;
  weixinGetUpdatesBuf?: string;
  weixinActivatedAt?: number;
  /** Direct-message binding generation, preventing late events from restoring the old association after rebinding. */
  privateBindingId?: string;
  /** iLink login returns the bot identity; the direct-message recipient comes from an authorized inbound message. */
  privateRecipientId?: string;
  updatedAt: number;
}

export type BotContextState = BotState;

export const botGroupDeliverySchema = z
  .object({
    /** Request fingerprint before resolving the name; duplicate calls read only the original receipt and do not target someone else if the directory changes. */
    channelReplyRequestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    appId: z.string().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
    authorizationId: z.string().optional(),
    id: z.string().min(1),
    taskId: z.string().min(1),
    sourceCommandId: z.string().min(1).optional(),
    text: z.string(),
    replyToMessageId: z.string().optional(),
    mentionedUserIds: z.array(z.string().min(1)).max(200).optional(),
    contentParts: channelContentPartsSchema.optional(),
    providerMessageId: z.string().optional(),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    status: z.enum(["pending", "sent", "failed", "unknown", "invalidated"]),
    lastError: z.string().optional(),
    updatedAt: z.number(),
  })
  .strict();
export type BotGroupDelivery = z.infer<typeof botGroupDeliverySchema>;

export const botGroupCardSchema = z
  .object({
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    conversationThreadId: z.string().min(1).nullable().optional(),
    taskId: z.string().nullable(),
    authorizationId: z.string().min(1),
  })
  .strict();
export type BotGroupCard = z.infer<typeof botGroupCardSchema>;

export const botTopicMessageSchema = z
  .object({
    id: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    senderId: z.string(),
    senderName: z.string().optional(),
    parentId: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), kind: z.string() }).strict()).optional(),
    senderType: z.enum(["user", "app"]),
    text: z.string(),
    createdAt: z.number(),
    kind: z.string(),
    controlCard: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
export type BotTopicMessage = z.infer<typeof botTopicMessageSchema>;

export interface BotTopicHistoryRequest {
  chatId: string;
  threadId: string;
  rootMessageId: string;
  messageId: string;
  checkpoint?: string;
}

export const botTopicContextSchema = z
  .object({
    messages: z.array(botTopicMessageSchema).max(201),
    checkpoint: z.string().min(1),
    hasGap: z.boolean(),
  })
  .strict();
export type BotTopicHistoryBatch = z.infer<typeof botTopicContextSchema>;

export const botIdentitySchema = z
  .object({ name: z.string().min(1), openId: z.string().min(1).optional() })
  .strict();
export const botBackgroundHistorySchema = z
  .object({ revision: z.string().min(1), checkpoint: z.string().min(1).optional() })
  .strict();

export const botAutoReplyGuardSchema = z
  .object({
    consecutive: z.number().int().min(0).max(5),
    messageIds: z.array(z.string().min(1)),
  })
  .strict();

export interface BotGroupSession {
  preparation?: BotTopicPreparation[];
  chatId: string;
  chatMode?: "group" | "topic";
  threadId?: string;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  /** Only the group’s default record owns this configuration; threads read it after checking group authorization. */
  historyEnabled?: boolean;
  /** Join only after successfully receiving the first input; after leave, retain the task but stop triggering on ordinary messages. */
  topicActive?: boolean;
  topicAliases?: Record<string, { taskId: string; rootMessageId: string }>;
  name: string;
  ownerId: string;
  enabled: boolean;
  taskIds: string[];
  taskWorkspaces?: Record<string, { workspacePath: string; workspaceIdentity?: string }>;
  currentOptions: BotCurrentOptions;
  initiatorId?: string;
  authorizationId?: string;
  deliveries?: Record<string, BotGroupDelivery>;
  autoReplyGuard?: z.infer<typeof botAutoReplyGuardSchema>;
  backgroundHistory?: z.infer<typeof botBackgroundHistorySchema>;
  inputs?: Record<
    string,
    {
      taskId: string;
      source: BotGroupInputSource;
      admission?: "pending" | "accepted" | "rejected";
      progress?: BotGroupInputProgress;
    }
  >;
}

export const botGroupInputStatusSchema = z.enum([
  "waiting",
  "working",
  "done",
  "failed",
  "stopped",
  "cancelled",
  "discarded",
]);
export type BotGroupInputStatus = z.infer<typeof botGroupInputStatusSchema>;
export const botTopicPreparationSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderName: z.string(),
    text: z.string(),
    status: z.enum(["preparing", "waitingStop", "failed"]),
    error: z.string().optional(),
  })
  .strict();
export type BotTopicPreparation = z.infer<typeof botTopicPreparationSchema>;
export const botGroupInputProgressSchema = z
  .object({
    status: botGroupInputStatusSchema,
    interruptionReason: z.literal("newMessage").optional(),
    cardMessageId: z.string().min(1).optional(),
    cardStatus: botGroupInputStatusSchema.optional(),
  })
  .strict();
export type BotGroupInputProgress = z.infer<typeof botGroupInputProgressSchema>;

/** The CLI receives only a lightweight material index; the original content remains in the Host archive and text attachment. */
export const botTopicHistorySourceSchema = z
  .object({
    checkpoint: z.string().min(1).max(256),
    hasGap: z.boolean(),
    messageCount: z.number().int().min(0).max(201),
    resourceMessages: z
      .array(
        z
          .object({
            messageId: z.string().min(1).max(256),
            count: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(201),
  })
  .strict();

export const botTopicInputMessageSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    text: z.string(),
    conversationQuotes: conversationQuotesSchema.optional(),
    attachmentIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

/** Input source injected by the trusted Host; identity display must not grant execution permission. */
export const botGroupInputSourceSchema = z
  .object({
    botIdentity: botIdentitySchema.optional(),
    appId: z.string().min(1).optional(),
    contentParts: channelContentPartsSchema.optional(),
    authorizationId: z.string().min(1).optional(),
    botId: z.string().min(1),
    provider: z.enum(["feishu", "lark"]),
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    messageId: z.string().min(1),
    messages: z.array(botTopicInputMessageSchema).min(1).max(200).optional(),
    topicContext: botTopicContextSchema.optional(),
    topicHistory: botTopicHistorySourceSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      source.messages &&
      (!source.threadId ||
        source.messages.at(-1)?.messageId !== source.messageId ||
        new Set(source.messages.map((message) => message.messageId)).size !==
          source.messages.length)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Topic batch boundary mismatch",
      });
    }

    if (
      source.topicHistory &&
      (!source.threadId || source.topicHistory.checkpoint !== source.messageId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topicHistory"],
        message: "Topic history scope mismatch",
      });
    }
    if (
      source.topicContext &&
      (!source.threadId ||
        source.topicContext.checkpoint !== source.messageId ||
        source.topicContext.messages.some(
          (m) => m.chatId !== source.chatId || m.threadId !== source.threadId,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["topicContext"],
        message: "Topic context scope mismatch",
      });
  });
export type BotGroupInputSource = z.infer<typeof botGroupInputSourceSchema>;

export interface BotsStateFile {
  version: 3;
  bots: Record<string, BotState>;
}

export interface BotRuntimeInfo {
  /** Most recent message delivery error; independent of long-connection state and cleared after a successful delivery. */
  deliveryError?: string;
  /** Failed direct-message reply retained by the current process; an explicit retry may duplicate content already received. */
  deliveryRetryId?: string;
  botId: string;
  provider: BotProvider;
  status: "disabled" | "idle" | "polling" | "connected" | "error";
  messageId?: string;
  message?: string;
  lastUpdateAt?: number;
  offset?: number;
}

export interface BotActor {
  /** Whether this trusted input explicitly mentioned the bot; used for thread reply notifications. */
  mentionedBot?: boolean;
  provider: BotProvider;
  botId: string;
  providerUserId: string;
  displayName?: string;
  chatType: "private" | "group";
  chatId?: string;
  threadId?: string;
  /** Set only by the service from the saved result association; null means the group’s original default task. */
  conversationThreadId?: string | null;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  providerMessageId?: string;
  providerContextToken?: string;
}

export type BotInboundAttachmentKind = "image" | "audio" | "video" | "file";

export interface BotInboundAttachment {
  id: string;
  kind: BotInboundAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  providerFileId?: string;
  downloadUrl?: string;
  dataBase64?: string;
  localPath?: string;
  providerMetadata?: Record<string, string>;
}

export type BotCommand =
  | { type: "group.history"; enabled?: boolean }
  | { type: "queue.cancel"; commandId: string }
  | { type: "group.enable" }
  | { type: "group.disable" }
  | { type: "bind"; code: string }
  | { type: "help" }
  | { type: "status" }
  | { type: "new" }
  | { type: "reconnect" }
  | { type: "workspace.list" }
  | { type: "workspace.set"; value: string }
  | { type: "model.list" }
  | { type: "model.provider.set"; value: string }
  | { type: "model.set"; value: string }
  | { type: "mode.list" }
  | { type: "mode.set"; value: string }
  | { type: "thoughtLevel.list" }
  | { type: "thoughtLevel.set"; value: string }
  | { type: "remote" }
  | { type: "task.list" }
  | { type: "task.set"; value: string }
  | { type: "reply.list" }
  | { type: "reply.set"; value: string }
  | { type: "stop" }
  | { type: "topic.leave" }
  | { type: "permission.respond"; value: string }
  | { type: "elicitation.respond"; value: string }
  | { type: "elicitation.submit" }
  | { type: "approve"; requestId: string; optionId: string }
  | { type: "deny"; requestId: string }
  | { type: "unknown"; name: string; raw: string }
  | { type: "selection.cancel" }
  | { type: "message"; text: string };

export interface SelectionPrompt {
  id: string;
  token?: string;
  title: string;
  currentId?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  action:
    | "queue.cancel"
    | "workspace.set"
    | "model.provider.set"
    | "model.set"
    | "mode.set"
    | "thoughtLevel.set"
    | "task.set"
    | "reply.set"
    | "permission.respond"
    | "elicitation.respond";
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

export interface BotInboundMessage {
  /** Used only to identify commands/pure wakeups; the original text and contentParts remain intact. */
  commandText?: string;
  /** Current bot identity verified by the Provider; never infer it from the message body. */
  botOpenId?: string;
  /** Sender type validated by the Provider; bot-authored content has no control-command authority. */
  senderType?: "user" | "app";
  contentParts?: ChannelContentPart[];
  /** Set by the Provider from the actual mention identity; this is not derived by parsing the body. */
  mentionedBot?: boolean;
  /** The Provider verified that the native root message was sent by the current bot. */
  topicRootIsCurrentBot?: boolean;
  /** Explicit reference validated by the trusted Provider; it is excluded from control-command parsing. */
  referencedMessage?: import("./conversationSelection.js").ConversationSelectionText & {
    messageId: string;
  };
  groupCard?: BotGroupCard;
  groupCardAction?: boolean;
  botId: string;
  actor: BotActor;
  text: string;
  attachments?: BotInboundAttachment[];
  elicitationResponse?: BotStructuredElicitationResponse;
  receivedAt?: number;
}

export interface BotOutboundMessage {
  trace?: ZCodeProtocolTrace;
  contentParts?: ChannelContentPart[];
  groupCard?: BotGroupCard;
  threadId?: string;
  conversationThreadId?: string | null;
  rootMessageId?: string;
  botId: string;
  provider: BotProvider;
  providerUserId: string;
  text: string;
  locale?: Locale;
  selection?: SelectionPrompt;
  elicitation?: BotOutboundElicitationRequest;
  providerContextToken?: string;
  /** Unauthorized/expired callbacks may only notify the operator; they must not overwrite the shared group card. */
  callbackToastOnly?: boolean;
  /** Admin follow-up is a separate notification; do not overwrite the shared card with a rejection notice. */
  administratorAttention?: boolean;
  replyToMessageId?: string;
  /** Notification target determined by trusted input; display only, with no group-operation permissions. */
  mentionedUserIds?: string[];
  deliveryId?: string;
  /** Revalidate the group’s current association before sending a task update. Control-command replies do not carry it. */
  groupTaskId?: string;
  /** Input command from the trusted task event, used to associate delivery status with the corresponding reply. */
  groupSourceCommandId?: string;
}

export interface BotTaskSummary {
  taskId: string;
  title: string;
  status: ZCodeTaskRuntimeStatus | "persisted-completed" | "persisted-error" | "unknown";
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  model?: string;
}

export const BOT_TASK_BROADCAST_CHANNEL = "bots:task";
export const BOT_TASK_STREAM_BROADCAST_CHANNEL = "bots:task-stream";

export type BotTaskBroadcastEvent =
  | "created"
  | "prompt_sent"
  | "resumed"
  | "streaming"
  | "permission_request"
  | "permission_resolved"
  | "elicitation_request"
  | "elicitation_resolved"
  | "updated"
  | "completed"
  | "error";

export interface BotTaskBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: BotTaskBroadcastEvent;
  updatedAt: number;
  task?: ZCodeTaskMeta;
  provider?: ZCodeProvider;
  configOptions?: ZCodeConfigOption[];
  prompt?: {
    content: string;
    attachments?: ZCodePromptAttachment[];
    messageId: string;
    sentAt: number;
  };
  permissionRequest?: ZCodePermissionRequest;
  elicitationRequest?: ZCodeElicitationRequest;
  requestId?: string;
  error?: string;
}

export interface BotTaskStreamBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: ZCodeStreamEvent;
  updatedAt: number;
}

export interface BotServiceStatus {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeInfo[];
}

export interface BotProviderCallbackResult {
  ok: boolean;
  replies: BotOutboundMessage[];
  responseBody?: unknown;
  status?: number;
}

export const botAllowedCommandsSchema = z
  .object({
    status: z.boolean(),
    new: z.boolean(),
    workspace: z.boolean(),
    model: z.boolean(),
    mode: z.boolean().optional(),
    thoughtLevel: z.boolean(),
    sandboxMode: z.boolean().optional(),
    approvalPolicy: z.boolean().optional(),
    remote: z.boolean().optional(),
    // For compatibility with legacy bot-config.json; the /cli command was removed, so new configs no longer write this field.
    cli: z.boolean().optional(),
    reply: z.boolean(),
  })
  .strict();

export const botCommandPolicySchema = botAllowedCommandsSchema;

// Fix rationale: third-party CLI providers were removed and glm is the only ZCodeProvider, but old bot configuration and state files may still contain
// historical values for removed providers. Using a strict literal would make the entire file fail to parse and disable every Bot;
// therefore, continue accepting these historical values during parsing and normalize them to the sole current agent provider.
const legacyBotAgentProviderSchema = z
  .enum(["codex", "claude", "opencode", "gemini", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

export const botCurrentOptionsSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
    sandboxMode: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1).optional(),
    // For compatibility with legacy bot-config.json; CLI providers are now configured centrally through ZCode Protocol.
    cli: legacyBotAgentProviderSchema.optional(),
  })
  .strict();

export const botDraftOptionsSchema = z
  .object({
    provider: legacyBotAgentProviderSchema,
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

const botElicitationOptionSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();

const botElicitationQuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(botElicitationOptionSchema),
    multiSelect: z.boolean().optional(),
  })
  .strict();

const botPendingElicitationSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    actorKey: z.string().min(1).optional(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(botElicitationQuestionSchema),
    answers: z.record(z.string(), z.array(z.string())),
    renderContext: z
      .object({
        kind: z.literal("plan_approval"),
        plan: z.string().min(1),
      })
      .strict()
      .optional(),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    handledAt: z.number().optional(),
  })
  .strict();

export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: z.enum(botProviders),
    enabled: z.boolean(),
    credentialRef: z.string().min(1).optional(),
    webhookSecretRef: z.string().min(1).optional(),
    webhookUrl: z.string().url().optional(),
    webhookAuthHeaderName: z.string().min(1).optional(),
    feishuAppId: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string().min(1)),
    allowedCommands: botAllowedCommandsSchema,
    currentOptions: botCurrentOptionsSchema,
    replyMode: z.enum([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
      "streaming_card",
    ]),
  })
  .strict();

export const botsConfigFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.array(botConfigSchema),
  })
  .strict();

export const botsStateFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.record(
      z.string(),
      z.object({
        botId: z.string().min(1),
        group: z
          .object({
            chatId: z.string().trim().min(1),
            chatMode: z.enum(["group", "topic"]).optional(),
            threadId: z.string().trim().min(1).optional(),
            rootMessageId: z.string().min(1).optional(),
            topicTitle: z.string().optional(),
            topicUrl: z.string().url().optional(),
            historyEnabled: z.boolean().optional(),
            topicActive: z.boolean().optional(),
            preparation: z.array(botTopicPreparationSchema).optional(),
            topicAliases: z
              .record(
                z.string(),
                z.object({ taskId: z.string().min(1), rootMessageId: z.string().min(1) }).strict(),
              )
              .optional(),
            name: z.string(),
            ownerId: z.string().min(1),
            enabled: z.boolean(),
            taskIds: z.array(z.string().min(1)),
            taskWorkspaces: z
              .record(
                z.string(),
                z
                  .object({
                    workspacePath: z.string().min(1),
                    workspaceIdentity: z.string().optional(),
                  })
                  .strict(),
              )
              .optional(),
            currentOptions: botCurrentOptionsSchema,
            initiatorId: z.string().optional(),
            authorizationId: z.string().optional(),
            deliveries: z.record(z.string(), botGroupDeliverySchema).optional(),
            autoReplyGuard: botAutoReplyGuardSchema.optional(),
            backgroundHistory: botBackgroundHistorySchema.optional(),
            inputs: z
              .record(
                z.string(),
                z
                  .object({
                    taskId: z.string().min(1),
                    source: botGroupInputSourceSchema,
                    admission: z.enum(["pending", "accepted", "rejected"]).optional(),
                    progress: botGroupInputProgressSchema.optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict()
          .optional(),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        projectId: z.string().min(1).nullable().optional(),
        hostId: z.string().min(1).optional(),
        additionalDirectories: z.array(z.string().min(1)).max(256).optional(),
        mode: z.enum(["draft", "task"]),
        activeTaskId: z.string().min(1).nullable(),
        draftOptions: botDraftOptionsSchema.optional(),
        pendingPermissionOptions: z
          .array(
            z.object({
              requestId: z.string().min(1),
              optionId: z.string().min(1),
              command: z.enum(["approve", "deny"]),
              label: z.string().min(1),
              response: zcodePermissionResponseSchema,
              handledAt: z.number().optional(),
            }),
          )
          .optional(),
        pendingElicitation: botPendingElicitationSchema.optional(),
        telegramOffset: z.number().optional(),
        weixinGetUpdatesBuf: z.string().optional(),
        weixinActivatedAt: z.number().optional(),
        privateBindingId: z.string().min(1).optional(),
        privateRecipientId: z.string().min(1).optional(),
        updatedAt: z.number(),
      }),
    ),
  })
  .strict();

export const DEFAULT_BOT_COMMANDS: BotAllowedCommands = {
  status: true,
  new: true,
  workspace: true,
  model: true,
  mode: true,
  thoughtLevel: true,
  remote: true,
  reply: true,
};

export const DEFAULT_BOT_REPLY_GRANULARITY: BotReplyGranularity = "assistant_changes";

export function getSupportedBotReplyGranularities(
  provider: BotProvider,
): readonly BotReplyGranularity[] {
  return isFeishuBotProvider(provider)
    ? (["streaming_card"] as const)
    : BOT_REPLY_GRANULARITIES.filter(
        // Bugfix: streaming cards require Feishu/Lark Card JSON 2.0; other channels cannot render or update this message type.
        (granularity) => granularity !== "streaming_card",
      );
}

export function normalizeBotReplyGranularity(
  provider: BotProvider,
  replyMode: BotReplyGranularity | undefined,
): BotReplyGranularity {
  const supported = getSupportedBotReplyGranularities(provider);
  const candidate = replyMode ?? DEFAULT_BOT_REPLY_GRANULARITY;
  return supported.includes(candidate) ? candidate : supported[0]!;
}

export const BOT_ZCODE_PROVIDER_OPTIONS: Array<{
  id: ZCodeProvider;
  label: string;
}> = [{ id: ZCODE_AGENT_PROVIDER, label: ZCODE_AGENT_PROVIDER_LABEL }];
