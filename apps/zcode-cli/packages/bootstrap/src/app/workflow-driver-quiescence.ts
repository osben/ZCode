// ============================================================
// AgentRuntime-backed WorkflowDriver: session release and the quiescence ledger during dispose.
// ============================================================
// The two concerns live in one module because they are two faces of the same moment: dispose does **not** wait for in-flight turns, and the quiescence
// ledger exists precisely to record that fact. The release orchestration ({@link releaseActorSessions}) also registers "does this session still have a
// turn writing right now" into the ledger; there is no second observation point between them.
//
// See the "Amend-resume" rows "What is imported" and "Tool contract and refusals" in
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md.
//
// Why the ledger is needed: when amending an **in-flight** predecessor, amend first aborts it, then awaits its own settlement promise,
// then counts the predecessor session's messages and treats that count as the "continuation position" (`inFlight.messageBoundary`). But
// `dispose()` is synchronous-for sessions with a turn still in flight it merely chains `state.turn.then(close, close)`
// without waiting, while the engine settles immediately after `cancelAsk` aborts the turn. So "the settlement promise has resolved" does not imply
// "the aborted turn has finished writing its tail": the count taken at that moment may be short one message, or may land on a message whose
// parts are not fully stored. Completed prefixes are unaffected-their boundaries were journaled when the ask settled.
//
// So at the moment of dispose the driver records each session's still-in-flight turn into this ledger, and amend then asks once
// "which sessions have gone quiet" and negotiates continuation only for the quiet ones.
//
// **This is not a timeout papering over a race**: a session that has not settled by the deadline is not "kept as if quiet"; it simply gets no
// `inFlight`-that is, the behavior before this feature (the entire in-flight transcript is dropped, and the ask restarts from the complete prefix). We would rather
// skip one optimization than truncate a transcript at a count that is still moving.
//
// ——————————————————————————————————————————————————————————————
// The one thing this gate **cannot** hold back (verified 2026-09-19; accepted by ruling)
// ——————————————————————————————————————————————————————————————
// The core turn mainline is fully awaited: on abort it awaits `abandon("cancelled")`
// (core/src/runtime/methods/turn-model-step.ts:365), `persistCancelledStreamSnapshot` (ibid :372),
// and `persistAssistantMessage` (ibid :405) in order, so the "turn has settled" observed by this gate really does imply those writes finished.
//
// What leaks out is the **streaming-tool parts**, via two paths, neither of which affects the message count:
//   1. The `throwIfTurnAborted` at ibid :633 sits **outside** the try/catch that runs `abandon()` (`drain()` is at :646),
//      so an abort arriving in the "stream ended → drain" window bypasses abandon and leaves the in-flight streaming-tool handles outside;
//   2. `abandon()` itself waits only 250ms (core/src/runtime/methods/streaming-tool-coordinator.ts:38, :121).
// Both paths let an already-stored assistant message **grow one more part** after this gate has let it through
// (the pending part at ibid :253, the running part at ibid :294). It cannot be awaited: those handles have already
// detached from the promise we await, so there is nothing to wait on-this is not a question of gate strictness.
//
// Why this is acceptable: **the count is taken at amend time, and the messages are copied when the successor subagent is first dispatched**
// (workflow-actor-transcript.ts's seedActorTranscript reads parts along with the `messageCount`).
// A part that lands in between is copied as-is; the only real loss is a part still absent "at the moment of copying". Both shapes rehydrate
// normally (core/src/agent/session-history-hydrator.ts):
//   - Part present but stuck at pending / running: the hydrator has dedicated branches only for `completed` and `error`; everything else falls
//     to the `INTERRUPTED_TOOL_RESULT` at :189, so pending and running take the same path;
//   - Part entirely absent: the assistant's tool calls are taken from the parts **that are present** (the `addAssistant` at ibid :173),
//     so no result-less `tool_use` appears out of thin air; and an assistant message with neither body, nor reasoning, nor tool parts,
//     nor a token baseline is skipped entirely (ibid :162), leaving no empty message behind.
// Neither shape produces history a provider would consider illegal (no tool_use without tool_result, and no empty
// assistant). Also, the three part states are an **upsert on the same part id** (the `savePart` in
// storage/session-store/repositories/messages.ts, `on conflict(id) do update`),
// not an append, so a late part cannot change the message count and therefore cannot move any boundary.
//
// The correct fix for path 1 lives in core (move that `throwIfTurnAborted` inside abandon's protected region), not in this file.

import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import { defaultSchedule } from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * Upper bound for waiting for an aborted turn to finish writing its tail.
 *
 * Rationale: it waits for an **already aborted** turn to finish the core-side awaited persistence steps
 * (abandon → cancellation snapshot → assistant message). This is millisecond-scale cleanup, not a model request. Five seconds allows for a
 * slow disk and one retry without making "amend an active run" noticeably slow; exceeding it only skips one continuation, not a failure.
 */
export const AMEND_TRANSCRIPT_QUIESCE_MS = 5_000;

