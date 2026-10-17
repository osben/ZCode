import { beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createChildTraceContext,
  createQueryId,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createTurnId,
  latestProviderRateLimitReadingFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
  formatLocalIsoDate,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  MessagePart,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseDreamCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildDateChangeReminderBody,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  summarizeTurnAttachmentsForEvent,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import {
  maybeStartDeferredSessionTitleGeneration,
  maybeStartSessionTitleGeneration,
} from "./session-title.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import {
  disposeProjectMemoryRecallPrefetch,
  startProjectMemoryRecallPrefetch,
} from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  applySubmissionExecutionState,
  createTurnModel,
  resolveExecutionModelRetryBudget,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // Ordinary Turns previously read Session Selection/output style only after asynchronous initialization completed.
  // A model switch during initialization could cross the admission boundary and incorrectly affect a Turn that had already started.
  // Freeze the facts for this turn before any await; later configuration changes apply only to the next turn.
  const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const dreamCommand = parseDreamCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  // A likely cause of "worked for N seconds" with no terminal state in production is an await rejecting
  // before the inner Turn try/catch. Record the current phase and whether the inner handler processed it, so production logs can identify the stuck point.
  let turnPhase = "queued";
  let turnFailureHandled = false;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      let admittedModel;
      try {
        admittedModel =
          rewindCommand === null
            ? createTurnModel(this, {
                requestDependencies: options?.modelExecution?.requestDependencies,
                selection: admittedModelSelection,
                // Execution handles with a fallback declaration allow zero retries; pass failures immediately to the turn step to fall back to the session model.
                retryBudget: resolveExecutionModelRetryBudget({
                  selection: admittedModelSelection,
                  selectionFallback: options?.modelExecution?.selectionFallback,
                }),
              })
            : undefined;
      } catch (error) {
        // Sync lag/model invalidation can fail before the inner Turn try begins. Logging alone would leave accepted input
        // without a terminal state, hiding the error from desktop and mobile. Reuse outcome; do not wait for sync or change the original selection.
        turnFailureHandled = true;
        const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnStartedAtMs,
          turnPhase: "model_creation",
          inputId: options?.inputId,
          traceContext: turnTraceContext,
          fallbackMessage: "Model creation failed",
          logEvent: "turn.failed",
          logLabel: "Turn",
        });
        throw coreError;
      }
      let phaseStartedAt = startTurnPhase("context_initialization");
      if (this.contextInitialized) {
        // Re-project Context for each later model step using the Model actually held by that step.
        // Session Selection determines which Model to create in the future; it is not evidence of what is executing now.
        rebuildContextPrefix(this, { model: admittedModel });
      } else {
        // First-turn initialization has already built and installed the full Context with the admitted Model; rebuilding afterward
        // would construct the same Prefix twice. The initialized and uninitialized branches are mutually exclusive, so each model step builds it once.
        await this.ensureContextInitialized(turnTraceContext, admittedModel);
      }
      completeTurnPhase("context_initialization", phaseStartedAt);
      throwIfTurnAborted(turnAbortSignal);
      phaseStartedAt = startTurnPhase("session_start_hooks");
      const sessionStartHookResult = await this.runSessionStartHooks(
        "startup",
        turnTraceContext,
        turnAbortSignal,
        admittedModel,
      );
      completeTurnPhase("session_start_hooks", phaseStartedAt);
      this.injectHookAdditionalContextIntoMessageHistory(
        HookEventName.SessionStart,
        sessionStartHookResult.additionalContexts,
      );

      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (dreamCommand !== null) {
        return this.executeManualDream(
          input,
          dreamCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          // Same admission freeze as compact: the Memory agent must run on the model selected
          // before any await, not on whatever the session switched to during initialization.
          admittedModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "regular", true, {
        ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
      });
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // An execution-scoped temporary Provider (such as an off-peak task) owns its own model for this turn and does not change
      // Session Selection. Ordinary submissions apply their atomic selection only when execution actually starts.
      const submissionModel = await applySubmissionExecutionState(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
        admittedModel,
      );
      startedTarget = await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // Send attachment display metadata with TurnStarted (v4 projection → userInput row.attachments).
      // A workspace checkpoint is attached to the user messageId. Generate the id before TurnStarted so the v4 projection
      // can find this turn's file checkpoint through the turn rowId, avoiding a summary with a count but no expanded contents.
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId
            ? { automationId: options.automationId }
            : options?.offPeakTaskId
              ? {
                  offPeakTaskId: options.offPeakTaskId,
                  ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
                }
              : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          const response =
            userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
          if (activeTurn) activeTurn.steerable = false;
          turnMachine = new TurnMachineImpl(turnMachine.complete(response, "success"));
          const turnUsage = createModelUsageSummaryFromEvents(events);
          const completeEvent = this.createEvent(
            SessionEventType.TurnComplete,
            {
              response,
              tokenCount: 0,
              usage: turnUsage,
              toolCallCount: 0,
              duration: Date.now() - turnMachine.state.startedAt.getTime(),
              resultType: "success",
              cacheStats: this.messageHistory.getCacheStats(),
              inputId: options?.inputId,
            },
            turnTraceContext,
          );
          await this.appendEvent(completeEvent, turnTraceContext);
          events.push(completeEvent);
          await recordTurnUsageFact(this, {
            completedAt: Date.now(),
            events,
            startedAt: turnStartedAtMs,
            status: "completed",
            traceContext: turnTraceContext,
            turnId,
          });
          this.turnNumber++;
          const projection = await this.rebuildProjection();
          await this.accountTargetTurnCompletion({
            inputID: targetRunInputID,
            startedAtMs: turnStartedAtMs,
            startedTarget,
            traceContext: turnTraceContext,
            usage: turnUsage,
          });
          return {
            response,
            turnId,
            traceId,
            usage: turnUsage,
            events,
            projection,
          };
        }
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
        // Read the original topic text on demand from the standard text attachment; trusted source archives must not generate hidden context again.
        injectDateChangeReminderIntoMessageHistory.call(this);
        const resolvedAttachments = await resolveTurnAttachments(attachments, {
          abortSignal: turnAbortSignal,
          artifactStore: this.artifactStore,
          fileSystemPort: this.fileSystemPort,
          imageProcessorPort: this.imageProcessorPort,
          sessionId: this.sessionId,
          traceContext: turnTraceContext,
          turnId,
          workingDirectory: this.workingDirectory,
        });
        logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
        const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
        if (sharedContextRefs && sharedContextRefs.length > 0) {
          const [reference] = sharedContextRefs;
          if (!reference || reference.kind !== "shared_context_import") {
            throw new Error("invalid shared context reference");
          }
          if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
          const alreadyHydrated = this.messageHistory
            .borrowReadOnlyRuntimeEntries()
            .some(
              (entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context",
            );
          if (!alreadyHydrated) {
            const importedMessages = await this.sessionStore.messages({
              sessionID: this.sessionId,
            });
            const contextMessage = importedMessages.find(
              (message) =>
                message.info.role === "user" &&
                message.info.source === "shared_context" &&
                message.info.metadata &&
                typeof message.info.metadata === "object" &&
                (message.info.metadata as Record<string, unknown>).contextId ===
                  reference.context_id,
            );
            const contextText = contextMessage?.parts
              .filter(
                (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
              .trim();
            if (!contextText) throw new Error("shared context content is unavailable");
            this.messageHistory.addUser(
              contextText,
              runtimeMetadataForSyntheticUserMessageSource("shared_context"),
            );
          }
        }
        await this.persistPendingModelChangeTimeline(turnTraceContext);
        if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
          const inputSource = options.inputSource ?? "goal-continuation";
          const userContent = buildUserContentFromTurn(input, resolvedAttachments);
          this.messageHistory.addUser(
            userContent,
            runtimeInputMetadata(options.inputPresentation) ??
              runtimeMetadataForSyntheticUserMessageSource(inputSource),
          );
          // /goal automatic continuation is an internal user-role input injected by the runtime for the model,
          // not a new message sent by the user in chat. Preserve the raw input when persisting for recovery/diagnostics,
          // but mark it model-only so UI-facing snapshots do not render it as a user bubble.
          await this.persistSyntheticUserNoticeForSession({
            messageID: userMessageId,
            metadata: {
              ...(options.targetId ? { targetId: options.targetId } : {}),
              ...(options.inputPresentation
                ? { inputPresentation: options.inputPresentation }
                : {}),
              visibility: "model-only",
            },
            sessionId: this.sessionId,
            source: inputSource,
            text: input,
            traceContext: turnTraceContext,
            visibility: "model-only",
          });
        } else if (options?.skipInputRecord !== true) {
          this.messageHistory.addEntries(
            buildRuntimeUserEntriesFromTurn(
              withConversationQuotes(
                input,
                options?.intent?.conversationQuotes,
                options?.intent?.botGroupSource,
              ),
              resolvedAttachments,
              {
                browserAmbientContext: options?.browserAmbientContext,
              },
            ).map((entry) => {
              const metadata = runtimeInputMetadata(options?.inputPresentation);
              return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
            }),
          );
          // /init and custom slash commands expand model input into a longer internal prompt.
          // Model-visible history must use the expanded input, while the UI, session title, and recovery snapshot
          // must show only the original query submitted by the user.
          await this.persistUserPrompt(
            userMessageId,
            displayInput,
            resolvedAttachments,
            turnTraceContext,
            {
              intent: options?.intent,
              inputPresentation: options?.inputPresentation,
              sessionInputId: options?.intent?.queueItemId,
              sourceCommandId: options?.inputId,
              ...(options?.epilogueStart === undefined
                ? {}
                : { epilogueStart: options.epilogueStart }),
            },
          );
        }
        // Configuration was previously read before displaying/persisting input, so a read failure made a sent message disappear from the UI.
        // Freeze this turn's definition after recording the input; reuse this layer's cleanup for errors/cancellation and do not start title generation or a model request.
        await this.prepareAgentDefinitions({
          signal: turnAbortSignal,
          traceContext: turnTraceContext,
        });
        throwIfTurnAborted(turnAbortSignal);
        if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
          // Reason for the fix: title generation used to wait for the main turn to succeed, so if the user stopped/cancelled the first request
          // the generated title was never started. Generate it asynchronously after persisting the first query so cancellation of the main path cannot block it.
          const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            {
              deferIfProviderRuntimeHeadersRefresh: true,
            },
          );
          shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
        }
        // Append the Plugin reminder only after its corresponding user message is written to history and the session store.
        // This keeps provider order stable as user → system, and cold hydration restores the same causal order.
        // The input may already have been expanded by a custom command; parsing it would incorrectly treat plugin://
        // inside the command template as a user reference. Parse only the canonical displayInput actually persisted.
        // A runtime-internal model-only continuation is not new user intent, so do not parse it again.
        if (options?.inputVisibility !== "model-only") {
          await this.injectPluginReferenceReminderFromTurn(
            displayInput,
            turnTraceContext,
            options?.toolDisallowlist,
          );
        }

        this.messageHistory.setCacheMiss();
        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        startProjectMemoryRecallPrefetch(
          this,
          {
            model: loopModel,
            traceContext: turnTraceContext,
            turnAbortSignal,
          },
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        loopState = {
          activeTurn,
          ...(options?.automationId ? { automationId: options.automationId } : {}),
          // Put the off-peak dispatch turn identity in loop state so tool execution boundaries can deny OffPeakCreate.
          ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
          anomalyWarningsInjected: 0,
          backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
          workflowResultConsumed: options?.workflowResultConsumed === true,
          completedRealToolResultBatch: false,
          currentUserMessageId: userMessageId,
          events,
          input,
          ...(options?.inputId ? { inputId: options.inputId } : {}),
          modelResponse: "",
          model: loopModel,
          ...(options?.modelExecution?.selectionScope === "execution"
            ? { modelSelectionScope: "execution" as const }
            : {}),
          // If the accelerated card expires during tool execution, do not fail the whole turn; fall back to Session Selection and finish it.
          ...(options?.modelExecution?.selectionFallback
            ? { selectionFallback: options.modelExecution.selectionFallback }
            : {}),
          ...(options?.modelExecution?.subagents && options.intent?.modelSelection
            ? {
                subagentModelOverride: {
                  selection: options.intent.modelSelection,
                  requestDependencies: options.modelExecution.requestDependencies,
                  background: options.modelExecution.subagents.background,
                },
              }
            : {}),
          modelStepCount: 0,
          historyRoundCount: 0,
          reactiveCompactAttemptedInCurrentModelStep: false,
          repeatedToolCallSignature: undefined,
          repeatedToolCallStreakCount: 0,
          stopHookContinuationCount: 0,
          streamRecoveryRetryCount: 0,
          tokenCount: 0,
          toolCallCount: 0,
          turnRequestState: {
            // The Turn borrows the canonical member set once and advances it only through an explicit commit; the entry itself
            // follows MessageHistory's immutability contract.
            entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
            outputTokenContinuationCount: 0,
          },
          toolDisallowlist: options?.toolDisallowlist,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnOutputStyle: admittedOutputStyle,
          turnTraceContext,
          userMessageId,
        };

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        const turnUsage = createModelUsageSummaryFromEvents(events);
        // ChatGPT plan (SIWC) usage windows ride the completion usage so the host can record the
        // latest per-account snapshot without extra network calls; absent for every other provider.
        const providerRateLimitReading = latestProviderRateLimitReadingFromEvents(events);
        const turnUsagePayload = providerRateLimitReading
          ? {
              ...(turnUsage ?? {}),
              providerRateLimits: providerRateLimitReading.usage,
              providerRateLimitProviderId: providerRateLimitReading.providerId,
            }
          : turnUsage;
        // Settle goal usage/active-run first, then persist the exact goal/verifier boundary. TurnComplete may expose the final
        // assistant fork in the projection/UI only after both have been persisted.
        await this.accountTargetTurnCompletion({
          inputID: targetRunInputID,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          traceContext: turnTraceContext,
          usage: turnUsage,
        });
        if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
          await persistStableForkCompletionBoundary(this, {
            boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
            startMessageId: loopState.stableProductStartMessageId,
            historyRoundCount: loopState.historyRoundCount,
            traceContext: turnTraceContext,
          });
        }
        if (loopState.stableBoundaryAssistantMessageId) {
          await appendBrowserTurnScreenshot(
            this,
            loopState,
            loopState.stableBoundaryAssistantMessageId,
          );
        }
        const completeEvent = this.createEvent(
          SessionEventType.TurnComplete,
          {
            response: loopState.modelResponse,
            tokenCount: loopState.tokenCount,
            usage: turnUsagePayload,
            toolCallCount: loopState.toolCallCount,
            historyRoundCount: loopState.historyRoundCount,
            duration: Date.now() - turnMachine.state.startedAt.getTime(),
            resultType: "success",
            ...(loopState.backgroundSubagentResultConsumed
              ? { backgroundSubagentResultConsumed: true }
              : {}),
            ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
            cacheStats: this.messageHistory.getCacheStats(),
            inputId: options?.inputId,
          },
          turnTraceContext,
        );
        await this.appendEvent(completeEvent, turnTraceContext);
        events.push(completeEvent);
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          events,
          startedAt: turnStartedAtMs,
          status: "completed",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
          // For models that refresh provider runtime headers before a request, generating the title before the main turn
          // would consume the authentication-refresh window first and cause the actual user message to fail.
          maybeStartDeferredSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
          );
        }
        this.turnNumber++;

        const projection = await this.rebuildProjection();
        this.logger?.info("Turn completed", {
          ...traceContextToLogContext(turnTraceContext),
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          event: "turn.completed",
          module: "core.runtime",
          status: "completed",
          toolCallCount: loopState.toolCallCount,
        });
        // The per-turn execution strategy suppresses background extraction for this successful Turn only; it does not change Session Memory configuration.
        if (options?.modelExecution?.memoryExtraction !== "skip") {
          scheduleProjectMemoryExtraction(this, {
            model: loopState.model,
            traceContext: turnTraceContext,
          });
        }

        const result: TurnResult = {
          response: loopState.modelResponse,
          turnId,
          traceId,
          usage: turnUsage,
          events,
          projection,
        };
        return result;
      } catch (error) {
        turnFailureHandled = true;
        const coreError = createTurnFailureError(error, turnAbortSignal, "Turn execution failed");
        const preserveQueueAutoDrainOnCancel =
          coreError.type === CoreErrorType.TurnCancelled &&
          this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
        const finishedTarget = await this.finishTargetTurnAccounting({
          endedAtMs: Date.now(),
          inputID: targetRunInputID,
          startedTarget,
          status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
          traceContext: turnTraceContext,
        });
        if (finishedTarget?.targetID === startedTarget?.targetID) {
          startedTarget = finishedTarget;
        }
        if (coreError.type === CoreErrorType.TurnCancelled) {
          await this.pauseActiveTargetForCancellation(turnTraceContext);
          if (activeTurn) {
            await this.fallbackPendingGuidesToQueue({
              activeTurn,
              events,
              reasonCode: "guide.turnInterrupted",
              traceContext: turnTraceContext,
            });
          }
        }
        // An ordinary TurnError ends only the current turn; it does not revoke already accepted future input.
        // The V4 TurnError projection pauses the queue on error, so runtime also closes inline drain and
        // preserves queued input until the user explicitly resumes.
        if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
          const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
          if (pendingInputs.length > 0) {
            this.queueAutoDrain = false;
            this.queueExternalDrainActive = false;
          }
        } else if (
          activeTurn &&
          coreError.type === CoreErrorType.TurnCancelled &&
          !preserveQueueAutoDrainOnCancel &&
          activeTurn.pendingInputs.length > 0
        ) {
          // Keep the runtime authorization bit in sync with the projection: when TurnComplete(cancelled)+queue>0,
          // the projection sets queue.autoDrain to false (held), so runtime's drain gate must flip too.
          // Otherwise a new turn started while held would drain later queued items and diverge from projection semantics.
          this.queueAutoDrain = false;
          this.queueExternalDrainActive = false;
        }

        // A background wake may be cancelled before loopState initializes; preserve the fact that it was already dequeued.
        const backgroundSubagentResultConsumed =
          options?.backgroundSubagentResultConsumed === true ||
          loopState?.backgroundSubagentResultConsumed === true;
        const workflowResultConsumed =
          options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          turnPhase: turnMachine.state.phase,
          inputId: options?.inputId,
          traceContext: turnTraceContext,
          fallbackMessage: "Turn execution failed",
          logEvent: "turn.failed",
          logLabel: "Turn",
          preserveQueueAutoDrainOnCancel,
          backgroundSubagentResultConsumed,
          workflowResultConsumed,
          historyRoundCount: loopState?.historyRoundCount,
        });
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          error: coreError,
          events,
          startedAt: turnStartedAtMs,
          status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        throw coreError;
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    disposeProjectMemoryRecallPrefetch(this);
    if (targetRunHeartbeat) {
      clearInterval(targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(activeTurn);
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // Lifecycle cleanup failure must not override a main turn that already completed/failed; the backend retries cleanup when the session closes.
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}

function injectDateChangeReminderIntoMessageHistory(this: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(this.now());
  const previousDate = this.lastEmittedLocalDate;
  this.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) {
    return;
  }

  this.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}

function injectReferencedSessionContextReminderIntoMessageHistory(
  this: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  this.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
