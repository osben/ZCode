import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  ModelSelection,
  SessionInfo,
  SessionTitleSource,
  TraceContext,
} from "../deps.js";
import type { AgentTelemetryCausation } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistFallbackGoalSummaryTitle,
  persistGeneratedGoalSummaryTitle,
} from "./goal-summary-title.js";
import {
  SESSION_TITLE_QUERY_SOURCE,
  generateTitleCandidate,
  normalizeTitleInput,
  retainTitleModelContext,
  type TitleModelContext,
} from "./title-generation-sidecar.js";

const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [
  "default",
  "first_input",
  "generated",
];
const MIN_GENERATED_TITLE_INPUT_CHARS = 10;

export function maybeStartSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  options?: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    offPeakExecutionId?: string;
  },
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    deferIfProviderRuntimeHeadersRefresh: options?.deferIfProviderRuntimeHeadersRefresh,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    offPeakExecutionId: options?.offPeakExecutionId,
    messageID,
    traceContext,
  });
}

export function maybeStartDeferredSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  offPeakExecutionId?: string,
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    messageID,
    traceContext,
    offPeakExecutionId,
  });
}

export function maybeStartSessionTitleGenerationFromExternalInput(
  this: AgentRuntimeInternal,
  input: string,
  options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
): void {
  // Protocol commands such as /goal do not use ordinary executeTurn, but the objective remains the first user-visible intent.
  // Reuse the title seed here without persisting an extra user message, avoiding transcript pollution for title generation.
  maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    bypassShortInputGuard: true,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    traceContext: options?.traceContext ?? this.rootTraceContext,
  });
}

function maybeStartSessionTitleGenerationFromSeed(
  this: AgentRuntimeInternal,
  input: string,
  options: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    messageID?: MessageId;
    traceContext: TraceContext;
    bypassShortInputGuard?: boolean;
    offPeakExecutionId?: string;
  },
): boolean {
  if (
    !shouldAttemptSessionTitleGeneration(this, input, {
      bypassShortInputGuard: options.bypassShortInputGuard,
    })
  ) {
    return false;
  }
  if (
    options.deferIfProviderRuntimeHeadersRefresh &&
    shouldDeferSessionTitleForRuntimeHeaders(this)
  ) {
    // Title generation for the first message shares the same runtimeModel as the main message.
    // For providers that need runtime-header refresh, send the main turn first and generate the title asynchronously afterward.
    return false;
  }
  this.sessionTitleGenerationAttempted = true;
  // The title task outlives the current Turn. Freeze causation when enqueuing it so later awaits,
  // scheduler behavior, or implementation refactoring cannot silently drop the background Trace's Link to the triggering Span.
  const causation = this.agentTelemetry.captureCausation();
  const modelContext = retainTitleModelContext(this, options.offPeakExecutionId);

  const generation = generateAndPersistSessionTitle
    .call(this, input, options.messageID, options.traceContext, {
      causation,
      modelContext,
      goalSummaryTargetID: options.goalSummaryTargetID,
    })
    .catch(async (error) => {
      this.logger?.warn("Session title generation failed", {
        ...traceContextToLogContext(options.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_title_generation.failed",
        module: "core.runtime",
        status: "failed",
      });
      if (options.goalSummaryTargetID) {
        await persistFallbackGoalSummaryTitle.call(this, {
          objective: input,
          reason: "session_title_generation_failed",
          targetID: options.goalSummaryTargetID,
          traceContext: options.traceContext,
        });
      }
    })
    .finally(() => modelContext.release());
  void this.trackResidencyBlockingWork(generation).catch((error) => {
    this.logger?.warn("Session title fallback persistence failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_title_generation.fallback_failed",
      module: "core.runtime",
      status: "failed",
    });
  });
  return true;
}

function shouldAttemptSessionTitleGeneration(
  runtime: AgentRuntimeInternal,
  input: string,
  options: { bypassShortInputGuard?: boolean } = {},
): boolean {
  if (runtime.sessionTitleGenerationAttempted) return false;
  if (runtime.config.titleGeneration?.enabled === false) return false;
  if (!runtime.config.titleGeneration) return false;
  if (!runtime.sessionStore) return false;
  if (runtime.config.parentSessionId) return false;
  if (runtime.config.taskType && runtime.config.taskType !== "interactive") return false;
  if (runtime.turnNumber !== 0) return false;
  const normalizedInput = normalizeTitleInput(input);
  if (normalizedInput.length === 0) return false;
  // A short initial input is already a readable title. Running the generated-title sidecar would
  // consistently overwrite titles such as "hi" with the generic "New Coding Session."
  return (
    options.bypassShortInputGuard ||
    Array.from(normalizedInput).length >= MIN_GENERATED_TITLE_INPUT_CHARS
  );
}

function shouldDeferSessionTitleForRuntimeHeaders(runtime: AgentRuntimeInternal): boolean {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (!runtimeHeadersPort) return false;
  const selection =
    runtime.config.titleGeneration?.modelSelection ?? runtime.getSessionModelSelection();
  if (!selection) return true;
  return (
    runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
      providerId: selection.providerId,
      modelId: selection.modelId,
    }) ?? true
  );
}

