import {
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext, TurnId } from "../deps.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  appendTurnOutcomeEvent,
} from "../helpers/index.js";
import type { ParsedDreamCommand } from "../helpers/commands.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  runManualProjectMemoryDream,
  type ProjectMemoryDreamOutcome,
} from "../helpers/project-memory-dream.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/**
 * Manual `/dream` command turn, structured like `executeManualCompact`: the command text is
 * `model-only` in events, the Memory agent runs on the detached Memory path (no session usage
 * events — the TurnComplete usage summary is intentionally empty), and the final assistant text
 * becomes the turn response.
 */
export async function executeManualDream(
  this: AgentRuntimeInternal,
  input: string,
  command: ParsedDreamCommand,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
): Promise<TurnResult> {
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "dream", false);
  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("Dream command started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "dream.command.started",
      module: "core.runtime",
      status: "started",
    });

    await this.ensureSessionPersisted(input, turnTraceContext);

    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input,
        inputId,
        // Manual /dream is a maintenance command, not a real user query.
        // Keep raw input in events for recovery/diagnostics, but the v4 projection must not render it as a user bubble.
        inputVisibility: "model-only",
      },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      throwIfTurnAborted(abortSignal);
      const outcome = command.ok
        ? await runManualProjectMemoryDream(this, {
            abortSignal,
            traceContext: turnTraceContext,
          })
        : { status: "usage-error" as const };
      throwIfTurnAborted(abortSignal);

      if (outcome.status === "failed") {
        throw outcome.error;
      }
      const response = formatDreamCommandResponse(outcome);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response,
          tokenCount: 0,
          usage: turnUsage,
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: Date.now() - startedAt,
          resultType: "success",
          cacheStats: this.messageHistory.getCacheStats(),
          inputId,
        },
        turnTraceContext,
      );
      await this.appendEvent(completeEvent, turnTraceContext);
      events.push(completeEvent);
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt,
        status: "completed",
        traceContext: turnTraceContext,
        turnId,
      });

      this.turnNumber++;
      const projection = await this.rebuildProjection();
      this.logger?.info("Dream command completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "dream.command.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response,
        turnId,
        traceId: turnTraceContext.traceId,
        usage: turnUsage,
        events,
        projection,
      };
    } catch (error) {
      const coreError = createTurnFailureError(error, abortSignal, "Dream failed");
      const preserveQueueAutoDrainOnCancel =
        coreError.type === CoreErrorType.TurnCancelled &&
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      if (coreError.type === CoreErrorType.TurnCancelled && !preserveQueueAutoDrainOnCancel) {
        // Stopping the dream command follows ordinary Stop semantics: pause the queue again and close the outer FIFO resume window too.
        this.queueAutoDrain = false;
        this.queueExternalDrainActive = false;
      }
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "dream",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "Dream failed",
        logEvent: "dream.command.failed",
        logLabel: "Dream",
        preserveQueueAutoDrainOnCancel,
      });

      throw coreError;
    }
  }).finally(() => {
    this.finishActiveTurn(activeTurn);
  });
}

function formatDreamCommandResponse(
  outcome: Exclude<ProjectMemoryDreamOutcome, { status: "failed" }> | { status: "usage-error" },
): string {
  if (outcome.status === "usage-error") {
    return "Usage: /dream — takes no arguments. Run /dream to consolidate project memory now.";
  }
  if (outcome.status === "skipped") {
    switch (outcome.reason) {
      case "memory-disabled":
        return "Dream skipped: project memory is not enabled for this workspace.";
      case "remote-workspace":
        return "Dream skipped: it is unavailable for remote workspaces. Run it from the local session.";
      case "lock-held":
        return "Dream skipped: another dream is already running for this workspace. Try again once it finishes.";
      case "no-fresh-transcripts":
        return "Dream skipped: no new session activity since the last dream — nothing to consolidate yet.";
      default:
        return "Dream skipped.";
    }
  }
  const filesLine =
    outcome.touchedPaths.length > 0
      ? `\n\nFiles changed: ${outcome.touchedPaths.join(", ")}`
      : "";
  return `${outcome.summary}${filesLine}`;
}
