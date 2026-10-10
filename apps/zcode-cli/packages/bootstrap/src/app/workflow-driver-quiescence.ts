// AgentRuntime-backed WorkflowDriver: release sessions and track quiescence during dispose.
// `dispose()` does not wait for turns still running; it records their promises as sessions are released so amend can determine when a session has stopped writing.
//
// Engine settlement does not mean an aborted turn has finished persisting its final message. amend must first wait for the session to become quiet,
// then read the message count for `inFlight.messageBoundary`. Completed ask boundaries are already in the journal and are unaffected.
// If waiting times out, do not import the incomplete portion; the successor re-executes from the complete prefix. A timeout must not be treated as quiescence.
//
// This waits only for the main turn promise; it does not guarantee that all streaming tool parts have been stored, because some tool handles may have
// detached from the turn promise. Transcript copying reads the parts visible at that time. History restoration treats pending/running tools as interrupted;
// missing parts do not create a result-less tool_use, and empty assistant messages are skipped.
// Parts update by the same ID without increasing the message count, so late parts do not change the message boundary.

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
 * Create a session-quiescence ledger. In-memory only, no I/O; the caller injects the clock.
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
 * actor runtime。
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
