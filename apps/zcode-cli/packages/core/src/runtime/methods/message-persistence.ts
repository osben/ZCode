import type { RuntimeInputPresentation } from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { SessionEventType, createPartId, traceContextToLogContext } from "../deps.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type {
  EnvInfo,
  MessageId,
  MessagePart,
  MessageVisibility,
  Model,
  SessionId,
  SessionProjection,
  SessionStorePort,
  TraceContext,
  SyntheticUserMessageSource,
  TurnInputIntentMetadata,
  TurnExecutionKind,
} from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSyntheticUserNoticeMessageMetadata,
  buildSyntheticUserNoticePartMetadata,
  buildSyntheticUserNoticeSemantics,
} from "./synthetic-notice-metadata.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { buildProjectionAnchor, mapSyntheticSourceToAnchorOrigin } from "./projection-anchor.js";

export async function persistUserPrompt(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  input: string,
  attachments: ResolvedTurnAttachment[] | undefined,
  traceContext: TraceContext,
  options?: {
    /**
      * Persist delivery semantics for input injected by drain (metadata.turnSteerDelivery).
      * Cold recovery uses it to restore the "queue = separate turn / guide = inline current turn" distinction, matching the live structure.
     */
    steerDelivery?: "guide" | "queue";
    inputPresentation?: RuntimeInputPresentation;
    /**
      * (Atomic promotion): when a ledger id is provided and the store supports it, marking the ledger promoted
      * shares a transaction with message/parts persistence, eliminating the orphan window where the queue is consumed but the transcript has no
      * user message (the old drain crossed stores without a transaction).
     */
    sessionInputId?: string;
    /** V4 command idempotency anchor; must come from CLI admission and cannot be replaced with a new id during drain. */
    sourceCommandId?: string;
    clientId?: string;
    intent?: TurnInputIntentMetadata;
    /** Execution semantics needed for cold recovery; these cannot exist only in the live TurnStarted event. */
    executionKind?: TurnExecutionKind;
    /** Start of engine-appended text; persisted for cold recovery as well. */
    epilogueStart?: number;
  },
): Promise<void> {
  this.latestConversationMessageId = messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  const tools = Object.fromEntries(this.getTools().map((tool) => [tool.name, true]));
  const conversationInputIntent = buildPersistedConversationInputIntent(
    input,
    options?.intent,
    "drained",
  );
  const message: Parameters<SessionStorePort["saveMessage"]>[0] = {
    id: messageID,
    sessionID: this.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    modelSelection: this.getSessionModelSelection(),
    contextSnapshot: buildPersistedContextSnapshot(this.config.envInfo),
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    anchor: buildProjectionAnchor(
      traceContext,
      "realUser",
      options?.intent?.sourceCommandId ?? options?.sourceCommandId,
    ),
    system: this.config.systemPrompt,
    tools,
    ...(options?.inputPresentation ||
    options?.steerDelivery ||
    options?.clientId ||
    options?.intent ||
    options?.executionKind ||
    options?.epilogueStart !== undefined
      ? {
          metadata: {
            ...(options?.steerDelivery ? { turnSteerDelivery: options.steerDelivery } : {}),
            ...(options?.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
            ...(options?.intent ? { inputIntent: options.intent } : {}),
            ...(conversationInputIntent ? { conversationInputIntent } : {}),
            ...((options?.intent?.clientId ?? options?.clientId)
              ? { inputClientId: options?.intent?.clientId ?? options?.clientId }
              : {}),
            ...(options?.executionKind ? { executionKind: options.executionKind } : {}),
            ...(options?.intent?.highspeed ? { highspeed: options.intent.highspeed } : {}),
            ...(options?.epilogueStart === undefined
              ? {}
              : { epilogueStart: options.epilogueStart }),
          },
        }
      : {}),
  };
  const parts: MessagePart[] = [
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID,
      type: "text",
      text: withConversationQuotes(
        input,
        options?.intent?.conversationQuotes,
        options?.intent?.botGroupSource,
      ),
      time: {
        start: created,
        end: created,
      },
    },
    ...(attachments ?? []).map(
      (attachment): MessagePart => ({
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "file",
        mime: attachment.mime,
        filename: attachment.filename,
        url: attachment.url,
        source: attachment.source,
        metadata: attachment.metadata,
      }),
    ),
  ];

  if (options?.sessionInputId && this.sessionStore.promoteSessionInput) {
    await this.sessionStore.promoteSessionInput({
      id: options.sessionInputId,
      sessionID: this.sessionId,
      message,
      parts,
    });
    this.logger?.debug("Session input promoted", {
      ...traceContextToLogContext(traceContext),
      event: "session_input.promoted",
      messageId: messageID,
      module: "core.runtime",
      sessionInputId: options.sessionInputId,
      status: "completed",
    });
    const sourceCommandId =
      options.intent?.sourceCommandId ?? options.sourceCommandId ?? options.sessionInputId;
    // Emit the event after the promotion transaction commits; only at this boundary may the gateway release the live-input pin.
    // Releasing it during queue removal/TurnStarted could let LRU churn turn commands/query into unknown before the transcript is persisted,
    // causing the same input to execute twice.
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: options.sessionInputId,
          sourceCommandId,
          messageId: messageID,
        },
        traceContext,
      ),
      traceContext,
    );
    return;
  }

  await this.persistMessage(message, traceContext);
  for (const part of parts) {
    await this.persistPart(part, traceContext);
  }
}

