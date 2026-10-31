import type { ModelToolContract } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  prepareRuntimeProviderRequest,
  shouldFoldRemindersIntoToolResults,
  shouldUseMidConversationSystem,
} from "../helpers/runtime-provider-request-messages.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../../tool/search/history.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  SessionEventType,
  createChildTraceContext,
  isCoreError,
  createMessageId,
  createPartId,
  traceContextToLogContext,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  getUsageTotalTokens,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
  readApprovedPlanFileReferenceEntry,
  replaceReadFileStateAfterCompact,
  restorePostCompactFiles,
  buildRuntimeModeReminderBody,
  hasFullRuntimeModeReminder,
} from "../helpers/index.js";
import {
  buildCompactLeadingAnnouncements,
  collectSkillsListing,
  resolveSessionContextAnnouncement,
  restateContextAfterCompact,
} from "./context-refresh.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  legacySyntheticRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto reuses the policy decision, Reactive reuses the overflow path's activeMessages; other triggers do no extra projection.
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  const executionMaxOutputTokens = compactModel.optionSpecs.maxOutputTokens.max;
  // Active compact holds this shallow member snapshot across multiple awaits; it relies on the
  // RuntimeMessageEntry immutability contract. Selection, provider render, and the final replace
  // create their own copies — never mutate the shared entry/message/content inside activeEntries
  // in place during compact.
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem = shouldUseMidConversationSystem(this.config, compactModel);
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  let currentSelection = initialSelection;
  let preservedEntries = currentSelection.preservedEntries;
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  let entriesForSummary = initialEntriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // After a recent compaction or with too little history, /compact is a healthy no-op, not a system fault.
    // The fast-backfill tracker upstream records only real boundaries, so an explicit skipped must be returned.
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const preCompactHookResult = await this.runPreCompactHooks(
    trigger,
    customInstructions,
    preCompactTokenCount,
    turnTraceContext,
    options.abortSignal,
  );
  if (preCompactHookResult.blockRequested) {
    // A blocked PreCompact skips only this compaction call; the next trigger (for example the
    // next auto-compact check) dispatches the hook again.
    return {
      displayText: preCompactHookResult.stopReason
        ? `Compaction blocked by hook: ${preCompactHookResult.stopReason.slice(0, 500)}`
        : "Compaction blocked by hook",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  // Same tool catalog as the main loop (including this turn's disable rules), projected by the same request-preparation entry.
  // Fix reason: when the summary request picked different tools (only ToolSearch-related ones, or an
  // empty list beyond 100), the tools segment differed from the main loop and the whole summary
  // request missed the main loop's prefix cache.
  const compactCandidates = options.getContinuationTools?.() ?? this.getTools(compactModel);
  const registry = this.getToolRegistry();

  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      const compactPrompt = buildCompactPrompt(customInstructions);
      let result: RuntimeModelTextResult;
      let compactPromptTooLongAttempts = 0;
      let stripMediaForSummary = false;
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      while (true) {
        const prepared = prepareRuntimeProviderRequest(this, {
          model: compactModel,
          tools: compactCandidates,
          registry,
          // Discovered tools are computed from this request's messages: tools discovered only in the kept tail are not sent.
          entries: entriesForSummary,
          prompt: compactPrompt,
          applyCacheControl: true,
          skipCacheWrite: true,
        });
        const requestMessages = prepared.request.messages;
        const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
        const recordableRequestMessages =
          recordableEntries === prepared.entries
            ? requestMessages
            : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
                useMidConversationSystem,
                foldRemindersIntoToolResults: shouldFoldRemindersIntoToolResults(compactModel),
                loadedToolCallIds: prepared.loadedToolCallIds,
              });
        // Compact used to run only capability projection, missing the aggregate media budget shared
        // with plain turns; route uniformly through the model media policy so the summary request
        // cannot bypass the global request cap.
        const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
          requestMessages,
          compactModel.properties.inputFormat,
        );
        logMediaCapabilityProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.capabilityProjection,
          {
            event: "compact.request.media_capability_projection",
            message: "Compact request media capability projection",
            model: `${compactModel.providerId}/${compactModel.modelId}`,
          },
        );
        logMediaBudgetProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.mediaBudgetProjection,
          {
            event: "compact.request.media_projection",
            message: "Compact request media budget projection",
          },
        );
        let projectedRequestMessages = mediaPolicyProjection.messages;
        let projectedRecordableMessages =
          recordableRequestMessages === requestMessages
            ? projectedRequestMessages
            : projectMessagesForModelMediaPolicy(
                recordableRequestMessages,
                compactModel.properties.inputFormat,
              ).messages;
        if (stripMediaForSummary) {
          // Reusing the generic media-budget wording would pollute the summary's provider-visible content.
          const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
          projectedRequestMessages = mediaProjection.messages;
          projectedRecordableMessages =
            recordableRequestMessages === requestMessages
              ? projectedRequestMessages
              : projectCompactMediaForRetry(projectedRecordableMessages).messages;
          logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
        }

        const modelRequestEvent = this.createEvent(
          SessionEventType.ModelRequest,
          {
            // The event mistakenly used the actual request array including Continue, letting
            // query-local hints into the persisted trajectory. Consistent with v0.16.6: the event
            // records the filtered projection while the provider request below still uses the full context.
            messages: projectedRecordableMessages,
            providerId: String(compactModel.providerId),
            modelId: String(compactModel.modelId),
            querySource: "compact",
            toolCount: prepared.request.tools.length,
            compactPromptTooLongRetry: compactPromptTooLongAttempts,
          },
          modelTraceContext,
        );
        await this.appendEvent(modelRequestEvent, modelTraceContext);
        events.push(modelRequestEvent);
        const modelStartedAt = Date.now();
        const networkEventStartIndex = events.length;
        const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
        const compactModelRequest = {
          abortSignal: options.abortSignal,
          maxOutputTokens: compactSummaryMaxOutputTokens,
          messages: projectedRequestMessages,
          metadata: traceContextToLogContext(modelTraceContext),
          modelCall: {
            attributes: {
              compactionOuterAttempt: attempt,
              compactionTrigger: trigger,
            },
            operation: "context_compaction" as const,
            operationId: compactTimeline.operationId,
          },
          statusSink: this.createModelStatusSink(modelTraceContext, events),
          // compact's first real provider event ends SSE retry eligibility; a hidden partial can
          // still be discarded with an HTTP fallback before its content block commits, but after
          // block end no replay is allowed.
          preserveProviderStreamBoundaries: true,
          traceContext: modelTraceContext,
          tools: prepared.request.tools,
          toolSearchEnabled: prepared.request.toolSearchEnabled,
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
            abortSignal: options.abortSignal,
            model: compactModel,
            traceContext: modelTraceContext,
          }),
        };

        try {
          result = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: compactModelRequest,
          });
        } catch (error) {
          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            error,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            startedAt: modelStartedAt,
            status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
            traceContext: modelTraceContext,
          });
          if (isTurnCancellationError(error, options.abortSignal)) {
            throw error;
          }
          if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
            stripMediaForSummary = true;
            this.logger?.info(
              "Compact summary hit media-size error; retrying with stripped media",
              {
                ...traceContextToLogContext(modelTraceContext),
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "compact.request.media_too_large.retry",
                module: "core.runtime",
              },
            );
            continue;
          }
          if (isModelContextExceededError(error)) {
            if (reselectEntriesAfterPromptTooLong(error)) continue;
            if (truncateEntriesAfterPromptTooLong(error)) continue;
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: error,
              preCompactTokenCount,
            });
          }
          throw error;
        }

        await recordModelUsageFact(this, {
          attemptIndex: compactPromptTooLongAttempts,
          events,
          model: compactModel,
          networkEventStartIndex,
          querySource: "compact",
          result,
          startedAt: modelStartedAt,
          status: "completed",
          toolCallCount: this.extractToolCallsFromResult(result).length,
          traceContext: modelTraceContext,
        });
        const contextError = createCompactContextExceededFinishError(result);
        if (contextError) {
          // A compact summary can also report an over-window via finishReason instead of throwing;
          // it must first enter the same recent-preserve reselection logic so the finishReason path
          // does not lose context.
          if (reselectEntriesAfterPromptTooLong(contextError)) continue;
          if (truncateEntriesAfterPromptTooLong(contextError)) continue;
          throw createCompactPromptTooLongError({
            attempt: compactPromptTooLongAttempts,
            cause: contextError,
            preCompactTokenCount,
          });
        }
        break;
      }

      const summary = formatCompactSummaryOrThrow(this, result);
      const persistedSummary = summary;
      // Fix reason: file restore used to read the view cached in read state, and what it restored
      // could be stale content or a fragment; the file is now re-read. The plan file and the
      // restored file are independent — read both in parallel.
      const [planFileReferenceEntry, fileRestore] = await Promise.all([
        this.fileSystemPort
          ? readApprovedPlanFileReferenceEntry({
              abortSignal: options.abortSignal,
              fileSystemPort: this.fileSystemPort,
              sessionId: this.sessionId,
              traceContext: modelTraceContext,
              workspaceRoot: this.workspaceRoot,
            })
          : undefined,
        restorePostCompactFiles(this, {
          abortSignal: options.abortSignal,
          preservedEntries,
          traceContext: modelTraceContext,
        }),
      ]);
      // Bug root cause: after compact dropped old announcements it relied on the next request to
      // rebuild them, but a plain Continue never runs normal collection. Rebuild here from the kept
      // history after the cancellation check, using the continuation scope — not the summary's
      // candidate tools.
      throwIfTurnAborted(options.abortSignal);
      const preCompactDiscoveredTools = collectDiscoveredTools(activeEntries);
      const discovery = compactDiscoveryMetadata({
        boundaryId: createCompactBoundaryId(),
        preCompactDiscoveredTools: [...preCompactDiscoveredTools],
      });
      // The new discovery checkpoint is not committed yet; the announcement uses the same candidate classification so tools about to be promoted are not re-announced as to-load.
      const toolAnnouncement = buildToolSearchAnnouncement(
        {
          model: compactModel,
          mode: this.config.toolSearch?.mode,
          tools: options.getContinuationTools?.() ?? this.getTools(compactModel),
          registry,
          entries: preservedEntries,
        },
        preCompactDiscoveredTools,
      );
      const agentListingEntry = collectRuntimeAgentListing(
        this,
        preservedEntries,
        options.agentListingTools ?? this.getTools(options.model ?? compactModel),
      );
      const skillsListingEntry = collectSkillsListing(this, preservedEntries);
      // With a non-empty kept tail, the request-time announcement goes before the summary (minus
      // sources already in the kept tail) and Git is re-read for the current directory; with an
      // empty kept tail, the next request's request-time announcement appends at the end, and Git
      // is read then.
      const leadingReminderEntries =
        preservedEntries.length > 0
          ? buildCompactLeadingAnnouncements(
              this,
              preservedEntries,
              await resolveSessionContextAnnouncement(
                this,
                preservedEntries,
                "compaction",
                modelTraceContext,
                options.abortSignal,
              ),
            )
          : [];
      // In plan mode, compaction resends the full plan reminder.
      // Fix reason: input attachments and auto/reactive compaction share one loop pass, and
      // collection runs before compaction; the kept tail may already carry this pass's full
      // reminder, and resending unconditionally produced two full reminders and double-counted the
      // cycle. When the kept tail has only the short reminder, the full wording was summarized
      // away and must still be resent.
      const planModeReminderBody = hasFullRuntimeModeReminder(preservedEntries)
        ? null
        : buildRuntimeModeReminderBody([], this.getMode(), this.getPlanEnabled());
      // Compaction attachment order: file restore → plan file → plan reminder → ToolSearch
      // announcement → agent listing → skill list → environment → model → output style.
      // Fix reason: agent listing used to come before file restore — wrong order.
      const postCompactReminderEntries = [
        ...fileRestore.entries,
        ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
        ...(planModeReminderBody
          ? [systemReminderAttachmentEntry("runtime_mode", planModeReminderBody)]
          : []),
        ...(toolAnnouncement ? [toolAnnouncement] : []),
        ...(agentListingEntry ? [agentListingEntry] : []),
        ...(skillsListingEntry ? [skillsListingEntry] : []),
        ...restateContextAfterCompact(this, activeEntries, preservedEntries),
      ];

      const modelCompleteEvent = this.createEvent(
        SessionEventType.ModelComplete,
        {
          content: summary,
          stopReason: result.finishReason,
          usage: result.usage,
          querySource: "compact",
          toolCallCount: 0,
        },
        modelTraceContext,
      );
      await this.appendEvent(modelCompleteEvent, modelTraceContext);
      events.push(modelCompleteEvent);

      const summaryMessageId = createMessageId();
      const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
        // Same criterion as the pre-summary request-time announcement: the kept tail is non-empty.
        preservedMessagesKept: preservedEntries.length > 0,
        suppressFollowup: true,
      });
      // Continue has no corresponding Session message; store-less statistics must not count it as a preserved record either.
      const recordablePreservedEntries = filterOutputTokenContinuationEntries(preservedEntries);
      const preservation = this.sessionStore
        ? await selectPersistedCompactTail({
            sessionStore: this.sessionStore,
            sessionId: this.sessionId,
            groupsPreserved: currentSelection.groupsPreserved,
            summaryMessageId,
          })
        : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
      const summaryEntry = {
        message: { role: "user" as const, content: summaryMessageContent },
        metadata: { ...legacySyntheticRuntimeMetadata(), compactBoundary: discovery },
      };
      const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, summaryEntry, {
        leadingReminderEntries,
        postCompactReminderEntries,
        preservedEntries,
      });
      const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
        useMidConversationSystem,
      });
      const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
      const compactBoundary = buildManualCompactBoundary({
        ...discovery,
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions,
        lastSummarizedMessageId,
        phase,
        postCompactTokenCount: providerPostCompactTokenCount,
        preCompactTokenCount,
        summarizedMessageCount: entriesToSummarize.length,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        ...(currentSelection.groupsPreserved > 0
          ? {
              keptMessageCount: preservation.keptMessageCount,
            }
          : {}),
        preservedSegment: preservation.preservedSegment,
        truePostCompactTokenCount,
        willRetriggerNextTurn:
          options.autoCompactThreshold !== undefined
            ? truePostCompactTokenCount >= options.autoCompactThreshold
            : undefined,
      });

      // The discovery checkpoint is saved atomically with the summary; the Runtime history is replaced only after persistence succeeds.
      await this.persistCompactSummary(
        summaryMessageId,
        summaryMessageContent,
        persistedSummary,
        compactBoundary,
        modelTraceContext,
        {
          model: compactModel,
          operationId: compactTimeline.operationId,
          leadingReminderEntries,
          postCompactReminderEntries,
        },
      );

      const compactBoundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        compactBoundary,
        turnTraceContext,
      );
      await this.appendEvent(compactBoundaryEvent, turnTraceContext);
      events.push(compactBoundaryEvent);

      const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
        ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
        boundaryId: compactBoundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: providerPostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId,
        tailStartMessageId: lastSummarizedMessageId,
        truePostCompactTokenCount,
      });
      await persistCompactTimelineEvent(
        this,
        SessionEventType.CompactCompleted,
        compactCompletedPayload,
        turnTraceContext,
        events,
      );

      this.latestConversationMessageId = summaryMessageId;
      const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
      this.messageHistory.replaceMessages(
        options.activeEntries
          ? preserveCanonicalContextPrefix(
              this.messageHistory.borrowReadOnlyRuntimeEntries(),
              recordablePostCompactEntries,
            )
          : recordablePostCompactEntries,
      );
      replaceReadFileStateAfterCompact(this.readFileState, fileRestore.readFileStateEntries);
      resetProjectMemoryRecall(this);

      // Diagnostic-only: runs after the history replacement is committed and never alters the
      // compaction result (per docs/hooks-runtime-contract.md).
      await this.runPostCompactHooks(
        trigger,
        preCompactTokenCount,
        providerPostCompactTokenCount,
        turnTraceContext,
        options.abortSignal,
      );

      return {
        displayText: "Compacted",
        entries: postCompactEntries,
        outcome: "compacted",
        tokenCount: providerPostCompactTokenCount,
      };
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // An intermediate auto-compact failure must not become a failed bar prematurely.
        // Emit retrying on the same operation and write the final failed only after the 3rd attempt fails.
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = initialEntriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact is an independent execution chain; explicitly take the smaller of the model cap and the 20K summary cap here.
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
