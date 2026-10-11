import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createPartId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  SyntheticUserMessageSource,
  TraceContext,
  TurnInputIntentMetadata,
  WorkflowLaunchMeta,
} from "../deps.js";
import { buildUserContentFromTurn } from "../helpers/index.js";
import { realUserRuntimeMetadata } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ControlOnlyTurnRuntimeCommand } from "../command-queue.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";

/**
 * Shared boundary for controlOnly user turns (`/goal` external queries and workflow launches from the hub).
 *
 * Neither entry point uses ordinary `executeTurn`, but both must persist a **user-visible, role=user** message,
 * add it to runtime history (so the model sees it on the next turn), and emit complete turn boundaries with no model output
 * (`TurnStarted{executionKind:"controlOnly"}` + `TurnComplete{response:""}`). Otherwise live
 * ProductProjection misses TurnStarted, the query appears only after cold recovery, and a 0ms control turn is
 * misreported by the modelChange marker as "worked for 1 second." The only substantive difference is how the message
 * is persisted (a real user prompt vs. a synthetic user message with `workflowLaunch` metadata), plus title and follow-up
 * side effects, injected through the `persistMessage` and `afterTurnBoundary` callbacks.
 */
export async function emitControlOnlyUserTurn(
  this: AgentRuntimeInternal,
  options: {
    messageId: MessageId;
    /** First-input title seed for `ensureSessionPersisted` (normalized objective for /goal, workflow name for launch). */
    titleInput: string;
    /** Visible text added to runtime history (the model reads it on the next turn). */
    historyText: string;
    /** `TurnStarted.input` (fallback presentation for older clients / TUI). */
    turnInput: string;
    traceContext: TraceContext;
    inputId?: string;
    inputSource?: SyntheticUserMessageSource;
    workflowLaunch?: WorkflowLaunchMeta;
    intent?: TurnInputIntentMetadata;
    /** Persist this user message (real or synthetic)—the only substantive difference between the two paths. */
    persistMessage: () => Promise<void>;
    /** Optional side effects after the session is first persisted and before turnNumber advances (such as title sidecars). */
    afterTurnBoundary?: () => void;
  },
): Promise<void> {
  const { messageId, traceContext } = options;
  // The /goal entry point may run before the first turn writes runtime history. If we call addUser first,
  // later lazy context initialization rebuilds messageHistory and drops this real user query.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(options.titleInput, traceContext);
  // This entry point does not use ordinary submitPrompt, but it carries real user intent. Write it to both
  // runtime history and the session store so model context, desktop continuous, and mobile replayable snapshots
  // all use the same visible user intent.
  this.messageHistory.addUser(
    buildUserContentFromTurn(options.historyText, []),
    realUserRuntimeMetadata(),
  );
  await options.persistMessage();
  // Entry points outside executeTurn previously persisted only the transcript, so live ProductProjection missed
  // TurnStarted and the query appeared only after cold recovery. Emit complete turn boundaries with no model output
  // for this real user input; later goal continuation or notification-driven turns still open a separate turn and
  // do not create a second user bubble.
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(traceContext, {
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input: options.turnInput,
        messageId,
        ...(options.inputId ? { inputId: options.inputId } : {}),
        // The visible query needs its own turn for live display, but it does not run the Agent. Without this state,
        // the modelChange marker makes the UI show a 0ms control turn as "worked for 1 second" and briefly overlays
        // session running/activeWorks。
        executionKind: "controlOnly",
        ...(options.inputSource ? { inputSource: options.inputSource } : {}),
        ...(options.workflowLaunch ? { workflowLaunch: options.workflowLaunch } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
        resultType: "success",
        ...(options.inputId ? { inputId: options.inputId } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  options.afterTurnBoundary?.();
  this.turnNumber += 1;
  this.messageHistory.setCacheMiss();
}

/**
 * Persists the user message for the launch turn when a workflow is started directly from the hub.
 *
 * This message is **synthetic but semantically represents a real user action**: `synthetic: true` and the new
 * `source: "workflow_launch"`, while also carrying `origin: "real_user"` / `kind: "user_prompt"` and remaining
 * visible to the UI, provider, and transcript. The user clicked "Run" in the hub, so this is real intent; the GUI
 * uses `metadata.workflowLaunch` to render a run card at the end of the turn instead of showing this text. The same
 * metadata is included in message metadata (for cold recovery) and the TurnStarted payload (for live projection,
 * written by the caller).
 */
export async function persistWorkflowLaunchUserMessage(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    text: string;
    meta: WorkflowLaunchMeta;
    traceContext: TraceContext;
  },
): Promise<void> {
  this.latestConversationMessageId = options.messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: this.sessionId,
      role: "user",
      time: { created },
      agent: this.config.agentName ?? "zcode-agent",
      // Cold-recovery source: transcript hydration rebuilds the launch card row from
      // source === "workflow_launch" + metadata.workflowLaunch.
      metadata: { workflowLaunch: options.meta },
      modelSelection: this.getSessionModelSelection(),
      semantics: {
        // A real user action, not an agent_runtime system reminder; the model reads it as a real user prompt next turn.
        origin: "real_user",
        kind: "user_prompt",
        source: "workflow_launch",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(options.traceContext, "realUser"),
      source: "workflow_launch",
      system: this.config.systemPrompt,
      synthetic: true,
      tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      visibility: "user-visible",
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: { start: created, end: created },
      metadata: { source: "workflow_launch", visibility: "user-visible" },
    },
    options.traceContext,
  );
}

/**
 * Runs a queued controlOnly turn ({@link ControlOnlyTurnRuntimeCommand}) using the same persistence path as a hub launch:
 * a synthetic `workflow_launch` user message, metadata, and complete turn boundaries, with timing determined by the queue.
 */
export async function runControlOnlyTurnCommand(
  this: AgentRuntimeInternal,
  command: ControlOnlyTurnRuntimeCommand,
): Promise<void> {
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: command.titleInput,
    historyText: command.text,
    turnInput: command.text,
    traceContext: command.traceContext,
    ...(command.inputId === undefined ? {} : { inputId: command.inputId }),
    inputSource: "workflow_launch",
    workflowLaunch: command.workflowLaunch,
    persistMessage: () =>
      persistWorkflowLaunchUserMessage.call(this, {
        messageID: messageId,
        text: command.text,
        meta: command.workflowLaunch,
        traceContext: command.traceContext,
      }),
  });
}

