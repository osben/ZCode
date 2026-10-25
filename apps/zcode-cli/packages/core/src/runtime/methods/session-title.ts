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
import { sanitizeTitleSeed } from "@zcode/shared";

const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [
  "default",
  "first_input",
  "generated",
];
const MIN_GENERATED_TITLE_INPUT_CHARS = 10;
// First attempt plus one retry (specs/session-title-polish.md §6.2).
const MAX_SESSION_TITLE_GENERATION_ATTEMPTS = 2;

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
  const seedText = normalizeTitleInput(sanitizeTitleSeed(input));
  if (
    !options.bypassShortInputGuard &&
    !options.goalSummaryTargetID &&
    !this.sessionTitleSeed &&
    seedText.length > 0 &&
    isTitleGenerationConfigured(this)
  ) {
    this.sessionTitleSeed = { input: seedText, messageID: options.messageID };
  }
  const mode = resolveSessionTitleGenerationMode(this, seedText, {
    bypassShortInputGuard: options.bypassShortInputGuard,
    firstTurnOnly: options.bypassShortInputGuard || Boolean(options.goalSummaryTargetID),
  });
  if (!mode) return false;
  if (
    options.deferIfProviderRuntimeHeadersRefresh &&
    shouldDeferSessionTitleForRuntimeHeaders(this)
  ) {
    // Title generation for the first message shares the same runtimeModel as the main message.
    // For providers that need runtime-header refresh, send the main turn first and generate the title asynchronously afterward.
    return false;
  }
  // A retry prefers the first seed of this runtime when it is substantial; otherwise the current message.
  const seed =
    mode === "retry" &&
    this.sessionTitleSeed &&
    codePointLength(this.sessionTitleSeed.input) >= MIN_GENERATED_TITLE_INPUT_CHARS
      ? this.sessionTitleSeed
      : { input, messageID: options.messageID };
  this.sessionTitleGenerationInFlight = true;
  // The title task outlives the current Turn. Freeze causation when enqueuing it so later awaits,
  // scheduler behavior, or implementation refactoring cannot silently drop the background Trace's Link to the triggering Span.
  const causation = this.agentTelemetry.captureCausation();
  const modelContext = retainTitleModelContext(this, options.offPeakExecutionId);

  const generation = generateAndPersistSessionTitle
    .call(this, seed.input, seed.messageID, options.traceContext, {
      causation,
      modelContext,
      goalSummaryTargetID: options.goalSummaryTargetID,
      retry: mode === "retry",
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
    .finally(() => {
      this.sessionTitleGenerationInFlight = false;
      modelContext.release();
    });
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

type SessionTitleGenerationMode = "first" | "retry";

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Cheap in-memory gates shared by the seed memory and the mode decision. */
function isTitleGenerationConfigured(runtime: AgentRuntimeInternal): boolean {
  if (runtime.config.titleGeneration?.enabled === false) return false;
  if (!runtime.config.titleGeneration) return false;
  if (!runtime.sessionStore) return false;
  if (runtime.config.taskType === "selection_side_chat") return true;
  if (runtime.config.parentSessionId) return false;
  return !runtime.config.taskType || runtime.config.taskType === "interactive";
}

function resolveSessionTitleGenerationMode(
  runtime: AgentRuntimeInternal,
  seedText: string,
  options: { firstTurnOnly?: boolean; bypassShortInputGuard?: boolean } = {},
): SessionTitleGenerationMode | null {
  if (!isTitleGenerationConfigured(runtime)) return null;
  if (runtime.sessionTitleGenerationInFlight || runtime.sessionTitleGenerationSettled) return null;
  if (runtime.sessionTitleGenerationAttempts >= MAX_SESSION_TITLE_GENERATION_ATTEMPTS) return null;
  if (seedText.length === 0) return null;
  const meetsMinimum = codePointLength(seedText) >= MIN_GENERATED_TITLE_INPUT_CHARS;
  const sideChat = runtime.config.taskType === "selection_side_chat";
  if (runtime.turnNumber === 0 && runtime.sessionTitleGenerationAttempts === 0 && !sideChat) {
    // A short initial input is already a readable title. Running the generated-title sidecar would
    // consistently overwrite titles such as "hi" with the generic "New Coding Session."
    return options.bypassShortInputGuard || meetsMinimum ? "first" : null;
  }
  // /goal and other external inputs keep their first-turn-only behavior (their goal summary fallback depends on it).
  if (options.firstTurnOnly) return null;
  return meetsMinimum ? "retry" : null;
}

function isTitleEligibleSession(session: SessionInfo): boolean {
  if (session.taskType === "selection_side_chat") return Boolean(session.parentID);
  return !session.parentID && session.taskType === "interactive";
}

/**
 * The persisted title is still an automatic placeholder that a generated title may replace in a retry.
 * A side chat is created with a `generated` placeholder title that carries no `titleMessageID`; a title written by
 * the sidecar always records the message it came from.
 */
function isAutoTitlePending(session: SessionInfo): boolean {
  if (session.titleSource === "default" || session.titleSource === "first_input") return true;
  return (
    session.taskType === "selection_side_chat" &&
    session.titleSource === "generated" &&
    !session.titleMessageID
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
    retry?: boolean;
  } = {},
): Promise<void> {
  const initialSession = await this.sessionStore?.getSession(this.sessionId);
  if (initialSession && !isTitleEligibleSession(initialSession)) {
    // Forks, subagents and other non-interactive sessions never get a generated title; stop checking per message.
    this.sessionTitleGenerationSettled = true;
  }
  if (!initialSession || !isTitleEligibleSession(initialSession)) {
    return;
  }
  if (options.retry && !isAutoTitlePending(initialSession)) {
    // A generated or custom title already exists (for example after a cold resume or a user rename); stop retrying.
    this.sessionTitleGenerationSettled = true;
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "title_already_resolved",
    });
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
  if (!shouldPersistSessionTitle) this.sessionTitleGenerationSettled = true;
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

  this.sessionTitleGenerationAttempts++;
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
  this.sessionTitleGenerationSettled = true;
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
    this.sessionTitleGenerationSettled = true;
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
  this.sessionTitleGenerationSettled = true;

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
  if (!session || !isTitleEligibleSession(session)) return null;
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
  // The first query was edited: no title can be written for it any more, so stop re-reading the store per message.
  this.sessionTitleGenerationSettled = true;
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

/**
 * Title from an external agent's `session_title` update (specs/acp-agent-runtime.md "S3"). Uses the
 * same conditional write as generated titles: a `custom` title is never replaced, and an unchanged
 * title is skipped. The title sidecar itself does not run for external agent turns.
 */
export async function setExternalAgentSessionTitle(
  this: AgentRuntimeInternal,
  input: { title: string; traceContext: TraceContext },
): Promise<void> {
  const title = input.title.trim();
  if (title.length === 0) return;
  const session = await this.sessionStore?.getSession(this.sessionId);
  if (!session || session.parentID || session.taskType !== "interactive") return;
  if (session.titleSource === "custom" || session.title === title) return;

  const previousTitle = session.title;
  const updated = await this.sessionStore?.updateSession({
    expectedTitleSources: GENERATED_TITLE_EXPECTED_SOURCES,
    id: this.sessionId,
    title,
    titleSource: "generated",
  });
  if (!updated || updated.title !== title || updated.titleSource !== "generated") return;

  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      { previousTitle, source: "generated", title },
      input.traceContext,
    ),
    input.traceContext,
  );
}
