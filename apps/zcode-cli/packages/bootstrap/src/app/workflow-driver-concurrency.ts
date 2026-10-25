// ============================================================
// Driver-side half of adaptive concurrency: per-actor admission + model-state observation + failure attribution
// ============================================================
// Split from workflow-driver.ts: that file handles only session and turn orchestration, while these
// three concerns do not touch turn orchestration. They wrap the coordinator port as one actor's
// `ModelRequestAdmission`, read only the actor runtime's session event stream, and observe only
// run-level success/retry timing (stall clock). Model failure attribution (formerly
// modelFailureReasonOf) moved to the adapters policy table (`inspectWorkflowModelFailure`), shared
// by runner and driver.

import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  AskLastTool,
  AskProgress,
  AskWaitInfo,
  InstanceRef,
  RunStallInfo,
} from "@zcode/dynamic-workflow";
import { createActorToolActivity, type ActorToolCounts } from "./workflow-driver-tool-activity.js";
import {
  workflowConcurrencyKey,
  type WorkflowConcurrencyPort,
} from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** Same rule as the coordinator: these two retries are not provider failures and do not merit a badge. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface ActorModelActivityHandlers {
  /** The ask's next model request is waiting: for a slot (`cause: "slot"`) or in backoff (`cause: "backoff"`). */
  onWaiting(info: AskWaitInfo): void;
  /** The ask's model request was actually sent (the first request or one after a wait). */
  onExecuting(): void;
  /** Any model request for this actor (turn or tool-side) completed successfully; resets the run-level stall clock. */
  onRequestCompleted?(): void;
  /** Runner scheduled a retry (excluding signature repair/auth refresh); arms the run-level stall clock. */
  onRetryScheduled?(reason: string): void;
  /**
   * A subagent of an in-flight ask is about to execute a tool that mutates the workspace (at most
   * once per ask; this module resolves the instance through `live`, and reports nothing if not
   * in-flight). The engine uses this to close the amend-resume import cache.
   */
  onMutating?(instance: InstanceRef): void;
}

/**
 * An actor's **observation surface**: its runtime `ModelRequestAdmission` (admission), model state
 * from its session event stream (source of executing/waiting badges), and tool calls on that same
 * stream (first workspace write -> close import cache, plus this ask's tool count; see
 * workflow-driver-tool-activity.ts). They share a per-ask lifecycle, so the driver holds one object
 * and observes/resets/unsubscribes once. This also lets it recognize `model_request_started` after
 * waiting for a slot as a resumed request.
 */