export async function recordExternalUserPrompt(
  this: AgentRuntimeInternal,
  input: string,
  options?: {
    goalSummaryTargetID?: string;
    traceContext?: TraceContext;
    intent?: TurnInputIntentMetadata;
  },
): Promise<MessageId> {
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const canonicalInput = options?.intent?.text?.trim() || input;
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: canonicalInput,
    historyText: input,
    turnInput: input,
    traceContext,
    inputId: options?.intent?.sourceCommandId,
    intent: options?.intent,
    // The /goal command itself does not use ordinary submitPrompt, but the objective used to set a goal for the first time
    // is a real user query; automatic continuation reminders are still marked model-only by the runtime.
    persistMessage: () =>
      this.persistUserPrompt(messageId, input, undefined, traceContext, {
        intent: options?.intent,
        sessionInputId: options?.intent?.queueItemId,
        executionKind: "controlOnly",
      }),
    afterTurnBoundary: () => {
      // Start the title sidecar for the first query while turnNumber is still 0. Otherwise the first-turn gate treats
      // it as a later turn, generating only goal summaryTitle and leaving the first_input session title unchanged.
      const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
        this,
        canonicalInput,
        messageId,
        traceContext,
        { goalSummaryTargetID: options?.goalSummaryTargetID },
      );
      if (!titleGenerationStarted && options?.goalSummaryTargetID) {
        maybeStartGoalSummaryTitleGeneration.call(
          this,
          canonicalInput,
          options.goalSummaryTargetID,
          { traceContext },
        );
      }
    },
  });
  return messageId;
}
