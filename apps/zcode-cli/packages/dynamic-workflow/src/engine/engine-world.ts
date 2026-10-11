/**
 * engine.ts reached oxlint's max-lines limit (400), so the admission/settlement paths for world
 * nodes (world-read / world-run) and the close/recovery seam for the amend-resume import cache were
 * moved to this file; the public surface is still exported from engine.ts.
 *
 * Free functions read and write engine state through the {@link EngineState} seam;
 * WorkflowEngine.worldRead is only a thin delegate. The scheduler triggers cache closure through
 * SchedulerHost, and recovery is called from the resume branch of the engine constructor.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { heldResolution } from "./replay-order.js";
import { boundWorldReadInput } from "./world-read-input.js";
import { hashMismatch } from "./hash-mismatch.js";
import type { EngineState } from "./engine-state.js";
import type {
  InstanceRef,
  JournalStorePort,
  NodeKind,
  WorkflowErrorJson,
  WorldReadInput,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

export function readWorld(
  state: EngineState,
  siteId: string,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };
  // inputHash covers `{op, args}` (rather than a single argument `{op, arg}`). This is an
  // **intentional payload change**: in old journals written before multi-argument world-read, every
  // world-read hit would have a different inputHash and fail the run loudly with InputHashMismatch.
  // This is acceptable—v1 resume already requires byte-identical script text (script_hash), so a
  // script using the facade before multi-argument world-read would not be the script being resumed.
  // The comment is here because the failure appears during resume, far from this line.
  const hash = inputHash({ op, args });
  // Bounded `{op, args}` is written at the same admission as the hash and passed through unchanged
  // in the settlement upsert. putNode replaces the entire row, so omitting it would reset it to NULL.
  const input = boundWorldReadInput(op, args);

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
    // A completed hit short-circuits (journaled world reads make resume immune to disk changes between run and resume).
    // Pass the release point through the replay-order gate: a world read in one fan-out branch may be awaited by another continuation,
    // so releasing in admission order would shift ordinals after the join (docs/execution-engine.md, “Replaying the settle order”).
    if (recorded.status === "completed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
        return recorded.result;
      });
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({
          type: "node-settled",
          instance,
          outcome: "failed",
          cached: true,
          error: recorded.error,
        });
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
    // status === "running": the process crashed during execution; fall through and run it live again.
  }

  // op "run" is an effect rather than a read, so give it its own journal kind (world-run). The
  // mechanics are the same, but this keeps the audit surface accurate. Other ops remain world-read.
  const kind: NodeKind = op === "run" ? "world-run" : "world-read";

  // For amend-resume, consult the imported cache only if this run has no journal row (journal replay
  // always takes precedence—after a crash/resume of the amended run, consumed hits are already
  // real rows, and replaying them must not advance the cursor again).
  // On a hit, write a completed row shaped like settleWorldRead and emit node-settled(cached),
  // **without calling the driver**: never silently replay a world-run effect.
  // After cache closure, do not consult the table or advance its cursor: the command text is
  // unchanged, but a live subagent may have modified the world it would read.
  const imported = state.importClosed() ? undefined : state.importedWorld.take(hash);
  if (imported !== undefined) {
    state.journal.putNode({
      runId: state.runId,
      siteId,
      ordinal,
      kind,
      inputHash: hash,
      input,
      status: "completed",
      result: imported.result,
    });
    state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    return Promise.resolve(imported.result);
  }

  // Live world-read: not subject to actor FIFO / concurrency limits (harness I/O).
  if (state.isRunSettled()) return Promise.reject(state.runError());
  // A live world.run is a write (an effect, not a read): once executed, the workspace differs from
  // what the predecessor left behind. Close the import cache **before dispatch**, using the same
  // rule and timing as a subagent's mutating tool (before it acts). world-read does not close it;
  // reads do not change the world.
  if (kind === "world-run") closeImportCache(state, instance, "world-run");
  // Record running at admission so a world read interrupted by a crash can be re-executed on resume.
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind,
    inputHash: hash,
    input,
    status: "running",
  });
  state.record({ type: "node-queued", instance, kind });
  state.record({ type: "node-dispatched", instance });
  return state.driver.executeWorldRead(op, args).then(
    (value) =>
      settleWorldRead(state, instance, kind, hash, input, { status: "completed", result: value }),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `World read failed: ${op} ${canonicalJson(args)}.`, {
              cause,
            });
      return settleWorldRead(state, instance, kind, hash, input, {
        status: "failed",
        error: err.toJSON(),
      });
    },
  );
}

function settleWorldRead(
  state: EngineState,
  instance: InstanceRef,
  // putNode is an upsert (replaces the whole row); hardcoding world-read at settlement would
  // silently change a world-run recorded at admission, so kind must come from admission.
  kind: NodeKind,
  hash: string,
  // Same reason: the bounded input written at admission must survive the full-row settlement update.
  input: WorldReadInput,
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: WorkflowErrorJson },
): unknown {
  if (state.isRunSettled()) throw state.runError();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind,
    inputHash: hash,
    input,
    status: outcome.status,
    ...(outcome.status === "completed" ? { result: outcome.result } : { error: outcome.error }),
  });
  if (outcome.status === "completed") {
    state.record({ type: "node-settled", instance, outcome: "ok" });
    return outcome.result;
  }
  state.record({ type: "node-settled", instance, outcome: "failed", error: outcome.error });
  throw WorkflowError.fromJSON(outcome.error);
}

/**
 * Close the import cache (idempotent). There are two triggers, both **before the first write**:
 * the driver reports that a live subagent is about to run a mutating tool (`mutating-tool`), or a
 * `world.run` is about to execute live (`world-run`). Emit `import-cache-closed` only for an actual
 * amended run; it is the sole source of truth for recovering “cache closed” on resume. A regular
 * run has no cache to close, so the flag is harmless but no event is emitted.
 */
