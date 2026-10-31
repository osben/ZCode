import { assertNotExternalAgentModel } from "@zcode/contracts";
import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationOutput,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import { prepareRuntimeProviderRequest, throwIfTurnAborted } from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";

export interface TargetCompletionVerificationResult {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verification = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });

    if (!verification.passed) {
      return {
        target: input.target,
        verification,
      };
    }

    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const completedTarget =
      (await this.sessionStore!.updateTargetStatus({
        sessionID: this.sessionId,
        status: "complete",
      })) ?? input.target;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget,
      source: "runtime",
      target: completedTarget,
      traceContext: input.traceContext,
    });

    return {
      target: completedTarget,
      verification,
    };
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<GoalCompletionVerificationOutput> {
  // Switching the session default model during goal verification is allowed; request, retries, and
  // usage must share the model snapshot taken at verification start, never re-reading Session
  // Selection after the provider returns.
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  // Like every model step in the turn, the verifier re-projects the prefix with this request's model.
  // Fix reason: rebuilding after the turn ended (language, output style changes, …) carried no model
  // and defaulted to MCS wording; models without MCS support got Harness wording contradicting the
  // actual delivery, and the prefix cache went stale.
  rebuildContextPrefix(this, { model });
  const prepared = prepareRuntimeProviderRequest(this, {
    entries: withoutTrailingPendingAssistantToolCallEntries(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
    ),
    prompt: formatGoalCompletionVerificationPrompt(input.target),
    tools: [],
    applyCacheControl: true,
    model,
  });
  // The verifier consumes the full history directly but used to bypass the normal request media
  // policy; patching only capability still let aggregate-limit failures reach fail-open. Apply the
  // capability and budget projection uniformly before the request.
  const messages = projectMessagesForModelMediaPolicy(
    prepared.request.messages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      request: { ...prepared.request, messages },
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    const verification =
      toolCalls.length > 0
        ? failOpenGoalCompletionVerification(
            "The completion verifier attempted to call tools instead of returning a verification result.",
          )
        : parseGoalCompletionVerificationText(result.text);
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "completed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  } catch (error) {
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: input.abortSignal?.aborted ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (input.abortSignal?.aborted) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // When a user Stop or a queued "send now" interrupts the goal verifier, no current
      // cancellation path of a plain executeTurn pauses the target. If it stayed active, a later
      // resumeSession + sendPrompt would be treated by the agent as a goal continuation, and plain
      // user messages would keep emitting checkpoints.
      await this.pauseActiveTargetForCancellation(modelTraceContext);
      throw error;
    }
    this.logger?.warn("Goal completion verification failed open", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_open",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    const verification = failOpenGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  }
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {
  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    request: ReturnType<typeof prepareRuntimeProviderRequest>["request"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink: this.createModelStatusSink(input.traceContext, input.events),
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        assertNotExternalAgentModel(input.model, "goal completion verification").generateText({
          abortSignal: input.abortSignal,
          ...input.request,
          // The verifier inherits the already-bound thinking config; it must not apply the downgraded level and caps of low-cost auxiliary calls.
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // Goal completion verification runs after the user has already seen assistant iterations; a
      // Start Plan busy is transient admission concurrency. Retry briefly first instead of going
      // straight to fail-open and mistaking recoverable concurrency for completion.
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // Goal iteration advances via the verifier lifecycle, not plain turns or user continuation counts.
  // The runtime pins the same number across started/completed/failed_closed/cancelled so the UI and
  // snapshot never each guess their own.
  return latestIteration + 1;
}

function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
