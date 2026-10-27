import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";

import type {
  DreamJournalHost,
  DreamJournalMemoryFileReader,
  DreamJournalRun,
  DreamJournalRunHandle,
  DreamJournalScope,
  DreamJournalTrigger,
} from "./contract.js";
import { beginDreamJournalRun, recordDreamJournalSkip } from "./journal.js";

/**
 * Best-effort wrappers the Dream run calls. A journal write failure is logged as
 * `memory.dream.journal.failed` and never fails or blocks the Dream run.
 */
export type DreamSkipReasonCode =
  | "disabled"
  | "remote"
  | "no_new_turns"
  | "too_few_sessions"
  | "min_interval"
  | "scan_throttled"
  | "lock_held";

/** Logs the skip and writes its journal row; a journal failure is logged and never changes the skip. */
export async function recordDreamSkip(
  host: DreamJournalHost,
  input: DreamJournalScope & {
    trigger: DreamJournalTrigger;
    reasonCode: DreamSkipReasonCode;
  },
): Promise<void> {
  logDreamSkip(host, input.traceContext, input.trigger, input.reasonCode);
  try {
    await recordDreamJournalSkip({
      memoryRoot: input.memoryRoot,
      trigger: input.trigger,
      reasonCode: input.reasonCode,
      now: host.now(),
    });
  } catch (error) {
    logJournalFailure(host, input.traceContext, "skip", error);
  }
}

export function logDreamSkip(
  host: DreamJournalHost,
  traceContext: TraceContext,
  trigger: DreamJournalTrigger,
  reasonCode: DreamSkipReasonCode,
): void {
  host.logger?.info("Dream run skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.dream.run.skipped",
    module: "core.runtime",
    reasonCode,
    trigger,
  });
}

export async function beginDreamJournalRunSafely(
  host: DreamJournalHost,
  scope: DreamJournalScope,
  trigger: DreamJournalTrigger,
): Promise<DreamJournalRunHandle | undefined> {
  try {
    return await beginDreamJournalRun({
      memoryRoot: scope.memoryRoot,
      readMemoryFile: readMemoryFileThroughPort(host, scope.traceContext),
      trigger,
      now: host.now(),
    });
  } catch (error) {
    logJournalFailure(host, scope.traceContext, "begin", error);
    return undefined;
  }
}

/** Snapshots read through the same port the Dream tools write through, not directly from disk. */
function readMemoryFileThroughPort(
  host: DreamJournalHost,
  traceContext: TraceContext,
): DreamJournalMemoryFileReader {
  return async (path) => {
    if (!host.fileSystemPort) throw new Error("Dream file port is unavailable");
    try {
      const result = await host.fileSystemPort.readTextFile({ path, trace: traceContext });
      return result.content;
    } catch (error) {
      if ((error as { code?: unknown }).code === "not_found") return null;
      throw error;
    }
  };
}

export async function snapshotBeforeTouchSafely(
  host: DreamJournalHost,
  scope: DreamJournalScope,
  journal: DreamJournalRunHandle | undefined,
  filePath: string,
): Promise<void> {
  if (!journal) return;
  try {
    await journal.snapshotBeforeFirstTouch(filePath);
  } catch (error) {
    // The tool still runs: a missing snapshot loses undo for this file, not the Dream run.
    logJournalFailure(host, scope.traceContext, "snapshot", error, journal.id);
  }
}

export async function finalizeDreamJournalSafely(
  host: DreamJournalHost,
  scope: DreamJournalScope,
  journal: DreamJournalRunHandle | undefined,
  input: { status: "succeeded" | "failed"; reasonCode?: string },
): Promise<DreamJournalRun | undefined> {
  if (!journal) return undefined;
  try {
    return await journal.finalize({ ...input, now: host.now() });
  } catch (error) {
    logJournalFailure(host, scope.traceContext, "finalize", error, journal.id);
    return undefined;
  }
}

function logJournalFailure(
  host: DreamJournalHost,
  traceContext: TraceContext,
  operation: "begin" | "snapshot" | "finalize" | "skip",
  error: unknown,
  runId?: string,
): void {
  host.logger?.warn("Dream journal write failed", {
    ...traceContextToLogContext(traceContext),
    errorMessage: error instanceof Error ? error.message : String(error),
    event: "memory.dream.journal.failed",
    module: "core.runtime",
    operation,
    runId,
    status: "failed",
  });
}

export function countDreamJournalActions(run: DreamJournalRun): {
  created: number;
  updated: number;
  deleted: number;
} {
  const count = (action: string) => run.items.filter((item) => item.action === action).length;
  return { created: count("created"), updated: count("updated"), deleted: count("deleted") };
}
