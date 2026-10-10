import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK = 128;

interface ModelStreamingEventQueue {
  drain(): Promise<void>;
  enqueue(payload: ModelStreamingPayload): void;
  maybeApplyBackpressure(): Promise<void>;
}

export function createModelStreamingEventQueue(params: {
  events: SessionEvent[];
  highWaterMark?: number;
  runtime: AgentRuntimeInternal;
  traceContext: TraceContext;
}): ModelStreamingEventQueue {
  const highWaterMark = params.highWaterMark ?? MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK;
  let pendingWrites = 0;
  let tail: Promise<void> = Promise.resolve();
  let writeFailure: unknown;

  const assertNoWriteFailure = (): void => {
    if (writeFailure) {
      throw writeFailure;
    }
  };

  const drain = async (): Promise<void> => {
    await tail;
    assertNoWriteFailure();
  };

  return {
    async drain(): Promise<void> {
      await drain();
    },

    enqueue(payload: ModelStreamingPayload): void {
      assertNoWriteFailure();
      pendingWrites += 1;
      // Synchronously appending each token makes the provider SSE reader wait outside
      // iterator.next(), so frames already received are not consumed until persistence/notification finishes.
      // Serialize appends through an ordered write queue while the reader continues draining the provider queue;
      // explicitly drain at finish / error / tool_call boundaries to preserve the existing ordering semantics.
      tail = tail
        .then(async () => {
          if (writeFailure) {
            return;
          }
          await params.runtime.emitModelStreamingEvent(payload, params.traceContext, params.events);
        })
        .catch((error: unknown) => {
          writeFailure ??= error;
        })
        .finally(() => {
          pendingWrites -= 1;
        });
    },

    async maybeApplyBackpressure(): Promise<void> {
      assertNoWriteFailure();
      if (pendingWrites < highWaterMark) {
        return;
      }
      await drain();
    },
  };
}