async function generateAndPersistSessionTitle(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
  options: {
    causation?: AgentTelemetryCausation;
    goalSummaryTargetID?: string;
    modelContext?: TitleModelContext;
  } = {},
): Promise<void> {
  const initialSession = await this.sessionStore?.getSession(this.sessionId);
  if (!initialSession || initialSession.parentID || initialSession.taskType !== "interactive") {
    return;
  }

  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(
      this,
      initialSession,
      messageID,
      traceContext,
    )
  ) {
    return;
  }

  const shouldPersistSessionTitle = initialSession.titleSource !== "custom";
  if (!shouldPersistSessionTitle && !options.goalSummaryTargetID) {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }
  if (options.goalSummaryTargetID) {
    this.logger?.info("Goal summary title generation started", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.started",
      module: "core.runtime",
      querySource: SESSION_TITLE_QUERY_SOURCE,
      status: "started",
      targetId: options.goalSummaryTargetID,
    });
  }

  const generated = await generateTitleCandidate.call(this, input, {
    causation: options.causation,
    modelContext: options.modelContext,
    messageID,
    querySource: SESSION_TITLE_QUERY_SOURCE,
    traceContext,
  });
  if (!generated) {
    if (options.goalSummaryTargetID) {
      // The first /goal uses the session title sidecar as the summaryTitle source too.
      // If this sidecar returns an empty response, provide a fallback for the goal summary or the first iteration will have no meaningful title.
      await persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "session_title_empty",
        targetID: options.goalSummaryTargetID,
        traceContext,
      });
    }
    return;
  }

  if (shouldPersistSessionTitle) {
    await persistGeneratedSessionTitle.call(this, {
      messageID,
      modelSelection: generated.modelSelection,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }

  if (options.goalSummaryTargetID) {
    await persistGeneratedGoalSummaryTitle.call(this, {
      targetID: options.goalSummaryTargetID,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }
}

/**
 * renameSession: explicitly renames the session by the user (titleSource=custom). Automatic title
 * generation is skipped afterward (see the custom_title short circuit in persistGeneratedSessionTitle); persist it and emit
 * SessionTitleUpdated(source:custom) to update v4 projection metadata.
 */
export async function setCustomSessionTitle(
  this: AgentRuntimeInternal,
  input: { title: string; traceContext: TraceContext },
): Promise<void> {
  const previous = await this.sessionStore?.getSession(this.sessionId);
  const previousTitle = previous?.title ?? "";
  await this.sessionStore?.updateSession({
    id: this.sessionId,
    title: input.title,
    titleSource: "custom",
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle,
        source: "custom",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function persistGeneratedSessionTitle(
  this: AgentRuntimeInternal,
  input: {
    messageID: MessageId | undefined;
    modelSelection: ModelSelection;
    title: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // The title sidecar now starts concurrently after the first query is persisted, so the user may edit that query before the LLM responds.
  // Re-read the session before writing back to prevent a generated title for the old query from replacing the edited first-screen title.
  const session = await getSessionForGeneratedTitle.call(this, input.messageID, input.traceContext);
  if (!session) return;
  if (session.titleSource === "custom") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }

  const previousTitle = session.title;
  const updated = await this.sessionStore?.updateSession({
    expectedTitleSources: GENERATED_TITLE_EXPECTED_SOURCES,
    id: this.sessionId,
    title: input.title,
    ...(input.messageID ? { titleMessageID: input.messageID } : {}),
    titleSource: "generated",
  });
  if (!updated || updated.title !== input.title || updated.titleSource !== "generated") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "title_source_changed",
    });
    return;
  }

  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        // The old persisted-event DTO has not been migrated; do not expose this projection again as title-generation configuration.
        ...(input.messageID ? { messageID: input.messageID } : {}),
        previousTitle,
        source: "generated",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function getSessionForGeneratedTitle(
  this: AgentRuntimeInternal,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<SessionInfo | null> {
  const session = await this.sessionStore?.getSession(this.sessionId);
  if (!session || session.parentID || session.taskType !== "interactive") return null;
  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(this, session, messageID, traceContext)
  ) {
    return null;
  }
  return session;
}

async function shouldSkipGeneratedTitleForFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!(await isSuppressedByFirstQueryEdit.call(this, session, messageID))) return false;
  this.logger?.debug("Session title generation skipped", {
    ...traceContextToLogContext(traceContext),
    event: "session_title_generation.skipped",
    module: "core.runtime",
    reason: "first_query_edited",
  });
  return true;
}

async function isSuppressedByFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
): Promise<boolean> {
  // Editing the first query uses conversation_rewind to target the old user message.
  // Even if the old query's title request has already been sent, it may record usage only and must not write back the session title.
  if (messageID && session.revert?.targetMessageID === messageID) return true;
  return hasEditedFirstVisibleUserQuery.call(this, session);
}

async function hasEditedFirstVisibleUserQuery(
  this: AgentRuntimeInternal,
  session: SessionInfo,
): Promise<boolean> {
  const revert = session.revert;
  if (revert?.kind !== "conversation_rewind" || !revert.targetMessageID) return false;
  const keptMessageIds = new Set(revert.keptMessageIDs ?? []);
  if (keptMessageIds.size === 0) return true;

  const messages = await this.sessionStore?.messages({ sessionID: this.sessionId });
  if (!messages) return false;
  return !messages.some(
    (message) => keptMessageIds.has(message.info.id) && isVisibleRealUserMessage(message),
  );
}

function isVisibleRealUserMessage(message: MessageWithParts): boolean {
  const info = message.info;
  return info.role === "user" && info.synthetic !== true && info.visibility !== "model-only";
}
