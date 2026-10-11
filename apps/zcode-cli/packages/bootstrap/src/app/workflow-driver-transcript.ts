// ============================================================
// AgentRuntime-backed WorkflowDriver: transcript orchestration (two driver-specific amend-resume tasks).
// ============================================================
// workflow-driver.ts reached oxlint's 400-line limit, so driver-side transcript orchestration was
// moved here as free functions: truncating a divergent actor's transcript (seedActorSession), counting
// ask-boundary ledger entries (countSessionTranscript), and writing them back (journalAskMessageBoundary).
// The public surface is unchanged. The mechanisms remain in workflow-actor-transcript.ts (copying and
// counting); this file contains only the driver's three calls and their failure handling. The original
// method bodies are preserved, replacing only `this.deps` / `this.journal` with explicit deps.

import type { SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorSessionSeed,
  type InstanceRef,
} from "@zcode/dynamic-workflow";
import { countActorTranscript, seedActorTranscript } from "./workflow-actor-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * Truncate/copy a divergent actor's transcript (amend-resume): copy the first N messages from the
 * source session into the newly created session, then start runtime with that context.
 *
 * Order is **load-bearing**; none of these three steps can move:
 *   1. The factory has returned -> the session row is persisted (`message.session_id` has an FK to
 *      `session(id)`, so copying first would fail).
 *   2. Copy to the **persistent layer**, not in-memory history. Two readers depend on the persisted
 *      copy: hydration for this run and **future revisions of this run** (lineage traversal reads this
 *      session as its transcript source).
 *   3. Hydrate through the existing `resumeFromStore` path (the same mechanism used to reattach on
 *      resume); do not create another hydration path. The session row and messages have just been
 *      persisted, so do not copy the launch-side `SessionNotFound -> new session` fallback: that
 *      fallback handles a cleaned-up session, while here it can only mean wiring is wrong and should fail loudly.
 *
 * Condition for step 3: hydrate if we copied anything. If copying was skipped and the journal already
 * records this session ID, the runtime factory just reattached through the resume path
 * (launch's attachActorSession), so hydrating again would emit an extra SessionResumed and rerun
 * SessionStart hooks. If neither condition holds (copy skipped and journal has no record = the prior
 * process crashed between copy and putActor), hydration is still required; otherwise runtime would
 * start with an empty context despite the session containing messages.
 *
 * This condition holds for **both** skip cases in {@link seedActorTranscript}; there is no need to
 * distinguish them. Both check whether the target session already has content of its own, and
 * `attachActorSession` uses the same predicate to decide whether to reattach (whether the journal has
 * a sessionId for this actor), so both checks are always true together or false together.
 */
export async function seedActorSession(
  deps: AgentRuntimeWorkflowDriverDeps,
  input: {
    journaledSessionId: string | undefined;
    runtime: AgentRuntime;
    seed: ActorSessionSeed;
    sessionId: SessionId;
  },
): Promise<void> {
  const { journaledSessionId, runtime, seed, sessionId } = input;
  const store = deps.actorTranscriptStore;
  if (store === undefined) {
    throw new WorkflowError(
      "DriverError",
      `Subagent session ${sessionId} carries a transcript seed, but the driver has no ` +
        `transcript store (wiring error).`,
    );
  }
  const copied = await seedActorTranscript({
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    seed,
    store,
    targetSessionId: sessionId,
  });
  if (copied === undefined && journaledSessionId !== undefined) return;
  await runtime.resumeFromStore();
}

/** Count messages persisted for this session; on failure, omit the boundary rather than recording an incorrect one. */
export async function countSessionTranscript(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
): Promise<number | undefined> {
  const store = deps.actorTranscriptStore;
  if (store === undefined) return undefined;
  try {
    return await countActorTranscript(store, state.sessionId);
  } catch (error) {
    deps.logger?.warn?.("Dynamic workflow ask message boundary count failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.count_failed",
      instance: refToString(instance),
      module: "bootstrap.app",
      sessionId: state.sessionId,
    });
    return undefined;
  }
}

/**
 * Write the message-count boundary into this ask's journal row (`NodeRecord.messageBoundary`).
 *
 * This is in the same **family** as stats backfill: the record written at engine settlement omits
 * this field (it is owned by the driver), so use the same read-modify-write flow. `getNode` reads the
 * just-settled record, then `putNode` adds only the boundary without changing status, result,
 * actorSeq, inputHash, or stats. It must be written after settlement because the engine replaces the
 * entire record; writing before settlement would be overwritten.
 *
 * Write this for every ask, whether it is named or anonymous, revised or a regular run: **anonymity
 * is determined only during import**, and any run may be the predecessor of a future revision. The
 * cost is one small write per ask.
 *
 * The two early returns each have a reason: if the record is missing (the run was cleaned up), there
 * is nowhere to write; if `currentInstance` changed, the next ask has already started in this
 * session, so the current count no longer belongs to this exchange. Omit the boundary (making the
 * ask unavailable for import) rather than writing an inflated value that would include the next ask's opening.
 */
export function journalAskMessageBoundary(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
  boundary: number,
): void {
  const key = refToString(instance);
  if (state.currentInstance !== undefined && refToString(state.currentInstance) !== key) return;
  const runId = deps.runId ?? "run";
  try {
    const recorded = deps.journal.getNode(runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    deps.journal.putNode({ ...recorded, messageBoundary: boundary });
  } catch (error) {
    // A bookkeeping write failure must not break an already-settled ask (and this runs in a detached
    // promise, so throwing would only become an unhandled rejection). As with count failures, this ask
    // becomes unavailable for import and its run cannot be used as a predecessor.
    deps.logger?.warn?.("Dynamic workflow ask message boundary write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.write_failed",
      instance: key,
      module: "bootstrap.app",
      runId,
    });
  }
}
