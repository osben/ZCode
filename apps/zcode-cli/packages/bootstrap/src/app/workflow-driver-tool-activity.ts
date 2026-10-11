// ============================================================
// Driver-side tool activity observation: an upcoming subagent workspace mutation tells the engine to invalidate its import cache.
// ============================================================
// Like the model activity surface in workflow-driver-concurrency.ts, this only reads the actor runtime's session event stream and does not touch turn
// orchestration. It recognizes one event, `ToolCallStarted`, emitted by the executor after permission checks and before the handler runs. Its payload
// includes `readOnly` / `sideEffectScope` resolved from the arguments (including Bash read-only command detection). Workspace mutations are classified with contracts'
// `isWorkspaceMutatingToolCall`; the same payload is counted with `isWorldTouchingToolCall` to determine whether a cache entry is pure (see below).
//
// This subscription also **counts** an ask's tool calls (total calls and writes), as required by AskStats. `TurnResult.events` contains no tool events,
// so counting there would always report `toolCalls` as 0 (confirmed across all 2,097 ask rows in the production journal, including subagents that wrote files).
// Counts reset at startAsk and accumulate across repair / nudge turns, so the final askStats reports the total for the full ask.
//
// The two counts serve different purposes: `toolCalls` includes every call for accurate auditing, while `worldToolCalls` counts only calls that inspect or modify
// the external world. Protocol tools (`submit_result`, `escalate`) are excluded; otherwise every typed ask would appear to touch the world by submitting its result,
// making the pure-ask exemption useless.
//
// Report the gate closure once per ask. Engine-side closure is already idempotent; this only saves event traffic. Reset when the ask changes.
//
// The same subscription also records the **most recent** tool name and a bounded target hint (`lastTool` on `node-progress`). The name is available on `ToolCallStarted`, but arguments are not—
// they appear only on the earlier `ToolCallScheduled`. Subscribe to both: scheduled stores arguments by toolCallId; started retrieves them, reduces them to a hint, and deletes the temporary entry.
// Update `lastTool` only on started, alongside the counts, so calls rejected by permission checks and never actually run are not reported as current work.

import {
  isWorkspaceMutatingToolCall,
  isWorldTouchingToolCall,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type ToolCallScheduledPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { AskLastTool } from "@zcode/dynamic-workflow";
import { summarizeToolCall } from "./workflow-driver-tool-target.js";

/**
 * Keep at most this many scheduled argument entries awaiting a started event. Normally each entry is consumed by the next started event, but permission-rejected,
 * canceled, or batch-skipped calls are not; without a limit, a long ask could accumulate them and leak memory. On overflow,
 * discard the oldest entry (Map iteration follows insertion order); the newest call best represents current work.
 */
const MAX_PENDING_SCHEDULED_CALLS = 64;

/** Tool call counts observed within one ask (these are the two AskStats fields). */
export interface ActorToolCounts {
  /** All calls, including protocol tools such as `submit_result` / `escalate`. */
  toolCalls: number;
  /** Calls that inspect or modify the external world (read files, run commands, access the network); zero means this ask is pure. */
  worldToolCalls: number;
}

interface ActorToolActivity {
  /** Reset when the ask changes: start counting again and report the next ask’s first write. */
  reset(): void;
  /** Tool call counts observed so far in this ask. */
  counts(): ActorToolCounts;
  /**
   * Number of tool calls **still running** (started minus result / error, deduplicated by toolCallId, so four parallel
   * WebSearch calls count as 4).
   *
   * The seat gate (workflow-seat-gate.ts) is the only reader. Admission receives only `{model}`, so it cannot tell whether a model request
   * is the subagent’s next turn step or comes from one of its tools; **tool-side requests never park**. A running tool
   * means a tool-side request; no running tools means the next turn step. Track started/finished pairs rather than the previous event:
   * With parallel calls, that would incorrectly report idle as soon as the first call returned.
   */
  inFlight(): number;
  /** The **most recent** tool call that actually started in this ask; absent if none has started. */
  lastTool(): AskLastTool | undefined;
  /** Subscribe to runtime `ToolCallStarted` session events; no-op when a minimal stub runtime lacks subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

export function createActorToolActivity(handlers: {
  /** The current ask’s subagent is about to run a workspace-mutating tool (at most once per ask). */
  onMutating(): void;
}): ActorToolActivity {
  let reported = false;
  let toolCalls = 0;
  let worldToolCalls = 0;
  let lastTool: AskLastTool | undefined;
  /** toolCallId → name and arguments from scheduled, waiting to be claimed by started. */
  const scheduled = new Map<string, ToolCallSummaryHold>();
  /** toolCallIds that have started but not yet received result / error (see {@link ActorToolActivity.inFlight}). */
  const running = new Set<string>();
  let unsubscribeEvents: (() => void) | undefined;
  return {
    reset: () => {
      reported = false;
      toolCalls = 0;
      worldToolCalls = 0;
      lastTool = undefined;
      scheduled.clear();
      // No tools should still be running at an ask boundary (the previous ask’s turn settled or was aborted). Resetting prevents
      // an exceptional path from carrying stale state into the next ask, where the gate would always pass it as a tool-side request.
      running.clear();
    },
    counts: () => ({ toolCalls, worldToolCalls }),
    inFlight: () => running.size,
    lastTool: () => lastTool,
    observe: (runtime, sessionId) => {
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.sessionId !== sessionId) return;
          if (event.type === SessionEventType.ToolCallScheduled) {
            holdScheduled(scheduled, event.payload as ToolCallScheduledPayload);
            return;
          }
          // A call finishes: the executor emits one event from each try/catch branch after started, so every started has a matching event
          // (permission denial, schema failure, and registry miss happen **before** started and emit only error, so they do not affect pairing).
          if (
            event.type === SessionEventType.ToolCallResult ||
            event.type === SessionEventType.ToolCallError
          ) {
            running.delete(String((event.payload as { toolCallId: unknown }).toolCallId));
            return;
          }
          if (event.type !== SessionEventType.ToolCallStarted) return;
          const capability = event.payload as ToolCallStartedPayload;
          running.add(String(capability.toolCallId));
          const hold = scheduled.get(String(capability.toolCallId));
          scheduled.delete(String(capability.toolCallId));
          lastTool =
            summarizeToolCall({
              ...(hold === undefined ? {} : { input: hold.input }),
              toolName: capability.toolName ?? hold?.toolName,
            }) ?? lastTool;
          toolCalls++;
          if (isWorldTouchingToolCall(capability)) worldToolCalls++;
          if (!isWorkspaceMutatingToolCall(capability)) return;
          if (reported) return;
          reported = true;
          handlers.onMutating();
        },
      });
    },
    unsubscribe: () => {
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

/** A temporary entry (name + arguments) saved from scheduled until its matching started event consumes it. */
interface ToolCallSummaryHold {
  toolName?: string;
  input?: unknown;
}

/** Save scheduled arguments and keep the map within {@link MAX_PENDING_SCHEDULED_CALLS} entries (discarding the oldest). */
function holdScheduled(
  scheduled: Map<string, ToolCallSummaryHold>,
  payload: ToolCallScheduledPayload,
): void {
  scheduled.set(String(payload.toolCallId), { toolName: payload.toolName, input: payload.input });
  while (scheduled.size > MAX_PENDING_SCHEDULED_CALLS) {
    const oldest = scheduled.keys().next();
    if (oldest.done === true) return;
    scheduled.delete(oldest.value);
  }
}