export function closeImportCache(
  state: EngineState,
  instance: InstanceRef,
  cause: "mutating-tool" | "world-run",
  actorName?: string,
): void {
  if (state.importClosed()) return;
  state.closeImport();
  if (state.importedCache === undefined) return;
  state.record({
    type: "import-cache-closed",
    instance,
    cause,
    ...(actorName === undefined || actorName === "" ? {} : { actorName }),
  });
}

/**
 * Restore the cache-closure decision, the set of ask instances that previously ran live, and the
 * set of ask instances admitted before closure during resume.
 *
 * The source of truth is this run's own events: live nodes emit `node-queued` at admission (asks
 * include an actor ref), while cache hits emit only `node-settled cached:true`, so the set of asks
 * that ran live is exact. The `import-cache-closed` event determines whether the cache is closed—an
 * ask going live no longer implies closure (it may not touch any files); only a write closes it,
 * and only this event records that. No schema change is needed.
 *
 * `queuedBeforeClose` also needs no schema change; it relies on **event order**: the decision to
 * resume a predecessor's in-flight ask and that ask's `node-queued` are in the same synchronous
 * admission slice (see scheduler's admitAsk → tryImportedSettle → admitLive). Thus “the cache was
 * open at admission” ⇔ “this node-queued precedes the first import-cache-closed.” If there is no
 * closure event, all queued asks are included.
 */
export function recoverImportClosure(
  journal: JournalStorePort,
  runId: string,
): { live: ReadonlySet<string>; queuedBeforeClose: ReadonlySet<string>; closed: boolean } {
  const live = new Set<string>();
  const queuedBeforeClose = new Set<string>();
  let closed = false;
  // The two event kinds needed for read-only detection (docs/execution-engine.md, “Reading the journal”); type filtering preserves order,
  // so “node-queued precedes the first import-cache-closed” still holds in the filtered sequence.
  for (const { event } of journal.listEvents(runId, {
    types: ["node-queued", "import-cache-closed"],
    reportItems: { limit: 0 },
  })) {
    if (event.type === "import-cache-closed") closed = true;
    if (event.type !== "node-queued" || event.kind !== "ask") continue;
    const key = refToString(event.instance);
    live.add(key);
    if (!closed) queuedBeforeClose.add(key);
  }
  return { live, queuedBeforeClose, closed };
}
