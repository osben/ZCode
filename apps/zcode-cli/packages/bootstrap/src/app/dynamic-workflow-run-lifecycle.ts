// ============================================================
// Dynamic Workflow Run: lifecycle bookkeeping for runs owned by this session (settlement / close / close gate / recording foreign terminal rows).
// ============================================================
// Split out because dynamic-workflow-run-service.ts reached oxlint's 400-line max-lines limit. This file owns the run lifecycle from settlement through
// close: settlement bookkeeping (recording terminal state, normalizing failures, residency registration, settlement notifications, terminal-entry eviction)
// plus closures for service shutdown and checking foreign terminal rows.
// These closures borrow only the service registry and journal through narrow dependencies; invariants 6 and 7 in the service file header remain their specification.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunSettlement } from "@zcode/dynamic-workflow";
import {
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";

/** Number of terminal runs to retain in the in-memory registry (artifacts exist only in settlement; the journal does not store script return values). */
const TERMINAL_REGISTRY_LIMIT = 32;

/** Notification emitted after a run settles; `liveRunCount` is the number of runs still active under this service at notification time. */
export interface DynamicWorkflowRunSettledNotice {
  runId: string;
  liveRunCount: number;
}

interface RunServiceLifecycleDeps {
  /** Read-only `getRun`: determine whether a terminal row is foreign by checking its state. */
  journal: Pick<JournalStorePort, "getRun">;
  logger?: Logger;
  parentSessionId: string;
  /** See the service's `DynamicWorkflowRunServiceDeps.registerResidencyBlockingWork` (invariant 6). */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /** The service's registry itself (not a snapshot): evict old terminal entries on settlement, enumerate active entries on close, and mark recorded rows. */
  runs: Map<string, RunRegistryEntry>;
}

interface RunServiceLifecycle {
  /** Number of runs not yet settled (`terminal === undefined` in the registry). */
  countLiveRuns(): number;
  /** Subscribe to settlement notifications (emitted after bookkeeping; listener errors are only logged). Return an unsubscribe function. */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /** Settlement bookkeeping shared by submit / amend / resume: record terminal state, normalize failures, and register residency. Never rejects. */
  trackSettlement(
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement>;
  /** See the close documentation in {@link createRunServiceLifecycle}. Idempotent. */
  close(): Promise<void>;
  /** Launching after close is a wiring error: throw instead of adding a member to the contracts rejection enum. */
  assertOpen(): void;
  /** A terminal row under an active entry indicates a foreign write; log one warning per entry. */
  noteForeignTerminalRow(runId: string): void;
}

/**
 * Close (service file header invariant 7).
 *
 * The engine is closed over by this App (actor runtime, event chain, cancellation controller, and settlement
 * promise all live here). Once the App closes, it has no host, but the journal row may remain running; the next activation could only guess via orphan reconciliation.
 * Therefore close must **actively stop** each active entry with an `"interrupted"` abort. The harness normalizes this
 * to `engine.stop("interrupted", Interrupted)`, and the engine writes the row as resumable stopped state.
 *
 * Wait without a timeout: the harness settles synchronously after stop, and waiting on the predecessor's own settlement promise is the discipline already used by amend (never use a timer instead of state). Settlement promises never reject (see {@link RunServiceLifecycle.trackSettlement}).
 */
export function createRunServiceLifecycle(deps: RunServiceLifecycleDeps): RunServiceLifecycle {
  const { runs } = deps;
  const terminalOrder: string[] = [];
  const settledListeners = new Set<(notice: DynamicWorkflowRunSettledNotice) => void>();
  const countLiveRuns = (): number => {
    let live = 0;
    for (const entry of runs.values()) if (entry.terminal === undefined) live += 1;
    return live;
  };
  // Emit settlement notifications **after** bookkeeping: listeners (the host registry safety boundary) must see a count that already excludes this run.
  const notifySettled = (runId: string): void => {
    if (settledListeners.size === 0) return;
    const notice: DynamicWorkflowRunSettledNotice = { runId, liveRunCount: countLiveRuns() };
    for (const listener of settledListeners) {
      try {
        listener(notice);
      } catch (error: unknown) {
        deps.logger?.warn?.("Dynamic workflow run settled listener threw", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.settled_listener_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    }
  };
  const subscribeRunSettled = (
    listener: (notice: DynamicWorkflowRunSettledNotice) => void,
  ): (() => void) => {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  };

  const rememberTerminal = (runId: string): void => {
    terminalOrder.push(runId);
    while (terminalOrder.length > TERMINAL_REGISTRY_LIMIT) {
      const evicted = terminalOrder.shift();
      if (evicted !== undefined && runs.get(evicted)?.terminal !== undefined) runs.delete(evicted);
    }
  };

  /**
   * Settlement bookkeeping shared by submit and resume: record terminal state and normalize failures.
   * Failures outside the harness (such as engine construction throwing) normalize to an errored terminal state, never stopped: in the journal
   * they have different meanings and resume UX (stopped can be resumed; errored can only be amended).
   */
  const trackSettlement = (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement> => {
    const settlement = launched.then(
      (result) => {
        entry.terminal = result;
        entry.completedAt = new Date();
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn?.("Dynamic workflow run failed before settling", {
          errorMessage: message,
          event: "dynamic_workflow.run.start_failed",
          module: "bootstrap.app",
          runId,
        });
        entry.completedAt = new Date();
        const result: RunSettlement = {
          status: "errored",
          error: error instanceof Error ? (error as never) : (new Error(message) as never),
        };
        entry.terminal = result;
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
    );
    // Service file header invariant 6: all three entry points (submit / amend / resume) share this registration point, which must run in the same synchronous turn as launch. Delaying by one microtask would let residency rebalance run between launch and registration. Register the **post-settlement** promise (`settlement` never rejects and bookkeeping is complete); release the count in its finally handler.
    deps.registerResidencyBlockingWork?.(settlement);
    return settlement;
  };

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Idempotently set `closed` **synchronously**: it must be true in this turn, or a launch arriving during close could slip in and create an unowned engine.
    closePromise ??= (async () => {
      closed = true;
      const live = [...deps.runs.values()].filter((entry) => entry.terminal === undefined);
      deps.logger?.info?.("Dynamic workflow run service closing", {
        event: "dynamic_workflow.service.closing",
        liveRunCount: live.length,
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
      });
      for (const entry of live) entry.controller.abort("interrupted");
      await Promise.all(live.map((entry) => entry.settlement));
      deps.logger?.info?.("Dynamic workflow run service closed", {
        event: "dynamic_workflow.service.closed",
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
        stoppedRunCount: live.length,
      });
    })();
    return closePromise;
  };

  /**
   * A launch after close is a **wiring error**, not a business rejection: the residency pool's close gate already blocks commands, so reaching
   * here means something bypassed it. Throw instead of adding a contracts rejection enum member that every caller would need to handle, even though it cannot occur during normal operation.
   */
  const assertOpen = (): void => {
    if (closed) {
      throw new Error(
        "dynamic workflow run service is closed; a launch after App close is a wiring fault",
      );
    }
  };

  /**
   * A terminal row under an active entry indicates a foreign write; log one warning per entry.
   *
   * A second desktop instance cold-restored the same session, and its orphan reconciliation wrote a terminal row for a run still executing in this
   * process. The read surface already ignores it based on the active {@link RunRegistryEntry} (observation's synthesizeRunStatus), but the event itself must be recorded—otherwise
   * we can only guess after the fact that the two instances interfered with each other.
   *
   * Once per entry: the tracker polls `getTask` every second, so without a marker it would emit the same warning every second. Before the marker is set,
   * perform one extra `getRun` (an indexed single-row query); afterward, even that query is skipped.
   */
  const noteForeignTerminalRow = (runId: string): void => {
    const entry = deps.runs.get(runId);
    if (entry === undefined || entry.terminal !== undefined || entry.foreignTerminalLogged) return;
    const record = deps.journal.getRun(runId);
    if (record === undefined || !TERMINAL_RUN_STATUSES.has(record.status)) return;
    entry.foreignTerminalLogged = true;
    deps.logger?.warn?.("Dynamic workflow run has a foreign terminal row under a live engine", {
      event: "dynamic_workflow.run.foreign_terminal_row",
      journalStatus: record.status,
      module: "bootstrap.app",
      runId,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    });
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  };
}