export interface ActorModelActivity {
  /** Admission port passed to runtime deps; undefined when the coordinator port is absent (ungated). */
  readonly admission: ModelRequestAdmission | undefined;
  /** Reset when switching asks: waiting/executing state and tool counts from one ask must not leak into the next. */
  reset(): void;
  /** Tool-call count observed so far for this ask (fed into AskStats). */
  toolCounts(): ActorToolCounts;
  /** Most recent tool call started so far in this ask (fed into `node-progress` lastTool). */
  lastTool(): AskLastTool | undefined;
  /**
   * Record that another turn resolved and return the ask progress at this point (`turn` starts at 1).
   * Keep the count here rather than in SessionState because it shares the per-ask lifecycle with
   * tool counts: the same reset clears both, both accumulate within one ask, and a new round from a
   * nudge counts as turn two.
   */
  noteTurnResolved(): AskProgress;
  /** Subscribe to runtime session events (model state + tool calls); no-op if a minimal stub runtime lacks subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

/**
 * Phase of one request chain. A chain is "one logical request and all its retries," keyed by
 * (querySource, queryId, toolCallId): a turn step has queryId but no toolCallId, concurrent
 * WebSearch calls each have their own toolCallId, and compaction/title sidecars have their own
 * querySource. Retries change requestId but not this key, so a chain in backoff and its next attempt are one chain.
 */
type ChainPhase = "queued" | "executing" | "backoff";

interface Chain {
  phase: ChainPhase;
  /** Most recent waiting info (queued/backoff); if only waiters remain after a chain ends, use the latest one for waiting. */
  wait?: AskWaitInfo;
  waitSeq: number;
}

/**
 * Aggregation rules (replacing a single phase): the driver tracks a set of in-flight request chains
 * for each actor—
 *   - `model_request_queued` (`tryAcquire` miss) -> chain queued;
 *   - `model_request_admitted` / `model_request_started` -> chain executing;
 *   - `model_retry_scheduled` (except `reasoning_signature_repair` / `auth_refresh`) -> chain backoff;
 *   - `model_request_completed` / non-retryable `model_request_failed` -> chain ends (removed from set).
 * Subagent phase: any executing chain -> executing; otherwise, if a chain is waiting -> waiting
 * (with its latest waiting info); if the set is empty -> keep the previous phase and emit no event
 * (while a tool runs within one ask, the subagent still shows executing unless that tool itself queues).
 * A subagent may hold multiple permits at once (parallel tool calls), so a single phase no longer works.
 *
 * This is a driver-**internal** observation subscription, not a transcript live stream: the v4
 * gateway drains only contiguous seq values, so transcript streaming must use the child runtime's
 * construction-time eventSink (the run service test asserts this). This subscription reads only
 * model network state, where missing seq 1 does not matter.
 */
export function createActorModelActivity(input: {
  port: WorkflowConcurrencyPort | undefined;
  runId: string;
  /** Current in-flight ask instance (undefined after settlement/cancellation); needed only for tool activity reports. */
  live?: () => InstanceRef | undefined;
  handlers: ActorModelActivityHandlers;
  /**
   * This run's seat gate and this subagent's key within it (docs/dynamic-workflow/concurrency.md
   * "Retuning a live run"). When present, wrap admission once more: wait for a seat, then pass
   * through the coordinator. When absent, this run's limit never changes mid-run (snippet
   * execution or an ungated assembly), and the admission port behaves exactly as before.
   */
  seat?: { gate: WorkflowRunSeatGate; key: string };
}): ActorModelActivity {
  const chains = new Map<string, Chain>();
  let executing = false;
  /** Most recently reported waiting info; cleared on executing. Report identical waiting info only once per wait period. */
  let reportedWait: AskWaitInfo | undefined;
  /** Number of resolved turns in this ask (`node-progress` turn); reset when switching asks. */
  let turnsResolved = 0;
  let waitSeq = 0;
  let unsubscribeEvents: (() => void) | undefined;
  const { handlers, live, port, runId, seat } = input;
  // Second reader of the same session event stream: tool calls. Implementation lives in a separate
  // file (including detection and counting); this only folds it into the same lifecycle so the
  // driver still has one observation object.
  const toolActivity = createActorToolActivity({
    onMutating: () => {
      const instance = live?.();
      if (instance !== undefined) handlers.onMutating?.(instance);
    },
  });

  const anyExecuting = (): boolean => {
    for (const chain of chains.values()) if (chain.phase === "executing") return true;
    return false;
  };
  /**
   * Still waiting after aggregation: report one waiting event (exactly one per wait period).
   * If one subagent starts four concurrent WebSearch calls and all four chains queue in the same
   * millisecond, four queued events would each report `waiting(slot)`; in practice 26 of 80 waiting
   * records were identical duplicates from the same millisecond. The subagent phase has not
   * changed, so do not emit another event: suppress it when every field matches the previous report,
   * and report again only after executing transitions back to waiting.
   */
  const reportWaiting = (info: AskWaitInfo): void => {
    if (anyExecuting()) return;
    executing = false;
    if (reportedWait !== undefined && sameWait(reportedWait, info)) return;
    reportedWait = info;
    handlers.onWaiting(info);
  };
  const reportExecuting = (): void => {
    reportedWait = undefined;
    if (executing) return;
    executing = true;
    handlers.onExecuting();
  };
  const setWaiting = (key: string, phase: "queued" | "backoff", wait: AskWaitInfo): void => {
    waitSeq += 1;
    chains.set(key, { phase, wait, waitSeq });
    reportWaiting(wait);
  };
  /** A chain ended: if none are executing but some are waiting, the subagent enters waiting now; report the latest waiting info. */
  const endChain = (key: string): void => {
    if (!chains.delete(key) || anyExecuting()) return;
    let latest: Chain | undefined;
    for (const chain of chains.values()) {
      if (chain.wait !== undefined && (latest === undefined || chain.waitSeq > latest.waitSeq)) latest = chain;
    }
    if (latest?.wait !== undefined) reportWaiting(latest.wait);
  };

  // Admission port is a narrow wrapper around the coordinator port: fast path = tryAdmit; queue =
  // admit (`waiting(slot)` comes from the runner's queued event, so do not emit it here). acquire
  // still tries the fast path first to support callers that do not use tryAcquire.
  const governed: ModelRequestAdmission | undefined =
    port === undefined
      ? undefined
      : {
          tryAcquire: ({ model }) => port.tryAdmit(runId, workflowConcurrencyKey(model)),
          acquire: async ({ model, signal }) => {
            const key = workflowConcurrencyKey(model);
            return (
              port.tryAdmit(runId, key) ??
              (await port.admit(runId, key, signal ?? new AbortController().signal))
            );
          },
        };
  // Wrap this run's own limit **on top of the shared cap** (the division between the two limits is
  // covered in docs/dynamic-workflow/concurrency.md "Two bounds on a run"). The gate needs the same
  // subagent fact—whether a tool is running right now—provided by this object's tool observer, so
  // both readers share one source.
  const admission =
    seat === undefined
      ? governed
      : seat.gate.wrap(seat.key, { toolsInFlight: () => toolActivity.inFlight() }, governed);

  return {
    admission,
    reset: () => {
      chains.clear();
      executing = false;
      reportedWait = undefined;
      turnsResolved = 0;
      toolActivity.reset();
    },
    toolCounts: () => toolActivity.counts(),
    lastTool: () => toolActivity.lastTool(),
    noteTurnResolved: () => {
      turnsResolved++;
      const lastTool = toolActivity.lastTool();
      return {
        turn: turnsResolved,
        toolCalls: toolActivity.counts().toolCalls,
        ...(lastTool === undefined ? {} : { lastTool }),
      };
    },
    observe: (runtime, sessionId) => {
      toolActivity.observe(runtime, sessionId);
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.type !== SessionEventType.ModelNetworkStatus || event.sessionId !== sessionId) return;
          const status = event.payload as ModelNetworkStatusEvent;
          const key = chainKey(status);
          switch (status.type) {
            case "model_request_queued":
              setWaiting(key, "queued", { cause: "slot" });
              return;
            case "model_request_admitted":
            case "model_request_started":
              chains.set(key, { phase: "executing", waitSeq: chains.get(key)?.waitSeq ?? 0 });
              reportExecuting();
              return;
            case "model_retry_scheduled": {
              if (NON_FAILURE_RETRY_REASONS.has(status.reason)) return;
              handlers.onRetryScheduled?.(status.reason);
              setWaiting(key, "backoff", {
                cause: "backoff",
                reason: status.reason,
                attempt: status.nextAttempt,
                delayMs: status.delayMs,
                ...(status.retryAfterMs === undefined ? {} : { retryAfterMs: status.retryAfterMs }),
              });
              return;
            }
            case "model_request_completed":
              handlers.onRequestCompleted?.();
              endChain(key);
              return;
            case "model_request_failed":
              // A failed event with retryable:true is immediately followed by retry_scheduled; only that event changes phase.
              if (!status.retryable) endChain(key);
              return;
            default:
              return;
          }
        },
      });
    },
    unsubscribe: () => {
      toolActivity.unsubscribe();
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

function sameWait(a: AskWaitInfo, b: AskWaitInfo): boolean {
  return (
    a.cause === b.cause &&
    a.reason === b.reason &&
    a.attempt === b.attempt &&
    a.delayMs === b.delayMs &&
    a.retryAfterMs === b.retryAfterMs
  );
}

function chainKey(status: ModelNetworkStatusEvent): string {
  const parts = [status.querySource, status.queryId, status.toolCallId].map((part) =>
    part === undefined ? "" : String(part),
  );
  return parts.some((part) => part.length > 0) ? parts.join("|") : status.requestId;
}

// ————————————————————————————— Run-level stall clock —————————————————————————————

/** Notify the main agent after this much time without a successful model request (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Terminal states"). */
export const WORKFLOW_STALL_NOTIFY_AFTER_MS = 20 * 60_000;

/** Clock and timer interface (injectable for tests using fake time). */
export interface WorkflowClock {
  now?: () => number;
  /** Return a cancellation function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface RunStallClockOptions extends WorkflowClock {
  /** Defaults to {@link WORKFLOW_STALL_NOTIFY_AFTER_MS}. */
  afterMs?: number;
  onStalled: (info: RunStallInfo) => void;
}

/**
 * Stall observation for one run: all actors (turn and tool-side requests together) share one table.
 *   - `noteSuccess`: any `model_request_completed` -> reset, cancel timer, clear reason counts, end this period.
 *   - `noteRetryScheduled`: a `model_retry_scheduled` -> count its reason; if this period is not
 *     armed, set the timer for "last success + afterMs".
 *   - Timer fires: if elapsed time since last success >= afterMs and at least one retry was
 *     scheduled in this period, call `onStalled` exactly once (one event per stall period) and do
 *     not rearm until the next success.
 *   - `noteCap`: coordinator fan-out of a cap change; include the current cap (most recently fanned
 *     out value) in the notification, or omit it if none has been seen.
 * Observation only, no decisions; `dispose` cancels the timer after run settlement.
 */
export interface RunStallClock {
  noteSuccess(): void;
  noteRetryScheduled(reason: string): void;
  noteCap(cap: number): void;
  dispose(): void;
}

export function createRunStallClock(options: RunStallClockOptions): RunStallClock {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const afterMs = options.afterMs ?? WORKFLOW_STALL_NOTIFY_AFTER_MS;
  let lastSuccessAt = now();
  let notified = false;
  let cancelTimer: (() => void) | undefined;
  let cap: number | undefined;
  const reasons = new Map<string, number>();
  let disposed = false;

  const dominantReason = (): string | undefined => {
    let best: string | undefined;
    let bestCount = 0;
    for (const [reason, count] of reasons) {
      if (count > bestCount) {
        best = reason;
        bestCount = count;
      }
    }
    return best;
  };
  const fire = (): void => {
    cancelTimer = undefined;
    if (disposed || notified) return;
    const sinceMs = now() - lastSuccessAt;
    if (sinceMs < afterMs) {
      // Clock drift or a non-monotonic injected clock: wait again for the remaining interval instead of missing this period.
      cancelTimer = schedule(fire, afterMs - sinceMs);
      return;
    }
    if (reasons.size === 0) return;
    notified = true;
    const reason = dominantReason();
    options.onStalled({
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    });
  };

  return {
    noteSuccess: () => {
      if (disposed) return;
      lastSuccessAt = now();
      notified = false;
      reasons.clear();
      cancelTimer?.();
      cancelTimer = undefined;
    },
    noteRetryScheduled: (reason) => {
      if (disposed || notified) return;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (cancelTimer !== undefined) return;
      cancelTimer = schedule(fire, Math.max(0, afterMs - (now() - lastSuccessAt)));
    },
    noteCap: (next) => {
      cap = next;
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Do not let a stall timer keep the process alive; it should not matter when the run ends and the process exits.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};