export async function persistSyntheticUserNotice(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "rewind",
    text,
    traceContext,
  });
}

export async function persistSyntheticUserNoticeForSession(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    /** Additional structured metadata merged with `{ source }` in part.metadata so the UI can identify the message type. */
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  },
): Promise<void> {
  if (options.sessionId === this.sessionId) {
    this.latestConversationMessageId = options.messageID;
  }
  if (!this.sessionStore) return;

  const created = Date.now();
  const visibility = options.visibility ?? "model-only";
  const messageMetadata = buildSyntheticUserNoticeMessageMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  const partMetadata = buildSyntheticUserNoticePartMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: options.sessionId,
      role: "user",
      time: {
        created,
      },
      agent: this.config.agentName ?? "zcode-agent",
      metadata: messageMetadata,
      modelSelection: this.getSessionModelSelection(),
      semantics: buildSyntheticUserNoticeSemantics(options.source, visibility),
      anchor: buildProjectionAnchor(
        options.traceContext,
        mapSyntheticSourceToAnchorOrigin(options.source),
      ),
      source: options.source,
      system: this.config.systemPrompt,
      synthetic: true,
      tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      visibility,
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: options.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: {
        start: created,
        end: created,
      },
      metadata: partMetadata,
    },
    options.traceContext,
  );
}

export async function persistAssistantMessage(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  parentID: MessageId,
  created: number,
  update:
    | {
        completed?: number;
        error?: { name: string; data?: Record<string, unknown> };
        finish?: string;
        tokens?: ReturnType<typeof toTokenUsageInfo>;
      }
    | undefined,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  this.latestConversationMessageId = messageID;
  this.latestAssistantMessageId = messageID;
  if (traceContext.turnId) {
    this.latestAssistantTurnId = traceContext.turnId;
  }
  if (!this.sessionStore) return;
  const selection = this.getSessionModelSelection();
  const providerId =
    model?.providerId ?? (selection && createModelProviderId(selection.providerId));
  const modelId = model?.modelId ?? (selection && createModelId(selection.modelId));

  await this.persistMessage(
    {
      id: messageID,
      sessionID: this.sessionId,
      role: "assistant",
      time: {
        created,
        completed: update?.completed,
      },
      error: update?.error,
      parentID,
      // The default model may change while a request is in progress; the model-request path must explicitly pass the model that generated this
      // message. Keep the default only for existing synthetic/fallback paths that do not use a model result.
      modelId,
      providerId,
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        // cwd can change through Bash cd; root must preserve the session's initial workspace identity.
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: update?.tokens ?? emptyTokenUsageInfo(),
      finish: update?.finish,
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(traceContext),
    },
    traceContext,
  );
}

export async function persistMessage(
  this: AgentRuntimeInternal,
  input: Parameters<SessionStorePort["saveMessage"]>[0],
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.saveMessage(input, copyFrom);
  this.logger?.debug("Session message persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.message.persisted",
    messageId: input.id,
    module: "core.runtime",
    role: input.role,
    status: "completed",
  });
}

export async function persistPart(
  this: AgentRuntimeInternal,
  input: MessagePart,
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.savePart(input, copyFrom);
  this.logger?.debug("Session part persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.part.persisted",
    messageId: input.messageID,
    module: "core.runtime",
    partId: input.id,
    partType: input.type,
    status: "completed",
  });
}

function buildPersistedContextSnapshot(envInfo: EnvInfo | undefined):
  | {
      envInfo: EnvInfo;
    }
  | undefined {
  if (!envInfo) {
    return undefined;
  }

  return { envInfo: { ...envInfo } };
}

export async function rebuildProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  const events = await this.eventStore.getEvents(this.sessionId);
  return this.eventReducer.reduce(events);
}