/** Actor-session quiescence query surface for one run. A private driver capability; **not** part of Boundary B's `WorkflowDriver`. */
export interface ActorSessionQuiescence {
  /**
   * Session IDs that are quiet now (no turn is still writing). Wait is bounded; see {@link AMEND_TRANSCRIPT_QUIESCE_MS}.
   *
   * There are two reasons an ID may be absent from the set, and the caller treats both the same (no continuation): the session was still writing at the deadline,
   * or this driver does not recognize it. The latter occurs only when the predecessor never created a session for that actor in this lifecycle.
   * Conservatively treat it as not quiet (the cost is one skipped continuation; the alternative is truncating a transcript at a message count nobody owns).
   */
  quietSessions(): Promise<ReadonlySet<string>>;
}

/** Driver-side write surface: {@link ActorSessionQuiescence} plus a registration hook used during dispose. */
export interface ActorSessionQuiescenceLedger extends ActorSessionQuiescence {
  /**
   * Register a session and the turn cleanup chain (`SessionState.turn`) still in flight **now**. If `pendingTurn` is absent,
   * the session has no active turn and is immediately quiet.
   *
   * Called once per session by `dispose()`: this is the only point when all sessions are still visible and no new
   * turns can be started (after dispose, `sessions` is cleared).
   */
  noteDisposed(sessionId: string, pendingTurn: Promise<unknown> | undefined): void;
}

/**
 * Create a session-quiescence ledger. In-memory only, no I/O; the clock is injectable so tests need not actually sleep.
 *
 * Ownership: exactly one per driver instance, with the same lifetime. Deliberately **no** process-level registry—a session's owning run is already defined
 * by the driver, and a second table would raise the question of which source to trust when they disagree.
 */
export function createActorSessionQuiescence(options?: {
  clock?: WorkflowClock;
  /** Defaults to {@link AMEND_TRANSCRIPT_QUIESCE_MS}. */
  quiesceMs?: number;
}): ActorSessionQuiescenceLedger {
  /** sessionId → turn still in flight at dispose time (`undefined` = no turn was in flight then). */
  const disposed = new Map<string, Promise<unknown> | undefined>();
  const schedule = options?.clock?.schedule ?? defaultSchedule;
  const quiesceMs = options?.quiesceMs ?? AMEND_TRANSCRIPT_QUIESCE_MS;

  return {
    noteDisposed(sessionId, pendingTurn) {
      disposed.set(sessionId, pendingTurn);
    },

    async quietSessions() {
      const quiet = new Set<string>();
      const waits: Promise<unknown>[] = [];
      for (const [sessionId, pending] of disposed) {
        if (pending === undefined) {
          quiet.add(sessionId);
          continue;
        }
        // Whether the turn cleanup chain resolves or rejects is irrelevant to quiescence: it will no longer write to this session either way.
        waits.push(
          pending.then(
            () => quiet.add(sessionId),
            () => quiet.add(sessionId),
          ),
        );
      }
      if (waits.length > 0) await settleWithin(Promise.all(waits), quiesceMs, schedule);
      // Return a snapshot: sessions that become quiet after the deadline still get added to `quiet`, but the caller must see facts from
      // the moment it asked—a set that silently grows in the background is more dangerous than a conservative one.
      return new Set(quiet);
    },
  };
}

/**
 * Per-session release during dispose: unsubscribe activity observers, cancel backoff retries, **register quiescence**, then close after the active turn settles
 * actor runtime.
 *
 * Run the **same** chain used to close an app session for every runtime: `closeBrowserSession` performs beginShutdown,
 * node_repl session release, and browser-session close in order. Do not create a separate subagent shutdown chain that could drift. Close failures only warn;
 * they do not throw through settlement.
 *
 * Register **before** `state.turn.then(...)`: at this point `state.turn` is the chain to await, while then would replace it with another promise.
 * This function returns synchronously (close is chained from then), so dispose remains non-blocking.
 */
export function releaseActorSessions(
  deps: AgentRuntimeWorkflowDriverDeps,
  sessions: Iterable<SessionState>,
  ledger: ActorSessionQuiescenceLedger,
): void {
  for (const state of sessions) {
    state.modelActivity.unsubscribe();
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    ledger.noteDisposed(state.sessionId, state.turn);
    const close = (): void => closeActorRuntime(deps, state);
    if (state.turn === undefined) close();
    else state.turn.then(close, close);
  }
}

function closeActorRuntime(deps: AgentRuntimeWorkflowDriverDeps, state: SessionState): void {
  // Promise.resolve().then(...): route synchronous throws through the same warning path (minimal stub runtimes may not have this method).
  void Promise.resolve()
    .then(() => state.runtime.closeBrowserSession())
    .catch((error: unknown) => {
      deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.actor_runtime.close_failed",
        module: "bootstrap.app",
        sessionId: state.sessionId,
      });
    });
}

/** Wait for `work` to settle for at most `delayMs`. Return at the deadline without throwing; clear the timer in either branch. */
async function settleWithin(
  work: Promise<unknown>,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => {
    cancel = schedule(resolve, delayMs);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    // If work settles first, clear the timer; a pending setTimeout would otherwise delay CLI exit until the deadline.
    cancel?.();
  }
}
