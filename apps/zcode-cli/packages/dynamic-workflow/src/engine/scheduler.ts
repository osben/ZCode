/**
 * Ask scheduler: extracts "per-actor FIFO + hold rules + concurrency-limited dispatch + ask settlement"
 * from the engine body so both files stay focused and readable (and meet the per-file line limit).
 * The engine injects dependencies through {@link SchedulerHost} (driver, caps, sequence allocation,
 * and run-level failure); the scheduler handles only the ask lifecycle, not the run lifecycle.
 *
 * See the engine.ts header for key rules: cache-hit short-circuiting, actorSeq admission order,
 * replay hold rules, and serialized actors.
 *
 * Internal types and SchedulerHost live in scheduler-types.ts; submit/turn callback handling lives
 * in scheduler-submit.ts (split to satisfy oxlint's 400-line max-lines limit). SchedulerHost is
 * re-exported here so import paths remain unchanged.
 */

import { inputHash } from "./hash.js";
import { importedAskRecord, type ImportedActorState } from "./imported-cache.js";
import {
  defer,
  drainActorAdmission,
  hashMismatch,
  describeCause,
  headOfInstructions,
  type Actor,
  type AskNode,
  type Deferred,
  type SchedulerHost,
} from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskMessage,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  SessionRef,
} from "./types.js";
import { NUDGE_ATTEMPTS, refToString, REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

export { hashMismatch } from "./scheduler-types.js";
export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  /**
   * Ask instances (`siteId@ordinal`) whose transcript predates this dispatch: in-flight asks from
   * the predecessor during continuation, and asks redispatched from running rows on resume. Their
   * journal stats must omit `worldToolCalls`; see {@link journaledStats}. Keep them after settlement
   * because late stats backfills still need to look them up.
   */
  private readonly priorTranscriptAsks = new Set<string>();
  private activeAsks = 0;

  /** Lets scheduler-submit.ts free functions look up live nodes and settle by result (see {@link SubmitSeam}). */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => this.liveNodes.get(refToString(instance)),
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * Register an actor (creation site × ordinal). `imported` is an amend-resume import candidate:
   * the engine already matched it by effective name and normalized persona in createActor; the
   * scheduler only consumes it.
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.journal
      .listNodes(this.host.runId)
      .filter(
        (n) => n.kind === "ask" && n.actorSiteId === ref.siteId && n.actorOrdinal === ref.ordinal,
      ).length;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // Do not preload the journal's sessionId into actor.session/sessionPromise, which would let
    // ensureSession skip driver.createActorSession after resume. The production driver's session
    // table is populated **only** by createActorSession, and startAsk looks sessions up there;
    // every ask redispatched on resume would then fail with "unknown session." Pure replay (zero
    // dispatches) and fake drivers (whose startAsk does not consult the table) do not expose this.
    // Session identity belongs to the driver (the production factory deterministically derives
    // it from (runId, actorRef), producing the same ID when reattached). The journal's
    // dwf_actor.session_id is a record, not the authority, so never use it to bypass session
    // creation here: first dispatch always goes through driver.createActorSession (see ensureSession).
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** Accept an ask: short-circuit completed hits (using hold rules); live-dispatch running hits and misses. */
  admitAsk(
    siteId: string,
    actorId: ActorId,
    instructions: string,
    spec: AskSpec,
  ): Promise<unknown> {
    const actor = this.actors.get(actorId)!;
    const ordinal = this.host.nextOrdinal(siteId);
    const instance: InstanceRef = { siteId, ordinal };
    const hash = inputHash(instructions);
    const deferred = defer<unknown>();

    const recorded = this.journal.getNode(this.host.runId, siteId, ordinal);
    if (recorded !== undefined) {
      // Validate inputHash defensively on a hit; a mismatch means the purity contract was violated, so fail the run loudly.
      if (recorded.inputHash !== hash) {
        const err = hashMismatch(instance, recorded.inputHash, hash);
        this.host.failRun(err);
        return Promise.reject(err);
      }
      const seq = recorded.actorSeq ?? 0;
      const reconcile = (): void =>
        actor.imported?.reconcileRecorded(
          seq,
          recorded.inputHash,
          this.host.wasLiveBeforeResume(instance),
          this.host.wasQueuedBeforeImportClose(instance),
        );
      if (recorded.status === "running") {
        // Interrupted during execution: live-dispatch again at the recorded actorSeq position
        // (hold rules preserve its admission order). Its transcript already contains messages from
        // the previous attempt, so record stats as having a transcript predating this dispatch.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, true);
        });
      } else {
        // completed/failed: settle by short-circuit without calling the driver.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.releaseCachedAsk(instance, recorded, deferred);
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // Miss (fresh): add to pendingLive; after recorded nodes drain, admit in arrival order and
    // assign a new actorSeq. Then check the import cache (amend-resume): on a hit, settle from cache
    // instead of live-dispatching.
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (this.tryImportedSettle(instance, actor, seq, hash, deferred)) return;
      // Only after a miss can we know whether this is an in-flight ask from the continuation
      // predecessor; take determines that together with the divergence.
      const carried = actor.imported?.carriedAt(seq) === true;
      this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, carried);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /**
   * Admit an ask as a live node: create the node, write its running record at admission, enqueue it, and record the event.
   *
   * `priorTranscript` is true when this ask does not start from an empty transcript (an in-flight
   * ask from a continuation predecessor, or a redispatch from a running row on resume). It only
   * affects how stats are persisted; see {@link journaledStats}.
   */
  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    priorTranscript = false,
  ): void {
    if (priorTranscript) this.priorTranscriptAsks.add(refToString(instance));
    // Record the instruction prefix with the birth event. These instructions are still the
    // author's original text; the driver's quality/schema suffix is appended in startAsk, so the
    // summary does not include engine text. Compute this once on the node: dispatch repeats the
    // birth facts, and both events must carry the same string.
    const instructionsHead = headOfInstructions(instructions);
    const node: AskNode = {
      instance,
      actor,
      actorSeq: seq,
      instructions,
      hash,
      spec,
      deferred,
      repairsRemaining: REPAIR_ATTEMPTS,
      nudgesRemaining: NUDGE_ATTEMPTS,
      settled: false,
      dispatched: false,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    };
    this.liveNodes.set(refToString(instance), node);
    // Write the running row at admission (with actorSeq + inputHash), so a node interrupted during execution can be redispatched on resume.
    this.journal.putNode({
      runId: this.host.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: seq,
      inputHash: hash,
      status: "running",
    });
    actor.liveQueue.push(node);
    this.host.record({
      type: "node-queued",
      instance,
      kind: "ask",
      actor: actor.ref,
      actorSeq: seq,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    });
    // Switching to live does **not** close the import cache. It used to close here, treating any
    // live ask as a possible workspace mutation. That substituted time for dependency: sibling
    // asks later than the first miss in the same Promise.all were invalidated despite having no
    // dependency on it (testing lost 6 hits in a 50-way fan-out and the only hit in a 5-way fan-out).
    // The cache now closes on the **first write**: the driver reports askMutating just before a
    // subagent executes a mutating tool, or a world.run starts live execution. Until then, the
    // world is unchanged from the predecessor's state, so cache hits remain valid.
  }

  /**
   * Check the import cache (amend-resume) when admitting a fresh ask. A hit performs a **cached
   * settle** and returns true (the caller does not live-dispatch); {@link ImportedActorState}
   * handles the decision and divergence accounting.
   *
   * A hit writes a **real** dwf_node row and emits only `node-settled cached:true`, matching the
   * replay-hit behavior in {@link releaseCachedAsk}: no node-queued/node-dispatched events, no
   * liveQueue entry, no session creation, and no `actor.current` occupancy.
   */
  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    deferred: Deferred<unknown>,
  ): boolean {
    // Once the cache is closed, allow only **pure** asks (the predecessor recorded toolCalls === 0).
    // They depend only on instructions and the transcript prefix, not the workspace, so answers
    // from the old world remain valid in the new one. Entries with tool calls go live even when
    // their hashes match because the workspace they read may have changed. That live ask diverges
    // the actor (the transcript now differs); the consumed prefix still defines the seed boundary.
    const entry = this.host.importCacheClosed()
      ? actor.imported?.takeIfPure(seq, hash)
      : actor.imported?.take(seq, hash);
    if (entry === undefined) return false;
    this.journal.putNode(importedAskRecord(this.host.runId, instance, actor.ref, seq, hash, entry));
    this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    deferred.resolve(entry.result);
    return true;
  }

  // ——————————————————————————————— Callbacks ———————————————————————————————

  /** A submit_result arrived; implementation is handleSubmitAttempted in scheduler-submit.ts. */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** A turn ended without a submit; implementation is handleTurnEnded in scheduler-submit.ts. */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // The node has left liveNodes on the typed-accept path: submit stops the turn and settlement
    // persists the row, but actual actor usage is known only after the turn resolves (after submit),
    // so stats arrive after settlement. Backfill the settled journal row, adding/overwriting only
    // stats while preserving status/result/actorSeq/inputHash/error/kind and actor identity.
    // Best-effort and idempotent; budget deduction remains in engine.askStats (this only completes the journal record).
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats: this.journaledStats(instance, stats) });
  }

  /**
   * Stats persisted to the journal: omit `worldToolCalls` for asks whose transcript predates this dispatch.
   *
   * Cause: the driver's tool counter is in memory and resets at the start of each ask. An ask
   * continuing an existing transcript therefore counts only its own turns and misses every tool
   * call already in that transcript. The consequence is not inaccurate usage accounting (that is
   * the tokens concern), but **corrupted purity checks**: a later revision could treat an ask
   * reporting zero calls as pure and settle it from cache after the cache closes, even though it
   * touched the workspace. An absent key already means "touched" (the conservative interpretation),
   * so omitting it is the honest record. Keep tokens/toolCalls/turns: they describe usage, not purity.
   */
  private journaledStats(instance: InstanceRef, stats: AskStats): AskStats {
    if (!this.priorTranscriptAsks.has(refToString(instance))) return stats;
    const { worldToolCalls: _unreliable, ...rest } = stats;
    return rest;
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node === undefined || node.settled) return;
    this.settleFailed(node, error);
  }

  /** Whether this instance is still a live ask (admitted but unsettled); throttle observations matter only for these nodes. */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** Effective name of the subagent owning an in-flight ask (used to name it in cache-close events); undefined otherwise. */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** Abort all in-flight asks when the run is cancelled or fails; emit node-settled(cancelled) when emitCancelled is true. */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }

  // ——————————————————————————————— Internal: admission / dispatch ———————————————————————————————

  private drainAdmission(actor: Actor): void {
    drainActorAdmission(actor);
    this.pumpActor(actor);
  }

  /**
   * Release asks with recorded hits in the **settlement order** stored in the journal. Hold rules
   * define admission order within an actor; this gate restores completion order across actors, so
   * every journal call after an await in a fan-out branch receives the same sequence number.
   */
  private releaseCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    this.host.holdForReplay(instance, () => this.settleCachedAsk(instance, recorded, deferred));
  }

  private settleCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    if (recorded.status === "completed") {
      this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
      deferred.resolve(recorded.result);
    } else {
      // Reproduce recorded failures by short-circuit too: the script may have caught the error and branched on it, so replay must produce the same rejection.
      this.host.record({
        type: "node-settled",
        instance,
        outcome: "failed",
        cached: true,
        error: recorded.error,
      });
      deferred.reject(WorkflowError.fromJSON(recorded.error!));
    }
  }

  /**
   * Rescan each actor's dispatch queue. This public method has **one caller**: the engine invokes it
   * after raising this run's concurrency limit. {@link pumpActor} reads the limit before each
   * dispatch, but no other event triggers a rescan; queued asks would otherwise wait until the next
   * settlement. Immediate additional dispatches after raising the limit are the purpose of this command.
   */
  pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }

  private async dispatch(node: AskNode): Promise<void> {
    let session: SessionRef;
    try {
      session = await this.ensureSession(node.actor);
    } catch (cause) {
      if (this.host.isRunSettled() || node.settled) return;
      // Include the cause text in the message: WorkflowError.toJSON persists only code/message,
      // while cause is neither journaled nor logged. Without this, "failed to create actor session"
      // becomes an undiagnosable black box in the GUI/journal (in production the underlying error
      // was a FOREIGN KEY constraint failure in session_task_link).
      this.settleFailed(
        node,
        new WorkflowError(
          "DriverError",
          `Failed to create the subagent session: ${describeCause(cause)}`,
          { cause },
        ),
      );
      return;
    }
    if (this.host.isRunSettled() || node.settled) return;
    // node-dispatched follows session readiness. The process-level concurrency gate does not live
    // here: it admits **model requests** and lives in runtime deps below the driver; the scheduler
    // enforces only the per-run ask limit.
    // This repeats the instance's birth facts (`node-dispatched` in types.ts). The values already
    // available to the scheduler share a source with `node-queued`; the engine fills both event
    // names from the same construction table in the record.
    this.host.record({
      type: "node-dispatched",
      instance: node.instance,
      kind: "ask",
      actor: node.actor.ref,
      ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
      ...(node.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    });
    node.dispatched = true;
    const message: AskMessage = {
      instructions: node.instructions,
      typed: node.spec.typed,
      schema: node.spec.schema,
    };
    this.host.driver.startAsk(session, node.instance, message);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    // The seed is known only at the divergence point (discovered at runtime), so the engine must
    // pass it to the driver here. The engine owns import state and the driver owns the session
    // store; this signature is their smallest shared boundary.
    const seed = actor.imported?.seed();
    const promise = this.host.driver
      .createActorSession(actor.ref, actor.persona, seed)
      .then((session) => {
        actor.session = session;
        // resolvedModel is written **inside** createActorSession by the host runtime factory (only
        // it knows which model "lite" resolves to). putActor replaces the entire record, so read
        // back and preserve the value just written or this update will erase it, losing the model
        // tier resolution audit trail and resume basis.
        const resolvedModel = this.journal.getActor(
          this.host.runId,
          actor.ref.siteId,
          actor.ref.ordinal,
        )?.resolvedModel;
        this.journal.putActor({
          runId: this.host.runId,
          siteId: actor.ref.siteId,
          ordinal: actor.ref.ordinal,
          name: actor.name,
          persona: actor.persona,
          sessionId: session.id,
          resolvedModel,
        });
        return session;
      });
    actor.sessionPromise = promise;
    return promise;
  }

  // ——————————————————————————————— Internal: settlement ———————————————————————————————

  private settleOk(node: AskNode, artifact: unknown): void {
    if (node.settled) return;
    node.settled = true;
    this.journal.putNode(this.nodeRecordFor(node, { status: "completed", result: artifact }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "ok" });
    this.finishLiveNode(node);
    node.deferred.resolve(artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    if (node.settled) return;
    node.settled = true;
    // Persist settlement failures to the journal (overwriting the running row from admission): a
    // failure is terminal, and the script may have observed the rejection and branched on it, so
    // replay must reproduce it. Journaling failures is required for replay correctness.
    this.journal.putNode(this.nodeRecordFor(node, { status: "failed", error: error.toJSON() }));
    this.host.record({
      type: "node-settled",
      instance: node.instance,
      outcome: "failed",
      error: error.toJSON(),
    });
    this.finishLiveNode(node);
    // A node failure rejects only this ask, not the whole run; the script can catch it.
    node.deferred.reject(error);
  }

  private finishLiveNode(node: AskNode): void {
    this.liveNodes.delete(refToString(node.instance));
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    }
    this.pumpAll();
  }

  private nodeRecordFor(
    node: AskNode,
    outcome:
      | { status: "completed"; result: unknown }
      | { status: "failed"; error: NodeRecord["error"] },
  ): NodeRecord {
    const record: NodeRecord = {
      runId: this.host.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: "ask",
      actorSiteId: node.actor.ref.siteId,
      actorOrdinal: node.actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: outcome.status,
    };
    if (outcome.status === "completed") record.result = outcome.result;
    else record.error = outcome.error;
    if (node.lastStats !== undefined)
      record.stats = this.journaledStats(node.instance, node.lastStats);
    return record;
  }
}
