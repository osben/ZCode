import {
  SessionEventType,
  getCurrentModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import type { ToolExecutionContext } from "../types.js";

/**
 * Default status sink for model requests made inside tools.
 *
 * Each call site cannot be responsible for setting `statusSink`: WebSearch did, but
 * WebFetch did not. Requests without a sink still pass through and queue at the
 * admission gate, but the runner's queued / admitted / 429 events have nowhere to go.
 * The executor cannot pause its deadline (in one observed case, 18 WebFetch requests
 * waited 20–45 seconds in the queue and were cancelled at 60 seconds with `queuedMs: 0`),
 * and the driver cannot see that the subagent is waiting either.
 * Like the admission port, attach the default at the **boundary** instead of relying on
 * each call site to remember it: wrap `context.model` passed to the handler and provide
 * the session-event sink only when the call site did not supply one.
 */
export function createToolModelStatusSink(
  context: Pick<ToolExecutionContext, "emitEvent" | "sessionId" | "turnId" | "traceId">,
): ModelStatusSink | undefined {
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

/** Add the default sink when the call site has none; preserve a call-site sink (the default never overrides it). */
export function withDefaultToolModelStatusSink(
  model: Model | undefined,
  sink: ModelStatusSink | undefined,
): Model | undefined {
  if (model === undefined || sink === undefined) return model;
  return withModelInvocationContext(model, () =>
    getCurrentModelInvocationContext()?.statusSink === undefined ? { statusSink: sink } : {},
  );
}
