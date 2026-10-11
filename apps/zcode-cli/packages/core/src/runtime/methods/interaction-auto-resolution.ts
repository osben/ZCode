import {
  SessionEventType,
  type UserInputAutoResolutionUpdatedPayload,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Record the automatic completion phase for AskUserQuestion. Events must use the runtime's durable append/sink path
 * so desktop continuous and web remote replayable both restore the same absolute timestamps.
 */
export async function recordUserInputAutoResolutionUpdate(
  this: AgentRuntimeInternal,
  input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.UserInputAutoResolutionUpdated,
      {
        interactionId: input.interactionId,
        toolCallId: input.toolCallId,
        autoResolution: input.autoResolution,
      } satisfies UserInputAutoResolutionUpdatedPayload,
      traceContext,
    ),
    traceContext,
  );
}
